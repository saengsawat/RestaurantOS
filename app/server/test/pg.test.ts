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
  }, 60_000);
});
