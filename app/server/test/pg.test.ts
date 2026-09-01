/**
 * E4 integration: the same API against a REAL PostgreSQL.
 *
 * Spins a throwaway PG 17 instance (initdb into a temp dir, random port),
 * runs the migrations, drives a full service over HTTP, then builds a
 * SECOND store on the same database to prove state survives a "restart".
 * Skips cleanly if PostgreSQL is not installed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer } from "../src/server.js";
import { PgStore } from "../src/pgStore.js";

const PGBIN = ["C:/Program Files/PostgreSQL/17/bin", "C:/Program Files/PostgreSQL/16/bin"]
  .find((p) => existsSync(path.join(p, "initdb.exe")));
const PORT = 55000 + Math.floor(Math.random() * 2000);
let dataDir = "";
let url = "";

const ENV = (extra: Record<string, unknown> = {}) => ({
  operationId: crypto.randomUUID(),
  deviceId: "pg-test",
  ...extra,
});

describe.skipIf(!PGBIN)("PostgreSQL persistence (E4)", () => {
  let store: PgStore;

  beforeAll(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ros-pg-"));
    execFileSync(path.join(PGBIN!, "initdb.exe"), ["-D", dataDir, "-U", "rostest", "-A", "trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(path.join(PGBIN!, "pg_ctl.exe"), ["-D", dataDir, "-o", `-p ${PORT} -c listen_addresses=127.0.0.1`, "-l", path.join(dataDir, "log"), "start"], { stdio: "ignore" });
    execFileSync(path.join(PGBIN!, "psql.exe"), ["-h", "127.0.0.1", "-p", String(PORT), "-U", "rostest", "-d", "postgres", "-c", "CREATE DATABASE ros"], { stdio: "ignore" });
    url = `postgres://rostest@127.0.0.1:${PORT}/ros`;
  }, 60_000);

  afterAll(async () => {
    if (store) await store.end().catch(() => {});
    if (PGBIN && dataDir) {
      spawnSync(path.join(PGBIN, "pg_ctl.exe"), ["-D", dataDir, "stop", "-m", "immediate"], { stdio: "ignore" });
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs a full service, persists it, and survives a restart", async () => {
    store = new PgStore(url);
    await store.init();
    await store.init(); // idempotent: migrations and seeds run once
    const app = buildServer(store, "postgres");

    const open = await app.inject({ method: "POST", url: "/v1/checks",
      payload: ENV({ tableName: "Table 7", covers: 4 }) });
    expect(open.statusCode).toBe(200);
    const id = open.json().check.id as string;

    const add = await app.inject({ method: "POST", url: `/v1/checks/${id}/items`,
      payload: ENV({ itemId: "ragu", quantity: 1, seatNo: 2,
        modifiers: [{ groupId: "pasta", modifierId: "gf" },
          { groupId: "additions", modifierId: "shrimp", children: [{ groupId: "cooked", modifierId: "grill" }] }] }) });
    expect(add.statusCode).toBe(200);
    expect(add.json().check.totals.subtotalMinor).toBe(2400 + 200 + 800);

    // invalid modifiers still refused, through Postgres and all
    const bad = await app.inject({ method: "POST", url: `/v1/checks/${id}/items`,
      payload: ENV({ itemId: "cacio", quantity: 1, seatNo: 1 }) });
    expect(bad.statusCode).toBe(422);

    const send = await app.inject({ method: "POST", url: `/v1/checks/${id}/send`, payload: ENV() });
    expect(send.statusCode).toBe(200);

    // E7: transfer the party to Table 12; the party row and kitchen cards follow
    const transfer = await app.inject({ method: "POST", url: `/v1/checks/${id}/transfer`,
      payload: ENV({ tableName: "Table 12" }) });
    expect(transfer.statusCode).toBe(200);

    // idempotent replay via the sync_operation table
    const opId = crypto.randomUUID();
    const p1 = await app.inject({ method: "POST", url: `/v1/checks/${id}/items`,
      payload: { operationId: opId, deviceId: "pg-test", itemId: "acqua", quantity: 1, seatNo: 1 } });
    const p2 = await app.inject({ method: "POST", url: `/v1/checks/${id}/items`,
      payload: { operationId: opId, deviceId: "pg-test", itemId: "acqua", quantity: 1, seatNo: 1 } });
    expect(p2.json()).toEqual(p1.json());

    // kitchen: bump everything, serve the table
    await app.inject({ method: "POST", url: `/v1/checks/${id}/send`, payload: ENV() });

    // E12: void the fired acqua with reason + approval; the kitchen line flags
    const state1 = (await app.inject({ method: "GET", url: `/v1/checks/${id}` })).json().check;
    const acquaLine = state1.lines.find((l: { capturedName: string }) => l.capturedName === "Acqua Panna");
    const voidRes = await app.inject({ method: "POST", url: `/v1/checks/${id}/items/${acquaLine.id}/void`,
      payload: ENV({ reason: "guest changed order", managerPin: "1122" }) });
    expect(voidRes.statusCode).toBe(200);

    // E12: a manager discount, audited into check_adjustment
    const disc = await app.inject({ method: "POST", url: `/v1/checks/${id}/adjustments`,
      payload: ENV({ amountMinor: 400, label: "Regular guest", reason: "weekly regular", managerPin: "1122" }) });
    expect(disc.statusCode).toBe(200);
    expect(disc.json().check.totals.discountMinor).toBe(400);

    // E8-T3: hold a course that has nothing ordered in it yet. The hold is
    // check state, so it has to survive a restart on its own; a hold on an
    // empty course is the case that proves it, since no line carries it.
    const heldRes = await app.inject({ method: "POST", url: `/v1/checks/${id}/hold`,
      payload: ENV({ course: "DOLCI" }) });
    expect(heldRes.statusCode).toBe(200);
    expect(heldRes.json().check.heldCourses).toEqual(["DOLCI"]);
    const historyBefore = (await app.inject({ method: "GET", url: `/v1/checks/${id}/history` })).json();
    expect(historyBefore.entries.map((e: { kind: string }) => e.kind)).toContain("course_held");

    const kds = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets;
    for (const t of kds) for (const i of t.items) {
      if (i.voided) continue;
      await app.inject({ method: "POST", url: "/v1/kds/toggle", payload: ENV({ ticketId: t.id, orderItemId: i.orderItemId }) });
    }
    const serve = await app.inject({ method: "POST", url: "/v1/kds/serve", payload: ENV({ tableName: "Table 12" }) });
    expect(serve.statusCode).toBe(200);

    // E11: the split preview is computed on read (nothing stored), and a
    // labeled portion payment lands in payment_intent.split_label
    const split = await app.inject({ method: "GET", url: `/v1/checks/${id}/split?mode=bySeat` });
    expect(split.statusCode).toBe(200);
    const portions = split.json().portions as { label: string; totalMinor: number }[];
    expect(portions.map((p) => p.label)).toEqual(["Seat 2"]); // seat 1's acqua was voided
    const seatPay = await app.inject({ method: "POST", url: `/v1/checks/${id}/payments`,
      payload: ENV({ method: "card", amountMinor: 1_000, label: "Seat 2" }) });
    expect(seatPay.statusCode).toBe(200);

    // pay in full, close
    const due = (await app.inject({ method: "GET", url: `/v1/checks/${id}` })).json().check.totals.dueMinor as number;
    await app.inject({ method: "POST", url: `/v1/checks/${id}/payments`, payload: ENV({ method: "card", amountMinor: due }) });
    const close = await app.inject({ method: "POST", url: `/v1/checks/${id}/close`, payload: ENV() });
    expect(close.statusCode).toBe(200);

    // E20: a guest the house remembers, attached to the check that just closed
    // (attaching after the fact is the point: that is when a server has time)
    const guestRes = await app.inject({ method: "POST", url: "/v1/guests",
      payload: ENV({ displayName: "Elena Rossi", phone: "555-0100", notes: "Barolo, corner two-top" }) });
    expect(guestRes.statusCode).toBe(200);
    const guestId = guestRes.json().guest.id as string;
    const attachRes = await app.inject({ method: "POST", url: `/v1/checks/${id}/guests`,
      payload: ENV({ guestId }) });
    expect(attachRes.statusCode).toBe(200);
    expect(attachRes.json().check.guests).toEqual([{ id: guestId, name: "Elena Rossi" }]);
    const profileBefore = (await app.inject({ method: "GET", url: `/v1/guests/${guestId}` })).json();
    expect(profileBefore.visitCount).toBe(1);

    // relocate a table on the floor plan (E6 editor)
    const move = await app.inject({ method: "POST", url: "/v1/floor/move",
      payload: ENV({ tableName: "Table 2", x: 40, y: 56 }) });
    expect(move.statusCode).toBe(200);

    // E14/E16: run a till and close the business day
    const drawer = await app.inject({ method: "POST", url: "/v1/drawer/open",
      payload: ENV({ drawerName: "Front drawer", openingFloatMinor: 20000 }) });
    expect(drawer.statusCode).toBe(200);
    const sessionId = drawer.json().session.id as string;
    await app.inject({ method: "POST", url: "/v1/drawer/event",
      payload: ENV({ sessionId, kind: "pay_out", amountMinor: 2500, reason: "produce run", managerPin: "1122" }) });
    const drawerClose = await app.inject({ method: "POST", url: "/v1/drawer/close",
      payload: ENV({ sessionId, countedMinor: 17500 }) });
    expect(drawerClose.json().session.overShortMinor).toBe(0);
    const dayClose = await app.inject({ method: "POST", url: "/v1/day/close", payload: ENV({ managerPin: "1122" }) });
    expect(dayClose.statusCode).toBe(200);

    // E5: publish menu v2 (price change) and 86 the calamari, both persisted
    await app.inject({ method: "POST", url: "/v1/menu/draft/item",
      payload: ENV({ itemId: "tiramisu", name: "Tiramisu della Casa", priceMinor: 1300, course: "DOLCI", station: "FREDDO" }) });
    const pub = await app.inject({ method: "POST", url: "/v1/menu/publish", payload: ENV({ managerPin: "1122" }) });
    expect(pub.statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/v1/menu/86", payload: ENV({ itemId: "calamari", is86: true }) });

    /* THE RESTART: a brand-new store + server on the same database.
       Everything must still be there. */
    await store.end();
    store = new PgStore(url);
    await store.init();
    const app2 = buildServer(store, "postgres");

    const back = await app2.inject({ method: "GET", url: `/v1/checks/${id}` });
    expect(back.statusCode).toBe(200);
    const check = back.json().check;
    expect(check.status).toBe("closed");
    expect(check.tableName).toBe("Table 12"); // the transfer survived (party.table_id)

    // E19: the opener came back off the employee join. Nobody signs in during
    // this test, so the check carries the seeded default, which is exactly
    // what an unsigned demo terminal stamps: attribution, never null.
    expect(check.serverId).toBe("33333333-3333-3333-3333-333333333333");
    expect(check.serverName).toBe("Gia R.");

    // and the close stamped the party's own endpoint (seated_at to cleared_at
    // is the turn time). No read exposes cleared_at yet, so ask the table.
    const cleared = execFileSync(path.join(PGBIN!, "psql.exe"),
      ["-h", "127.0.0.1", "-p", String(PORT), "-U", "rostest", "-d", "ros", "-tAc",
        `SELECT p.cleared_at IS NOT NULL FROM party p JOIN checks ch ON ch.party_id = p.id WHERE ch.id = '${id}'`],
      { encoding: "utf8" }).trim();
    expect(cleared).toBe("t");
    expect(check.lines).toHaveLength(2);
    expect(check.totals.dueMinor).toBe(0);
    expect(check.totals.paidMinor).toBe(1_000 + due); // the labeled portion plus the remainder

    // the split label survived as payment_intent.split_label, so the portion
    // still reads as partly settled after the restart
    const labeled = check.payments.find((p: { label: string }) => p.label === "Seat 2");
    expect(labeled.amountMinor).toBe(1_000);
    const portions2 = (await app2.inject({ method: "GET", url: `/v1/checks/${id}/split?mode=bySeat` })).json().portions;
    expect(portions2).toHaveLength(1);
    expect(portions2[0]).toMatchObject({ label: "Seat 2", paidMinor: 1_000 });
    const ragu = check.lines.find((l: { capturedName: string }) => l.capturedName === "Ragu alla Bolognese");
    expect(ragu.modifierPriceMinor).toBe(1000); // gf 200 + shrimp 800, survived as a tree
    expect(ragu.modifiers[1].children[0].modifierId).toBe("grill");

    // the void survived with its paperwork (void_has_reason constraint)
    const acqua2 = check.lines.find((l: { capturedName: string }) => l.capturedName === "Acqua Panna");
    expect(acqua2.status).toBe("voided");
    expect(acqua2.voidReason).toBe("guest changed order");

    // the discount survived as a check_adjustment row
    expect(check.adjustments).toHaveLength(1);
    expect(check.adjustments[0].label).toBe("Regular guest");
    expect(check.adjustments[0].reason).toBe("weekly regular");
    expect(check.totals.discountMinor).toBe(400);

    const kds2 = (await app2.inject({ method: "GET", url: "/v1/kds" })).json().tickets;
    expect(kds2.every((t: { status: string }) => t.status === "served")).toBe(true);

    // both the vacated table and the closed one read free on the floor
    const floor = (await app2.inject({ method: "GET", url: "/v1/floor" })).json().tables;
    expect(floor.find((t: { name: string }) => t.name === "Table 7").check).toBeNull();
    expect(floor.find((t: { name: string }) => t.name === "Table 12").check).toBeNull();

    // and the layout edit survived the restart too
    const t2 = floor.find((t: { name: string }) => t.name === "Table 2");
    expect(t2.x).toBe(40);
    expect(t2.y).toBe(56);

    // the closed business day and the counted drawer survived the restart:
    // day status from business_day, ledger from drawer_session + cash_event
    const day = (await app2.inject({ method: "GET", url: "/v1/day" })).json();
    expect(day.status).toBe("closed");
    expect(day.drawers).toHaveLength(1);
    expect(day.drawers[0].openingFloatMinor).toBe(20000);
    expect(day.drawers[0].expectedMinor).toBe(17500);
    expect(day.drawers[0].overShortMinor).toBe(0);
    expect(day.drawers[0].events).toHaveLength(1);
    expect(day.drawers[0].events[0].reason).toBe("produce run");

    // a closed day refuses new checks even after the restart
    const blocked = await app2.inject({ method: "POST", url: "/v1/checks",
      payload: ENV({ tableName: "Table 5", covers: 2 }) });
    expect(blocked.statusCode).toBe(422);

    // menu v2 and the 86 board survived: snapshot rows + item_availability
    const menu = (await app2.inject({ method: "GET", url: "/v1/menu" })).json();
    expect(menu.version).toBe(2);
    expect(menu.snapshotId).toBe("snap-0002");
    expect(menu.items.find((i: { id: string }) => i.id === "tiramisu").priceMinor).toBe(1300);
    expect(menu.availability.find((a: { itemId: string }) => a.itemId === "calamari").is86).toBe(true);
    // and the closed check still reports the v1 snapshot it was opened on
    expect(check.menuSnapshotId).toBe("snap-0001");

    // E20: the guest and the attachment survived as guest + check_guest rows,
    // and the profile is byte-identical, because it is derived from the ledger
    // rather than stored anywhere
    const profileAfter = (await app2.inject({ method: "GET", url: `/v1/guests/${guestId}` })).json();
    expect(profileAfter).toEqual(profileBefore);
    expect(profileAfter.guest.notes).toBe("Barolo, corner two-top");
    expect(profileAfter.totalSpendMinor).toBe(check.totals.totalMinor);
    expect(check.guests).toEqual([{ id: guestId, name: "Elena Rossi" }]);
    // search finds her through the location-scoped index
    expect((await app2.inject({ method: "GET", url: "/v1/guests?q=ROSSI" })).json().guests).toHaveLength(1);

    // E8-T3: the hold, its log, and the timestamps a history is made of all
    // came back off the row (checks.course_state, order_item.created_at and
    // voided_at, payment.taken_at)
    expect(check.heldCourses).toEqual(["DOLCI"]);
    expect(check.lines.every((l: { addedAt?: string }) => typeof l.addedAt === "string")).toBe(true);
    expect(acqua2.voidedAt).toEqual(expect.any(String));
    expect(check.payments.every((p: { takenAt?: string }) => typeof p.takenAt === "string")).toBe(true);
    const historyAfter = (await app2.inject({ method: "GET", url: `/v1/checks/${id}/history` })).json();
    expect(historyAfter.heldCourses).toEqual(["DOLCI"]);
    for (const entry of historyBefore.entries) expect(historyAfter.entries).toContainEqual(entry);
    for (const kind of ["opened", "item_added", "course_held", "fired", "voided", "adjustment", "payment", "closed"]) {
      expect(historyAfter.entries.map((e: { kind: string }) => e.kind), `missing ${kind} after the restart`).toContain(kind);
    }
    const times = historyAfter.entries.map((e: { at: string }) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a: number, b: number) => a - b));
  }, 60_000);

  /* --------------------- the floor editor, for real (E6-T2) ---------------------
   * The memory store proves the RULES in api.test.ts. Only Postgres can prove
   * the things that are actually about rows: the partial unique index, the
   * revive-in-place identity, the sort order of a new area, and a booth
   * surviving a round trip through a CHECK-constrained column. */

  const sql = (q: string) =>
    execFileSync(path.join(PGBIN!, "psql.exe"),
      ["-h", "127.0.0.1", "-p", String(PORT), "-U", "rostest", "-d", "ros", "-tAc", q],
      { encoding: "utf8" }).trim();

  it("draws, edits, retires, and revives a table against real rows", async () => {
    const app = buildServer(store, "postgres");
    const MGR = "1122";
    const tables = async () =>
      (await app.inject({ method: "GET", url: "/v1/floor" })).json().tables as
        { name: string; area: string; seats: number; shape: string; x: number; y: number; w: number; h: number }[];
    const named = async (name: string) => (await tables()).find((t) => t.name === name);

    // the previous test sealed the day; the room is still editable, but the
    // live-check cases below need a check, so reopen first
    const reopen = await app.inject({ method: "POST", url: "/v1/day/reopen", payload: ENV({ managerPin: MGR }) });
    expect(reopen.statusCode).toBe(200);

    /* --- add: a new area lands last, and a booth stays a booth --- */
    const areasBefore = [...new Set((await tables()).map((t) => t.area))];
    const add = await app.inject({ method: "POST", url: "/v1/floor/add",
      payload: ENV({ managerPin: MGR, name: "Dehors 1", area: "Dehors", seats: 6, shape: "booth", x: 12, y: 30, w: 18, h: 24 }) });
    expect(add.statusCode).toBe(200);
    expect(await named("Dehors 1")).toMatchObject({ area: "Dehors", seats: 6, shape: "booth", x: 12, y: 30, w: 18, h: 24 });
    const areasAfter = [...new Set((await tables()).map((t) => t.area))];
    expect(areasAfter[areasAfter.length - 1]).toBe("Dehors");
    expect(areasAfter.slice(0, -1)).toEqual(areasBefore);
    expect(sql("SELECT sort FROM dining_area WHERE name = 'Dehors'")).not.toBe("0");

    // no PIN and a server's PIN are refused with the same words the memory
    // store uses: one engine, one rule, two stores
    const bare = await app.inject({ method: "POST", url: "/v1/floor/add",
      payload: ENV({ name: "Dehors 2", area: "Dehors", seats: 2, shape: "round", x: 40, y: 30, w: 10, h: 16 }) });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().reason).toBe("adding a table requires a manager's PIN");
    const asServer = await app.inject({ method: "POST", url: "/v1/floor/add",
      payload: ENV({ managerPin: "2468", name: "Dehors 2", area: "Dehors", seats: 2, shape: "round", x: 40, y: 30, w: 10, h: 16 }) });
    expect(asServer.statusCode).toBe(422);
    expect(asServer.json().reason).toBe("PIN not recognized as a manager");

    // the duplicate name is refused case-insensitively, and the partial unique
    // index is there to say so even if two devices raced
    const dup = await app.inject({ method: "POST", url: "/v1/floor/add",
      payload: ENV({ managerPin: MGR, name: "dehors 1", area: "Dehors", seats: 2, shape: "round", x: 40, y: 30, w: 10, h: 16 }) });
    expect(dup.statusCode).toBe(422);
    expect(dup.json().reason).toBe("dehors 1 is already a table on the floor");
    expect(sql("SELECT indexdef FROM pg_indexes WHERE indexname = 'dining_table_active_name_uq'"))
      .toContain("retired_at IS NULL");

    // the idempotent replay of a dropped add
    const op = ENV({ managerPin: MGR, name: "Dehors 2", area: "Dehors", seats: 2, shape: "round", x: 40, y: 30, w: 10, h: 16 });
    const first = await app.inject({ method: "POST", url: "/v1/floor/add", payload: op });
    const retry = await app.inject({ method: "POST", url: "/v1/floor/add", payload: op });
    expect(first.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect(sql("SELECT count(*) FROM dining_table WHERE lower(name) = 'dehors 2'")).toBe("1");

    /* --- resize: the position re-clamps at the right and bottom edges --- */
    await app.inject({ method: "POST", url: "/v1/floor/move", payload: ENV({ tableName: "Dehors 1", x: 999, y: 999 }) });
    const parked = (await named("Dehors 1"))!;
    expect(parked).toMatchObject({ x: 100 - 18, y: 100 - 24 });
    const grow = await app.inject({ method: "POST", url: "/v1/floor/resize",
      payload: ENV({ managerPin: MGR, tableName: "Dehors 1", w: 30, h: 36 }) });
    expect(grow.statusCode).toBe(200);
    expect(await named("Dehors 1")).toMatchObject({ w: 30, h: 36, x: 70, y: 64, seats: 6 });
    const tooBig = await app.inject({ method: "POST", url: "/v1/floor/resize",
      payload: ENV({ managerPin: MGR, tableName: "Dehors 1", w: 60, h: 10 }) });
    expect(tooBig.json().reason).toBe("w and h must be between 3 and 40 (percent of the room)");

    /* --- rename: refused while the table is working, and history keeps the
           name the guests were served under --- */
    const open = await app.inject({ method: "POST", url: "/v1/checks", payload: ENV({ tableName: "Dehors 1", covers: 4 }) });
    expect(open.statusCode).toBe(200);
    const liveId = open.json().check.id as string;
    const blocked = await app.inject({ method: "POST", url: "/v1/floor/update",
      payload: ENV({ managerPin: MGR, tableName: "Dehors 1", newName: "Giardino 1" }) });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().reason).toContain("cannot rename while Dehors 1 has an open check");

    // seats and shape are corrections, allowed even with guests sitting there
    const reshape = await app.inject({ method: "POST", url: "/v1/floor/update",
      payload: ENV({ managerPin: MGR, tableName: "Dehors 1", seats: 8, shape: "rect" }) });
    expect(reshape.statusCode).toBe(200);
    expect(await named("Dehors 1")).toMatchObject({ seats: 8, shape: "rect" });

    // run the check out: ordered, fired, paid, closed, and the kitchen card
    // bumped and served. Only then does nothing hold the name any more.
    await app.inject({ method: "POST", url: `/v1/checks/${liveId}/items`, payload: ENV({ itemId: "acqua", quantity: 1, seatNo: 1 }) });
    await app.inject({ method: "POST", url: `/v1/checks/${liveId}/send`, payload: ENV() });

    // the fired card blocks the rename on its own, even with the guests gone
    const owed = (await app.inject({ method: "GET", url: `/v1/checks/${liveId}` })).json().check.totals.dueMinor as number;
    await app.inject({ method: "POST", url: `/v1/checks/${liveId}/payments`, payload: ENV({ method: "card", amountMinor: owed }) });
    expect((await app.inject({ method: "POST", url: `/v1/checks/${liveId}/close`, payload: ENV() })).statusCode).toBe(200);
    const cooking = await app.inject({ method: "POST", url: "/v1/floor/update",
      payload: ENV({ managerPin: MGR, tableName: "Dehors 1", newName: "Giardino 1" }) });
    expect(cooking.statusCode).toBe(422);
    expect(cooking.json().reason).toContain("still has an open kitchen ticket");

    for (const t of (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets) {
      if (t.status !== "open") continue;
      for (const i of t.items) {
        await app.inject({ method: "POST", url: "/v1/kds/toggle", payload: ENV({ ticketId: t.id, orderItemId: i.orderItemId }) });
      }
      await app.inject({ method: "POST", url: "/v1/kds/serve", payload: ENV({ tableName: t.tableName }) });
    }

    const taken = await app.inject({ method: "POST", url: "/v1/floor/update",
      payload: ENV({ managerPin: MGR, tableName: "Dehors 1", newName: "dehors 2" }) });
    expect(taken.statusCode).toBe(422);
    expect(taken.json().reason).toBe("dehors 2 is already a table on the floor");

    const selfCase = await app.inject({ method: "POST", url: "/v1/floor/update",
      payload: ENV({ managerPin: MGR, tableName: "Dehors 1", newName: "DEHORS 1" }) });
    expect(selfCase.statusCode).toBe(200);
    const renamed = await app.inject({ method: "POST", url: "/v1/floor/update",
      payload: ENV({ managerPin: MGR, tableName: "DEHORS 1", newName: "Giardino 1" }) });
    expect(renamed.statusCode).toBe(200);
    expect(await named("Giardino 1")).toBeDefined();
    expect(await named("DEHORS 1")).toBeUndefined();

    // the closed check was served at Dehors 1 and still says so: the name is
    // captured on the check, not read back off the table it happens to point at
    const served = (await app.inject({ method: "GET", url: `/v1/checks/${liveId}` })).json().check;
    expect(served.tableName).toBe("Dehors 1");

    /* --- retire and revive: the SAME row, so the party history holds --- */
    const rowId = sql("SELECT id FROM dining_table WHERE name = 'Giardino 1'");
    expect(rowId).not.toBe("");
    expect(sql(`SELECT count(*) FROM party WHERE table_id = '${rowId}'`)).toBe("1");

    const retire = await app.inject({ method: "POST", url: "/v1/floor/retire",
      payload: ENV({ managerPin: MGR, tableName: "Giardino 1" }) });
    expect(retire.statusCode).toBe(200);
    expect(await named("Giardino 1")).toBeUndefined();
    expect(sql(`SELECT retired_at IS NOT NULL FROM dining_table WHERE id = '${rowId}'`)).toBe("t");
    const stranded = await app.inject({ method: "POST", url: "/v1/floor/move", payload: ENV({ tableName: "Giardino 1", x: 5, y: 5 }) });
    expect(stranded.statusCode).toBe(422);
    expect(stranded.json().reason).toBe("unknown table Giardino 1");

    const revive = await app.inject({ method: "POST", url: "/v1/floor/add",
      payload: ENV({ managerPin: MGR, name: "giardino 1", area: "Sala", seats: 4, shape: "booth", x: 20, y: 60, w: 16, h: 20 }) });
    expect(revive.statusCode).toBe(200);
    expect(sql("SELECT count(*) FROM dining_table WHERE lower(name) = 'giardino 1'")).toBe("1");
    expect(sql(`SELECT id FROM dining_table WHERE lower(name) = 'giardino 1'`)).toBe(rowId);
    expect(sql(`SELECT count(*) FROM party WHERE table_id = '${rowId}'`)).toBe("1"); // history intact
    expect(await named("giardino 1")).toMatchObject({ area: "Sala", seats: 4, shape: "booth", x: 20, y: 60 });

    /* --- the booth survives a restart, which is what E6-T2 fixes --- */
    await store.end();
    store = new PgStore(url);
    await store.init();
    const app2 = buildServer(store, "postgres");
    const back = (await app2.inject({ method: "GET", url: "/v1/floor" })).json().tables;
    expect(back.find((t: { name: string }) => t.name === "giardino 1").shape).toBe("booth");
    // and the closed check still names the table it was served at
    expect((await app2.inject({ method: "GET", url: `/v1/checks/${liveId}` })).json().check.tableName).toBe("Dehors 1");
  }, 60_000);

  /* ------------------- the venue and the roster (E21-T1) -------------------
   * The rules are proven against the memory store in api.test.ts. What only
   * Postgres can prove is that a renamed venue, a reset PIN, and a
   * deactivated employee all SURVIVE a restart, which is exactly what a
   * seed-on-every-boot roster used to destroy. */

  it("keeps a renamed venue, a new hire, a reset PIN, and a deactivation across a restart", async () => {
    const app = buildServer(store, "postgres");
    const MGR = "1122";
    const roster = async (a: ReturnType<typeof buildServer>) =>
      (await a.inject({ method: "GET", url: "/v1/staff" })).json().staff as
        { id: string; name: string; role: string; active: boolean }[];

    /* --- the venue seeded from the demo values, then edited --- */
    expect((await app.inject({ method: "GET", url: "/v1/venue" })).json()).toEqual({
      name: "Osteria Nove", address: "9 Vicolo della Luna, New York", timezone: "America/New_York",
      payPeriod: "biweekly", payPeriodAnchor: "2026-01-05",
    });
    const bad = await app.inject({ method: "POST", url: "/v1/venue",
      payload: ENV({ managerPin: MGR, timezone: "America/Atlantis" }) });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().reason).toBe("America/Atlantis is not a timezone this machine knows");
    const rename = await app.inject({ method: "POST", url: "/v1/venue",
      payload: ENV({ managerPin: MGR, name: "Trattoria Sedici", address: "16 Elm St, Austin", timezone: "America/Chicago" }) });
    expect(rename.statusCode).toBe(200);

    /* --- the roster: no PIN on it, and a new hire lands in real rows --- */
    const before = await roster(app);
    expect(before.map((s) => s.name)).toEqual(["Gia R.", "Marco B.", "Sofia T."]);
    expect(JSON.stringify(before)).not.toContain("2468");

    const hired = await app.inject({ method: "POST", url: "/v1/staff",
      payload: ENV({ managerPin: MGR, name: "Luca P.", role: "server", pin: "4321" }) });
    expect(hired.statusCode).toBe(200);
    const luca = hired.json().employee as { id: string };
    const dupPin = await app.inject({ method: "POST", url: "/v1/staff",
      payload: ENV({ managerPin: MGR, name: "Clone", role: "server", pin: "4321" }) });
    expect(dupPin.json().reason).toBe("that PIN already belongs to Luca P.");

    // Luca signs in and opens a check, so he has history worth protecting
    expect((await app.inject({ method: "POST", url: "/v1/session",
      payload: { deviceId: "term-luca", pin: "4321" } })).statusCode).toBe(200);
    const opened = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { operationId: crypto.randomUUID(), deviceId: "term-luca", tableName: "Table 5", covers: 2 } });
    expect(opened.statusCode).toBe(200);
    const lucaCheck = opened.json().check.id as string;
    expect(opened.json().check.serverName).toBe("Luca P.");

    /* --- reset his PIN, then let Sofia go --- */
    const reset = await app.inject({ method: "POST", url: `/v1/staff/${luca.id}/pin`,
      payload: ENV({ managerPin: MGR, pin: "998877" }) });
    expect(reset.statusCode).toBe(200);

    const sofia = (await roster(app)).find((s) => s.name === "Sofia T.")!;
    const out = await app.inject({ method: "POST", url: `/v1/staff/${sofia.id}/deactivate`,
      payload: ENV({ managerPin: MGR }) });
    expect(out.statusCode).toBe(200);

    const marco = (await roster(app)).find((s) => s.name === "Marco B.")!;
    const lastManager = await app.inject({ method: "POST", url: `/v1/staff/${marco.id}/deactivate`,
      payload: ENV({ managerPin: MGR }) });
    expect(lastManager.statusCode).toBe(422);
    expect(lastManager.json().reason).toBe("Marco B. is the only active manager; promote someone else first");

    /* THE RESTART: the seed must not undo any of it --- */
    await store.end();
    store = new PgStore(url);
    await store.init();
    const app3 = buildServer(store, "postgres");

    expect((await app3.inject({ method: "GET", url: "/v1/venue" })).json()).toEqual({
      name: "Trattoria Sedici", address: "16 Elm St, Austin", timezone: "America/Chicago",
      payPeriod: "biweekly", payPeriodAnchor: "2026-01-05",
    });

    const after = await roster(app3);
    expect(after.map((s) => s.name)).toEqual(["Gia R.", "Marco B.", "Sofia T.", "Luca P."]);
    expect(after.find((s) => s.name === "Sofia T.")!.active).toBe(false);
    expect(after.find((s) => s.name === "Luca P.")).toMatchObject({ role: "server", active: true });
    expect(JSON.stringify(after)).not.toContain("4321");

    // the reset PIN survived and the old one is still dead
    expect((await app3.inject({ method: "POST", url: "/v1/session", payload: { deviceId: "d9", pin: "4321" } })).statusCode).toBe(401);
    expect((await app3.inject({ method: "POST", url: "/v1/session", payload: { deviceId: "d9", pin: "998877" } })).json().employee.id).toBe(luca.id);
    // Sofia's PIN is dead too, and her deactivation did not resurrect on boot
    expect((await app3.inject({ method: "POST", url: "/v1/session", payload: { deviceId: "d9", pin: "3579" } })).statusCode).toBe(401);

    // and Luca's check still names him: deactivation and PIN resets are
    // roster events, never history edits
    expect((await app3.inject({ method: "GET", url: `/v1/checks/${lucaCheck}` })).json().check.serverName).toBe("Luca P.");
  }, 60_000);

  /* ------------------- the people directory (E24-T2) -------------------
   * The gate and the two rules are proven against the memory store in
   * api.test.ts. What only Postgres can prove: the five columns migration
   * 0008 adds actually hold their values across a restart, and the public
   * roster query cannot leak them because it never selects them. */

  it("round-trips a title and contact details through real columns and a restart", async () => {
    const app = buildServer(store, "postgres");
    const MGR = "1122";
    const PERSONAL = { phone: "917-555-0143", email: "nok@example.com",
      emergencyContact: "Preeda (sister) 917-555-0198", notes: "Certified food handler, Tuesdays off" };
    const directory = (a: ReturnType<typeof buildServer>, pin?: string) =>
      a.inject({ method: "POST", url: "/v1/staff/directory",
        payload: pin === undefined ? {} : { managerPin: pin } });

    // 0008 landed, and it is the columns the ticket named
    for (const column of ["title", "phone", "email", "emergency_contact", "notes"]) {
      expect(sql(`SELECT count(*) FROM information_schema.columns
                  WHERE table_name = 'employee' AND column_name = '${column}'`), column).toBe("1");
    }
    // and NOT the ones D28 says are a payroll provider's business, not ours
    for (const column of ["wage_minor", "wage_rate", "ssn", "tax_id", "bank_account"]) {
      expect(sql(`SELECT count(*) FROM information_schema.columns
                  WHERE table_name = 'employee' AND column_name = '${column}'`), column).toBe("0");
    }

    /* --- the line cook this rung exists for: never signs in, and the room
           calls him something the permission enum has no word for --- */
    const hired = await app.inject({ method: "POST", url: "/v1/staff",
      payload: ENV({ managerPin: MGR, name: "Nok S.", role: "server", pin: "4455", title: "Line cook", ...PERSONAL }) });
    expect(hired.statusCode).toBe(200);
    const nok = hired.json().employee as { id: string };

    // the details are in real columns, not a JSON blob on the side
    expect(sql(`SELECT title FROM employee WHERE id = '${nok.id}'`)).toBe("Line cook");
    expect(sql(`SELECT phone FROM employee WHERE id = '${nok.id}'`)).toBe(PERSONAL.phone);
    expect(sql(`SELECT emergency_contact FROM employee WHERE id = '${nok.id}'`)).toBe(PERSONAL.emergencyContact);
    // the role is still the permission level, in its own table, untouched
    expect(sql(`SELECT r.name FROM employee_role er JOIN role r ON r.id = er.role_id
                WHERE er.employee_id = '${nok.id}'`)).toBe("Server");

    /* --- an edit: some fields change, one clears, the rest hold --- */
    const edit = await app.inject({ method: "POST", url: `/v1/staff/${nok.id}`,
      payload: ENV({ managerPin: MGR, title: "Sous chef", phone: "917-555-0111", notes: "" }) });
    expect(edit.statusCode).toBe(200);
    expect(sql(`SELECT notes IS NULL FROM employee WHERE id = '${nok.id}'`)).toBe("t");
    expect(sql(`SELECT email FROM employee WHERE id = '${nok.id}'`)).toBe(PERSONAL.email);

    /* THE RESTART --- */
    await store.end();
    store = new PgStore(url);
    await store.init();
    const app4 = buildServer(store, "postgres");

    const back = (await directory(app4, MGR)).json().staff.find((s: { id: string }) => s.id === nok.id);
    expect(back).toMatchObject({
      name: "Nok S.", role: "server", active: true, title: "Sous chef",
      phone: "917-555-0111", email: PERSONAL.email, emergencyContact: PERSONAL.emergencyContact,
    });
    expect(back.notes).toBeUndefined();

    // the public roster carries the title and not one personal field, and the
    // gate is the engine's, so both stores refuse in the same sentence
    const publicRoster = (await app4.inject({ method: "GET", url: "/v1/staff" })).json().staff;
    expect(publicRoster.find((s: { id: string }) => s.id === nok.id).title).toBe("Sous chef");
    for (const secret of [PERSONAL.email, PERSONAL.emergencyContact, "917-555-0111"]) {
      expect(JSON.stringify(publicRoster), secret).not.toContain(secret);
    }
    const asServer = await directory(app4, "2468");
    expect(asServer.statusCode).toBe(422);
    expect(asServer.json().reason).toBe("PIN not recognized as a manager");
    expect((await directory(app4)).json().reason).toBe("reading the staff directory requires a manager's PIN");

    // an untitled hire still reads as its role, computed and never stored
    expect(sql("SELECT title IS NULL FROM employee WHERE display_name = 'Gia R.'")).toBe("t");
    expect(publicRoster.find((s: { name: string }) => s.name === "Gia R.").title).toBe("Server");
  }, 60_000);

  /* ------------- the modifier graph on the draft (E5-T2) -------------
   * The rules are proven against the memory store in api.test.ts. What only
   * Postgres can prove: the draft document actually carries the manager's
   * groups through the JSONB column and a restart, and the published
   * snapshot's graph is the one that comes back, not the seed constant. */

  it("round-trips a manager-authored modifier graph through the draft document and a restart", async () => {
    const app = buildServer(store, "postgres");
    const MGR = "1122";

    const group = await app.inject({ method: "POST", url: "/v1/menu/draft/group",
      payload: ENV({ managerPin: MGR, groupId: "spice", name: "Spice level", minSelect: 1, maxSelect: 1,
        options: [{ name: "Mild", priceMinor: 0 }, { name: "Thai hot", priceMinor: 250 }] }) });
    expect(group.statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/v1/menu/draft/assign",
      payload: ENV({ managerPin: MGR, itemId: "ragu", groupIds: ["spice", "pasta"] }) });

    // it is really in the document column, not held in a process somewhere
    expect(sql("SELECT document->'groups'->0->>'id' IS NOT NULL FROM menu_draft")).toBe("t");
    expect(sql(`SELECT count(*) FROM menu_draft WHERE document::text LIKE '%Thai hot%'`)).toBe("1");

    /* the draft survives a restart unpublished, which is the whole point of
       storing it rather than keeping it in memory */
    await store.end();
    store = new PgStore(url);
    await store.init();
    const app5 = buildServer(store, "postgres");

    const draft = (await app5.inject({ method: "GET", url: "/v1/menu/draft" })).json().draft;
    expect(draft.groups.find((g: { id: string }) => g.id === "spice"))
      .toMatchObject({ name: "Spice level", minSelect: 1, maxSelect: 1 });
    expect(draft.items.find((m: { id: string }) => m.id === "ragu").modifierGroupIds).toEqual(["spice", "pasta"]);

    /* publish, and the SNAPSHOT carries the graph too */
    const before = (await app5.inject({ method: "GET", url: "/v1/menu" })).json().version as number;
    const pub = await app5.inject({ method: "POST", url: "/v1/menu/publish", payload: ENV({ managerPin: MGR }) });
    expect(pub.statusCode).toBe(200);
    expect((await app5.inject({ method: "GET", url: "/v1/menu/draft" })).json().draft).toBeNull();

    await store.end();
    store = new PgStore(url);
    await store.init();
    const app6 = buildServer(store, "postgres");
    const live = (await app6.inject({ method: "GET", url: "/v1/menu" })).json();
    expect(live.version).toBe(before + 1);
    expect(live.groups.spice.options.map((o: { id: string }) => o.id)).toEqual(["mild", "thai-hot"]);

    // and the manager's rule is what refuses the order, through real rows
    const check = await app6.inject({ method: "POST", url: "/v1/checks", payload: ENV({ tableName: "Table 9", covers: 2 }) });
    const checkId = check.json().check.id as string;
    const bare = await app6.inject({ method: "POST", url: `/v1/checks/${checkId}/items`,
      payload: ENV({ itemId: "ragu", quantity: 1, seatNo: 1, modifiers: [{ groupId: "pasta", modifierId: "spag" }] }) });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().modifierErrors).toEqual([{ code: "too_few", groupId: "spice", min: 1, got: 0 }]);

    const priced = await app6.inject({ method: "POST", url: `/v1/checks/${checkId}/items`,
      payload: ENV({ itemId: "ragu", quantity: 1, seatNo: 1,
        modifiers: [{ groupId: "pasta", modifierId: "spag" }, { groupId: "spice", modifierId: "thai-hot" }] }) });
    expect(priced.statusCode).toBe(200);
    expect(priced.json().check.lines.at(-1).modifierPriceMinor).toBe(250);

    /* the kitchen rail names the manager's option, which is what the seed
       GROUPS constant could never have done: it has never heard of "Thai hot" */
    await app6.inject({ method: "POST", url: `/v1/checks/${checkId}/send`, payload: ENV() });
    // scoped to THIS check: earlier tests in this file share the database and
    // left their own Ragu on the rail
    const fired = (await app6.inject({ method: "GET", url: "/v1/kds" })).json().tickets
      .filter((t: { checkId: string }) => t.checkId === checkId)
      .flatMap((t: { items: { name: string; mods: string }[] }) => t.items)
      .find((i: { name: string }) => i.name === "Ragu alla Bolognese");
    expect(fired.mods).toBe("Spaghetti, Thai hot");
  }, 60_000);

  /* ------------- the pay period setting (E24-T3) -------------
   * The export's arithmetic is proven against the memory store in
   * api.test.ts. What only Postgres can prove: migration 0009's columns
   * exist, hold the setting across a restart, and hold NO wage beside it. */

  it("keeps the pay period across a restart, and stores no wage next to it", async () => {
    const app = buildServer(store, "postgres");
    const MGR = "1122";

    // 0009 landed with the two columns, and the backfill gave an existing
    // database a sensible answer rather than a NULL
    for (const column of ["pay_period", "pay_period_anchor"]) {
      expect(sql(`SELECT count(*) FROM information_schema.columns
                  WHERE table_name = 'location' AND column_name = '${column}'`), column).toBe("1");
    }
    // and STILL nothing that turns hours into money, on either table
    for (const column of ["wage_minor", "wage_rate", "hourly_rate", "ssn", "tax_id", "bank_account"]) {
      expect(sql(`SELECT count(*) FROM information_schema.columns
                  WHERE table_name IN ('location', 'employee') AND column_name = '${column}'`), column).toBe("0");
    }

    const seeded = (await app.inject({ method: "GET", url: "/v1/venue" })).json();
    expect(seeded.payPeriod).toBe("biweekly");
    expect(seeded.payPeriodAnchor).toBe("2026-01-05");

    const set = await app.inject({ method: "POST", url: "/v1/venue",
      payload: ENV({ managerPin: MGR, payPeriod: "semimonthly", payPeriodAnchor: "2026-03-02" }) });
    expect(set.statusCode).toBe(200);
    expect(sql("SELECT pay_period FROM location")).toBe("semimonthly");

    await store.end();
    store = new PgStore(url);
    await store.init();
    const app7 = buildServer(store, "postgres");

    const back = (await app7.inject({ method: "GET", url: "/v1/venue" })).json();
    // the seed must not overwrite a real setting on boot, the same rule the
    // roster learned in E21-T1
    expect(back.payPeriod).toBe("semimonthly");
    // a DATE column comes back as a Date object; it must still be the day
    // that was typed, not yesterday in some other timezone
    expect(back.payPeriodAnchor).toBe("2026-03-02");

    const period = (await app7.inject({ method: "GET", url: "/v1/payroll/period?on=2026-02-20" })).json().period;
    expect(period).toEqual({ start: "2026-02-16", end: "2026-02-28" });

    // the export runs against real shift rows and refuses without a manager
    const bare = await app7.inject({ method: "POST", url: "/v1/staff/hours-export", payload: {} });
    expect(bare.statusCode).toBe(422);
    const csv = await app7.inject({ method: "POST", url: "/v1/staff/hours-export",
      payload: { managerPin: MGR, periodEnd: "2026-02-20" } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0])
      .toBe("employee_id,employee_name,title,period_start,period_end,regular_hours,declared_tips,shift_count");
    // no overtime COLUMN, which is the specification. The word appears once
    // more in the file, in the footer that says whose job overtime is.
    expect(csv.body.split("\n")[0]).not.toContain("overtime");
    expect(csv.body).toContain("wage, overtime, and tax rules are the payroll provider's");
  }, 60_000);
});
