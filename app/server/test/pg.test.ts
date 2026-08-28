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
});
