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

    // idempotent replay via the sync_operation table
    const opId = crypto.randomUUID();
    const p1 = await app.inject({ method: "POST", url: `/v1/checks/${id}/items`,
      payload: { operationId: opId, deviceId: "pg-test", itemId: "acqua", quantity: 1, seatNo: 1 } });
    const p2 = await app.inject({ method: "POST", url: `/v1/checks/${id}/items`,
      payload: { operationId: opId, deviceId: "pg-test", itemId: "acqua", quantity: 1, seatNo: 1 } });
    expect(p2.json()).toEqual(p1.json());

    // kitchen: bump everything, serve the table
    await app.inject({ method: "POST", url: `/v1/checks/${id}/send`, payload: ENV() });
    const kds = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets;
    for (const t of kds) for (const i of t.items) {
      await app.inject({ method: "POST", url: "/v1/kds/toggle", payload: ENV({ ticketId: t.id, orderItemId: i.orderItemId }) });
    }
    const serve = await app.inject({ method: "POST", url: "/v1/kds/serve", payload: ENV({ tableName: "Table 7" }) });
    expect(serve.statusCode).toBe(200);

    // pay in full, close
    const due = (await app.inject({ method: "GET", url: `/v1/checks/${id}` })).json().check.totals.dueMinor as number;
    await app.inject({ method: "POST", url: `/v1/checks/${id}/payments`, payload: ENV({ method: "card", amountMinor: due }) });
    const close = await app.inject({ method: "POST", url: `/v1/checks/${id}/close`, payload: ENV() });
    expect(close.statusCode).toBe(200);

    // relocate a table on the floor plan (E6 editor)
    const move = await app.inject({ method: "POST", url: "/v1/floor/move",
      payload: ENV({ tableName: "Table 2", x: 40, y: 56 }) });
    expect(move.statusCode).toBe(200);

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
    expect(check.tableName).toBe("Table 7");
    expect(check.lines).toHaveLength(2);
    expect(check.totals.dueMinor).toBe(0);
    expect(check.totals.paidMinor).toBe(due);
    const ragu = check.lines.find((l: { capturedName: string }) => l.capturedName === "Ragu alla Bolognese");
    expect(ragu.modifierPriceMinor).toBe(1000); // gf 200 + shrimp 800, survived as a tree
    expect(ragu.modifiers[1].children[0].modifierId).toBe("grill");

    const kds2 = (await app2.inject({ method: "GET", url: "/v1/kds" })).json().tickets;
    expect(kds2.every((t: { status: string }) => t.status === "served")).toBe(true);

    // Table 7 is free again on the floor after close
    const floor = (await app2.inject({ method: "GET", url: "/v1/floor" })).json().tables;
    expect(floor.find((t: { name: string }) => t.name === "Table 7").check).toBeNull();

    // and the layout edit survived the restart too
    const t2 = floor.find((t: { name: string }) => t.name === "Table 2");
    expect(t2.x).toBe(40);
    expect(t2.y).toBe(56);
  }, 60_000);
});
