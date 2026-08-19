import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

const ENV = (n: number, extra: Record<string, unknown> = {}) => ({
  operationId: `op-${n}-${Math.random().toString(36).slice(2)}`,
  deviceId: "test-terminal",
  ...extra,
});

async function openCheck(app: ReturnType<typeof buildServer>) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/checks",
    payload: { ...ENV(0), tableName: "Table 14", covers: 2 },
  });
  expect(res.statusCode).toBe(200);
  return res.json().check as { id: string; version: number; totals: { dueMinor: number } };
}

describe("full service over HTTP", () => {
  it("open, order with modifiers, fire, pay exactly, close", async () => {
    const app = buildServer();
    const check = await openCheck(app);

    const add = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/items`,
      payload: {
        ...ENV(1),
        itemId: "ragu",
        quantity: 1,
        seatNo: 1,
        modifiers: [{ groupId: "pasta", modifierId: "gf" }],
      },
    });
    expect(add.statusCode).toBe(200);
    // 2400 base + 200 gluten-free penne
    expect(add.json().check.totals.subtotalMinor).toBe(2600);

    const send = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/send`,
      payload: ENV(2),
    });
    expect(send.statusCode).toBe(200);

    const due = send.json().check.totals.dueMinor as number;
    // 2600 + NYC tax 8.875% of 2600 = 2600 + 231 (230.75 rounds up)
    expect(due).toBe(2831);

    const pay = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(3), method: "card", amountMinor: due },
    });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().check.status).toBe("paid");
    expect(pay.json().check.totals.dueMinor).toBe(0);

    const close = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/close`,
      payload: ENV(4),
    });
    expect(close.statusCode).toBe(200);
    expect(close.json().check.status).toBe("closed");
  });
});

describe("the engine refuses what the domain refuses", () => {
  it("missing required modifier group returns 422 with the exact errors", async () => {
    const app = buildServer();
    const check = await openCheck(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "ragu", quantity: 1, seatNo: 1, modifiers: [] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().modifierErrors).toEqual([{ code: "too_few", groupId: "pasta", min: 1, got: 0 }]);
  });

  it("payment is blocked while lines are unsent (FR-26)", async () => {
    const app = buildServer();
    const check = await openCheck(app);
    await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "acqua", quantity: 1, seatNo: 1 },
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(2), method: "cash", amountMinor: 653 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toMatch(/unsent/);
  });

  it("close refuses while an offline card is pending upload", async () => {
    const app = buildServer();
    const check = await openCheck(app);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`, payload: { ...ENV(1), itemId: "acqua", quantity: 1, seatNo: 1 } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(2) });
    const state = await app.inject({ method: "GET", url: `/v1/checks/${check.id}` });
    const due = state.json().check.totals.dueMinor as number;
    await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(3), method: "card", amountMinor: due, offline: true },
    });
    const close = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/close`, payload: ENV(4) });
    expect(close.statusCode).toBe(422);
    expect(close.json().reason).toMatch(/pending upload/);
  });

  it("seat number beyond covers is refused", async () => {
    const app = buildServer();
    const check = await openCheck(app);
    const res = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "acqua", quantity: 1, seatNo: 5 },
    });
    expect(res.statusCode).toBe(422);
  });
});

describe("the sync protocol", () => {
  it("replaying an operationId returns the recorded result and executes nothing twice", async () => {
    const app = buildServer();
    const check = await openCheck(app);
    const payload = { operationId: "op-replay-fixed", deviceId: "t1", itemId: "acqua", quantity: 1, seatNo: 1 };
    const first = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`, payload });
    const second = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`, payload });
    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());
    const state = await app.inject({ method: "GET", url: `/v1/checks/${check.id}` });
    expect(state.json().check.lines).toHaveLength(1); // not two
  });

  it("a stale expectedVersion returns 409 with both versions", async () => {
    const app = buildServer();
    const check = await openCheck(app);
    await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "acqua", quantity: 1, seatNo: 1, expectedVersion: 0 },
    });
    const stale = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(2), itemId: "burrata", quantity: 1, seatNo: 1, expectedVersion: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ status: "CONFLICT", reason: "STALE_AGGREGATE_VERSION", expectedVersion: 0, currentVersion: 1 });
  });

  it("mutations without an envelope are 400", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "POST", url: "/v1/checks", payload: { tableName: "T1", covers: 2 } });
    expect(res.statusCode).toBe(400);
  });
});

describe("the kitchen (E8)", () => {
  it("send creates tickets; items bump; serve is gated then recallable; floor sees it all", async () => {
    const app = buildServer();
    const check = await openCheck(app);

    // floor now shows Table 14 occupied, and refuses a second check on it
    const floor1 = await app.inject({ method: "GET", url: "/v1/floor" });
    expect(floor1.json().tables.find((t: { name: string }) => t.name === "Table 14").check.checkNo).toBeDefined();
    const dup = await app.inject({ method: "POST", url: "/v1/checks", payload: { ...ENV(90), tableName: "Table 14", covers: 2 } });
    expect(dup.statusCode).toBe(422);

    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "ragu", quantity: 1, seatNo: 1, modifiers: [{ groupId: "pasta", modifierId: "spag" }] } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(2), itemId: "chianti", quantity: 2, seatNo: 2, modifiers: [{ groupId: "size", modifierId: "glass" }] } });
    const send = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(3) });
    expect(send.statusCode).toBe(200);
    expect(send.json().tickets).toHaveLength(2); // one per course: PRIMI + BEVERAGE

    const kds = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets;
    expect(kds).toHaveLength(2);
    const primi = kds.find((t: { course: string }) => t.course === "PRIMI");
    expect(primi.items[0].mods).toBe("Spaghetti");

    // serve refuses until every item on the table is done
    const early = await app.inject({ method: "POST", url: "/v1/kds/serve", payload: { ...ENV(4), tableName: "Table 14" } });
    expect(early.statusCode).toBe(422);
    expect(early.json().reason).toMatch(/plated/);

    for (const t of kds) {
      for (const i of t.items) {
        const r = await app.inject({ method: "POST", url: "/v1/kds/toggle",
          payload: { ...ENV(100 + Math.random()), ticketId: t.id, orderItemId: i.orderItemId } });
        expect(r.statusCode).toBe(200);
      }
    }
    const serve = await app.inject({ method: "POST", url: "/v1/kds/serve", payload: { ...ENV(5), tableName: "Table 14" } });
    expect(serve.statusCode).toBe(200);

    // served but recallable
    const after = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets;
    expect(after.every((t: { status: string }) => t.status === "served")).toBe(true);
    const recall = await app.inject({ method: "POST", url: "/v1/kds/recall", payload: { ...ENV(6), ticketId: primi.id } });
    expect(recall.statusCode).toBe(200);
    expect(recall.json().tickets[0].status).toBe("open");

    // a bump on a served ticket is refused (recall first)
    const bev = after.find((t: { course: string }) => t.course === "BEVERAGE");
    const badBump = await app.inject({ method: "POST", url: "/v1/kds/toggle",
      payload: { ...ENV(7), ticketId: bev.id, orderItemId: bev.items[0].orderItemId } });
    expect(badBump.statusCode).toBe(422);
  });
});

describe("reads", () => {
  it("serves the menu snapshot and the landing page", async () => {
    const app = buildServer();
    const menu = await app.inject({ method: "GET", url: "/v1/menu" });
    expect(menu.json().items.length).toBeGreaterThan(5);
    const landing = await app.inject({ method: "GET", url: "/" });
    expect(landing.statusCode).toBe(200);
    expect(landing.body).toContain("RestaurantOS");
  });

  it("serves the POS web client at /pos", async () => {
    const app = buildServer();
    const pos = await app.inject({ method: "GET", url: "/pos" });
    expect(pos.statusCode).toBe(200);
    expect(pos.headers["content-type"]).toContain("text/html");
    expect(pos.body).toContain("RestaurantOS POS");
    expect(pos.body).toContain("operationId");
  });

  it("serves the KDS and Tables pages and the floor", async () => {
    const app = buildServer();
    expect((await app.inject({ method: "GET", url: "/kds" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/tables" })).statusCode).toBe(200);
    const floor = await app.inject({ method: "GET", url: "/v1/floor" });
    expect(floor.json().tables.length).toBe(13);
    expect(floor.json().tables.find((t: { name: string }) => t.name === "Table 7").check).toBeNull();
  });
});
