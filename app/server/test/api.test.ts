import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { MemoryStore } from "../src/memoryStore.js";
import { lastCompletedPeriod, periodContaining, VENUE, type Shift, type Venue } from "../src/types.js";
import { parseCsv } from "../src/csv.js";
import { parseMajorPrice } from "../src/engine.js";
import { readFileSync } from "node:fs";

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

describe("voids and discounts (E12)", () => {
  it("voiding a sent line needs reason + approval, flags the kitchen, and fixes the money", async () => {
    const app = buildServer();
    const check = await openCheck(app);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "ragu", quantity: 1, seatNo: 1, modifiers: [{ groupId: "pasta", modifierId: "spag" }] } });
    const add2 = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(2), itemId: "acqua", quantity: 1, seatNo: 2 } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(3) });

    const lines = add2.json().check.lines as { id: string; capturedName: string }[];
    const ragu = lines.find((l) => l.capturedName === "Ragu alla Bolognese")!;

    // no reason -> refused; no PIN -> refused; the approval step is real
    const noReason = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items/${ragu.id}/void`,
      payload: { ...ENV(4), managerPin: "1122" } });
    expect(noReason.statusCode).toBe(422);
    const noPin = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items/${ragu.id}/void`,
      payload: { ...ENV(5), reason: "guest changed mind" } });
    expect(noPin.statusCode).toBe(422);
    expect(noPin.json().reason).toMatch(/manager/);

    const voided = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items/${ragu.id}/void`,
      payload: { ...ENV(6), reason: "guest changed mind", managerPin: "1122" } });
    expect(voided.statusCode).toBe(200);
    const vLine = voided.json().check.lines.find((l: { id: string }) => l.id === ragu.id);
    expect(vLine.status).toBe("voided");
    expect(vLine.voidReason).toBe("guest changed mind");
    // only the acqua remains on the money
    expect(voided.json().check.totals.subtotalMinor).toBe(600);

    // the kitchen was told: the ticket line is flagged voided
    const kds = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets;
    const flagged = kds.flatMap((t: { items: { orderItemId: string; voided?: boolean }[] }) => t.items)
      .find((i: { orderItemId: string }) => i.orderItemId === ragu.id);
    expect(flagged.voided).toBe(true);

    // and serve does not wait for a voided item: bump the rest, serve succeeds
    for (const t of kds) for (const i of t.items) {
      if (i.voided) continue;
      await app.inject({ method: "POST", url: "/v1/kds/toggle", payload: { ...ENV(700 + Math.random()), ticketId: t.id, orderItemId: i.orderItemId } });
    }
    const serve = await app.inject({ method: "POST", url: "/v1/kds/serve", payload: { ...ENV(8), tableName: "Table 14" } });
    expect(serve.statusCode).toBe(200);

    // a second void of the same line is refused
    const again = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items/${ragu.id}/void`,
      payload: { ...ENV(9), reason: "double tap", managerPin: "1122" } });
    expect(again.statusCode).toBe(422);
  });

  it("percent and amount discounts change the due; both need reason + approval; paid checks refuse", async () => {
    const app = buildServer();
    const check = await openCheck(app);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "ragu", quantity: 1, seatNo: 1, modifiers: [{ groupId: "pasta", modifierId: "spag" }] } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(2) });

    // 10% of 2400 = 240 off; taxable 2160; tax 8.875% = 191.7 -> 192
    const pct = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/adjustments`,
      payload: { ...ENV(3), percentBp: 1000, reason: "industry guest", managerPin: "1122" } });
    expect(pct.statusCode).toBe(200);
    expect(pct.json().check.totals.discountMinor).toBe(240);
    expect(pct.json().check.totals.dueMinor).toBe(2160 + 192);

    // both amount AND percent in one call is refused (schema XOR)
    const both = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/adjustments`,
      payload: { ...ENV(4), amountMinor: 100, percentBp: 500, reason: "confused", managerPin: "1122" } });
    expect(both.statusCode).toBe(422);

    // no PIN refused
    const noPin = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/adjustments`,
      payload: { ...ENV(5), amountMinor: 100, reason: "no approval" } });
    expect(noPin.statusCode).toBe(422);

    // amount comp stacks with the percent
    const amt = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/adjustments`,
      payload: { ...ENV(6), kind: "comp", amountMinor: 500, label: "Kitchen delay", reason: "long wait on primi", managerPin: "1122" } });
    expect(amt.statusCode).toBe(200);
    expect(amt.json().check.totals.discountMinor).toBe(740);

    // pay in full, then a further discount is refused
    const due = amt.json().check.totals.dueMinor as number;
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(7), method: "card", amountMinor: due } });
    const late = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/adjustments`,
      payload: { ...ENV(8), amountMinor: 100, reason: "too late", managerPin: "1122" } });
    expect(late.statusCode).toBe(422);
  });
});

describe("the floor layout editor (E6)", () => {
  const floorOf = async (app: ReturnType<typeof buildServer>) =>
    (await app.inject({ method: "GET", url: "/v1/floor" })).json().tables as
      { name: string; x: number; y: number; w: number; h: number }[];

  it("moves a table, clamps to the room, refuses unknown tables", async () => {
    const app = buildServer();
    const move = await app.inject({ method: "POST", url: "/v1/floor/move",
      payload: { ...ENV(1), tableName: "Table 9", x: 50, y: 33.34 } });
    expect(move.statusCode).toBe(200);
    let t9 = (await floorOf(app)).find((t) => t.name === "Table 9")!;
    expect(t9.x).toBe(50);
    expect(t9.y).toBe(33.3); // rounded to one decimal

    // a drag past the edge cannot strand the table off-canvas
    await app.inject({ method: "POST", url: "/v1/floor/move",
      payload: { ...ENV(2), tableName: "Table 9", x: 999, y: -40 } });
    t9 = (await floorOf(app)).find((t) => t.name === "Table 9")!;
    expect(t9.x).toBe(100 - t9.w);
    expect(t9.y).toBe(0);

    const bad = await app.inject({ method: "POST", url: "/v1/floor/move",
      payload: { ...ENV(3), tableName: "Table 99", x: 10, y: 10 } });
    expect(bad.statusCode).toBe(422);
  });

  it("a layout edit never leaks into a different store", async () => {
    const a = buildServer();
    await a.inject({ method: "POST", url: "/v1/floor/move",
      payload: { ...ENV(1), tableName: "Table 2", x: 60, y: 60 } });
    const b = buildServer();
    const t2 = (await floorOf(b)).find((t) => t.name === "Table 2")!;
    expect(t2.x).toBe(5); // seed position, untouched
  });
});

/* --------------------------- the floor EDITOR (E6-T2) ---------------------------
 * Moving a table was always allowed. Drawing the room is new, and every
 * structural command is a manager act with history hanging off it. */

describe("drawing the room (E6-T2)", () => {
  const MGR = "1122"; // Marco B.
  const SRV = "2468"; // Gia R., a server: never enough to reshape the room

  const tables = async (app: ReturnType<typeof buildServer>) =>
    (await app.inject({ method: "GET", url: "/v1/floor" })).json().tables as
      { name: string; area: string; seats: number; shape: string; x: number; y: number; w: number; h: number }[];
  const named = async (app: ReturnType<typeof buildServer>, name: string) =>
    (await tables(app)).find((t) => t.name === name);

  const add = (app: ReturnType<typeof buildServer>, n: number, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/floor/add",
      payload: { ...ENV(n), managerPin: MGR, area: "Dehors", seats: 4, shape: "rect", x: 10, y: 10, w: 14, h: 20, ...body } });

  /** Take an open check all the way out: ordered, fired, paid, closed, and the
   *  kitchen card bumped and served, so nothing is left holding the name.
   *  A check cannot close from 'open', which is exactly why retiring a table
   *  takes real work rather than a keystroke. */
  async function runOut(app: ReturnType<typeof buildServer>, id: string, tableName: string) {
    await app.inject({ method: "POST", url: `/v1/checks/${id}/items`,
      payload: { ...ENV(0), itemId: "acqua", quantity: 1, seatNo: 1 } });
    await app.inject({ method: "POST", url: `/v1/checks/${id}/send`, payload: ENV(0) });
    const due = (await app.inject({ method: "GET", url: `/v1/checks/${id}` })).json().check.totals.dueMinor as number;
    await app.inject({ method: "POST", url: `/v1/checks/${id}/payments`,
      payload: { ...ENV(0), method: "card", amountMinor: due } });
    const closed = await app.inject({ method: "POST", url: `/v1/checks/${id}/close`, payload: ENV(0) });
    expect(closed.statusCode).toBe(200);
    for (const t of (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets) {
      for (const i of t.items) {
        await app.inject({ method: "POST", url: "/v1/kds/toggle",
          payload: { ...ENV(0), ticketId: t.id, orderItemId: i.orderItemId } });
      }
    }
    await app.inject({ method: "POST", url: "/v1/kds/serve", payload: { ...ENV(0), tableName } });
  }

  it("adds a table into a brand-new area, and replays the operation once", async () => {
    const app = buildServer();
    const before = await tables(app);

    const res = await add(app, 1, { name: "Dehors 1", shape: "booth", seats: 6 });
    expect(res.statusCode).toBe(200);

    const after = await tables(app);
    expect(after).toHaveLength(before.length + 1);
    const t = after.find((x) => x.name === "Dehors 1")!;
    expect(t).toMatchObject({ area: "Dehors", seats: 6, shape: "booth", x: 10, y: 10, w: 14, h: 20 });

    // a new area lands at the END of the room, so the areas a restaurant
    // already had keep the order the staff know them in
    const areas = [...new Set(after.map((x) => x.area))];
    expect(areas[areas.length - 1]).toBe("Dehors");
    expect(areas.slice(0, -1)).toEqual([...new Set(before.map((x) => x.area))]);

    // the retry of a dropped response adds nothing: same operationId, one table
    const dup = { operationId: "dup-add-0001", deviceId: "test-terminal", managerPin: MGR,
      name: "Dehors 2", area: "Dehors", seats: 2, shape: "round", x: 40, y: 10, w: 10, h: 16 };
    const first = await app.inject({ method: "POST", url: "/v1/floor/add", payload: dup });
    const retry = await app.inject({ method: "POST", url: "/v1/floor/add", payload: dup });
    expect(first.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect((await tables(app)).filter((x) => x.name === "Dehors 2")).toHaveLength(1);
  });

  it("refuses a structural edit without a manager PIN, and a server's PIN is not one", async () => {
    const app = buildServer();
    const bare = await app.inject({ method: "POST", url: "/v1/floor/add",
      payload: { ...ENV(1), name: "Dehors 1", area: "Dehors", seats: 4, shape: "rect", x: 10, y: 10, w: 14, h: 20 } });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().reason).toBe("adding a table requires a manager's PIN");

    const server = await add(app, 2, { name: "Dehors 1", managerPin: SRV });
    expect(server.statusCode).toBe(422);
    expect(server.json().reason).toBe("PIN not recognized as a manager");

    for (const [url, payload, what] of [
      ["/v1/floor/update", { tableName: "Table 9", seats: 8 }, "editing a table"],
      ["/v1/floor/resize", { tableName: "Table 9", w: 20, h: 20 }, "resizing a table"],
      ["/v1/floor/retire", { tableName: "Table 9" }, "retiring a table"],
    ] as const) {
      const res = await app.inject({ method: "POST", url, payload: { ...ENV(3), ...payload } });
      expect(res.statusCode).toBe(422);
      expect(res.json().reason).toBe(`${what} requires a manager's PIN`);
    }
    // and nothing on the seeded floor moved
    expect(await named(app, "Table 9")).toMatchObject({ seats: 2, w: 12, h: 22 });
  });

  it("refuses a name the room already answers to, whatever the casing", async () => {
    const app = buildServer();
    const dup = await add(app, 1, { name: "table 9" });
    expect(dup.statusCode).toBe(422);
    expect(dup.json().reason).toBe("table 9 is already a table on the floor");
    expect((await tables(app)).filter((t) => t.area === "Dehors")).toHaveLength(0);
  });

  it("refuses nonsense: blank name, blank area, bad seats, unknown shape, impossible size", async () => {
    const app = buildServer();
    const cases: [Record<string, unknown>, string][] = [
      [{ name: "   " }, "a table needs a name"],
      [{ name: "Dehors 1", area: "  " }, "a table needs an area"],
      [{ name: "Dehors 1", seats: 0 }, "seats must be a positive integer"],
      [{ name: "Dehors 1", seats: 2.5 }, "seats must be a positive integer"],
      [{ name: "Dehors 1", shape: "hexagon" }, "unknown shape hexagon; expected one of rect, round, stool, booth"],
      [{ name: "Dehors 1", w: 2 }, "w and h must be between 3 and 40 (percent of the room)"],
      [{ name: "Dehors 1", h: 41 }, "w and h must be between 3 and 40 (percent of the room)"],
    ];
    let n = 1;
    for (const [patch, reason] of cases) {
      const res = await add(app, n++, patch);
      expect(res.statusCode, reason).toBe(422);
      expect(res.json().reason).toBe(reason);
    }
    expect((await tables(app)).filter((t) => t.area === "Dehors")).toHaveLength(0);
  });

  it("renames only when the table is quiet, and a closed check keeps the old name", async () => {
    const app = buildServer();
    const check = await openCheck(app); // Table 14
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "acqua", quantity: 1, seatNo: 1 } });

    const live = await app.inject({ method: "POST", url: "/v1/floor/update",
      payload: { ...ENV(2), managerPin: MGR, tableName: "Table 14", newName: "Table 14A" } });
    expect(live.statusCode).toBe(422);
    expect(live.json().reason).toContain("cannot rename while Table 14 has an open check");

    // seats and shape are ordinary corrections and stay allowed mid-service
    const reseat = await app.inject({ method: "POST", url: "/v1/floor/update",
      payload: { ...ENV(3), managerPin: MGR, tableName: "Table 14", seats: 6, shape: "booth" } });
    expect(reseat.statusCode).toBe(200);
    expect(await named(app, "Table 14")).toMatchObject({ seats: 6, shape: "booth" });

    // fire it, and the kitchen card blocks the rename on its own
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(4) });
    const due = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check.totals.dueMinor;
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(5), method: "card", amountMinor: due } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/close`, payload: ENV(6) });

    const cooking = await app.inject({ method: "POST", url: "/v1/floor/update",
      payload: { ...ENV(7), managerPin: MGR, tableName: "Table 14", newName: "Table 14A" } });
    expect(cooking.statusCode).toBe(422);
    expect(cooking.json().reason).toContain("still has an open kitchen ticket");

    const kds = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets;
    for (const t of kds) for (const i of t.items) {
      await app.inject({ method: "POST", url: "/v1/kds/toggle", payload: { ...ENV(8), ticketId: t.id, orderItemId: i.orderItemId } });
    }
    await app.inject({ method: "POST", url: "/v1/kds/serve", payload: { ...ENV(9), tableName: "Table 14" } });

    const ok = await app.inject({ method: "POST", url: "/v1/floor/update",
      payload: { ...ENV(10), managerPin: MGR, tableName: "Table 14", newName: "Table 14A" } });
    expect(ok.statusCode).toBe(200);
    expect(await named(app, "Table 14")).toBeUndefined();
    expect(await named(app, "Table 14A")).toMatchObject({ seats: 6, shape: "booth" });

    // the closed check was served at Table 14 and says so forever
    const closed = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check;
    expect(closed.status).toBe("closed");
    expect(closed.tableName).toBe("Table 14");
  });

  it("refuses a rename onto a taken name, allows a case-only self-rename, refuses an empty patch", async () => {
    const app = buildServer();
    const taken = await app.inject({ method: "POST", url: "/v1/floor/update",
      payload: { ...ENV(1), managerPin: MGR, tableName: "Table 9", newName: "table 12" } });
    expect(taken.statusCode).toBe(422);
    expect(taken.json().reason).toBe("table 12 is already a table on the floor");

    const self = await app.inject({ method: "POST", url: "/v1/floor/update",
      payload: { ...ENV(2), managerPin: MGR, tableName: "Table 9", newName: "TABLE 9" } });
    expect(self.statusCode).toBe(200);
    expect(await named(app, "TABLE 9")).toBeDefined();

    const empty = await app.inject({ method: "POST", url: "/v1/floor/update",
      payload: { ...ENV(3), managerPin: MGR, tableName: "TABLE 9" } });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().reason).toBe("nothing to change: send a newName, seats, or shape");

    const gone = await app.inject({ method: "POST", url: "/v1/floor/update",
      payload: { ...ENV(4), managerPin: MGR, tableName: "Table 404", seats: 2 } });
    expect(gone.statusCode).toBe(422);
    expect(gone.json().reason).toBe("unknown table Table 404");
  });

  it("resizes in place and pulls the table back inside the room", async () => {
    const app = buildServer();
    // park Table 9 hard against the right and bottom edges
    await app.inject({ method: "POST", url: "/v1/floor/move",
      payload: { ...ENV(1), tableName: "Table 9", x: 999, y: 999 } });
    const before = (await named(app, "Table 9"))!;
    expect(before.x).toBe(100 - before.w);
    expect(before.y).toBe(100 - before.h);

    const grow = await app.inject({ method: "POST", url: "/v1/floor/resize",
      payload: { ...ENV(2), managerPin: MGR, tableName: "Table 9", w: 30, h: 35 } });
    expect(grow.statusCode).toBe(200);
    const after = (await named(app, "Table 9"))!;
    expect(after).toMatchObject({ w: 30, h: 35, x: 70, y: 65 });
    expect(after.seats).toBe(before.seats); // a resize is not a re-seat

    const tooBig = await app.inject({ method: "POST", url: "/v1/floor/resize",
      payload: { ...ENV(3), managerPin: MGR, tableName: "Table 9", w: 60, h: 10 } });
    expect(tooBig.statusCode).toBe(422);
    expect(tooBig.json().reason).toBe("w and h must be between 3 and 40 (percent of the room)");
  });

  it("retires a table only when nobody is at it, and then the floor has never heard of it", async () => {
    const app = buildServer();
    const check = await openCheck(app); // Table 14
    const busy = await app.inject({ method: "POST", url: "/v1/floor/retire",
      payload: { ...ENV(1), managerPin: MGR, tableName: "Table 14" } });
    expect(busy.statusCode).toBe(422);
    expect(busy.json().reason).toContain("cannot retire while Table 14 has an open check");

    await runOut(app, check.id, "Table 14");

    const gone = await app.inject({ method: "POST", url: "/v1/floor/retire",
      payload: { ...ENV(3), managerPin: MGR, tableName: "Table 14" } });
    expect(gone.statusCode).toBe(200);
    expect(await named(app, "Table 14")).toBeUndefined();

    // a retired table is not room: you cannot move it and cannot retire it twice
    const move = await app.inject({ method: "POST", url: "/v1/floor/move",
      payload: { ...ENV(4), tableName: "Table 14", x: 10, y: 10 } });
    expect(move.statusCode).toBe(422);
    expect(move.json().reason).toBe("unknown table Table 14");
    const twice = await app.inject({ method: "POST", url: "/v1/floor/retire",
      payload: { ...ENV(5), managerPin: MGR, tableName: "Table 14" } });
    expect(twice.statusCode).toBe(422);
    expect(twice.json().reason).toBe("unknown table Table 14");
  });

  it("re-adding a retired name brings the same table back, history and all", async () => {
    const app = buildServer();
    const check = await openCheck(app); // Table 14
    await runOut(app, check.id, "Table 14");
    const retired = await app.inject({ method: "POST", url: "/v1/floor/retire",
      payload: { ...ENV(2), managerPin: MGR, tableName: "Table 14" } });
    expect(retired.statusCode).toBe(200);

    // back for the summer, in a different corner and a different shape
    const back = await add(app, 3, { name: "table 14", area: "Sala", seats: 8, shape: "booth", x: 30, y: 70, w: 20, h: 24 });
    expect(back.statusCode).toBe(200);
    const t = (await tables(app)).filter((x) => x.name.toLowerCase() === "table 14");
    expect(t).toHaveLength(1); // revived, not forked
    expect(t[0]).toMatchObject({ name: "table 14", area: "Sala", seats: 8, shape: "booth", x: 30, y: 70 });

    // the check that sat there still sat there
    const old = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check;
    expect(old.tableName).toBe("Table 14");
  });

  it("clamps a new table inside the room instead of stranding it off-canvas", async () => {
    const app = buildServer();
    const res = await add(app, 1, { name: "Dehors 1", x: 300, y: -50, w: 12, h: 18 });
    expect(res.statusCode).toBe(200);
    expect(await named(app, "Dehors 1")).toMatchObject({ x: 88, y: 0, w: 12, h: 18 });
  });
});

/* --------------------- the venue and the roster (E21-T1) ---------------------
 * "Osteria Nove", its address, its timezone, and three PINs were source code,
 * which is a fine way to demo one restaurant and no way to run a second. */

describe("the venue is data now (E21-T1)", () => {
  const MGR = "1122";
  // E25-T1, D33: the venue's IDENTITY is the owner's. Elena V. is the padrona.
  const OWNER = "1379";

  it("reads without a session, and the owner can rename, move, and re-zone it", async () => {
    const app = buildServer();
    const seeded = (await app.inject({ method: "GET", url: "/v1/venue" })).json();
    expect(seeded).toEqual({
      name: "Osteria Nove",
      address: "9 Vicolo della Luna, New York",
      timezone: "America/New_York",
      // E24-T3 added WHEN the venue pays. Never what it pays: there is no
      // wage field here and rung 3 is the reason there is not going to be one
      payPeriod: "biweekly",
      payPeriodAnchor: "2026-01-05",
      // and E23-T2 added the two soft reservation windows: one decides when a
      // badge appears, the other when the book nudges. Neither refuses anything.
      reservationLeadMinutes: 45,
      reservationHoldMinutes: 15,
    });

    const res = await app.inject({ method: "POST", url: "/v1/venue",
      payload: { ...ENV(1), managerPin: OWNER, name: "Trattoria Sedici", address: "16 Elm St, Austin", timezone: "America/Chicago" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().venue).toEqual({ name: "Trattoria Sedici", address: "16 Elm St, Austin", timezone: "America/Chicago", payPeriod: "biweekly", payPeriodAnchor: "2026-01-05", reservationLeadMinutes: 45, reservationHoldMinutes: 15 });
    expect((await app.inject({ method: "GET", url: "/v1/venue" })).json().name).toBe("Trattoria Sedici");

    // an omitted field is left alone; a blank address is a real edit, because
    // a kitchen with no street frontage is a real thing
    const partial = await app.inject({ method: "POST", url: "/v1/venue",
      payload: { ...ENV(2), managerPin: OWNER, address: "" } });
    expect(partial.json().venue).toEqual({ name: "Trattoria Sedici", address: "", timezone: "America/Chicago", payPeriod: "biweekly", payPeriodAnchor: "2026-01-05", reservationLeadMinutes: 45, reservationHoldMinutes: 15 });

    // and the two reservation windows are NOT identity: they are how the book
    // behaves tonight, so they stay a manager's to tune (E25-T1, D33)
    const windows = await app.inject({ method: "POST", url: "/v1/venue",
      payload: { ...ENV(3), managerPin: MGR, reservationLeadMinutes: 30 } });
    expect(windows.statusCode).toBe(200);
    expect(windows.json().venue.reservationLeadMinutes).toBe(30);
  });

  it("refuses the edit without a manager, and refuses a name or a timezone it cannot honor", async () => {
    const app = buildServer();
    const bare = await app.inject({ method: "POST", url: "/v1/venue", payload: { ...ENV(1), name: "Nope" } });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().reason).toBe("editing the venue requires a manager's PIN");

    const asServer = await app.inject({ method: "POST", url: "/v1/venue",
      payload: { ...ENV(2), managerPin: "2468", name: "Nope" } });
    expect(asServer.json().reason).toBe("PIN not recognized as a manager");

    // a manager's PIN clears the manager gate and then meets the owner's
    // (E25-T1, D33): the name on the door is not a manager's to change
    const asManager = await app.inject({ method: "POST", url: "/v1/venue",
      payload: { ...ENV(5), managerPin: MGR, name: "Nope" } });
    expect(asManager.statusCode).toBe(422);
    expect(asManager.json().reason).toBe("changing the venue's identity is the owner's to do; this PIN is not an owner's");

    const blank = await app.inject({ method: "POST", url: "/v1/venue",
      payload: { ...ENV(3), managerPin: OWNER, name: "   " } });
    expect(blank.statusCode).toBe(422);
    expect(blank.json().reason).toBe("a restaurant needs a name");

    const zone = await app.inject({ method: "POST", url: "/v1/venue",
      payload: { ...ENV(4), managerPin: OWNER, timezone: "America/Atlantis" } });
    expect(zone.statusCode).toBe(422);
    expect(zone.json().reason).toBe("America/Atlantis is not a timezone this machine knows");

    // nothing stuck
    expect((await app.inject({ method: "GET", url: "/v1/venue" })).json().name).toBe("Osteria Nove");
  });

  it("replays a venue edit exactly once", async () => {
    const app = buildServer();
    const payload = { operationId: "venue-op-0001", deviceId: "test-terminal", managerPin: OWNER, name: "Trattoria Sedici" };
    const first = await app.inject({ method: "POST", url: "/v1/venue", payload });
    const retry = await app.inject({ method: "POST", url: "/v1/venue", payload });
    expect(first.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
  });
});

describe("hiring, PINs, and letting somebody go (E21-T1)", () => {
  const MGR = "1122";
  const roster = async (app: ReturnType<typeof buildServer>) =>
    (await app.inject({ method: "GET", url: "/v1/staff" })).json().staff as
      { id: string; name: string; role: string; active: boolean }[];

  const hire = (app: ReturnType<typeof buildServer>, n: number, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/staff",
      payload: { ...ENV(n), managerPin: MGR, name: "Luca P.", role: "server", pin: "4321", ...body } });

  it("serves the roster without a single PIN or hash on it", async () => {
    const app = buildServer();
    const staff = await roster(app);
    // five since E25-T1: D33's four permission levels each have somebody, and
    // Nico's title says Chef while his level says kitchen (D28's two fields)
    expect(staff.map((s) => s.name)).toEqual(["Gia R.", "Marco B.", "Sofia T.", "Elena V.", "Nico F."]);
    expect(staff.map((s) => s.role)).toEqual(["server", "manager", "server", "owner", "kitchen"]);
    expect(staff.find((s) => s.name === "Nico F.")).toMatchObject({ role: "kitchen", title: "Chef" });
    expect(staff.every((s) => s.active)).toBe(true);
    // E24-T2 added exactly one public field, the job title. The personal half
    // of the record has its own gated read and must never appear here.
    for (const s of staff) expect(Object.keys(s).sort()).toEqual(["active", "id", "name", "role", "title"]);
    expect(JSON.stringify(staff)).not.toContain("2468");

    // the demo PINs the lock screen prints on purpose live on their own route
    const demo = (await app.inject({ method: "GET", url: "/v1/staff/demo-pins" })).json().staff;
    expect(demo.find((s: { name: string }) => s.name === "Gia R.").demoPin).toBe("2468");
  });

  it("hires a server who can then sign in and open a check in their own name", async () => {
    const app = buildServer();
    const res = await hire(app, 1, {});
    expect(res.statusCode).toBe(200);
    const luca = res.json().employee;
    expect(luca).toMatchObject({ name: "Luca P.", role: "server", active: true });
    expect(JSON.stringify(res.json())).not.toContain("4321"); // the PIN never comes back

    const session = await app.inject({ method: "POST", url: "/v1/session",
      payload: { deviceId: "term-luca", pin: "4321" } });
    expect(session.statusCode).toBe(200);
    expect(session.json().employee.id).toBe(luca.id);

    const check = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { operationId: "luca-opens-0001", deviceId: "term-luca", tableName: "Table 5", covers: 2 } });
    expect(check.json().check.serverName).toBe("Luca P.");
    expect(check.json().check.serverId).toBe(luca.id);
  });

  it("refuses a hire without a manager, without a name, without a role, or with a PIN somebody already has", async () => {
    const app = buildServer();
    const bare = await app.inject({ method: "POST", url: "/v1/staff",
      payload: { ...ENV(1), name: "Luca P.", role: "server", pin: "4321" } });
    expect(bare.json().reason).toBe("adding an employee requires a manager's PIN");

    for (const [patch, reason] of [
      [{ name: "  " }, "an employee needs a name"],
      // "chef" is a TITLE, never a permission level, which is the D28 rule the
      // wider E25-T1 enum did not soften
      [{ role: "chef" }, "role must be one of owner, manager, kitchen, server"],
      [{ pin: "12" }, "a PIN is 4 to 6 digits"],
      [{ pin: "1234567" }, "a PIN is 4 to 6 digits"],
      [{ pin: "12a4" }, "a PIN is 4 to 6 digits"],
      [{ pin: "2468" }, "that PIN already belongs to Gia R."],
    ] as [Record<string, unknown>, string][]) {
      const res = await hire(app, 2, patch);
      expect(res.statusCode, reason).toBe(422);
      expect(res.json().reason).toBe(reason);
    }
    expect(await roster(app)).toHaveLength(5);
  });

  it("resets a PIN: the old one stops working the moment the new one starts", async () => {
    const app = buildServer();
    const luca = (await hire(app, 1, {})).json().employee;

    const reset = await app.inject({ method: "POST", url: `/v1/staff/${luca.id}/pin`,
      payload: { ...ENV(2), managerPin: MGR, pin: "998877" } });
    expect(reset.statusCode).toBe(200);

    const old = await app.inject({ method: "POST", url: "/v1/session", payload: { deviceId: "d1", pin: "4321" } });
    expect(old.statusCode).toBe(401);
    const now = await app.inject({ method: "POST", url: "/v1/session", payload: { deviceId: "d1", pin: "998877" } });
    expect(now.json().employee.name).toBe("Luca P.");

    // somebody else's PIN is still somebody else's
    const clash = await app.inject({ method: "POST", url: `/v1/staff/${luca.id}/pin`,
      payload: { ...ENV(3), managerPin: MGR, pin: "1122" } });
    expect(clash.json().reason).toBe("that PIN already belongs to Marco B.");
    // but re-setting a PIN to the one you already have is not a clash with yourself
    const same = await app.inject({ method: "POST", url: `/v1/staff/${luca.id}/pin`,
      payload: { ...ENV(4), managerPin: MGR, pin: "998877" } });
    expect(same.statusCode).toBe(200);

    const nobody = await app.inject({ method: "POST", url: "/v1/staff/not-a-real-id/pin",
      payload: { ...ENV(5), managerPin: MGR, pin: "5555" } });
    expect(nobody.json().reason).toBe("no employee not-a-real-id");
  });

  it("deactivates a server: their PIN opens nothing, their history is untouched", async () => {
    const app = buildServer();
    // Gia opens and closes a check, so there is history to protect
    await app.inject({ method: "POST", url: "/v1/session", payload: { deviceId: "term-gia", pin: "2468" } });
    const open = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { operationId: "gia-opens-0001", deviceId: "term-gia", tableName: "Table 3", covers: 2 } });
    const checkId = open.json().check.id;
    expect(open.json().check.serverName).toBe("Gia R.");

    const gia = (await roster(app)).find((s) => s.name === "Gia R.")!;
    const out = await app.inject({ method: "POST", url: `/v1/staff/${gia.id}/deactivate`,
      payload: { ...ENV(1), managerPin: MGR } });
    expect(out.statusCode).toBe(200);
    expect(out.json().employee.active).toBe(false);
    expect((await roster(app)).find((s) => s.name === "Gia R.")!.active).toBe(false);

    // the PIN is dead for sign-in, and the terminal she was on is signed out
    expect((await app.inject({ method: "POST", url: "/v1/session", payload: { deviceId: "d2", pin: "2468" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/session?deviceId=term-gia" })).json().employee).toBeNull();

    // the check she opened still says she opened it
    expect((await app.inject({ method: "GET", url: `/v1/checks/${checkId}` })).json().check.serverName).toBe("Gia R.");

    const twice = await app.inject({ method: "POST", url: `/v1/staff/${gia.id}/deactivate`,
      payload: { ...ENV(2), managerPin: MGR } });
    expect(twice.json().reason).toBe("Gia R. is already deactivated");
  });

  it("a deactivated manager cannot approve, letting an approver go is the owner's, and the last approver stays", async () => {
    const app = buildServer();
    const OWNER = "1379";
    // a second manager. Hiring one is still a manager's act (unchanged by D33)
    const nina = (await hire(app, 1, { name: "Nina V.", role: "manager", pin: "7788" })).json().employee;

    // but letting one go is not: a manager who could deactivate the other
    // manager is a manager who could make themselves the only one (E25-T1)
    const byManager = await app.inject({ method: "POST", url: `/v1/staff/${nina.id}/deactivate`,
      payload: { ...ENV(2), managerPin: MGR } });
    expect(byManager.statusCode).toBe(422);
    expect(byManager.json().reason).toBe("letting Nina V. go is the owner's to do; this PIN is not an owner's");

    const out = await app.inject({ method: "POST", url: `/v1/staff/${nina.id}/deactivate`,
      payload: { ...ENV(3), managerPin: OWNER } });
    expect(out.statusCode).toBe(200);

    // her PIN no longer approves anything
    const check = await openCheck(app);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(4), itemId: "acqua", quantity: 1, seatNo: 1 } });
    const state = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check;
    const refused = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items/${state.lines[0].id}/void`,
      payload: { ...ENV(5), reason: "guest changed mind", managerPin: "7788" } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().reason).toBe("PIN not recognized as a manager");

    // Marco can go, because Elena can still approve: the guard counts owners
    // AND managers now, not managers alone (E25-T1 widening E21-T1)
    const marco = (await roster(app)).find((s) => s.name === "Marco B.")!;
    expect((await app.inject({ method: "POST", url: `/v1/staff/${marco.id}/deactivate`,
      payload: { ...ENV(6), managerPin: OWNER } })).statusCode).toBe(200);

    // and now Elena is the only person left who can say yes to a void at two
    // in the morning, so not even her own PIN can walk her out
    const elena = (await roster(app)).find((s) => s.name === "Elena V.")!;
    const last = await app.inject({ method: "POST", url: `/v1/staff/${elena.id}/deactivate`,
      payload: { ...ENV(7), managerPin: OWNER } });
    expect(last.statusCode).toBe(422);
    expect(last.json().reason).toBe("Elena V. is the only active manager or owner; promote someone else first");
    expect((await roster(app)).find((s) => s.name === "Elena V.")!.active).toBe(true);
  });

  it("the unsigned-device opener falls to the roster, never to nobody", async () => {
    const app = buildServer();
    // nobody signs in anywhere: the check lands on the first active server
    const first = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { operationId: "anon-opens-0001", deviceId: "term-anon", tableName: "Table 3", covers: 2 } });
    expect(first.json().check.serverName).toBe("Gia R.");

    const gia = (await roster(app)).find((s) => s.name === "Gia R.")!;
    await app.inject({ method: "POST", url: `/v1/staff/${gia.id}/deactivate`, payload: { ...ENV(1), managerPin: MGR } });
    const second = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { operationId: "anon-opens-0002", deviceId: "term-anon", tableName: "Table 5", covers: 2 } });
    expect(second.json().check.serverName).toBe("Sofia T."); // the next active SERVER

    const sofia = (await roster(app)).find((s) => s.name === "Sofia T.")!;
    await app.inject({ method: "POST", url: `/v1/staff/${sofia.id}/deactivate`, payload: { ...ENV(2), managerPin: MGR } });
    const third = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { operationId: "anon-opens-0003", deviceId: "term-anon", tableName: "Table 7", covers: 2 } });
    expect(third.json().check.serverName).toBe("Marco B."); // no servers left: any active employee
    expect(third.json().check.serverId).toBeTruthy();
  });
});

/* --------------------- the people directory (E24-T2) ---------------------
   Rung 1 of the D28 ladder. Two rules under test more than any feature: a
   job TITLE is not a permission LEVEL, and the personal half of a record
   leaves the server through exactly one PIN-checked door. */
describe("the people directory (E24-T2)", () => {
  const MGR = "1122";
  const SERVER = "2468"; // Gia R., a server: the wrong PIN for this read
  const PERSONAL = { phone: "917-555-0143", email: "nok@example.com",
    emergencyContact: "Preeda (sister) 917-555-0198", notes: "Certified food handler, Tuesdays off" };

  const roster = async (app: ReturnType<typeof buildServer>) =>
    (await app.inject({ method: "GET", url: "/v1/staff" })).json().staff as
      { id: string; name: string; role: string; active: boolean; title?: string }[];

  const directory = (app: ReturnType<typeof buildServer>, pin?: string) =>
    app.inject({ method: "POST", url: "/v1/staff/directory",
      payload: pin === undefined ? {} : { managerPin: pin } });

  /** the demo hire this whole rung exists for: a line cook who will never
   *  sign in, whose title says what the room calls him */
  const hireCook = (app: ReturnType<typeof buildServer>, n: number, extra: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: "/v1/staff",
      payload: { ...ENV(n), managerPin: MGR, name: "Nok S.", role: "server", pin: "4455",
        title: "Line cook", ...PERSONAL, ...extra } });

  it("hires with details, and the title never moves the permission role", async () => {
    const app = buildServer();
    const res = await hireCook(app, 1);
    expect(res.statusCode).toBe(200);

    // the title is what the room calls him; the ROLE is what he may do
    expect(res.json().employee).toMatchObject({ name: "Nok S.", role: "server", title: "Line cook", active: true });

    // the hire's own response is the public shape: it does not read the home
    // number back over the wire just because a manager typed it
    for (const secret of Object.values(PERSONAL)) expect(JSON.stringify(res.json())).not.toContain(secret);

    // and the role still means exactly what it meant: a cook's PIN approves nothing
    const check = await openCheck(app);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(2), itemId: "acqua", quantity: 1, seatNo: 1 } });
    const state = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check;
    const refused = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items/${state.lines[0].id}/void`,
      payload: { ...ENV(3), reason: "sent back", managerPin: "4455" } });
    expect(refused.json().reason).toBe("PIN not recognized as a manager");
  });

  it("keeps every personal field off the public roster, however it got there", async () => {
    const app = buildServer();
    await hireCook(app, 1);
    const staff = await roster(app);

    const nok = staff.find((s) => s.name === "Nok S.")!;
    expect(nok.title).toBe("Line cook"); // the title IS public: it is a job, not a secret
    for (const s of staff) expect(Object.keys(s).sort()).toEqual(["active", "id", "name", "role", "title"]);
    // the whole payload, not just the one row, so a leak anywhere fails here
    for (const secret of Object.values(PERSONAL)) expect(JSON.stringify(staff)).not.toContain(secret);

    // a title nobody typed is the role's own display name, never a blank
    expect(staff.find((s) => s.name === "Gia R.")!.title).toBe("Server");
    expect(staff.find((s) => s.name === "Marco B.")!.title).toBe("Manager");
  });

  it("serves the directory to a manager, and to nobody else", async () => {
    const app = buildServer();
    await hireCook(app, 1);

    const bare = await directory(app);
    expect(bare.statusCode).toBe(422);
    expect(bare.json().reason).toBe("reading the staff directory requires a manager's PIN");
    expect(JSON.stringify(bare.json())).not.toContain(PERSONAL.phone);

    const asServer = await directory(app, SERVER);
    expect(asServer.statusCode).toBe(422);
    expect(asServer.json().reason).toBe("PIN not recognized as a manager");
    expect(JSON.stringify(asServer.json())).not.toContain(PERSONAL.phone);

    const wrong = await directory(app, "0000");
    expect(wrong.statusCode).toBe(422);

    const ok = await directory(app, MGR);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().staff.find((s: { name: string }) => s.name === "Nok S."))
      .toMatchObject({ role: "server", title: "Line cook", ...PERSONAL });
    // still never a hash, on the read that shows everything else
    expect(JSON.stringify(ok.json())).not.toContain("4455");

    // the gate is per CALL, not per session: the PIN must come again
    const again = await directory(app);
    expect(again.statusCode).toBe(422);
  });

  it("edits a record in place, leaving role, PIN, and active alone", async () => {
    const app = buildServer();
    const nok = (await hireCook(app, 1)).json().employee;

    const edit = await app.inject({ method: "POST", url: `/v1/staff/${nok.id}`,
      payload: { ...ENV(2), managerPin: MGR, title: "Sous chef", phone: "917-555-0111", notes: "" } });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().employee).toMatchObject({ name: "Nok S.", role: "server", title: "Sous chef", active: true });

    const entry = (await directory(app, MGR)).json().staff.find((s: { id: string }) => s.id === nok.id);
    expect(entry.title).toBe("Sous chef");
    expect(entry.phone).toBe("917-555-0111");
    expect(entry.notes).toBeUndefined();                       // an emptied field clears
    expect(entry.email).toBe(PERSONAL.email);                  // an untouched one survives
    expect(entry.emergencyContact).toBe(PERSONAL.emergencyContact);

    // the promotion that did not happen: he is still a server, and his PIN
    // still signs him in
    const session = await app.inject({ method: "POST", url: "/v1/session",
      payload: { deviceId: "term-nok", pin: "4455" } });
    expect(session.json().employee.role).toBe("server");
  });

  it("refuses an edit without a manager, for a stranger, or with a blank name", async () => {
    const app = buildServer();
    const nok = (await hireCook(app, 1)).json().employee;

    const bare = await app.inject({ method: "POST", url: `/v1/staff/${nok.id}`,
      payload: { ...ENV(2), title: "Chef de cuisine" } });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().reason).toBe("editing an employee requires a manager's PIN");

    const nobody = await app.inject({ method: "POST", url: "/v1/staff/not-a-real-id",
      payload: { ...ENV(3), managerPin: MGR, title: "Chef" } });
    expect(nobody.json().reason).toBe("no employee not-a-real-id");

    const blank = await app.inject({ method: "POST", url: `/v1/staff/${nok.id}`,
      payload: { ...ENV(4), managerPin: MGR, name: "   " } });
    expect(blank.json().reason).toBe("an employee needs a name");

    // the refused edits changed nothing
    const entry = (await directory(app, MGR)).json().staff.find((s: { id: string }) => s.id === nok.id);
    expect(entry).toMatchObject({ name: "Nok S.", title: "Line cook" });

    // and a replayed edit is the same edit, not a second one
    const op = { ...ENV(5), managerPin: MGR, title: "Sous chef" };
    const first = await app.inject({ method: "POST", url: `/v1/staff/${nok.id}`, payload: op });
    const retry = await app.inject({ method: "POST", url: `/v1/staff/${nok.id}`, payload: op });
    expect(retry.json()).toEqual(first.json());
  });
});

describe("employees, PINs, and sessions (E15)", () => {
  it("signs staff in and out per device, and reports who is on it", async () => {
    const app = buildServer();
    const staff = (await app.inject({ method: "GET", url: "/v1/staff" })).json().staff;
    expect(staff.map((s: { name: string }) => s.name)).toContain("Marco B.");

    const bad = await app.inject({ method: "POST", url: "/v1/session",
      payload: { deviceId: "term-1", pin: "0000" } });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({ method: "POST", url: "/v1/session",
      payload: { deviceId: "term-1", pin: "2468" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().employee.name).toBe("Gia R.");
    expect(ok.json().employee.role).toBe("server");

    const who = await app.inject({ method: "GET", url: "/v1/session?deviceId=term-1" });
    expect(who.json().employee.name).toBe("Gia R.");

    await app.inject({ method: "POST", url: "/v1/session/signout", payload: { deviceId: "term-1" } });
    const after = await app.inject({ method: "GET", url: "/v1/session?deviceId=term-1" });
    expect(after.json().employee).toBeNull();
  });

  it("a server's PIN cannot approve; a manager's can, and the approver is recorded", async () => {
    const app = buildServer();
    const check = await openCheck(app);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "acqua", quantity: 1, seatNo: 1 } });
    const lineId = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` }))
      .json().check.lines[0].id as string;

    // Gia (server, 2468) tries to self-approve a void: refused
    const serverPin = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items/${lineId}/void`,
      payload: { ...ENV(2), reason: "wrong item", managerPin: "2468" } });
    expect(serverPin.statusCode).toBe(422);
    expect(serverPin.json().reason).toMatch(/not recognized as a manager/);

    // Marco (manager, 1122) approves, and the void records him
    const ok = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items/${lineId}/void`,
      payload: { ...ENV(3), reason: "wrong item", managerPin: "1122" } });
    expect(ok.statusCode).toBe(200);
    const line = ok.json().check.lines[0];
    expect(line.status).toBe("voided");
    expect(line.voidApprovedBy).toBe("66666666-6666-4666-8666-666666666666"); // Marco B.
  });

  it("payments are attributed to the signed-in employee on the device", async () => {
    const app = buildServer();
    await app.inject({ method: "POST", url: "/v1/session",
      payload: { deviceId: "test-terminal", pin: "2468" } }); // ENV uses test-terminal
    const check = await openCheck(app);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "acqua", quantity: 1, seatNo: 1 } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(2) });
    const due = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check.totals.dueMinor as number;
    const pay = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(3), method: "card", amountMinor: due } });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().check.payments[0].takenBy).toBe("33333333-3333-3333-3333-333333333333"); // Gia R.
  });
});

describe("reopen, clock-out, and tips (E14/E15 deepening)", () => {
  it("a closed check reopens with a manager, takes new items, and closes again", async () => {
    const app = buildServer();
    const check = await openCheck(app);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "acqua", quantity: 1, seatNo: 1 } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(2) });
    const due1 = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check.totals.dueMinor as number;
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/payments`, payload: { ...ENV(3), method: "card", amountMinor: due1 } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/close`, payload: ENV(4) });

    // a server's PIN cannot reopen; a manager's can
    const noAuth = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/reopen`,
      payload: { ...ENV(5), managerPin: "2468" } });
    expect(noAuth.statusCode).toBe(422);
    const reopened = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/reopen`,
      payload: { ...ENV(6), managerPin: "1122" } });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().check.status).toBe("reopened");

    // forgot the tiramisu: add it, fire it, settle the difference, close again
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(7), itemId: "tiramisu", quantity: 1, seatNo: 1 } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(8) });
    const due2 = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check.totals.dueMinor as number;
    expect(due2).toBeGreaterThan(0);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/payments`, payload: { ...ENV(9), method: "card", amountMinor: due2 } });
    const closed = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/close`, payload: ENV(10) });
    expect(closed.statusCode).toBe(200);
  });

  it("sign-in clocks you in; the day cannot close until everyone clocks out with tips declared", async () => {
    const app = buildServer();
    await app.inject({ method: "POST", url: "/v1/session", payload: { deviceId: "t9", pin: "2468" } }); // Gia clocks in

    const day1 = (await app.inject({ method: "GET", url: "/v1/day" })).json();
    expect(day1.blockers.openShifts).toContain("Gia R.");
    expect(day1.shifts.find((s: { employeeName: string }) => s.employeeName === "Gia R.").clockOut).toBeUndefined();

    const blocked = await app.inject({ method: "POST", url: "/v1/day/close", payload: { ...ENV(1), managerPin: "1122" } });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().reason).toMatch(/clocked in/);

    // wrong pin cannot clock out; her own pin declares her tips
    const wrong = await app.inject({ method: "POST", url: "/v1/shifts/clockout",
      payload: { ...ENV(2), pin: "9999", declaredTipsMinor: 4200 } });
    expect(wrong.statusCode).toBe(422);
    const out = await app.inject({ method: "POST", url: "/v1/shifts/clockout",
      payload: { ...ENV(3), pin: "2468", declaredTipsMinor: 4200 } });
    expect(out.statusCode).toBe(200);

    const day2 = (await app.inject({ method: "GET", url: "/v1/day" })).json();
    expect(day2.blockers.openShifts).toHaveLength(0);
    expect(day2.summary.declaredTipsMinor).toBe(4200);

    // a second clock-out is refused: the shift is settled
    const again = await app.inject({ method: "POST", url: "/v1/shifts/clockout",
      payload: { ...ENV(4), pin: "2468" } });
    expect(again.statusCode).toBe(422);

    // now the day closes
    const done = await app.inject({ method: "POST", url: "/v1/day/close", payload: { ...ENV(5), managerPin: "1122" } });
    expect(done.statusCode).toBe(200);
  });
});

describe("transfer and merge (E7)", () => {
  it("a transferred check takes its kitchen cards along and frees the old table", async () => {
    const app = buildServer();
    const check = await openCheck(app); // Table 14
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "ragu", quantity: 1, seatNo: 1, modifiers: [{ groupId: "pasta", modifierId: "spag" }] } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(2) });

    // occupied target refused; unknown-to-floor names are allowed (walk-in style)
    const other = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { ...ENV(3), tableName: "Table 5", covers: 2 } });
    const onto = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/transfer`,
      payload: { ...ENV(4), tableName: "Table 5" } });
    expect(onto.statusCode).toBe(422);
    expect(onto.json().reason).toMatch(/already has/);

    const move = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/transfer`,
      payload: { ...ENV(5), tableName: "Table 12" } });
    expect(move.statusCode).toBe(200);
    expect(move.json().check.tableName).toBe("Table 12");

    // the floor swapped: 14 free, 12 occupied by this check
    const floor = (await app.inject({ method: "GET", url: "/v1/floor" })).json().tables;
    expect(floor.find((t: { name: string }) => t.name === "Table 14").check).toBeNull();
    expect(floor.find((t: { name: string }) => t.name === "Table 12").check.id).toBe(check.id);

    // the kitchen card re-labeled
    const kds = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets;
    expect(kds.find((t: { checkId: string }) => t.checkId === check.id).tableName).toBe("Table 12");

    // a closed check refuses transfer
    const otherId = other.json().check.id as string;
    await app.inject({ method: "POST", url: `/v1/checks/${otherId}/items`, payload: { ...ENV(6), itemId: "acqua", quantity: 1, seatNo: 1 } });
    await app.inject({ method: "POST", url: `/v1/checks/${otherId}/send`, payload: ENV(7) });
    const due = (await app.inject({ method: "GET", url: `/v1/checks/${otherId}` })).json().check.totals.dueMinor as number;
    await app.inject({ method: "POST", url: `/v1/checks/${otherId}/payments`, payload: { ...ENV(8), method: "card", amountMinor: due } });
    await app.inject({ method: "POST", url: `/v1/checks/${otherId}/close`, payload: ENV(9) });
    const dead = await app.inject({ method: "POST", url: `/v1/checks/${otherId}/transfer`, payload: { ...ENV(10), tableName: "Table 9" } });
    expect(dead.statusCode).toBe(422);
  });

  it("merging combines lines, renumbers seats after the target's covers, and voids the source", async () => {
    const app = buildServer();
    const a = await openCheck(app); // Table 14, 2 covers
    const bRes = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { ...ENV(1), tableName: "Table 5", covers: 3 } });
    const b = bRes.json().check as { id: string };

    await app.inject({ method: "POST", url: `/v1/checks/${a.id}/items`,
      payload: { ...ENV(2), itemId: "burrata", quantity: 1, seatNo: 1 } });
    await app.inject({ method: "POST", url: `/v1/checks/${b.id}/items`,
      payload: { ...ENV(3), itemId: "ragu", quantity: 1, seatNo: 2, modifiers: [{ groupId: "pasta", modifierId: "gf" }] } });
    await app.inject({ method: "POST", url: `/v1/checks/${b.id}/send`, payload: ENV(4) });

    // no PIN, no merge; and a paid source refuses
    const noPin = await app.inject({ method: "POST", url: `/v1/checks/${a.id}/merge`,
      payload: { ...ENV(5), sourceCheckId: b.id } });
    expect(noPin.statusCode).toBe(422);

    const merged = await app.inject({ method: "POST", url: `/v1/checks/${a.id}/merge`,
      payload: { ...ENV(6), sourceCheckId: b.id, managerPin: "1122" } });
    expect(merged.statusCode).toBe(200);
    const c = merged.json().check;
    expect(c.covers).toBe(5); // 2 + 3
    const ragu = c.lines.find((l: { capturedName: string }) => l.capturedName === "Ragu alla Bolognese");
    expect(ragu.seatNo).toBe(4); // seat 2 + target's 2 covers: still the same person
    expect(ragu.status).toBe("sent"); // fired lines stay fired, never re-fire
    expect(c.totals.subtotalMinor).toBe(1600 + 2400 + 200);

    // the source voided and Table 5 freed; the fired course cooks for Table 14 now
    const bAfter = (await app.inject({ method: "GET", url: `/v1/checks/${b.id}` })).json().check;
    expect(bAfter.status).toBe("voided");
    expect(bAfter.lines).toHaveLength(0);
    const floor = (await app.inject({ method: "GET", url: "/v1/floor" })).json().tables;
    expect(floor.find((t: { name: string }) => t.name === "Table 5").check).toBeNull();
    const kds = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets;
    expect(kds.find((t: { checkId: string }) => t.checkId === b.id).tableName).toBe("Table 14");

    // and the merged check settles normally
    await app.inject({ method: "POST", url: `/v1/checks/${a.id}/send`, payload: ENV(7) });
    const due = (await app.inject({ method: "GET", url: `/v1/checks/${a.id}` })).json().check.totals.dueMinor as number;
    const pay = await app.inject({ method: "POST", url: `/v1/checks/${a.id}/payments`,
      payload: { ...ENV(8), method: "card", amountMinor: due } });
    expect(pay.json().check.status).toBe("paid");
  });

  it("a source with payments refuses to merge (refund first, FR-28 discipline)", async () => {
    const app = buildServer();
    const a = await openCheck(app);
    const bRes = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { ...ENV(1), tableName: "Table 5", covers: 2 } });
    const b = bRes.json().check as { id: string };
    await app.inject({ method: "POST", url: `/v1/checks/${b.id}/items`, payload: { ...ENV(2), itemId: "acqua", quantity: 1, seatNo: 1 } });
    await app.inject({ method: "POST", url: `/v1/checks/${b.id}/send`, payload: ENV(3) });
    await app.inject({ method: "POST", url: `/v1/checks/${b.id}/payments`, payload: { ...ENV(4), method: "card", amountMinor: 100 } });
    const res = await app.inject({ method: "POST", url: `/v1/checks/${a.id}/merge`,
      payload: { ...ENV(5), sourceCheckId: b.id, managerPin: "1122" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().reason).toMatch(/payments/);
  });
});

describe("menu drafts, publishing, and the 86 board (E5)", () => {
  it("drafts change nothing until a manager publishes; then new orders reprice and old lines never move", async () => {
    const app = buildServer();

    // a check ordered on v1 captures v1 prices
    const check = await openCheck(app);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "ragu", quantity: 1, seatNo: 1, modifiers: [{ groupId: "pasta", modifierId: "spag" }] } });

    // edit the draft: raise the ragu, add a focaccia
    const up1 = await app.inject({ method: "POST", url: "/v1/menu/draft/item",
      payload: { ...ENV(2), itemId: "ragu", name: "Ragu alla Bolognese", priceMinor: 2600, course: "PRIMI", station: "SAUTE", modifierGroupIds: ["pasta", "additions"] } });
    expect(up1.statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/v1/menu/draft/item",
      payload: { ...ENV(3), name: "Focaccia al Rosmarino", priceMinor: 900, course: "ANTIPASTI", station: "FORNO" } });

    // service still runs on v1: the live menu has not moved
    let menu = (await app.inject({ method: "GET", url: "/v1/menu" })).json();
    expect(menu.version).toBe(1);
    expect(menu.items.find((i: { id: string }) => i.id === "ragu").priceMinor).toBe(2400);
    expect(menu.items.some((i: { id: string }) => i.id === "focaccia-al-rosmarino")).toBe(false);

    // publish needs a manager
    const noPin = await app.inject({ method: "POST", url: "/v1/menu/publish", payload: ENV(4) });
    expect(noPin.statusCode).toBe(422);
    const pub = await app.inject({ method: "POST", url: "/v1/menu/publish", payload: { ...ENV(5), managerPin: "1122" } });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().menu.version).toBe(2);

    // now the live menu is v2, and the draft is gone
    menu = (await app.inject({ method: "GET", url: "/v1/menu" })).json();
    expect(menu.version).toBe(2);
    expect(menu.snapshotId).toBe("snap-0002");
    expect(menu.items.find((i: { id: string }) => i.id === "ragu").priceMinor).toBe(2600);
    expect((await app.inject({ method: "GET", url: "/v1/menu/draft" })).json().draft).toBeNull();

    // a new order on the same open check prices at v2 and records the snapshot
    const add2 = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(6), itemId: "ragu", quantity: 1, seatNo: 2, modifiers: [{ groupId: "pasta", modifierId: "spag" }] } });
    expect(add2.statusCode).toBe(200);
    const lines = add2.json().check.lines;
    expect(lines[0].unitPriceMinor).toBe(2400); // the v1 line never moves
    expect(lines[1].unitPriceMinor).toBe(2600); // the v2 line prices fresh
    expect(lines[1].menuSnapshotId).toBe("snap-0002");

    // the focaccia is orderable; and a check opened now pins v2
    const foc = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(7), itemId: "focaccia-al-rosmarino", quantity: 1, seatNo: 1 } });
    expect(foc.statusCode).toBe(200);

    // remove the calamari on a fresh draft, publish v3, and it stops being orderable
    await app.inject({ method: "POST", url: "/v1/menu/draft/remove", payload: { ...ENV(8), itemId: "calamari" } });
    await app.inject({ method: "POST", url: "/v1/menu/publish", payload: { ...ENV(9), managerPin: "1122" } });
    const gone = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(10), itemId: "calamari", quantity: 1, seatNo: 1 } });
    expect(gone.statusCode).toBe(422);
  });

  it("the 86 board is live: no publish needed, counts run down, zero auto-86s", async () => {
    const app = buildServer();
    const check = await openCheck(app);

    // 86 the branzino: instantly unorderable
    await app.inject({ method: "POST", url: "/v1/menu/86", payload: { ...ENV(1), itemId: "branzino", is86: true } });
    const dead = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(2), itemId: "branzino", quantity: 1, seatNo: 1 } });
    expect(dead.statusCode).toBe(422);
    expect(dead.json().reason).toMatch(/86/);

    // bring it back with a count of 2
    await app.inject({ method: "POST", url: "/v1/menu/86", payload: { ...ENV(3), itemId: "branzino", is86: false, remaining: 2 } });
    const overAsk = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(4), itemId: "branzino", quantity: 3, seatNo: 1 } });
    expect(overAsk.statusCode).toBe(422);
    expect(overAsk.json().reason).toMatch(/only 2/);

    // ordering both runs the count to zero and auto-86s
    const ok = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(5), itemId: "branzino", quantity: 2, seatNo: 1 } });
    expect(ok.statusCode).toBe(200);
    const menu = (await app.inject({ method: "GET", url: "/v1/menu" })).json();
    const avail = menu.availability.find((a: { itemId: string }) => a.itemId === "branzino");
    expect(avail.remaining).toBe(0);
    expect(avail.is86).toBe(true);
    const late = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(6), itemId: "branzino", quantity: 1, seatNo: 1 } });
    expect(late.statusCode).toBe(422);
  });
});

/* ------------- modifier groups become editable (E5-T2) -------------
   The menu stops being half source code. Everything below drives the same
   draft-then-publish flow the items already used, and the point of the
   end-to-end case is that modifiers.ts refuses an order because a MANAGER
   said the choice was required, not because a developer did. */
describe("the manager writes the modifier graph (E5-T2)", () => {
  const MGR = "1122";
  const group = (app: ReturnType<typeof buildServer>, n: number, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/menu/draft/group", payload: { ...ENV(n), managerPin: MGR, ...body } });
  const assign = (app: ReturnType<typeof buildServer>, n: number, itemId: string, groupIds: string[]) =>
    app.inject({ method: "POST", url: "/v1/menu/draft/assign", payload: { ...ENV(n), managerPin: MGR, itemId, groupIds } });
  const publish = (app: ReturnType<typeof buildServer>, n: number) =>
    app.inject({ method: "POST", url: "/v1/menu/publish", payload: { ...ENV(n), managerPin: MGR } });
  const draftOf = async (app: ReturnType<typeof buildServer>) =>
    (await app.inject({ method: "GET", url: "/v1/menu/draft" })).json().draft;

  /** the group this epic exists for: a house rule no developer wrote down */
  const SPICE = { groupId: "spice", name: "Spice level", minSelect: 1, maxSelect: 1,
    options: [{ name: "Mild", priceMinor: 0 }, { name: "Thai hot", priceMinor: 0 }] };

  it("starts a draft holding the whole live graph, not just the items", async () => {
    const app = buildServer();
    await app.inject({ method: "POST", url: "/v1/menu/draft/item",
      payload: { ...ENV(1), itemId: "acqua", name: "Acqua Panna", priceMinor: 650, course: "BEVERAGE", station: "BAR" } });
    const draft = await draftOf(app);
    // the seed GROUPS is the first snapshot's content now, so it arrives
    // through the draft rather than being read live from the source
    expect(draft.groups.map((g: { id: string }) => g.id).sort())
      .toEqual(["additions", "cooked", "pasta", "size", "temp"]);
    expect(draft.groups.find((g: { id: string }) => g.id === "pasta"))
      .toMatchObject({ name: "Pasta", minSelect: 1, maxSelect: 1 });
  });

  it("refuses every malformed group, and says which rule was broken", async () => {
    const app = buildServer();
    const bare = await app.inject({ method: "POST", url: "/v1/menu/draft/group", payload: { ...ENV(1), ...SPICE } });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().reason).toBe("editing modifier groups requires a manager's PIN");
    const asServer = await app.inject({ method: "POST", url: "/v1/menu/draft/group",
      payload: { ...ENV(2), managerPin: "2468", ...SPICE } });
    expect(asServer.json().reason).toBe("PIN not recognized as a manager");

    for (const [patch, reason] of [
      [{ name: "   " }, "a modifier group needs a name"],
      [{ minSelect: -1 }, "minSelect must be a non-negative integer"],
      [{ minSelect: 1, maxSelect: 0 }, "maxSelect 0 would make the group unpickable; remove the group instead"],
      [{ minSelect: 2, maxSelect: 1 }, "maxSelect 1 is below minSelect 2"],
      [{ options: [{ name: "  ", priceMinor: 0 }] }, "every option needs a name"],
      [{ options: [{ name: "Extra chilli", priceMinor: -50 }] }, 'option "Extra chilli" needs a non-negative whole price'],
      [{ options: [{ name: "Mild", priceMinor: 0 }, { name: "mild", priceMinor: 100 }] },
        'two options on this group are both called "mild"'],
    ] as [Record<string, unknown>, string][]) {
      const res = await group(app, 3, { ...SPICE, ...patch });
      expect(res.statusCode, reason).toBe(422);
      expect(res.json().reason).toBe(reason);
    }
    // nothing malformed reached the draft
    expect(await draftOf(app)).toBeNull();

    // unlimited IS a valid answer, and so is a purely optional group
    const open = await group(app, 4, { groupId: "sides", name: "Sides", minSelect: 0, maxSelect: null,
      options: [{ name: "Sticky rice", priceMinor: 300 }] });
    expect(open.statusCode).toBe(200);
    expect(open.json().menu.draft.groups.find((g: { id: string }) => g.id === "sides").maxSelect).toBeNull();
  });

  it("edits a group in place and never lets a removal strand a reference", async () => {
    const app = buildServer();
    await group(app, 1, SPICE);
    // an edit replaces rather than duplicates, and ids come off the names
    const edited = await group(app, 2, { ...SPICE, name: "Heat", options: [...SPICE.options, { name: "Extra hot", priceMinor: 100 }] });
    const groups = edited.json().menu.draft.groups;
    expect(groups.filter((g: { id: string }) => g.id === "spice")).toHaveLength(1);
    expect(groups.find((g: { id: string }) => g.id === "spice").name).toBe("Heat");
    expect(groups.find((g: { id: string }) => g.id === "spice").options.map((o: { id: string }) => o.id))
      .toEqual(["mild", "thai-hot", "extra-hot"]);

    await assign(app, 3, "ragu", ["spice"]);
    await assign(app, 4, "cacio", ["spice"]);

    const held = await app.inject({ method: "POST", url: "/v1/menu/draft/group/remove",
      payload: { ...ENV(5), managerPin: MGR, groupId: "spice" } });
    expect(held.statusCode).toBe(422);
    // it names the dishes, because "in use" without a list is a scavenger hunt
    expect(held.json().reason).toBe("spice is still on Ragu alla Bolognese, Cacio e Pepe; take it off those items first");

    // the same guard one level down: an option that OPENS the group
    await assign(app, 6, "ragu", []);
    await assign(app, 7, "cacio", []);
    await group(app, 8, { groupId: "additions", name: "Additions", minSelect: 0, maxSelect: null,
      options: [{ name: "Add shrimp", priceMinor: 800, childGroupIds: ["spice"] }] });
    const nested = await app.inject({ method: "POST", url: "/v1/menu/draft/group/remove",
      payload: { ...ENV(9), managerPin: MGR, groupId: "spice" } });
    expect(nested.json().reason).toBe("spice is still opened by an option on Additions; change those options first");

    await group(app, 10, { groupId: "additions", name: "Additions", minSelect: 0, maxSelect: null,
      options: [{ name: "Add shrimp", priceMinor: 800 }] });
    const freed = await app.inject({ method: "POST", url: "/v1/menu/draft/group/remove",
      payload: { ...ENV(11), managerPin: MGR, groupId: "spice" } });
    expect(freed.statusCode).toBe(200);
    expect(freed.json().menu.draft.groups.some((g: { id: string }) => g.id === "spice")).toBe(false);

    const stranger = await app.inject({ method: "POST", url: "/v1/menu/draft/group/remove",
      payload: { ...ENV(12), managerPin: MGR, groupId: "spice" } });
    expect(stranger.json().reason).toBe("no modifier group spice on the draft");
  });

  it("assigns groups in order, refuses unknown ones, and an empty array clears", async () => {
    const app = buildServer();
    await group(app, 1, SPICE);

    const unknown = await assign(app, 2, "ragu", ["spice", "wine-pairing"]);
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().reason).toBe("unknown modifier group(s): wine-pairing");

    const nobody = await assign(app, 3, "not-a-dish", ["spice"]);
    expect(nobody.json().reason).toBe("no item not-a-dish on the draft");

    // order is the order the server is asked, so it is preserved verbatim
    const ordered = await assign(app, 4, "ragu", ["spice", "pasta", "additions"]);
    expect(ordered.json().menu.draft.items.find((m: { id: string }) => m.id === "ragu").modifierGroupIds)
      .toEqual(["spice", "pasta", "additions"]);

    const cleared = await assign(app, 5, "ragu", []);
    expect(cleared.json().menu.draft.items.find((m: { id: string }) => m.id === "ragu").modifierGroupIds).toEqual([]);

    // and the item command validates against the DRAFT's graph, so a group
    // created moments ago is assignable before it is published
    const viaItem = await app.inject({ method: "POST", url: "/v1/menu/draft/item",
      payload: { ...ENV(6), itemId: "ragu", name: "Ragu alla Bolognese", priceMinor: 2400,
        course: "PRIMI", station: "SAUTE", groupIds: ["spice"] } });
    expect(viaItem.statusCode).toBe(200);
    expect(viaItem.json().menu.draft.items.find((m: { id: string }) => m.id === "ragu").modifierGroupIds).toEqual(["spice"]);
  });

  it("publishes the manager's graph, and the order refusal comes from their rule", async () => {
    const app = buildServer();
    await group(app, 1, SPICE);
    await assign(app, 2, "ragu", ["spice"]);

    // service is still on v1, where "spice" does not exist at all
    expect((await app.inject({ method: "GET", url: "/v1/menu" })).json().groups.spice).toBeUndefined();

    const pub = await publish(app, 3);
    expect(pub.statusCode).toBe(200);
    const live = (await app.inject({ method: "GET", url: "/v1/menu" })).json();
    expect(live.version).toBe(2);
    expect(live.groups.spice).toMatchObject({ name: "Spice level", minSelect: 1, maxSelect: 1 });
    expect(live.groups.spice.options.map((o: { id: string }) => o.id)).toEqual(["mild", "thai-hot"]);

    // END TO END: the kitchen's own rule now refuses an order, and the words
    // come from modifiers.ts running over data a person typed
    const check = await openCheck(app);
    const bare = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(4), itemId: "ragu", quantity: 1, seatNo: 1 } });
    expect(bare.statusCode).toBe(422);
    // the structured error is modifiers.ts's own, unchanged by this ticket,
    // reporting a shortfall against a minimum a manager set this morning
    expect(bare.json().modifierErrors).toEqual([{ code: "too_few", groupId: "spice", min: 1, got: 0 }]);

    const chosen = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(5), itemId: "ragu", quantity: 1, seatNo: 1, modifiers: [{ groupId: "spice", modifierId: "thai-hot" }] } });
    expect(chosen.statusCode).toBe(200);
    // and a manager-authored PRICE reaches the money
    await group(app, 6, { groupId: "sides", name: "Sides", minSelect: 0, maxSelect: 2,
      options: [{ name: "Sticky rice", priceMinor: 350 }] });
    await assign(app, 7, "cacio", ["sides"]);
    await publish(app, 8);
    const priced = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(9), itemId: "cacio", quantity: 1, seatNo: 1, modifiers: [{ groupId: "sides", modifierId: "sticky-rice" }] } });
    expect(priced.statusCode).toBe(200);
    const line = priced.json().check.lines.at(-1);
    expect(line.modifierPriceMinor).toBe(350);
    expect(line.unitPriceMinor + line.modifierPriceMinor).toBe(2100 + 350);
  });

  it("a line ordered under the old graph survives the group being deleted", async () => {
    const app = buildServer();
    const check = await openCheck(app);
    // ordered under v1's "pasta", captured with its selection and its price
    const before = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "ragu", quantity: 1, seatNo: 1, modifiers: [{ groupId: "pasta", modifierId: "gf" }] } });
    expect(before.statusCode).toBe(200);
    expect(before.json().check.lines[0].modifierPriceMinor).toBe(200);

    // the manager takes "pasta" off every dish and deletes it outright
    await assign(app, 2, "ragu", []);
    await assign(app, 3, "cacio", []);
    const removed = await app.inject({ method: "POST", url: "/v1/menu/draft/group/remove",
      payload: { ...ENV(4), managerPin: MGR, groupId: "pasta" } });
    expect(removed.statusCode).toBe(200);
    expect((await publish(app, 5)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/menu" })).json().groups.pasta).toBeUndefined();

    // FR-9: the old line is captured, not revalidated. Its selection, its
    // price, and its snapshot id are all exactly where it left them.
    const still = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check;
    expect(still.lines[0].modifiers).toEqual([{ groupId: "pasta", modifierId: "gf" }]);
    expect(still.lines[0].modifierPriceMinor).toBe(200);
    expect(still.lines[0].menuSnapshotId).toBe("snap-0001");

    // it still fires, still pays, still closes: a deleted group cannot strand
    // a guest who is sitting at the table eating the dish
    expect((await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(6) })).statusCode).toBe(200);
    const due = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check.totals.dueMinor as number;
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(7), method: "card", amountMinor: due } });
    expect((await app.inject({ method: "POST", url: `/v1/checks/${check.id}/close`, payload: ENV(8) })).statusCode).toBe(200);

    // ordering it fresh is a different question, and now correctly refused
    const fresh = await openCheck(app);
    const now = await app.inject({ method: "POST", url: `/v1/checks/${fresh.id}/items`,
      payload: { ...ENV(9), itemId: "ragu", quantity: 1, seatNo: 1, modifiers: [{ groupId: "pasta", modifierId: "gf" }] } });
    expect(now.statusCode).toBe(422);
  });

  it("refuses to publish a menu holding an item nobody could ever order", async () => {
    const app = buildServer();
    // a required group with no options: correct-looking, and unsellable
    await group(app, 1, { groupId: "cut", name: "Cut", minSelect: 1, maxSelect: 1, options: [] });
    await assign(app, 2, "bistecca", ["cut"]);
    const refused = await publish(app, 3);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().reason)
      .toBe('cannot publish: Bistecca Fiorentina requires "Cut", which has no options, so it could never be ordered');
    expect((await app.inject({ method: "GET", url: "/v1/menu" })).json().version).toBe(1); // nothing published

    // the same trap one level down, reached through an option
    await group(app, 4, { groupId: "cut", name: "Cut", minSelect: 1, maxSelect: 1,
      options: [{ name: "Bone in", priceMinor: 0, childGroupIds: ["ageing"] }] });
    await group(app, 5, { groupId: "ageing", name: "Ageing", minSelect: 1, maxSelect: 1, options: [] });
    const nested = await publish(app, 6);
    expect(nested.json().reason).toContain('requires "Ageing", which has no options');

    // an OPTIONAL group with no options is merely pointless, never a refusal:
    // the item orders fine, so it is the manager's call to make
    await group(app, 7, { groupId: "ageing", name: "Ageing", minSelect: 0, maxSelect: 1, options: [] });
    const ok = await publish(app, 8);
    expect(ok.statusCode).toBe(200);
    const check = await openCheck(app);
    expect((await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(9), itemId: "bistecca", quantity: 1, seatNo: 1,
        modifiers: [{ groupId: "cut", modifierId: "bone-in" }] } })).statusCode).toBe(200);
  });

  it("replays a dropped group command instead of applying it twice", async () => {
    const app = buildServer();
    const op = { ...ENV(1), managerPin: MGR, ...SPICE };
    const first = await app.inject({ method: "POST", url: "/v1/menu/draft/group", payload: op });
    const retry = await app.inject({ method: "POST", url: "/v1/menu/draft/group", payload: op });
    expect(first.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect((await draftOf(app)).groups.filter((g: { id: string }) => g.id === "spice")).toHaveLength(1);
  });

  it("publishes a pre-E5-T2 draft against the live graph, as it always did", async () => {
    const app = buildServer();
    // a draft document written before groups were editable carries no `groups`
    const legacy = await app.inject({ method: "POST", url: "/v1/menu/draft/item",
      payload: { ...ENV(1), itemId: "ragu", name: "Ragu alla Bolognese", priceMinor: 2700,
        course: "PRIMI", station: "SAUTE", modifierGroupIds: ["pasta", "additions"] } });
    expect(legacy.statusCode).toBe(200);
    const draft = legacy.json().menu.draft;
    delete draft.groups;
    // put it back the way an older build would have left it
    await app.inject({ method: "POST", url: "/v1/menu/draft/discard", payload: ENV(2) });
    await app.inject({ method: "POST", url: "/v1/menu/draft/item",
      payload: { ...ENV(3), itemId: "ragu", name: "Ragu alla Bolognese", priceMinor: 2700,
        course: "PRIMI", station: "SAUTE", modifierGroupIds: ["pasta", "additions"] } });

    expect((await publish(app, 4)).statusCode).toBe(200);
    const live = (await app.inject({ method: "GET", url: "/v1/menu" })).json();
    expect(live.version).toBe(2);
    // the graph came through the publish intact rather than being lost
    expect(Object.keys(live.groups).sort()).toEqual(["additions", "cooked", "pasta", "size", "temp"]);
    expect(live.items.find((i: { id: string }) => i.id === "ragu").priceMinor).toBe(2700);
  });
});

/* E5-T3: the page that puts E5-T2's commands behind a manager's hands. No
 * engine or route under test here, page-serve assertions only: the groups
 * section markup exists, and the sheets that write to it (group edit, item
 * assignment, publish's diff) are wired into the served script. */
describe("modifier groups on the Menu screen (E5-T3)", () => {
  it("serves the modifier-groups section, the item editor's chips, and the publish diff", async () => {
    const app = buildServer();
    const page = (await app.inject({ method: "GET", url: "/menu" })).body;

    // the groups section sits beside the items, under Draft
    expect(page).toContain('<div class="course-h">Modifier groups</div>');
    expect(page).toContain('<div id="draftGroups"></div>');
    expect(page).toContain('id="btnAddGroup"');
    expect(page).toContain("+ Add group");
    // one row per group: name, min-max badge, option count, price range
    expect(page).toContain("function renderGroupsBlock()");
    expect(page).toContain("g.minSelect");
    expect(page).toContain("priceRange(g)");
    expect(page).toContain("data-editgroup=");

    // the tap-to-edit sheet: name, min/max steppers, options, remove-group
    expect(page).toContain("function groupForm(src)");
    expect(page).toContain('data-gmin="-1"');
    expect(page).toContain('data-gmax="1"');
    expect(page).toContain("btnAddOpt");
    expect(page).toContain("data-optdel=");
    expect(page).toContain("btnRemoveGroup");
    expect(page).toContain("removeGroupFromDraft");
    expect(page).toContain("/v1/menu/draft/group/remove");

    // item assignment: chips on the item editor, ordered by tap, and a
    // plain "requires: X" line for anything with minSelect >= 1
    expect(page).toContain('class="gchip');
    expect(page).toContain("data-gchip=");
    expect(page).toContain('class="ord"');
    expect(page).toContain("requires: ");

    // draft-vs-live badging matches the item chips already on the page
    expect(page).toContain('<span class="chip green">new</span>');
    expect(page).toContain('<span class="chip amber">changed</span>');

    // publish stays one gesture, and its confirmation carries the diff plus
    // the engine's own refusal text, inline rather than only a toast
    expect(page).toContain("function publishForm()");
    expect(page).toContain("function diffSummary()");
    expect(page).toContain("<b>Items:</b>");
    expect(page).toContain("<b>Groups:</b>");
    expect(page).toContain('id="fErr"');
    expect(page).toContain("showFormErr");

    // the page formats, it never re-implements modifier math: no min/max
    // choice-counting logic lives here, only display and the engine's calls
    expect(page).not.toContain("too_few");
    expect(page).not.toContain("too_many");
  });

  it("still serves everything menu.html shipped before this ticket (existing menu markup untouched)", async () => {
    const app = buildServer();
    const page = (await app.inject({ method: "GET", url: "/menu" })).body;
    expect(page).toContain("Live now · 86 board");
    expect(page).toContain('id="live"></div>');
    expect(page).toContain('id="draft"></div>');
    expect(page).toContain("86 it");
    expect(page).toContain("Set count");
    // D35/UI-T5 trimmed the rail to seven icons (Menu and Reports left it)
    expect(page.match(/<svg viewBox="0 0 24 24" aria-hidden="true">/g)).toHaveLength(7);
  });
});

describe("cash drawers and the business day (E14/E16)", () => {
  it("cash needs a till; the drawer ledger balances; close counts over/short and freezes it", async () => {
    const app = buildServer();
    const check = await openCheck(app);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "acqua", quantity: 1, seatNo: 1 } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(2) });
    const due = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check.totals.dueMinor as number;

    // cash with no open drawer is refused: physical money needs a till
    const noDrawer = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(3), method: "cash", amountMinor: due } });
    expect(noDrawer.statusCode).toBe(422);
    expect(noDrawer.json().reason).toMatch(/drawer/);

    // open the till with a counted float
    const opened = await app.inject({ method: "POST", url: "/v1/drawer/open",
      payload: { ...ENV(4), drawerName: "Front drawer", openingFloatMinor: 20000 } });
    expect(opened.statusCode).toBe(200);
    const sessionId = opened.json().session.id as string;

    // one open session per drawer, like idx_drawer_one_open
    const dup = await app.inject({ method: "POST", url: "/v1/drawer/open",
      payload: { ...ENV(5), drawerName: "Front drawer", openingFloatMinor: 5000 } });
    expect(dup.statusCode).toBe(422);

    // now the same cash payment lands, and its sale event hits the ledger
    const paid = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(6), method: "cash", amountMinor: due, tipMinor: 100 } });
    expect(paid.statusCode).toBe(200);

    // pay-out without a manager is refused; with one it books negative
    const noPin = await app.inject({ method: "POST", url: "/v1/drawer/event",
      payload: { ...ENV(7), sessionId, kind: "pay_out", amountMinor: 1500, reason: "produce run" } });
    expect(noPin.statusCode).toBe(422);
    const payOut = await app.inject({ method: "POST", url: "/v1/drawer/event",
      payload: { ...ENV(8), sessionId, kind: "pay_out", amountMinor: 1500, reason: "produce run", managerPin: "1122" } });
    expect(payOut.statusCode).toBe(200);

    // count and close: expected = 20000 float + (due+100) sale − 1500 payout
    const expected = 20000 + due + 100 - 1500;
    const closed = await app.inject({ method: "POST", url: "/v1/drawer/close",
      payload: { ...ENV(9), sessionId, countedMinor: expected - 200 } });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().session.expectedMinor).toBe(expected);
    expect(closed.json().session.overShortMinor).toBe(-200); // two dollars short, frozen

    // a closed session takes no more cash events
    const late = await app.inject({ method: "POST", url: "/v1/drawer/event",
      payload: { ...ENV(10), sessionId, kind: "pay_in", amountMinor: 100, reason: "too late" } });
    expect(late.statusCode).toBe(422);
  });

  it("the day close is gated on open checks and drawers, then seals the numbers", async () => {
    const app = buildServer();
    const check = await openCheck(app);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "ragu", quantity: 1, seatNo: 1, modifiers: [{ groupId: "pasta", modifierId: "spag" }] } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(2) });

    // blocked: the check is still open
    const early = await app.inject({ method: "POST", url: "/v1/day/close", payload: { ...ENV(3), managerPin: "1122" } });
    expect(early.statusCode).toBe(422);
    expect(early.json().reason).toMatch(/open check/);

    // settle the check (card, so no drawer needed), then open a drawer and leave it open
    const due = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check.totals.dueMinor as number;
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(4), method: "card", amountMinor: due, tipMinor: 500 } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/close`, payload: ENV(5) });
    const opened = await app.inject({ method: "POST", url: "/v1/drawer/open",
      payload: { ...ENV(6), drawerName: "Bar drawer", openingFloatMinor: 10000 } });
    const sessionId = opened.json().session.id as string;

    // blocked: the drawer is still open
    const midway = await app.inject({ method: "POST", url: "/v1/day/close", payload: { ...ENV(7), managerPin: "1122" } });
    expect(midway.statusCode).toBe(422);
    expect(midway.json().reason).toMatch(/drawer/);

    await app.inject({ method: "POST", url: "/v1/drawer/close", payload: { ...ENV(8), sessionId, countedMinor: 10000 } });

    // blocked: the ragu was fired and never bumped, so the rail still has work
    // on it even though the check is paid and closed (E8-T2)
    const railOpen = await app.inject({ method: "POST", url: "/v1/day/close", payload: { ...ENV(8), managerPin: "1122" } });
    expect(railOpen.statusCode).toBe(422);
    expect(railOpen.json().reason).toMatch(/kitchen ticket\(s\) still open \(Table 14 PRIMI\)/);

    // sweep it: bump every item, serve the table
    const rail = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets as
      { id: string; items: { orderItemId: string }[] }[];
    for (const t of rail) {
      for (const i of t.items) {
        await app.inject({ method: "POST", url: "/v1/kds/toggle", payload: { ...ENV(8), ticketId: t.id, orderItemId: i.orderItemId } });
      }
    }
    await app.inject({ method: "POST", url: "/v1/kds/serve", payload: { ...ENV(8), tableName: "Table 14" } });

    // no PIN, no close
    const noPin = await app.inject({ method: "POST", url: "/v1/day/close", payload: ENV(9) });
    expect(noPin.statusCode).toBe(422);

    // all clear: the close carries the sealed summary
    const done = await app.inject({ method: "POST", url: "/v1/day/close", payload: { ...ENV(10), managerPin: "1122" } });
    expect(done.statusCode).toBe(200);
    const day = done.json().day;
    expect(day.status).toBe("closed");
    expect(day.summary.checksClosed).toBe(1);
    expect(day.summary.totalMinor).toBe(due);
    expect(day.summary.tipsMinor).toBe(500);
    expect(day.summary.paidCardMinor).toBe(due);
    expect(day.drawers[0].overShortMinor).toBe(0);

    // a closed day takes no new checks, and closing twice is refused
    const newCheck = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { ...ENV(11), tableName: "Table 5", covers: 2 } });
    expect(newCheck.statusCode).toBe(422);
    expect(newCheck.json().reason).toMatch(/closed/);
    const again = await app.inject({ method: "POST", url: "/v1/day/close", payload: { ...ENV(12), managerPin: "1122" } });
    expect(again.statusCode).toBe(422);

    // reopen (manager) and service resumes
    const reopen = await app.inject({ method: "POST", url: "/v1/day/reopen", payload: { ...ENV(13), managerPin: "1122" } });
    expect(reopen.statusCode).toBe(200);
    const resume = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { ...ENV(14), tableName: "Table 5", covers: 2 } });
    expect(resume.statusCode).toBe(200);
  });
});

describe("reads", () => {
  it("serves the menu snapshot and the landing page", async () => {
    const app = buildServer();
    const menu = await app.inject({ method: "GET", url: "/v1/menu" });
    expect(menu.json().items.length).toBeGreaterThan(5);
    // "/" is the lock screen (PIN pad); the API reference moved to /api
    const lock = await app.inject({ method: "GET", url: "/" });
    expect(lock.statusCode).toBe(200);
    expect(lock.body).toContain("enter your PIN");
    const api = await app.inject({ method: "GET", url: "/api" });
    expect(api.statusCode).toBe(200);
    expect(api.body).toContain("RestaurantOS");
  });

  it("serves the POS web client at /pos", async () => {
    const app = buildServer();
    const pos = await app.inject({ method: "GET", url: "/pos" });
    expect(pos.statusCode).toBe(200);
    expect(pos.headers["content-type"]).toContain("text/html");
    expect(pos.body).toContain("RestaurantOS POS");
    expect(pos.body).toContain("operationId");
    // E11: the pay modal's split selector and the portion cards it renders
    expect(pos.body).toContain("Whole check");
    expect(pos.body).toContain("By seat");
    expect(pos.body).toContain("/split?");
    // E20-T3: the guests flow, its modal, the header chips, and the API it reads
    expect(pos.body).toContain("Guests · attach a regular");
    expect(pos.body).toContain('id="ovGuests"');
    expect(pos.body).toContain('id="chGuests"');
    expect(pos.body).toContain("/v1/guests");
    expect(pos.body).toContain("Create and attach");
    // UI-T2: the menu is navigated by category, one category of tiles at a
    // time, rather than one scroll of the whole menu
    expect(pos.body).toContain('<div class="catrail" id="catRail"></div>');
    expect(pos.body).toContain('<div class="tiles" id="tiles"></div>');
    expect(pos.body).toContain('class="cat-btn" data-cat=');
    // the rail reads COURSES until E5-full lands real categories, and says so
    expect(pos.body).toContain('BEVERAGE:{name:"Beverage",note:"fires immediately"}');
    expect(pos.body).toContain('PRIMI:{name:"Primi",note:"course 2"}');
    expect(pos.body).toContain("When E5-full lands real menu categories");
    // UI-T3: corrections live on an explicit action bar, not on a bare tap
    expect(pos.body).toContain('<div class="actbar">');
    expect(pos.body).toContain('<button class="act" id="btnDisc">Discount</button>');
    expect(pos.body).toContain('<button class="act danger" id="btnVoid">Void</button>');
    expect(pos.body).toContain('<button class="act" id="btnHist">History</button>');
    expect(pos.body).toContain('<button class="act" id="btnMore">More ⋯</button>');
    // the history modal, and the E8-T3 read it renders
    expect(pos.body).toContain('id="ovHist"');
    expect(pos.body).toContain("/history");
    expect(pos.body).toContain('class="tl-item"');
    // course sections with their own hold and fire controls (E8-T3's commands)
    expect(pos.body).toContain('class="course-head"');
    expect(pos.body).toContain("data-hold=");
    expect(pos.body).toContain("data-rel=");
    expect(pos.body).toContain("data-fire=");
    for (const cmd of ["hold", "release", "fire"]) {
      expect(pos.body).toContain(`courseCmd("${cmd}"`);
    }
    // the batch void: many lines, one reason, one PIN
    expect(pos.body).toContain("Manager PIN, once for the batch");
    expect(pos.body).toContain('id="voidLines"');
    expect(pos.body).toContain("Guest changed mind");
    // a bare tap opens the line sheet; the void landmine is gone
    expect(pos.body).toContain('id="ovLine"');
    expect(pos.body).toContain("Void this line");
    expect(pos.body).toContain("openLine(b.dataset.l)");
    expect(pos.body).not.toContain("Tap to void");
    // UI-T4: the New check modal reads the room off the floor it already
    // fetches, and guards capacity softly
    expect(pos.body).toContain('class="arealbl"');
    expect(pos.body).toContain('<span class="cap">${t.seats}</span>');
    expect(pos.body).toContain("t.seats<newSel.covers?\"tight\"");
    expect(pos.body).toContain('id="newNote"');
    expect(pos.body).toContain("Tap again to squeeze them in.");
    expect(pos.body).toContain("function tightTable(");
    // soft means soft: no browser confirm anywhere on the page
    expect(pos.body).not.toContain("confirm(");
  });

  it("serves the Reports page at /reports, and /insights still lands (E19-T4)", async () => {
    const app = buildServer();
    const page = await app.inject({ method: "GET", url: "/reports" });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Reports");
    // D24 reserved "Insights" for the Phase 6 layer, so it is gone from the
    // live page copy, but the old URL still gets you there
    expect(page.body).not.toContain(">Insights<");
    const old = await app.inject({ method: "GET", url: "/insights" });
    expect(old.statusCode).toBe(302);
    expect(old.headers["location"]).toBe("/reports");
    // the page reads the two E19-T1 projections and nothing else
    expect(page.body).toContain("/v1/insights/servers");
    expect(page.body).toContain("/v1/insights/heatmap");
    // and the Tips tile takes declared cash from the server's own total
    // rather than summing the scorecard rows (E19-T3)
    expect(page.body).toContain("declaredTipsTotalMinor");
    // D35/UI-T5: Reports left the rail for the Office hub, so it is reached
    // from there now rather than from every floor screen's own rail entry
    // (the card and its href are built by the hub's own script at runtime)
    expect((await app.inject({ method: "GET", url: "/office" })).body).toContain('card("Reports","/reports"');
  });

  /* UI-T1: the shell DESIGN.md section 5 prescribes. Navigation is a place you
   * go, so it is the left icon rail with its badge counts; the topbar is where
   * you are. The markup is duplicated per page (each page is a self-contained
   * zero-dependency file), so the assertion runs over all TEN (Settings
   * joined in E21-T2, the book in E23-T3, the schedule in E24-T5, the hub in
   * UI-T5) to keep them from drifting apart.
   *
   * D35/UI-T5 split the rail in two: the floor keeps a rail entry per screen
   * (Service, Tables, Bookings, Kitchen, Close, Shifts), while Menu, Reports
   * and Settings collapse into ONE entry, Office, and that entry reads "on"
   * on all four office pages because you are "in the office" on any of them. */
  it("gives all ten navigable pages the app shell: rail navigates, topbar identifies", async () => {
    const app = buildServer();
    const railScreens = ["/pos", "/tables", "/reservations", "/kds", "/close", "/schedule", "/office"];
    const officeFamily = ["/office", "/menu", "/reports", "/settings"];
    const pages = [...railScreens.filter((s) => s !== "/office"), ...officeFamily];
    for (const url of pages) {
      const body = (await app.inject({ method: "GET", url })).body;
      expect(body).toContain('<nav class="navrail" aria-label="Screens">');
      expect(body).toContain('class="shellbody"');
      // every rail screen is reachable from every page, and exactly one entry
      // is marked current: the one you are on, or Office when you are behind it
      for (const dest of railScreens) expect(body).toContain(`href="${dest}"`);
      for (const dest of ["/menu", "/reports", "/settings"]) expect(body, `${url} still carries a rail entry to ${dest}`).not.toContain(`class="nav-btn" href="${dest}"`);
      expect(body.match(/class="nav-btn on" aria-current="page"/g)).toHaveLength(1);
      const onHref = officeFamily.includes(url) ? "/office" : url;
      expect(body).toContain(`class="nav-btn on" aria-current="page" href="${onHref}"`);
      // seven icons now (nine minus Menu and Reports, plus one for Office),
      // inline SVG in one stroke style, never emoji
      expect(body.match(/<svg viewBox="0 0 24 24" aria-hidden="true">/g)).toHaveLength(7);
      // the rail carries the two live counts the data already supports
      expect(body).toContain('id="navTables"');
      expect(body).toContain('id="navKds"');
      // the topbar keeps identity, screen, and session state, and nothing to
      // navigate with: the old row of nav pills is gone
      expect(body).toContain('<header class="topbar">');
      expect(body).toContain('class="screen-title"');
      expect(body).not.toContain('<nav class="nav">');
      // and the shell is still sized with --vph, never a percentage height
      expect(body).toContain("height:var(--vph)");
      // the three office pages carry a breadcrumb back to the hub; the hub
      // and the floor screens do not need one
      if (["/menu", "/reports", "/settings"].includes(url)) expect(body).toContain('class="office-crumb"');
    }
    // the lock screen stays a fullscreen PIN pad: no rail, nowhere to go yet
    expect((await app.inject({ method: "GET", url: "/" })).body).not.toContain("navrail");
  });

  /* E21-T2: the demo restaurant's name is not in anybody's markup any more.
   * Every page ships "RestaurantOS" and asks the server who it is actually
   * serving, so a second restaurant never sees somebody else's name flash. */
  it("takes the venue's name off the walls of all nine pages and the lock screen", async () => {
    const app = buildServer();
    for (const url of ["/pos", "/tables", "/reservations", "/kds", "/menu", "/close", "/reports", "/schedule", "/settings", "/"]) {
      const body = (await app.inject({ method: "GET", url })).body;
      expect(body, `${url} still names the demo venue`).not.toContain("<b>Osteria Nove</b>");
      expect(body, `${url} still names the demo venue`).not.toContain("<h1>Osteria Nove</h1>");
      // E25-T2 item 6: every page but the lock screen reads the venue through
      // dget(), which carries x-device-id so a signed-in device identifies a
      // read the same way it identifies a mutation; the lock screen has no
      // session yet, so it still reads with a bare fetch
      expect(body, `${url} does not read the venue`).toContain(url === "/" ? 'fetch("/v1/venue")' : 'dget("/v1/venue")');
      expect(body).toContain("data-venue-name");
      // the fallback is the product's name, never a guess at the restaurant's
      expect(body).toContain('let VENUE={name:"RestaurantOS"');
    }
    // the lock screen's title follows the venue; the rest stay generic
    const lock = (await app.inject({ method: "GET", url: "/" })).body;
    expect(lock).toContain("<title>RestaurantOS</title>");
    expect(lock).toContain('document.title=VENUE.name==="RestaurantOS"');
    expect((await app.inject({ method: "GET", url: "/pos" })).body).toContain("<title>RestaurantOS POS · connected</title>");
    // and the receipt prints the venue it was actually served at
    const pos = (await app.inject({ method: "GET", url: "/pos" })).body;
    expect(pos).toContain("<h4>${esc(VENUE.name)}</h4>");
    expect(pos).toContain("${esc(VENUE.address)}");
    expect(pos).not.toContain("9 Vicolo della Luna");
  });

  /* E21-T2: E21-T1 accepts 4 to 6 digit PINs, so every surface that takes one
   * has to. The lock pad was the sharp edge: it hard-capped at four AND
   * auto-submitted there, which locked anyone with a longer PIN out. */
  it("lets every PIN surface take 4 to 6 digits", async () => {
    const app = buildServer();
    const pos = (await app.inject({ method: "GET", url: "/pos" })).body;
    expect(pos).not.toContain('maxlength="4"');
    expect(pos.match(/maxlength="6" placeholder="••••"/g)).toHaveLength(8);

    const lock = (await app.inject({ method: "GET", url: "/" })).body;
    expect(lock).toContain("const PIN_MIN=4,PIN_MAX=6");
    expect(lock).toContain("if(buf.length>=PIN_MAX)return");
    expect(lock).toContain("if(buf.length===PIN_MAX)submit()");
    // an explicit send key, because the pad can no longer submit itself at four
    expect(lock).toContain('id="padGo"');
    expect(lock).toContain('if(k==="✓"){if(buf.length>=PIN_MIN)submit();return;}');
    expect(lock).toContain('if(e.key==="Enter")press("✓")');

    // the two manager gates the UI holds for a visit take the same range
    for (const url of ["/tables", "/settings"]) {
      const body = (await app.inject({ method: "GET", url })).body;
      expect(body).toContain('id="pinFld" inputmode="numeric" maxlength="6"');
      expect(body).toContain("/^[0-9]{4,6}$/.test(v)");
    }
  });

  /* E21-T2: the Settings screen itself. */
  it("serves /settings with the Venue form and the Team roster", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/settings" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const body = res.body;

    // venue: the three fields, saved through the manager-gated update
    expect(body).toContain(">Venue<");
    expect(body).toContain('id="vName"');
    expect(body).toContain('id="vAddr"');
    expect(body).toContain('id="vTz"');
    expect(body).toContain('cmd("/v1/venue"');
    // a filtered list over the runtime's IANA zones, not a 400-row select
    expect(body).toContain('Intl.supportedValuesOf("timeZone")');
    expect(body).toContain('class="tzlist"');
    expect(body).not.toContain("<select");
    // the caveat E21-T1 wrote into the engine is said out loud here too
    expect(body).toContain("business day still buckets on the server's own clock");

    // team: the roster read plus the three commands
    expect(body).toContain(">Team<");
    // E25-T2 item 6: the roster read carries x-device-id like every other GET
    expect(body).toContain('dget("/v1/staff")');
    expect(body).toContain('cmd("/v1/staff"');
    expect(body).toContain('/pin"');
    expect(body).toContain('/deactivate"');
    expect(body).toContain("Reset PIN");
    expect(body).toContain("Deactivate");
    // an initial PIN typed twice, checked here, everything else left to the engine
    expect(body).toContain('pinPair("aPin","aPin2")');
    expect(body).toContain("Those two PINs are not the same");
    // a PIN is never rendered on the roster, and deactivation says what
    // survives it. Scoped to renderStaff() itself (not the whole page):
    // E25-T3's terminal sheet legitimately reads demoPin off the SEPARATE
    // /v1/staff/demo-pins endpoint every page now carries, same as pos.html
    // always has, so the substring appears elsewhere in this script on purpose
    const rosterFn = body.slice(body.indexOf("function renderStaff()"), body.indexOf("function toggleDetail"));
    expect(rosterFn).not.toContain("demoPin");
    expect(body).toContain("Every check they opened keeps their name on it");

    // manager territory: gated on the first mutation, held for the visit
    expect(body).toContain('id="ovPin"');
    expect(body).toContain("const gated=job=>{mgrPin?job():askPin(job);}");
    // and refusals are the engine's own sentence
    expect(body).toContain('showErr("#vErr",r.reason)');
  });

  /* E21-T3 (D32): the picker was always first-party and always filtered, but
   * it rendered nothing until somebody typed, so the field read as a textbox
   * demanding a precisely spelled zone. Discoverability, not a new mechanism:
   * the browser still supplies every name, and nothing ships with the page. */
  it("the timezone picker shows itself before anybody types (E21-T3)", async () => {
    const body = (await buildServer().inject({ method: "GET", url: "/settings" })).body;

    // the field says what it does now
    expect(body).toContain('placeholder="Type a city, or tap a suggestion"');
    expect(body).not.toContain('placeholder="Type a city, e.g. Chicago"');

    // suggestions on focus, and on an untyped field: this device first, then
    // the zone the venue is already set to, then the common ones
    expect(body).toContain('$("#vTz").onfocus=renderTz');
    expect(body).toContain('Intl.DateTimeFormat().resolvedOptions().timeZone');
    expect(body).toContain('add(DEVICE_TZ,"This device")');
    expect(body).toContain('add(tzPick||VENUE.timezone,"Saved")');
    expect(body).toContain('const COMMON_TZ=["America/New_York","America/Chicago","America/Denver","America/Los_Angeles","America/Phoenix","Pacific/Honolulu"]');
    expect(body).toContain('class="tzhint"');
    expect(body).toContain("Or type a city to search every zone this browser knows.");

    // still no zone data of our own, and still the old fallback for a runtime
    // that cannot enumerate them
    expect(body).toContain('Intl.supportedValuesOf("timeZone")');
    expect(body).toContain("This browser will not list its timezones");
    expect(body).not.toContain("<select");

    // and free text cannot be saved: a value that is not on the browser's own
    // list is a typo, and the page says so instead of posting it
    expect(body).toContain("Pick a timezone from the list");
    expect(body).toContain("if(ZONES.length&&!ZONES.includes(tz)){");
    // the guard stands down when there is no list to judge against
    expect(body).toContain("ZONES.length&&");
  });

  /* E24-T2: the Team rows grow the people directory. */
  it("the Settings Team rows carry the gated directory (E24-T2)", async () => {
    const app = buildServer();
    const body = (await app.inject({ method: "GET", url: "/settings" })).body;

    // the fold, and the gated read behind it. A POST, because the PIN is the
    // body: it must not sit in a URL that lands in a log or a history list
    expect(body).toContain('data-more="');
    expect(body).toContain('fetch("/v1/staff/directory"');
    expect(body).toContain('body:JSON.stringify({managerPin:mgrPin})');
    expect(body).toContain('class="det"');

    // the inline locked state: not an error, just a question nobody answered
    expect(body).toContain('class="lock"');
    expect(body).toContain("Enter manager PIN");
    expect(body).toContain('data-unlock="1"');

    // edit in place, through the update command, with role deliberately absent
    expect(body).toContain('cmd("/v1/staff/"+encodeURIComponent(id)');
    expect(body).toContain('data-edit="');
    expect(body).toContain("Emergency contact");

    // the fold on the hire form, so the five-second hire stays five seconds
    expect(body).toContain('id="aMore"');
    expect(body).toContain('class="fold"');
    expect(body).toContain("+ More details");

    // the two rules, said out loud on the page and not only in the spec
    expect(body).toContain("A job title is what the room calls somebody");
    expect(body).toContain("Phone, email, and emergency contact are manager-only");
    // no wage, tax, or bank field anywhere on this page: that is rung 3, and
    // rung 3 exports to a payroll provider rather than storing any of it
    for (const forbidden of ["wageMinor", "id=\"aWage\"", "id=\"eWage\"", "Social security", "Bank account"]) {
      expect(body, `${forbidden} has no business on the directory`).not.toContain(forbidden);
    }
  });

  it("serves the KDS, Tables, and Close pages and the floor", async () => {
    const app = buildServer();
    expect((await app.inject({ method: "GET", url: "/kds" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/tables" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/close" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/day" })).json().status).toBe("open");
    const floor = await app.inject({ method: "GET", url: "/v1/floor" });
    expect(floor.json().tables.length).toBe(13);
    expect(floor.json().tables.find((t: { name: string }) => t.name === "Table 7").check).toBeNull();
  });

  it("the Tables page carries the floor editor: PIN gate, add sheet, booth (E6-T3)", async () => {
    const app = buildServer();
    const page = (await app.inject({ method: "GET", url: "/tables" })).body;

    // a booth is finally drawable, so it finally has a class of its own
    expect(page).toContain(".tbl.booth{border-radius:");
    expect(page).toContain('data-s="booth"');

    // the manager gate on entering edit mode, held for the visit and
    // re-validated by the server on every command
    expect(page).toContain('id="ovPin"');
    expect(page).toContain('id="pinGo"');
    expect(page).toContain("Start editing");
    expect(page).toContain("askPin(()=>{edit=true;render();})");

    // the one sheet that adds and edits
    expect(page).toContain('id="ovSheet"');
    expect(page).toContain('id="addBtn"');
    expect(page).toContain("+ Add table");
    expect(page).toContain('class="shapes"');
    expect(page).toContain('data-seat="-1"');
    // S / M / L at 0.75x / 1x / 1.3x of the shape default, not drag handles
    expect(page).toContain('const SIZES=[{k:"S",f:.75},{k:"M",f:1},{k:"L",f:1.3}]');
    expect(page).toContain('data-z="${s.k}"');
    expect(page).toContain("Or a new area, e.g. Patio");

    // all four shapes, each with the default size the ticket fixes
    for (const [shape, w, h] of [["rect", 16, 26], ["round", 12, 22], ["booth", 20, 30], ["stool", 6, 10]] as const) {
      expect(page).toContain(`{k:"${shape}",label:`);
      expect(page).toContain(`w:${w},h:${h}}`);
    }

    // retire is two-step, and the confirm says what survives it
    expect(page).toContain("Retire table");
    expect(page).toContain("Its past checks stay in the books");
    expect(page).toContain('id="shRetireGo"');

    // the four E6-T2 commands, and drag-to-move still ungated
    for (const url of ["/v1/floor/add", "/v1/floor/update", "/v1/floor/resize", "/v1/floor/retire"]) {
      expect(page).toContain(url);
    }
    expect(page).toContain("managerPin:mgrPin");

    // a refusal is the engine's own sentence, never a paraphrase
    expect(page).toContain("sh.err=reason");
    expect(page).toContain('class="err ${sh.err?"on":""}"');
  });
});

/* ----------------------------- split checks (E11) -----------------------------
 * A split is a payment partition over ONE check (D18): the portions are a read,
 * computed fresh every time, and settled by payments carrying the portion label.
 * The money math is the domain's splitCheck; these tests prove the HTTP layer
 * carries it faithfully, conservation included.
 */

interface Portion {
  label: string;
  seatNos?: number[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  dueMinor: number;
}

const sum = (ns: readonly number[]) => ns.reduce((a, b) => a + b, 0);

async function openTable(app: ReturnType<typeof buildServer>, tableName: string, covers: number) {
  const res = await app.inject({ method: "POST", url: "/v1/checks", payload: { ...ENV(0), tableName, covers } });
  expect(res.statusCode).toBe(200);
  return res.json().check as { id: string };
}

async function preview(app: ReturnType<typeof buildServer>, id: string, query: string) {
  const res = await app.inject({ method: "GET", url: `/v1/checks/${id}/split?${query}` });
  expect(res.statusCode).toBe(200);
  return res.json().portions as Portion[];
}

/** Every portion column sums to the check's own total, and every row adds up. */
async function expectConservation(app: ReturnType<typeof buildServer>, id: string, portions: Portion[]) {
  const totals = (await app.inject({ method: "GET", url: `/v1/checks/${id}` })).json().check.totals;
  expect(sum(portions.map((p) => p.subtotalMinor))).toBe(totals.subtotalMinor);
  expect(sum(portions.map((p) => p.discountMinor))).toBe(totals.discountMinor);
  expect(sum(portions.map((p) => p.taxMinor))).toBe(totals.taxMinor);
  expect(sum(portions.map((p) => p.totalMinor))).toBe(totals.totalMinor);
  for (const p of portions) {
    expect(p.totalMinor).toBe(p.subtotalMinor - p.discountMinor + p.taxMinor);
    expect(p.dueMinor).toBe(Math.max(0, p.totalMinor - p.paidMinor));
  }
}

/** Burrata for seat 1, acqua for seat 2, fired: subtotal 2200, tax 195, total 2395. */
async function twoSeatCheck(app: ReturnType<typeof buildServer>, tableName = "Table 14") {
  const check = await openTable(app, tableName, 2);
  await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`, payload: { ...ENV(1), itemId: "burrata", quantity: 1, seatNo: 1 } });
  await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`, payload: { ...ENV(2), itemId: "acqua", quantity: 1, seatNo: 2 } });
  const send = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(3) });
  expect(send.statusCode).toBe(200);
  expect(send.json().check.totals.totalMinor).toBe(2395);
  return check;
}

describe("split preview and labeled portion payments (E11)", () => {
  it("splits evenly, settles portion by portion, and closes on the total", async () => {
    const app = buildServer();
    const check = await twoSeatCheck(app);

    const portions = await preview(app, check.id, "mode=even&ways=3");
    expect(portions.map((p) => p.label)).toEqual(["Split 1 of 3", "Split 2 of 3", "Split 3 of 3"]);
    // 2200 subtotal splits 734/733/733, tax 195 splits 65/65/65
    expect(portions.map((p) => p.totalMinor)).toEqual([799, 798, 798]);
    expect(portions.every((p) => p.paidMinor === 0)).toBe(true);
    expect(portions.map((p) => p.dueMinor)).toEqual([799, 798, 798]);
    await expectConservation(app, check.id, portions);

    const first = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(4), method: "card", amountMinor: 799, label: "Split 1 of 3" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().check.status).toBe("partially_paid");

    // the same read now knows portion 1 is settled and the others are not
    const after = await preview(app, check.id, "mode=even&ways=3");
    expect(after[0]).toMatchObject({ paidMinor: 799, dueMinor: 0 });
    expect(after.slice(1).map((p) => p.dueMinor)).toEqual([798, 798]);

    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/payments`, payload: { ...ENV(5), method: "card", amountMinor: 798, label: "Split 2 of 3" } });
    const last = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(6), method: "card", amountMinor: 798, label: "Split 3 of 3" },
    });
    expect(last.statusCode).toBe(200);
    expect(last.json().check.status).toBe("paid");
    expect(last.json().check.totals.dueMinor).toBe(0);

    const close = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/close`, payload: ENV(7) });
    expect(close.json().check.status).toBe("closed");
  });

  it("splits by seat: only seats that ordered get a portion, voided lines vanish", async () => {
    const app = buildServer();
    const check = await openTable(app, "Table 7", 4);
    const add = async (n: number, itemId: string, seatNo: number) =>
      app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`, payload: { ...ENV(n), itemId, quantity: 1, seatNo } });
    await add(1, "burrata", 1);   // 1600
    await add(2, "acqua", 2);     //  600
    await add(3, "tiramisu", 2);  // 1200
    await add(4, "calamari", 3);  // 1500, voided below
    await add(5, "acqua", 3);     //  600
    await add(6, "acqua", 4);     //  600, voided below, so seat 4 drops out
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(7) });

    const lines = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check.lines as {
      id: string; capturedName: string; seatNo: number;
    }[];
    const calamari = lines.find((l) => l.capturedName === "Calamari Fritti");
    const seat4 = lines.find((l) => l.seatNo === 4);
    for (const [n, line] of [[8, calamari], [9, seat4]] as const) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/checks/${check.id}/items/${line!.id}/void`,
        payload: { ...ENV(n), reason: "guest changed mind", managerPin: "1122" },
      });
      expect(res.statusCode).toBe(200);
    }

    const portions = await preview(app, check.id, "mode=bySeat");
    // seat 4 has nothing that stands, so it gets no portion at all
    expect(portions.map((p) => p.label)).toEqual(["Seat 1", "Seat 2", "Seat 3"]);
    expect(portions.map((p) => p.seatNos)).toEqual([[1], [2], [3]]);
    // the voided calamari is gone from seat 3: 600, not 2100
    expect(portions.map((p) => p.subtotalMinor)).toEqual([1600, 1800, 600]);
    expect(portions.map((p) => p.taxMinor)).toEqual([142, 160, 53]);
    expect(portions.map((p) => p.totalMinor)).toEqual([1742, 1960, 653]);
    await expectConservation(app, check.id, portions);

    // seat 2 pays its own portion; the check stays open for the rest
    const pay = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(10), method: "card", amountMinor: 1960, tipMinor: 400, label: "Seat 2" },
    });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().check.status).toBe("partially_paid");
    const settled = await preview(app, check.id, "mode=bySeat");
    expect(settled[1]).toMatchObject({ label: "Seat 2", paidMinor: 1960, dueMinor: 0 });
    expect(settled[0]!.paidMinor).toBe(0);
  });

  it("refuses a labeled payment beyond its portion's due, tip aside", async () => {
    const app = buildServer();
    const check = await twoSeatCheck(app, "Table 12");

    const over = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(4), method: "card", amountMinor: 800, label: "Split 1 of 3" },
    });
    expect(over.statusCode).toBe(422);
    expect(over.json().reason).toMatch(/Split 1 of 3 has 799 left to pay/);
    expect(over.json().reason).toMatch(/exceeds/);

    // the tip rides on top of the portion, so due + tip is fine
    const ok = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(5), method: "card", amountMinor: 799, tipMinor: 300, label: "Split 1 of 3" },
    });
    expect(ok.statusCode).toBe(200);

    // and paying the same portion twice is refused: it owes nothing now
    const again = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(6), method: "card", amountMinor: 799, label: "Split 1 of 3" },
    });
    expect(again.statusCode).toBe(422);
    expect(again.json().reason).toMatch(/has 0 left to pay/);

    // an unlabeled payment is still free to settle whatever is left
    const rest = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(7), method: "card", amountMinor: 2395 - 799 },
    });
    expect(rest.statusCode).toBe(200);
    expect(rest.json().check.status).toBe("paid");
  });

  it("conserves a discount across portions, both ways of splitting", async () => {
    const app = buildServer();
    const check = await twoSeatCheck(app, "Table 9");
    const disc = await app.inject({
      method: "POST",
      url: `/v1/checks/${check.id}/adjustments`,
      payload: { ...ENV(4), percentBp: 1000, reason: "birthday table", managerPin: "1122" },
    });
    expect(disc.statusCode).toBe(200);
    // 10% of 2200 is 220, taxable 1980, tax 176, total 2156
    expect(disc.json().check.totals).toMatchObject({ discountMinor: 220, taxMinor: 176, totalMinor: 2156 });

    const even = await preview(app, check.id, "mode=even&ways=3");
    expect(even.map((p) => p.discountMinor)).toEqual([74, 73, 73]);
    expect(sum(even.map((p) => p.discountMinor))).toBe(220);
    await expectConservation(app, check.id, even);

    // by seat the discount follows what each seat ordered, not a flat share
    const bySeat = await preview(app, check.id, "mode=bySeat");
    expect(bySeat.map((p) => p.discountMinor)).toEqual([160, 60]);
    expect(bySeat.map((p) => p.totalMinor)).toEqual([1568, 588]);
    await expectConservation(app, check.id, bySeat);
  });

  it("refuses partitions a check cannot have, and 404s an unknown check", async () => {
    const app = buildServer();
    const check = await twoSeatCheck(app, "Table 3");
    const bad = ["", "mode=perItem", "mode=even", "mode=even&ways=1", "mode=even&ways=0", "mode=even&ways=2.5", "mode=even&ways=500"];
    for (const query of bad) {
      const res = await app.inject({ method: "GET", url: `/v1/checks/${check.id}/split?${query}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().reason).toBeTruthy();
    }
    const missing = await app.inject({ method: "GET", url: "/v1/checks/nope/split?mode=bySeat" });
    expect(missing.statusCode).toBe(404);

    // a check with nothing on it has nothing to split by seat
    const empty = await openTable(app, "Table 5", 2);
    expect(await preview(app, empty.id, "mode=bySeat")).toEqual([]);
  });
});

/* --------------------- cross-partition overpay guard (E11-T4) ---------------------
 * A portion's paid amount counts only payments under its own label, so after
 * settling portions from one partition, a portion of ANOTHER partition still
 * reads as owing its whole share. Paying it in full would overpay the check.
 * The POS refuses to offer it; the server has to refuse to take it.
 */

/** Seat 1 1600, seat 2 1800, seat 3 600: subtotal 4000, tax 355, total 4355. */
async function threeSeatCheck(app: ReturnType<typeof buildServer>, tableName: string) {
  const check = await openTable(app, tableName, 4);
  const add = (n: number, itemId: string, seatNo: number) =>
    app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`, payload: { ...ENV(n), itemId, quantity: 1, seatNo } });
  await add(1, "burrata", 1);
  await add(2, "acqua", 2);
  await add(3, "tiramisu", 2);
  await add(4, "acqua", 3);
  const send = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(5) });
  expect(send.json().check.totals.totalMinor).toBe(4355);
  return check;
}

const payLabel = (app: ReturnType<typeof buildServer>, id: string, n: number, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/v1/checks/${id}/payments`, payload: { ...ENV(n), method: "card", ...body } });

describe("cross-partition overpay guard (E11-T4)", () => {
  it("refuses a portion payment bigger than the check's remaining due, naming both amounts", async () => {
    const app = buildServer();
    const check = await threeSeatCheck(app, "Table 7");

    // even 3 ways: 1453 / 1451 / 1451
    const even = await preview(app, check.id, "mode=even&ways=3");
    expect(even.map((p) => p.totalMinor)).toEqual([1_453, 1_451, 1_451]);
    expect((await payLabel(app, check.id, 6, { amountMinor: 1_453, label: "Split 1 of 3" })).statusCode).toBe(200);

    // the party changes its mind and splits by seat instead
    const seats = await preview(app, check.id, "mode=bySeat");
    expect(seats.map((p) => p.totalMinor)).toEqual([1_742, 1_960, 653]);
    expect((await payLabel(app, check.id, 7, { amountMinor: 1_742, label: "Seat 1" })).statusCode).toBe(200);

    // seat 2 still reads as owing 1960, but the check only owes 1160 now
    const mid = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check;
    expect(mid.totals.dueMinor).toBe(1_160);
    const stillOwed = await preview(app, check.id, "mode=bySeat");
    expect(stillOwed[1]).toMatchObject({ label: "Seat 2", dueMinor: 1_960 });

    const over = await payLabel(app, check.id, 8, { amountMinor: 1_960, label: "Seat 2" });
    expect(over.statusCode).toBe(422);
    expect(over.json().reason).toMatch(/Seat 2 shows 1960 due but the check only owes 1160/);
    expect(over.json().reason).toMatch(/payments under other portions already cover the rest/);

    // paying what the check actually owes, tip on top, is accepted and closes
    const ok = await payLabel(app, check.id, 9, { amountMinor: 1_160, tipMinor: 250, label: "Seat 2" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().check.status).toBe("paid");
    expect(ok.json().check.totals.paidMinor).toBe(4_355);
    expect(ok.json().check.totals.dueMinor).toBe(0);
    const close = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/close`, payload: ENV(10) });
    expect(close.json().check.status).toBe("closed");
  });

  it("keeps the per-portion message when the portion itself is the binding cap", async () => {
    const app = buildServer();
    const check = await threeSeatCheck(app, "Table 12");
    // nothing paid yet, so the check owes more than any single portion
    const over = await payLabel(app, check.id, 6, { amountMinor: 2_000, label: "Seat 3" });
    expect(over.statusCode).toBe(422);
    expect(over.json().reason).toMatch(/Seat 3 has 653 left to pay; 2000 exceeds that portion's remaining due/);
  });

  it("never lets labeled payments overpay, whatever order the partitions come in", async () => {
    // Deterministic pseudo-random alternation (Lehmer), so a failure reproduces.
    let seed = 20_260_822;
    const rnd = (n: number) => { seed = (seed * 48_271) % 2_147_483_647; return seed % n; };
    let capped = 0; // times the CHECK's due, not the portion's, was the binding cap

    for (let round = 0; round < 6; round++) {
      const app = buildServer();
      const check = await threeSeatCheck(app, "Table 7");
      const total = 4_355;
      let paidNonTip = 0;
      let op = 6;

      for (let step = 0; step < 20; step++) {
        const live = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check;
        if (live.totals.dueMinor === 0) break;
        const mode = rnd(2) === 0 ? `mode=even&ways=${2 + rnd(4)}` : "mode=bySeat";
        const portions = await preview(app, check.id, mode);
        const owing = portions.filter((p) => p.dueMinor > 0);
        expect(owing.length).toBeGreaterThan(0); // a check that owes has an owing portion
        const pick = owing[rnd(owing.length)]!;
        // pay exactly what the server quotes, capped by the check itself
        const amount = Math.min(pick.dueMinor, live.totals.dueMinor);
        if (amount < pick.dueMinor) {
          capped++;
          // the guard must refuse the portion's own full due here
          const refused = await payLabel(app, check.id, op++, { amountMinor: pick.dueMinor, label: pick.label });
          expect(refused.statusCode).toBe(422);
          expect(refused.json().reason).toMatch(/the check only owes/);
        }
        const res = await payLabel(app, check.id, op++, { amountMinor: amount, tipMinor: rnd(300), label: pick.label });
        expect(res.statusCode).toBe(200);
        paidNonTip += amount;
        expect(paidNonTip).toBeLessThanOrEqual(total); // non-tip money never exceeds the check
      }

      const done = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check;
      expect(done.totals.paidMinor).toBe(total); // exactly paid, never over
      expect(done.totals.dueMinor).toBe(0);
      expect(done.status).toBe("paid");
    }
    // the loop is only worth anything if it actually met the cross-partition case
    expect(capped).toBeGreaterThan(0);
  });
});

/* ------------------ KDS awareness of a settled check (E8-T2) ------------------
 * The founder's scenario: Table 3 paid and closed, but the kitchen never
 * bumped the tiramisu. The card must stay (order is not check, and the dessert
 * may be real work), it must say the check settled, it must not be counted
 * late, and the day must not seal until somebody sweeps the rail.
 */
describe("KDS and a check that already settled (E8-T2)", () => {
  /** Table 3 orders a tiramisu, it is fired, paid, and the check closes,
   *  with the dessert still sitting unbumped on the rail. */
  async function settledButUnbumped(app: ReturnType<typeof buildServer>) {
    const check = await openTable(app, "Table 3", 2);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "tiramisu", quantity: 1, seatNo: 1 } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(2) });
    const due = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check.totals.dueMinor as number;
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(3), method: "card", amountMinor: due } });
    const closed = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/close`, payload: ENV(4) });
    expect(closed.json().check.status).toBe("closed");
    return check;
  }

  it("keeps the ticket on the rail, tells the kitchen the check closed, and leaves the table free", async () => {
    const app = buildServer();
    await settledButUnbumped(app);

    // the rail still carries the work, now labelled with the check's status
    const rail = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets;
    expect(rail).toHaveLength(1);
    expect(rail[0]).toMatchObject({ tableName: "Table 3", course: "DOLCI", status: "open", checkStatus: "closed" });
    expect(rail[0].items[0].done).toBe(false);

    // and the floor does not hold the table or call it late: the guests left
    const table = (await app.inject({ method: "GET", url: "/v1/floor" })).json()
      .tables.find((t: { name: string }) => t.name === "Table 3");
    expect(table.check).toBeNull();
    expect(table.kitchenLate).toBe(false);
  });

  it("treats a paid but not yet closed check the same way", async () => {
    const app = buildServer();
    const check = await openTable(app, "Table 9", 2);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "tiramisu", quantity: 1, seatNo: 1 } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(2) });
    const due = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check.totals.dueMinor as number;
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(3), method: "card", amountMinor: due } });
    const rail = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets;
    expect(rail[0].checkStatus).toBe("paid"); // the guests settled either way
  });

  it("blocks the day close by table and course until the rail is swept", async () => {
    const app = buildServer();
    await settledButUnbumped(app);

    const blocked = await app.inject({ method: "POST", url: "/v1/day/close", payload: { ...ENV(5), managerPin: "1122" } });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().reason).toMatch(/1 kitchen ticket\(s\) still open \(Table 3 DOLCI\)/);

    // the day report names it too, so the Close screen can link to the rail
    const report = (await app.inject({ method: "GET", url: "/v1/day" })).json();
    expect(report.blockers.openKitchenTickets).toHaveLength(1);
    expect(report.blockers.openKitchenTickets[0]).toMatchObject({ tableName: "Table 3", course: "DOLCI" });

    // sweep it the way the kitchen would: bump the dessert, serve the table
    const ticket = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets[0];
    await app.inject({ method: "POST", url: "/v1/kds/toggle",
      payload: { ...ENV(6), ticketId: ticket.id, orderItemId: ticket.items[0].orderItemId } });
    const served = await app.inject({ method: "POST", url: "/v1/kds/serve", payload: { ...ENV(7), tableName: "Table 3" } });
    expect(served.statusCode).toBe(200);

    // nothing else outstanding, so the day seals
    const done = await app.inject({ method: "POST", url: "/v1/day/close", payload: { ...ENV(8), managerPin: "1122" } });
    expect(done.statusCode).toBe(200);
    expect(done.json().day.status).toBe("closed");
    expect(done.json().day.blockers.openKitchenTickets).toEqual([]);
  });

  it("does not block on a ticket the kitchen already served", async () => {
    const app = buildServer();
    const check = await openTable(app, "Table 5", 2);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "acqua", quantity: 1, seatNo: 1 } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(2) });
    const ticket = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets[0];
    await app.inject({ method: "POST", url: "/v1/kds/toggle",
      payload: { ...ENV(3), ticketId: ticket.id, orderItemId: ticket.items[0].orderItemId } });
    await app.inject({ method: "POST", url: "/v1/kds/serve", payload: { ...ENV(4), tableName: "Table 5" } });
    // still recallable, so it is still on the read, but it no longer blocks
    const report = (await app.inject({ method: "GET", url: "/v1/day" })).json();
    expect(report.blockers.openKitchenTickets).toEqual([]);
  });

  it("serves the KDS page with the settled-check chip", async () => {
    const app = buildServer();
    const kds = await app.inject({ method: "GET", url: "/kds" });
    expect(kds.statusCode).toBe(200);
    expect(kds.body).toContain("check closed");
    expect(kds.body).toContain("check paid");
    expect(kds.body).toContain("chip amber");
  });
});

interface ServerRowJson {
  serverId: string;
  serverName: string;
  checks: number;
  covers: number;
  netMinor: number;
  totalMinor: number;
  tipMinor: number;
  discountMinor: number;
  declaredTipsMinor: number;
  voidCount: number;
  voidValueMinor: number;
  courses: Record<string, number>;
  avgCheckMinor: number;
  perCoverMinor: number;
  avgTurnMinutes: number;
}

interface CellJson {
  day: number;
  hour: number;
  netMinor: number;
  checks: number;
  covers: number;
}

async function signIn(app: ReturnType<typeof buildServer>, deviceId: string, pin: string) {
  const res = await app.inject({ method: "POST", url: "/v1/session", payload: { deviceId, pin } });
  expect(res.statusCode).toBe(200);
  return res.json().employee as { id: string; name: string };
}

/** One whole lifecycle on one device: open, order, fire, pay with a tip, close. */
async function serviceCheck(
  app: ReturnType<typeof buildServer>,
  deviceId: string,
  tableName: string,
  items: readonly { itemId: string; quantity: number; seatNo: number }[],
  tipMinor: number,
) {
  const env = (n: number) => ENV(n, { deviceId });
  const open = await app.inject({ method: "POST", url: "/v1/checks", payload: { ...env(0), tableName, covers: 2 } });
  expect(open.statusCode).toBe(200);
  const id = open.json().check.id as string;
  for (const item of items) {
    const add = await app.inject({ method: "POST", url: `/v1/checks/${id}/items`, payload: { ...env(1), ...item } });
    expect(add.statusCode).toBe(200);
  }
  expect((await app.inject({ method: "POST", url: `/v1/checks/${id}/send`, payload: env(2) })).statusCode).toBe(200);
  const due = (await app.inject({ method: "GET", url: `/v1/checks/${id}` })).json().check.totals.dueMinor as number;
  const pay = await app.inject({ method: "POST", url: `/v1/checks/${id}/payments`,
    payload: { ...env(3), method: "card", amountMinor: due, tipMinor } });
  expect(pay.statusCode).toBe(200);
  const close = await app.inject({ method: "POST", url: `/v1/checks/${id}/close`, payload: env(4) });
  expect(close.statusCode).toBe(200);
  return id;
}

const GIA = "33333333-3333-3333-3333-333333333333";
const SOFIA = "77777777-7777-4777-8777-777777777777";
const BURRATA = { itemId: "burrata", quantity: 1, seatNo: 1 };
const TWO_ACQUA = { itemId: "acqua", quantity: 2, seatNo: 2 };
const TIRAMISU = { itemId: "tiramisu", quantity: 1, seatNo: 1 };

describe("insights: server attribution and the sales heatmap (E19)", () => {
  it("credits each check to the server who opened it, and conserves the day's money", async () => {
    const app = buildServer();
    await signIn(app, "dev-gia", "2468");
    await signIn(app, "dev-sofia", "3579");

    // Gia turns two tables: burrata 1600 + two acqua 1200 = 2800 net each
    await serviceCheck(app, "dev-gia", "Table 14", [BURRATA, TWO_ACQUA], 100);
    await serviceCheck(app, "dev-gia", "Table 5", [BURRATA, TWO_ACQUA], 100);
    // Sofia turns one dessert table: 1200 net
    await serviceCheck(app, "dev-sofia", "Table 3", [TIRAMISU], 100);

    const report = (await app.inject({ method: "GET", url: "/v1/insights/servers" })).json();
    const servers = report.servers as ServerRowJson[];
    expect(servers).toHaveLength(2);

    // sorted by net sales, so Gia's 5600 leads Sofia's 1200
    const [gia, sofia] = servers as [ServerRowJson, ServerRowJson];
    expect(gia).toMatchObject({
      serverId: GIA, serverName: "Gia R.", checks: 2, covers: 4,
      netMinor: 5600, tipMinor: 200, avgCheckMinor: 2800, perCoverMinor: 1400,
    });
    expect(gia.courses).toEqual({ ANTIPASTI: 3200, BEVERAGE: 2400 });
    expect(sofia).toMatchObject({
      serverId: SOFIA, serverName: "Sofia T.", checks: 1, covers: 2,
      netMinor: 1200, tipMinor: 100, avgCheckMinor: 1200, perCoverMinor: 600,
    });
    expect(sofia.courses).toEqual({ DOLCI: 1200 });
    // only the courses somebody actually sold, in the fixed menu order
    expect(report.courseKeys).toEqual(["BEVERAGE", "ANTIPASTI", "DOLCI"]);
    expect(report.average).toMatchObject({ checks: 2, covers: 3, netMinor: 3400, tipMinor: 150 });

    // CONSERVATION: the per-server sums are the day summary, split up
    const day = (await app.inject({ method: "GET", url: "/v1/day" })).json();
    expect(sum(servers.map((s) => s.netMinor))).toBe(day.summary.grossMinor - day.summary.discountMinor);
    expect(sum(servers.map((s) => s.tipMinor))).toBe(day.summary.tipsMinor);
    expect(sum(servers.map((s) => s.checks))).toBe(day.summary.checksClosed);
    expect(sum(servers.map((s) => s.covers))).toBe(day.summary.covers);

    // declared cash tips ride along from the shift, same window as the Close screen
    const out = await app.inject({ method: "POST", url: "/v1/shifts/clockout",
      payload: { ...ENV(9, { deviceId: "dev-gia" }), pin: "2468", declaredTipsMinor: 900 } });
    expect(out.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: "/v1/insights/servers" })).json();
    const day2 = (await app.inject({ method: "GET", url: "/v1/day" })).json();
    expect((after.servers as ServerRowJson[])[0]!.declaredTipsMinor).toBe(900);
    expect(sum((after.servers as ServerRowJson[]).map((s) => s.declaredTipsMinor))).toBe(day2.summary.declaredTipsMinor);
    // and the top-level total says the same thing (E19-T3), which is the
    // figure the Tips tile prints
    expect(after.declaredTipsTotalMinor).toBe(900);
    expect(after.declaredTipsTotalMinor).toBe(day2.summary.declaredTipsMinor);

    // the heatmap holds the same money, bucketed by when the checks opened
    const heat = (await app.inject({ method: "GET", url: "/v1/insights/heatmap" })).json();
    const cells = heat.cells as CellJson[];
    expect(heat.grandNetMinor).toBe(6800);
    expect(sum(cells.map((c) => c.checks))).toBe(3);
    expect(sum(cells.map((c) => c.covers))).toBe(6);
    expect(sum(cells.map((c) => c.netMinor))).toBe(6800);
    expect(sum(heat.dayTotals as number[])).toBe(6800);
    expect(heat.daysCovered).toBe(1);
    // one service, so all of it sits under today's column (index 0 = Sunday)
    expect((heat.dayTotals as number[])[new Date().getDay()]).toBe(6800);
  });

  it("counts declared tips from someone who never closed a check (E19-T3)", async () => {
    const app = buildServer();
    await signIn(app, "dev-gia", "2468");
    await signIn(app, "dev-sofia", "3579");
    await signIn(app, "dev-marco", "1122"); // Marco works the pass and the close, not a table

    await serviceCheck(app, "dev-gia", "Table 14", [BURRATA, TWO_ACQUA], 100);
    await serviceCheck(app, "dev-sofia", "Table 3", [TIRAMISU], 100);

    const clockOut = async (device: string, pin: string, declaredTipsMinor: number) => {
      const res = await app.inject({ method: "POST", url: "/v1/shifts/clockout",
        payload: { ...ENV(20, { deviceId: device }), pin, declaredTipsMinor } });
      expect(res.statusCode).toBe(200);
    };
    await clockOut("dev-gia", "2468", 500);
    await clockOut("dev-sofia", "3579", 700);
    await clockOut("dev-marco", "1122", 3400); // zero checks, so zero scorecard rows

    const report = (await app.inject({ method: "GET", url: "/v1/insights/servers" })).json();
    const servers = report.servers as ServerRowJson[];
    // the scorecard is still the people who closed checks, and each row is
    // still that person's OWN declaration: nobody carries Marco's cash
    expect(servers.map((s) => s.serverName)).toEqual(["Gia R.", "Sofia T."]);
    expect(servers.map((s) => s.declaredTipsMinor)).toEqual([500, 700]);

    // the total is every declaration in the shift window, row or no row
    const day = (await app.inject({ method: "GET", url: "/v1/day" })).json();
    expect(report.declaredTipsTotalMinor).toBe(4600);
    expect(report.declaredTipsTotalMinor).toBe(day.summary.declaredTipsMinor);
    // the drift this closes: summing the rows loses the 3400 Marco declared
    expect(sum(servers.map((s) => s.declaredTipsMinor))).toBe(1200);
    expect(report.declaredTipsTotalMinor - sum(servers.map((s) => s.declaredTipsMinor))).toBe(3400);
  });

  it("counts a voided line as a void only, never as course value or net", async () => {
    const app = buildServer();
    await signIn(app, "dev-gia", "2468");
    const env = (n: number) => ENV(n, { deviceId: "dev-gia" });

    const open = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { ...env(0), tableName: "Table 14", covers: 2 } });
    const id = open.json().check.id as string;
    await app.inject({ method: "POST", url: `/v1/checks/${id}/items`, payload: { ...env(1), ...BURRATA } });
    await app.inject({ method: "POST", url: `/v1/checks/${id}/items`, payload: { ...env(2), itemId: "acqua", quantity: 1, seatNo: 2 } });
    await app.inject({ method: "POST", url: `/v1/checks/${id}/send`, payload: env(3) });
    const acqua = (await app.inject({ method: "GET", url: `/v1/checks/${id}` })).json().check.lines
      .find((l: { capturedName: string }) => l.capturedName === "Acqua Panna");
    const voided = await app.inject({ method: "POST", url: `/v1/checks/${id}/items/${acqua.id}/void`,
      payload: { ...env(4), reason: "guest changed order", managerPin: "1122" } });
    expect(voided.statusCode).toBe(200);
    const due = (await app.inject({ method: "GET", url: `/v1/checks/${id}` })).json().check.totals.dueMinor as number;
    await app.inject({ method: "POST", url: `/v1/checks/${id}/payments`, payload: { ...env(5), method: "card", amountMinor: due } });
    await app.inject({ method: "POST", url: `/v1/checks/${id}/close`, payload: env(6) });

    const row = ((await app.inject({ method: "GET", url: "/v1/insights/servers" })).json().servers as ServerRowJson[])[0]!;
    expect(row).toMatchObject({ netMinor: 1600, voidCount: 1, voidValueMinor: 600 });
    expect(row.courses).toEqual({ ANTIPASTI: 1600 }); // no BEVERAGE: the acqua died
    const heat = (await app.inject({ method: "GET", url: "/v1/insights/heatmap" })).json();
    expect(heat.grandNetMinor).toBe(1600);
  });

  it("attributes an unsigned terminal to the seeded default, never to nobody", async () => {
    const app = buildServer();
    await serviceCheck(app, "term-nobody", "Table 9", [TIRAMISU], 0);
    const servers = (await app.inject({ method: "GET", url: "/v1/insights/servers" })).json().servers as ServerRowJson[];
    expect(servers).toHaveLength(1);
    expect(servers[0]!.serverId).toBe(GIA);
    expect(servers[0]!.serverName).toBe("Gia R.");
  });

  it("reports an empty day honestly: no rows, no average, no cells", async () => {
    const app = buildServer();
    const report = (await app.inject({ method: "GET", url: "/v1/insights/servers" })).json();
    expect(report.servers).toEqual([]);
    expect(report.average).toBeNull();
    expect(report.courseKeys).toEqual([]);
    const heat = (await app.inject({ method: "GET", url: "/v1/insights/heatmap" })).json();
    expect(heat.cells).toEqual([]);
    expect(heat.grandNetMinor).toBe(0);
    expect(heat.daysCovered).toBe(0);
    expect(heat.dayTotals).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

/* ------------------------------ guestbook (E20) ------------------------------
 * The v0 rung: a record staff attach by hand, and a profile joined out of the
 * ledger. The invariant these tests exist for: nothing about a guest is
 * stored, so attaching, merging, and deleting can never move a cent.
 */

interface GuestJson {
  id: string;
  displayName: string;
  phone?: string;
  email?: string;
  notes?: string;
  marketingOptIn: boolean;
}

interface VisitJson {
  checkId: string;
  shareMinor: number;
  sharedCheck: boolean;
  guestsOnCheck: number;
  serverName: string | null;
}

interface ProfileJson {
  guest: GuestJson;
  visitCount: number;
  serviceDates: number;
  medianGapDays: number | null;
  lastVisitAt: string | null;
  totalSpendMinor: number;
  avgSpendMinor: number;
  tipPercentAvg: number | null;
  favorites: { name: string; count: number; lastAt: string }[];
  preferredSection: { area: string; visits: number } | null;
  preferredServer: { serverId: string; serverName: string; visits: number } | null;
  visits: VisitJson[];
}

async function createGuest(app: ReturnType<typeof buildServer>, input: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/v1/guests",
    payload: { ...ENV(30, { deviceId: "dev-gia" }), ...input } });
  expect(res.statusCode).toBe(200);
  return res.json().guest as GuestJson;
}

async function attachGuest(app: ReturnType<typeof buildServer>, checkId: string, guestId: string) {
  const res = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/guests`,
    payload: { ...ENV(31, { deviceId: "dev-gia" }), guestId } });
  expect(res.statusCode).toBe(200);
  return res.json().check as { guests: { id: string; name: string }[] };
}

async function profileOf(app: ReturnType<typeof buildServer>, guestId: string) {
  const res = await app.inject({ method: "GET", url: `/v1/guests/${guestId}` });
  expect(res.statusCode).toBe(200);
  return res.json() as ProfileJson;
}

async function totalsOf(app: ReturnType<typeof buildServer>, checkId: string) {
  const res = await app.inject({ method: "GET", url: `/v1/checks/${checkId}` });
  expect(res.statusCode).toBe(200);
  return res.json().check.totals as { subtotalMinor: number; discountMinor: number; taxMinor: number; totalMinor: number; paidMinor: number; dueMinor: number; refundDueMinor: number };
}

describe("the guestbook (E20)", () => {
  it("creates, searches, attaches, and derives the profile from the ledger", async () => {
    const app = buildServer();
    await signIn(app, "dev-gia", "2468");
    const elena = await createGuest(app, { displayName: "  Elena Rossi  ", phone: "555-0100", notes: "Corner two-top" });
    expect(elena.displayName).toBe("Elena Rossi"); // trimmed
    expect(elena.marketingOptIn).toBe(false); // privacy default C6: never assumed

    // a name needs to be a name
    const blank = await app.inject({ method: "POST", url: "/v1/guests",
      payload: { ...ENV(32, { deviceId: "dev-gia" }), displayName: "   " } });
    expect(blank.statusCode).toBe(422);
    expect(blank.json().reason).toMatch(/needs a name/);

    // search is case-blind over name and phone
    const byName = await app.inject({ method: "GET", url: "/v1/guests?q=rossi" });
    expect((byName.json().guests as GuestJson[]).map((g) => g.id)).toEqual([elena.id]);
    const byPhone = await app.inject({ method: "GET", url: "/v1/guests?q=0100" });
    expect((byPhone.json().guests as GuestJson[])).toHaveLength(1);
    const miss = await app.inject({ method: "GET", url: "/v1/guests?q=nobody" });
    expect(miss.json().guests).toEqual([]);
    // an empty query lists everyone, newest first
    expect((await app.inject({ method: "GET", url: "/v1/guests" })).json().total).toBe(1);

    // burrata 1600 + two acqua 1200 = 2800 net, tax 249, total 3049, tip 500
    const checkId = await serviceCheck(app, "dev-gia", "Table 14", [BURRATA, TWO_ACQUA], 500);
    const totals = await totalsOf(app, checkId);
    expect(totals.totalMinor).toBe(3049);

    // attaching to a CLOSED check is allowed, and attaching twice is a no-op
    const attached = await attachGuest(app, checkId, elena.id);
    expect(attached.guests).toEqual([{ id: elena.id, name: "Elena Rossi" }]);
    const again = await attachGuest(app, checkId, elena.id);
    expect(again.guests).toHaveLength(1);
    // the chip rides the check reads too, so the header needs no second fetch
    const listed = (await app.inject({ method: "GET", url: "/v1/checks" })).json().checks
      .find((c: { id: string }) => c.id === checkId);
    expect(listed.guests).toEqual([{ id: elena.id, name: "Elena Rossi" }]);

    const p = await profileOf(app, elena.id);
    expect(p.visitCount).toBe(1);
    expect(p.serviceDates).toBe(1);
    expect(p.medianGapDays).toBeNull(); // one visit has no cadence
    // one guest on the check owns the whole check
    expect(p.totalSpendMinor).toBe(3049);
    expect(p.avgSpendMinor).toBe(3049);
    expect(p.visits[0]).toMatchObject({ checkId, shareMinor: 3049, sharedCheck: false, guestsOnCheck: 1, serverName: "Gia R." });
    // favorites by count, and quantity counts
    expect(p.favorites.map((f) => [f.name, f.count])).toEqual([["Acqua Panna", 2], ["Burrata e Prosciutto", 1]]);
    expect(p.preferredSection).toMatchObject({ area: "Sala", visits: 1 });
    expect(p.preferredServer).toMatchObject({ serverName: "Gia R.", visits: 1 });
    // 500 of tip on 2800 of net
    expect(p.tipPercentAvg).toBe(17.9);
    // notes are the only stored thing on the profile
    expect(p.guest.notes).toBe("Corner two-top");

    // an unknown guest cannot be attached, and an unknown guest has no profile
    const bad = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/guests`,
      payload: { ...ENV(33, { deviceId: "dev-gia" }), guestId: "11111111-1111-1111-1111-111111111111" } });
    expect(bad.statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/v1/guests/11111111-1111-1111-1111-111111111111" })).statusCode).toBe(404);

    // detach puts it back the way it was
    const detached = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/guests/${elena.id}/detach`,
      payload: ENV(34, { deviceId: "dev-gia" }) });
    expect(detached.statusCode).toBe(200);
    expect(detached.json().check.guests).toEqual([]);
    expect((await profileOf(app, elena.id)).visitCount).toBe(0);
  });

  it("splits a shared check through the domain allocators, so the shares sum to it", async () => {
    const app = buildServer();
    await signIn(app, "dev-gia", "2468");
    const marco = await createGuest(app, { displayName: "Marco Bianchi" });
    const lucia = await createGuest(app, { displayName: "Lucia Bianchi" });

    const checkId = await serviceCheck(app, "dev-gia", "Table 5", [BURRATA, TWO_ACQUA], 0);
    const totals = await totalsOf(app, checkId);
    const both = await attachGuest(app, checkId, marco.id);
    expect(both.guests).toHaveLength(1);
    expect((await attachGuest(app, checkId, lucia.id)).guests).toHaveLength(2);

    const pm = await profileOf(app, marco.id);
    const pl = await profileOf(app, lucia.id);
    // CONSERVATION: two shares of one check are that check, to the cent
    expect(pm.totalSpendMinor + pl.totalSpendMinor).toBe(totals.totalMinor);
    // the odd cent lands on exactly one of them: 1400 + 125 and 1400 + 124
    expect([pm.totalSpendMinor, pl.totalSpendMinor].sort((a, b) => b - a)).toEqual([1525, 1524]);
    for (const p of [pm, pl]) {
      expect(p.visitCount).toBe(1);
      expect(p.visits[0]).toMatchObject({ sharedCheck: true, guestsOnCheck: 2 });
      // both ate the same food, so both profiles show it
      expect(p.favorites.map((f) => f.name)).toEqual(["Acqua Panna", "Burrata e Prosciutto"]);
    }
  });

  it("conserves a discounted check across three guests", async () => {
    const app = buildServer();
    await signIn(app, "dev-gia", "2468");
    const env = (n: number) => ENV(n, { deviceId: "dev-gia" });
    const guests = [];
    for (const name of ["Aldo", "Bruna", "Carlo"]) guests.push(await createGuest(app, { displayName: name }));

    // burrata 1600 + two acqua 1200, less a 400 discount: taxable 2400,
    // tax 213, total 2613, which does not divide evenly by three
    const open = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { ...env(80), tableName: "Table 7", covers: 3 } });
    const checkId = open.json().check.id as string;
    await app.inject({ method: "POST", url: `/v1/checks/${checkId}/items`, payload: { ...env(81), ...BURRATA } });
    await app.inject({ method: "POST", url: `/v1/checks/${checkId}/items`, payload: { ...env(82), ...TWO_ACQUA } });
    await app.inject({ method: "POST", url: `/v1/checks/${checkId}/send`, payload: env(83) });
    const disc = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/adjustments`,
      payload: { ...env(84), amountMinor: 400, label: "Regular guest", reason: "weekly regular", managerPin: "1122" } });
    expect(disc.statusCode).toBe(200);
    const due = (await totalsOf(app, checkId)).dueMinor;
    await app.inject({ method: "POST", url: `/v1/checks/${checkId}/payments`, payload: { ...env(85), method: "card", amountMinor: due } });
    await app.inject({ method: "POST", url: `/v1/checks/${checkId}/close`, payload: env(86) });
    const totals = await totalsOf(app, checkId);
    expect(totals.totalMinor).toBe(2613);

    for (const g of guests) await attachGuest(app, checkId, g.id);
    const shares = [];
    for (const g of guests) shares.push((await profileOf(app, g.id)).totalSpendMinor);
    // CONSERVATION with a discount in play and three ways to divide it
    expect(shares.reduce((a, s) => a + s, 0)).toBe(totals.totalMinor);
    expect(shares).toEqual([871, 871, 871]);
    // every profile agrees the check was shared three ways
    for (const g of guests) {
      expect((await profileOf(app, g.id)).visits[0]).toMatchObject({ sharedCheck: true, guestsOnCheck: 3 });
    }
  });

  it("counts neither a voided line nor an open check", async () => {
    const app = buildServer();
    await signIn(app, "dev-gia", "2468");
    const vera = await createGuest(app, { displayName: "Vera Conti" });
    const env = (n: number) => ENV(n, { deviceId: "dev-gia" });

    // a closed check whose acqua was voided after firing
    const open = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { ...env(40), tableName: "Table 14", covers: 2 } });
    const closedId = open.json().check.id as string;
    await app.inject({ method: "POST", url: `/v1/checks/${closedId}/items`, payload: { ...env(41), ...BURRATA } });
    await app.inject({ method: "POST", url: `/v1/checks/${closedId}/items`, payload: { ...env(42), itemId: "acqua", quantity: 1, seatNo: 2 } });
    await app.inject({ method: "POST", url: `/v1/checks/${closedId}/send`, payload: env(43) });
    const acqua = (await app.inject({ method: "GET", url: `/v1/checks/${closedId}` })).json().check.lines
      .find((l: { capturedName: string }) => l.capturedName === "Acqua Panna");
    const voided = await app.inject({ method: "POST", url: `/v1/checks/${closedId}/items/${acqua.id}/void`,
      payload: { ...env(44), reason: "guest changed order", managerPin: "1122" } });
    expect(voided.statusCode).toBe(200);
    const due = (await totalsOf(app, closedId)).dueMinor;
    await app.inject({ method: "POST", url: `/v1/checks/${closedId}/payments`, payload: { ...env(45), method: "card", amountMinor: due } });
    await app.inject({ method: "POST", url: `/v1/checks/${closedId}/close`, payload: env(46) });
    const closedTotal = (await totalsOf(app, closedId)).totalMinor;
    await attachGuest(app, closedId, vera.id);

    // and an open check she is also sitting at right now
    const openCheck = await openTable(app, "Table 5", 2);
    await app.inject({ method: "POST", url: `/v1/checks/${openCheck.id}/items`, payload: { ...env(47), ...TIRAMISU } });
    await app.inject({ method: "POST", url: `/v1/checks/${openCheck.id}/send`, payload: env(48) });
    await attachGuest(app, openCheck.id, vera.id);

    const p = await profileOf(app, vera.id);
    expect(p.visitCount).toBe(1); // the open table is not a visit yet
    expect(p.totalSpendMinor).toBe(closedTotal);
    // no acqua (voided, never eaten) and no tiramisu (still on an open check)
    expect(p.favorites.map((f) => f.name)).toEqual(["Burrata e Prosciutto"]);
  });

  it("merges two records for the same person without moving a cent", async () => {
    const app = buildServer();
    await signIn(app, "dev-gia", "2468");
    const survivor = await createGuest(app, { displayName: "Elena Rossi", notes: "Barolo, corner two-top" });
    const dupe = await createGuest(app, { displayName: "E. Rossi", phone: "555-0199", notes: "No shellfish" });

    const c1 = await serviceCheck(app, "dev-gia", "Table 14", [BURRATA], 0);
    const c2 = await serviceCheck(app, "dev-gia", "Table 5", [TIRAMISU], 0);
    await attachGuest(app, c1, survivor.id);
    await attachGuest(app, c2, dupe.id);
    const before1 = await totalsOf(app, c1);
    const before2 = await totalsOf(app, c2);

    // a server's PIN cannot destroy a record
    const refused = await app.inject({ method: "POST", url: `/v1/guests/${survivor.id}/merge`,
      payload: { ...ENV(50, { deviceId: "dev-gia" }), absorbedId: dupe.id, managerPin: "2468" } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().reason).toMatch(/not recognized as a manager/);
    // and nobody can absorb themselves
    const self = await app.inject({ method: "POST", url: `/v1/guests/${survivor.id}/merge`,
      payload: { ...ENV(51, { deviceId: "dev-gia" }), absorbedId: survivor.id, managerPin: "1122" } });
    expect(self.statusCode).toBe(422);

    const merged = await app.inject({ method: "POST", url: `/v1/guests/${survivor.id}/merge`,
      payload: { ...ENV(52, { deviceId: "dev-gia" }), absorbedId: dupe.id, managerPin: "1122" } });
    expect(merged.statusCode).toBe(200);
    // the audit carries the actor's approval and both names
    expect(merged.json().audit).toMatchObject({
      action: "merge_guests",
      survivor: { displayName: "Elena Rossi" },
      absorbed: { displayName: "E. Rossi" },
      checksRepointed: 1,
      approvedBy: "66666666-6666-4666-8666-666666666666", // Marco B.
    });

    // the survivor's history now spans both visits, and the absorbed record is gone
    const p = await profileOf(app, survivor.id);
    expect(p.visitCount).toBe(2);
    expect(p.totalSpendMinor).toBe(before1.totalMinor + before2.totalMinor);
    expect(p.favorites.map((f) => f.name).sort()).toEqual(["Burrata e Prosciutto", "Tiramisu della Casa"]);
    expect((await app.inject({ method: "GET", url: `/v1/guests/${dupe.id}` })).statusCode).toBe(404);
    // notes append rather than vanish, and the survivor takes the phone it lacked
    expect(p.guest.notes).toBe("Barolo, corner two-top\nNo shellfish");
    expect(p.guest.phone).toBe("555-0199");
    // the repointed check now shows the survivor on its header
    const c2After = await app.inject({ method: "GET", url: `/v1/checks/${c2}` });
    expect(c2After.json().check.guests).toEqual([{ id: survivor.id, name: "Elena Rossi" }]);
    // and no check moved: history is a join, not a copy
    expect(await totalsOf(app, c1)).toEqual(before1);
    expect(await totalsOf(app, c2)).toEqual(before2);
  });

  it("honors a deletion request: identity and links go, the checks stay", async () => {
    const app = buildServer();
    await signIn(app, "dev-gia", "2468");
    const guest = await createGuest(app, { displayName: "Delete Me", phone: "555-0000" });
    const checkId = await serviceCheck(app, "dev-gia", "Table 14", [BURRATA], 0);
    await attachGuest(app, checkId, guest.id);
    const before = await totalsOf(app, checkId);

    // a server's PIN is refused
    const refused = await app.inject({ method: "POST", url: `/v1/guests/${guest.id}/delete`,
      payload: { ...ENV(60, { deviceId: "dev-gia" }), managerPin: "2468" } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().reason).toMatch(/not recognized as a manager/);

    const deleted = await app.inject({ method: "POST", url: `/v1/guests/${guest.id}/delete`,
      payload: { ...ENV(61, { deviceId: "dev-gia" }), managerPin: "1122" } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().audit).toMatchObject({ action: "delete_guest", linksDropped: 1 });

    // identity gone, links gone
    expect((await app.inject({ method: "GET", url: `/v1/guests/${guest.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/guests?q=Delete" })).json().guests).toEqual([]);
    // check intact, to the cent, and simply no longer pointing at a person
    const after = await app.inject({ method: "GET", url: `/v1/checks/${checkId}` });
    expect(after.statusCode).toBe(200);
    expect(after.json().check.totals).toEqual(before);
    expect(after.json().check.guests).toEqual([]);
    // and the day still reports the same money
    const day = (await app.inject({ method: "GET", url: "/v1/day" })).json();
    expect(day.summary.grossMinor).toBe(before.subtotalMinor);
  });

  it("edits a record, clearing a field with an empty string", async () => {
    const app = buildServer();
    await signIn(app, "dev-gia", "2468");
    const guest = await createGuest(app, { displayName: "Ada Ferrari", phone: "555-0111", notes: "window" });
    const updated = await app.inject({ method: "POST", url: `/v1/guests/${guest.id}/update`,
      payload: { ...ENV(70, { deviceId: "dev-gia" }), notes: "window, still water", phone: "", marketingOptIn: true } });
    expect(updated.statusCode).toBe(200);
    const after = updated.json().guest as GuestJson;
    expect(after.notes).toBe("window, still water");
    expect(after.phone).toBeUndefined(); // cleared on request
    expect(after.marketingOptIn).toBe(true);
    expect(after.displayName).toBe("Ada Ferrari"); // untouched fields stay
    // and a rename still refuses a blank name
    const blank = await app.inject({ method: "POST", url: `/v1/guests/${guest.id}/update`,
      payload: { ...ENV(71, { deviceId: "dev-gia" }), displayName: " " } });
    expect(blank.statusCode).toBe(422);
  });
});

/* --------------------- reopen close-out (E2-T2) ---------------------
 * The founder's dead end: a check that paid in full, closed, and got
 * reopened had no way back out. close wanted `paid`, `paid` wanted another
 * payment, and a settled check has nothing left to pay, so the table stayed
 * occupied and the day could not close. These tests are the three roads out
 * of a reopened check: unchanged, cheaper, dearer.
 */

async function reopen(app: ReturnType<typeof buildServer>, checkId: string, pin = "1122") {
  return app.inject({ method: "POST", url: `/v1/checks/${checkId}/reopen`,
    payload: { ...ENV(90), managerPin: pin } });
}

async function sweepRail(app: ReturnType<typeof buildServer>, tableName: string) {
  const tickets = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets as
    { id: string; tableName: string; items: { orderItemId: string; voided?: boolean }[] }[];
  for (const t of tickets.filter((x) => x.tableName === tableName)) {
    for (const i of t.items) {
      if (i.voided) continue;
      await app.inject({ method: "POST", url: "/v1/kds/toggle",
        payload: { ...ENV(91), ticketId: t.id, orderItemId: i.orderItemId } });
    }
  }
  await app.inject({ method: "POST", url: "/v1/kds/serve", payload: { ...ENV(92), tableName } });
}

describe("a reopened check can always close out (E2-T2)", () => {
  it("closes again with no new payment, frees the table, and lets the day seal", async () => {
    const app = buildServer(); // nobody signs in, so no shift blocks the day close
    const checkId = await serviceCheck(app, "term-1", "Table 2", [BURRATA, TWO_ACQUA], 0);
    const settled = await totalsOf(app, checkId);
    expect(settled.dueMinor).toBe(0);
    expect(settled.refundDueMinor).toBe(0);

    const back = await reopen(app, checkId);
    expect(back.statusCode).toBe(200);
    expect(back.json().check.status).toBe("reopened");

    // the old dead end: nothing is owed, so there is no payment to record,
    // and a payment was the only road to a state close would accept
    const chargeNothing = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/payments`,
      payload: { ...ENV(93), method: "card", amountMinor: 0 } });
    expect(chargeNothing.statusCode).toBe(422);
    expect(chargeNothing.json().reason).toMatch(/positive integer/);

    // and the way out: the check simply closes, no PIN, no payment
    const closed = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/close`, payload: ENV(94) });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().check.status).toBe("closed");
    expect(closed.json().refundDueMinor).toBeUndefined();
    // the payments list is append-only and nobody touched it
    expect(closed.json().check.payments).toHaveLength(1);
    expect(closed.json().check.totals).toEqual(settled);

    // the table is free on the floor again
    const floor = (await app.inject({ method: "GET", url: "/v1/floor" })).json().tables;
    expect(floor.find((t: { name: string }) => t.name === "Table 2").check).toBeNull();

    // and the day can actually seal, which is what the founder could not do
    const day = (await app.inject({ method: "GET", url: "/v1/day" })).json();
    expect(day.blockers.openChecks).toEqual([]);
    await sweepRail(app, "Table 2");
    const dayClose = await app.inject({ method: "POST", url: "/v1/day/close",
      payload: { ...ENV(95), managerPin: "1122" } });
    expect(dayClose.statusCode).toBe(200);
    expect(dayClose.json().day.status).toBe("closed");
    expect(dayClose.json().day.summary.checksClosed).toBe(1);
  });

  it("books a refund when a correction leaves the guest overpaid, manager only", async () => {
    const app = buildServer();
    const checkId = await serviceCheck(app, "term-1", "Table 5", [BURRATA, TWO_ACQUA], 0);
    const paidTotals = await totalsOf(app, checkId);
    expect(paidTotals.totalMinor).toBe(3049); // 2800 + 249 tax
    await reopen(app, checkId);

    // the acqua never arrived, so it comes off: 1600 + 142 tax = 1742 owed,
    // against 3049 already taken
    const acqua = (await app.inject({ method: "GET", url: `/v1/checks/${checkId}` })).json().check.lines
      .find((l: { capturedName: string }) => l.capturedName === "Acqua Panna");
    const voided = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/items/${acqua.id}/void`,
      payload: { ...ENV(96), reason: "never arrived", managerPin: "1122" } });
    expect(voided.statusCode).toBe(200);
    const after = await totalsOf(app, checkId);
    expect(after.totalMinor).toBe(1742);
    expect(after.paidMinor).toBe(3049);
    expect(after.dueMinor).toBe(0); // due never goes negative
    expect(after.refundDueMinor).toBe(1307); // the house owes this back

    // closing books an obligation, so it is not a PIN-free act
    const noPin = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/close`, payload: ENV(97) });
    expect(noPin.statusCode).toBe(422);
    expect(noPin.json().reason).toMatch(/overpaid by 1307/);
    const serverPin = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/close`,
      payload: { ...ENV(98), managerPin: "2468" } });
    expect(serverPin.statusCode).toBe(422);
    expect(serverPin.json().reason).toMatch(/not recognized as a manager/);

    const closed = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/close`,
      payload: { ...ENV(99), managerPin: "1122" } });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().check.status).toBe("closed");
    expect(closed.json().refundDueMinor).toBe(1307);
    expect(closed.json().audit).toMatchObject({
      action: "refund_due",
      refundDueMinor: 1307,
      approvedBy: "66666666-6666-4666-8666-666666666666", // Marco B.
    });
    // the close moved no money: same payment, same totals, refund still stated
    expect(closed.json().check.payments).toHaveLength(1);
    expect(closed.json().check.payments[0].amountMinor).toBe(3049);
    expect(closed.json().check.totals).toEqual(after);

    // a closed check carrying a refund is settled paperwork, not an open item
    const day = (await app.inject({ method: "GET", url: "/v1/day" })).json();
    expect(day.blockers.openChecks).toEqual([]);
    expect(day.summary.checksClosed).toBe(1);
  });

  it("collects the difference first when a correction raises the total", async () => {
    const app = buildServer();
    const checkId = await serviceCheck(app, "term-1", "Table 14", [BURRATA, TWO_ACQUA], 0);
    await reopen(app, checkId);

    // the table orders a dessert after the check was settled
    await app.inject({ method: "POST", url: `/v1/checks/${checkId}/items`,
      payload: { ...ENV(100), ...TIRAMISU } });
    const owing = await totalsOf(app, checkId);
    expect(owing.totalMinor).toBe(4355);
    expect(owing.dueMinor).toBe(1306);

    // no free lunch: the close refuses and names the number
    const refused = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/close`, payload: ENV(101) });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().reason).toMatch(/no longer cover the total/);
    expect(refused.json().reason).toMatch(/1306 still due/);
    // and a manager PIN is not a way around it either
    const withPin = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/close`,
      payload: { ...ENV(102), managerPin: "1122" } });
    expect(withPin.statusCode).toBe(422);

    // the ordinary path: fire it, take the difference, close
    await app.inject({ method: "POST", url: `/v1/checks/${checkId}/send`, payload: ENV(103) });
    const pay = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/payments`,
      payload: { ...ENV(104), method: "card", amountMinor: 1306 } });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().check.status).toBe("paid");
    const closed = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/close`, payload: ENV(105) });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().check.status).toBe("closed");
    expect(closed.json().check.payments).toHaveLength(2);
    expect(closed.json().check.totals.paidMinor).toBe(4355);
    expect(closed.json().refundDueMinor).toBeUndefined();
  });

  it("still refuses to close what was never paid at all", async () => {
    const app = buildServer();
    const check = await openTable(app, "Table 9", 2);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(106), ...BURRATA } });
    const refused = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/close`, payload: ENV(107) });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().reason).toMatch(/only a paid or reopened check can close/);
  });

  it("serves the POS with the close-out controls (E2-T2)", async () => {
    const app = buildServer();
    const pos = await app.inject({ method: "GET", url: "/pos" });
    expect(pos.body).toContain("Close check ✓");
    expect(pos.body).toContain("Close + refund due");
    expect(pos.body).toContain('id="ovClose"');
    expect(pos.body).toContain("Refund due to guest");
    expect(pos.body).toContain("closableNow");
  });
});

/* ------------------- courses: hold and fire (E8-T3) -------------------
 * Real service is coursed. Send used to fire the whole order at once, so a
 * table that wanted its secondi held had no way to say so. The mockup's Hold
 * and Fire now chips are the spec; these are their commands.
 */

const CHIANTI = { itemId: "chianti", quantity: 1, seatNo: 1, modifiers: [{ groupId: "size", modifierId: "glass" }] };
const RAGU = { itemId: "ragu", quantity: 1, seatNo: 2, modifiers: [{ groupId: "pasta", modifierId: "spag" }] };
const BISTECCA = { itemId: "bistecca", quantity: 1, seatNo: 2, modifiers: [{ groupId: "temp", modifierId: "mr" }] };

async function addLine(app: ReturnType<typeof buildServer>, checkId: string, item: Record<string, unknown>, n = 1) {
  const res = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/items`, payload: { ...ENV(120 + n), ...item } });
  expect(res.statusCode).toBe(200);
  return res;
}

async function courseCmd(app: ReturnType<typeof buildServer>, checkId: string, action: string, course: string) {
  return app.inject({ method: "POST", url: `/v1/checks/${checkId}/${action}`, payload: { ...ENV(130), course } });
}

/** A four-course check: beverage, antipasti, primi, secondi, nothing fired. */
async function coursedCheck(app: ReturnType<typeof buildServer>, tableName = "Table 7") {
  const check = await openTable(app, tableName, 4);
  await addLine(app, check.id, CHIANTI, 1);
  await addLine(app, check.id, BURRATA, 2);
  await addLine(app, check.id, RAGU, 3);
  await addLine(app, check.id, BISTECCA, 4);
  return check.id;
}

const kindsOf = (entries: { kind: string }[]) => entries.map((e) => e.kind);

describe("per-course hold and fire (E8-T3)", () => {
  it("holds a course back from Send, and a held line still blocks payment", async () => {
    const app = buildServer();
    const checkId = await coursedCheck(app);

    const held = await courseCmd(app, checkId, "hold", "SECONDI");
    expect(held.statusCode).toBe(200);
    expect(held.json().check.heldCourses).toEqual(["SECONDI"]);
    expect(held.json().note).toBe("SECONDI held, 1 item(s) waiting");

    const sent = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/send`, payload: ENV(131) });
    expect(sent.statusCode).toBe(200);
    // three courses went, and the response says what stayed behind
    expect((sent.json().tickets as { course: string }[]).map((t) => t.course).sort())
      .toEqual(["ANTIPASTI", "BEVERAGE", "PRIMI"]);
    expect(sent.json().note).toBe("SECONDI held, 1 item(s) waiting");

    // the kitchen never heard about the secondi
    const rail = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets as { course: string }[];
    expect(rail.map((t) => t.course).sort()).toEqual(["ANTIPASTI", "BEVERAGE", "PRIMI"]);

    const lines = sent.json().check.lines as { capturedName: string; status: string }[];
    expect(lines.find((l) => l.capturedName === "Bistecca Fiorentina")!.status).toBe("unsent");
    expect(lines.filter((l) => l.status === "sent")).toHaveLength(3);

    // a held line is an unsent line, so FR-26 still bites
    const pay = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/payments`,
      payload: { ...ENV(132), method: "card", amountMinor: 1000 } });
    expect(pay.statusCode).toBe(422);
    expect(pay.json().reason).toMatch(/unsent/);

    // and Send again refuses rather than quietly doing nothing
    const again = await app.inject({ method: "POST", url: `/v1/checks/${checkId}/send`, payload: ENV(133) });
    expect(again.statusCode).toBe(422);
    expect(again.json().reason).toMatch(/everything unsent is held: SECONDI/);
  });

  it("fires exactly one course, clears its hold, and refuses a second fire", async () => {
    const app = buildServer();
    const checkId = await coursedCheck(app, "Table 12");
    await courseCmd(app, checkId, "hold", "SECONDI");
    await app.inject({ method: "POST", url: `/v1/checks/${checkId}/send`, payload: ENV(134) });

    const fired = await courseCmd(app, checkId, "fire", "SECONDI");
    expect(fired.statusCode).toBe(200);
    expect(fired.json().note).toBe("SECONDI fired to kitchen, 1 item(s)");
    // one ticket, that course only, and the hold is gone
    expect(fired.json().tickets).toHaveLength(1);
    expect(fired.json().tickets[0].course).toBe("SECONDI");
    expect(fired.json().tickets[0].items).toHaveLength(1);
    expect(fired.json().check.heldCourses).toEqual([]);
    expect((fired.json().check.lines as { status: string }[]).every((l) => l.status === "sent")).toBe(true);

    const twice = await courseCmd(app, checkId, "fire", "SECONDI");
    expect(twice.statusCode).toBe(422);
    expect(twice.json().reason).toBe("nothing unsent in SECONDI to fire");

    // lowercase from a client still finds the course, so no ghost holds
    const lower = await courseCmd(app, checkId, "hold", "dolci");
    expect(lower.statusCode).toBe(200);
    expect(lower.json().check.heldCourses).toEqual(["DOLCI"]);
    const nonsense = await courseCmd(app, checkId, "hold", "PUDDING");
    expect(nonsense.statusCode).toBe(422);
    expect(nonsense.json().reason).toMatch(/unknown course PUDDING/);
  });

  it("refuses a Send with every course held, naming them", async () => {
    const app = buildServer();
    const check = await openTable(app, "Table 14", 2);
    await addLine(app, check.id, { itemId: "acqua", quantity: 2, seatNo: 1 }, 1);
    await addLine(app, check.id, TIRAMISU, 2);
    await courseCmd(app, check.id, "hold", "BEVERAGE");
    await courseCmd(app, check.id, "hold", "DOLCI");

    const blocked = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(135) });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().reason).toMatch(/everything unsent is held: BEVERAGE, DOLCI/);

    // releasing without firing puts it back in the next Send
    const released = await courseCmd(app, check.id, "release", "BEVERAGE");
    expect(released.statusCode).toBe(200);
    expect(released.json().check.heldCourses).toEqual(["DOLCI"]);
    expect(released.json().note).toMatch(/BEVERAGE released/);
    const sent = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(136) });
    expect(sent.statusCode).toBe(200);
    expect((sent.json().tickets as { course: string }[]).map((t) => t.course)).toEqual(["BEVERAGE"]);
    expect(sent.json().note).toBe("DOLCI held, 1 item(s) waiting");
    // releasing a course that was not held says so instead of pretending
    const idle = await courseCmd(app, check.id, "release", "PRIMI");
    expect(idle.statusCode).toBe(200);
    expect(idle.json().note).toBe("PRIMI was not held");
  });

  it("tells the check's story back, in order, with nothing invented", async () => {
    const app = buildServer();
    await signIn(app, "dev-gia", "2468");
    const check = await openTable(app, "Table 3", 2);
    const env = (n: number) => ENV(140 + n);

    await addLine(app, check.id, BURRATA, 1);
    await addLine(app, check.id, TIRAMISU, 2);
    await courseCmd(app, check.id, "hold", "DOLCI");
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: env(1) });
    const dolci = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check.lines
      .find((l: { capturedName: string }) => l.capturedName === "Tiramisu della Casa");
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items/${dolci.id}/void`,
      payload: { ...env(2), reason: "guest skipped dessert", managerPin: "1122" } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/adjustments`,
      payload: { ...env(3), amountMinor: 200, label: "Regular guest", reason: "weekly regular", managerPin: "1122" } });
    const due = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check.totals.dueMinor;
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/payments`,
      payload: { ...env(4), method: "card", amountMinor: due, tipMinor: 300 } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/close`, payload: env(5) });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/reopen`, payload: { ...env(6), managerPin: "1122" } });
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/close`, payload: env(7) });

    const res = await app.inject({ method: "GET", url: `/v1/checks/${check.id}/history` });
    expect(res.statusCode).toBe(200);
    const story = res.json() as { checkNo: number; heldCourses: string[]; entries: { at: string; kind: string; summary: string }[] };
    const kinds = kindsOf(story.entries);

    expect(kinds[0]).toBe("opened");
    expect(story.entries[0]!.summary).toMatch(/opened on Table 3, 2 cover\(s\) by Gia R\./);
    for (const kind of ["item_added", "course_held", "fired", "voided", "adjustment", "payment", "reopened", "closed"]) {
      expect(kinds, `history is missing ${kind}`).toContain(kind);
    }
    // a hold is not a dispatch, so the held course never shows a fire
    expect(story.entries.filter((e) => e.kind === "fired").map((e) => e.summary))
      .toEqual(["ANTIPASTI fired to kitchen, 1 item(s)"]);
    expect(story.entries.find((e) => e.kind === "voided")!.summary)
      .toMatch(/Tiramisu della Casa voided: guest skipped dessert/);
    expect(story.entries.find((e) => e.kind === "payment")!.summary).toMatch(/paid \$\d+\.\d\d by card plus \$3\.00 tip/);
    // in order, and every timestamp inside the life of the check
    const times = story.entries.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBeLessThanOrEqual(times[times.length - 1]!);
    expect(times[times.length - 1]).toBeLessThanOrEqual(Date.now() + 1000);
    // the reopen sits before the close it caused
    expect(kinds.lastIndexOf("reopened")).toBeLessThan(kinds.lastIndexOf("closed"));
    // the still-held course rides along, and an unknown check has no story
    expect(story.heldCourses).toEqual(["DOLCI"]);
    expect((await app.inject({ method: "GET", url: "/v1/checks/11111111-1111-1111-1111-111111111111/history" })).statusCode).toBe(404);
  });

  it("keeps its hands off closed checks", async () => {
    const app = buildServer();
    const checkId = await serviceCheck(app, "term-1", "Table 2", [BURRATA], 0);
    for (const action of ["hold", "release", "fire"]) {
      const res = await courseCmd(app, checkId, action, "DOLCI");
      expect(res.statusCode).toBe(422);
      expect(res.json().reason).toMatch(/on a closed check/);
    }
  });
});

/* --------------- the payroll hours export (E24-T3) ---------------
   Rung 3 of the D28 ladder, and the point of it is what it does NOT do.
   Every assertion below is about hours and declared tips; not one of them
   is about money owed, because this system never works that out. */
describe("the payroll hours export (E24-T3)", () => {
  const MGR = "1122";
  const GIA = "33333333-3333-3333-3333-333333333333";
  const MARCO = "66666666-6666-4666-8666-666666666666";
  const SOFIA = "77777777-7777-4777-8777-777777777777";
  const HEADER = "employee_id,employee_name,title,period_start,period_end,regular_hours,declared_tips,shift_count";
  const POSTURE = "# hours and declared tips only; wage, overtime, and tax rules are the payroll provider's";

  /** a local-time instant, because the whole calendar runs on server-local */
  const at = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

  const shift = (id: string, name: string, clockIn: string, clockOut?: string, tips?: number): Shift => ({
    id: `sh-${id}-${clockIn}`, employeeId: id, employeeName: name, clockIn,
    ...(clockOut ? { clockOut } : {}),
    ...(tips !== undefined ? { declaredTipsMinor: tips } : {}),
  });

  /** a server whose clock records are planted rather than lived through, so a
   *  period boundary can actually be crossed inside a test */
  const withShifts = async (shifts: Shift[]) => {
    const store = new MemoryStore();
    await store.init();
    for (const s of shifts) await store.putShift(s);
    return buildServer(store);
  };

  /** The owner's PIN, because WHEN the venue pays is part of its identity and
   *  D33 made identity the owner's (E25-T1). Exporting the file is still a
   *  manager's, which is the split the export tests below lean on. */
  const setPeriod = (app: ReturnType<typeof buildServer>, n: number, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/venue", payload: { ...ENV(n), managerPin: "1379", ...body } });

  // null means "send no PIN at all": passing undefined would take the default
  const csvFor = async (app: ReturnType<typeof buildServer>, periodEnd?: string, pin: string | null = MGR) => {
    const res = await app.inject({ method: "POST", url: "/v1/staff/hours-export",
      payload: { ...(pin === null ? {} : { managerPin: pin }), ...(periodEnd ? { periodEnd } : {}) } });
    return { code: res.statusCode, type: res.headers["content-type"] as string,
      disposition: res.headers["content-disposition"] as string,
      lines: res.statusCode === 200 ? res.body.trimEnd().split("\n") : [], raw: res.body };
  };

  it("finds the right period at every month edge, for all three kinds", () => {
    const venue = (payPeriod: Venue["payPeriod"], payPeriodAnchor = "2026-01-05"): Venue =>
      ({ ...VENUE, payPeriod, payPeriodAnchor });

    // twice a month: the 1st to the 15th, then the 16th to whatever the month
    // happens to end on, which is where a hand-rolled calendar goes wrong
    const semi = venue("semimonthly");
    expect(periodContaining(semi, "2026-02-14")).toEqual({ start: "2026-02-01", end: "2026-02-15" });
    expect(periodContaining(semi, "2026-02-16")).toEqual({ start: "2026-02-16", end: "2026-02-28" }); // 28 days
    expect(periodContaining(semi, "2028-02-20")).toEqual({ start: "2028-02-16", end: "2028-02-29" }); // leap year
    expect(periodContaining(semi, "2026-01-31")).toEqual({ start: "2026-01-16", end: "2026-01-31" }); // 31 days
    expect(periodContaining(semi, "2026-04-30")).toEqual({ start: "2026-04-16", end: "2026-04-30" }); // 30 days

    // weekly and biweekly count from the anchor and do not care about months
    const weekly = venue("weekly");
    expect(periodContaining(weekly, "2026-01-05")).toEqual({ start: "2026-01-05", end: "2026-01-11" });
    expect(periodContaining(weekly, "2026-02-02")).toEqual({ start: "2026-02-02", end: "2026-02-08" });
    // a date BEFORE the anchor belongs to the cycle that ran before it, which
    // is the case a truncating division silently gets wrong
    expect(periodContaining(weekly, "2026-01-04")).toEqual({ start: "2025-12-29", end: "2026-01-04" });

    const bi = venue("biweekly");
    expect(periodContaining(bi, "2026-01-19")).toEqual({ start: "2026-01-19", end: "2026-02-01" }); // over a month end
    expect(lastCompletedPeriod(bi, "2026-01-20")).toEqual({ start: "2026-01-05", end: "2026-01-18" });
    // today's period is never the answer: it is still being worked
    expect(lastCompletedPeriod(bi, "2026-01-18")).toEqual({ start: "2025-12-22", end: "2026-01-04" });
  });

  it("exports the period as CSV, one row per employee who worked", async () => {
    const app = await withShifts([
      shift(GIA, "Gia R.", at(2026, 3, 3, 16), at(2026, 3, 3, 23, 30), 12_000),
      shift(GIA, "Gia R.", at(2026, 3, 4, 17), at(2026, 3, 4, 22), 8_000),
      shift(SOFIA, "Sofia T.", at(2026, 3, 5, 18), at(2026, 3, 5, 23, 15), 4_550),
    ]);
    await setPeriod(app, 1, { payPeriod: "weekly", payPeriodAnchor: "2026-03-02" });
    // a title set on rung 1 flows into the file; one nobody typed stays blank,
    // because a payroll file should carry what a manager wrote, not a fallback
    await app.inject({ method: "POST", url: `/v1/staff/${GIA}`,
      payload: { ...ENV(2), managerPin: MGR, title: "Bartender" } });

    const { code, type, disposition, lines } = await csvFor(app, "2026-03-08");
    expect(code).toBe(200);
    expect(type).toContain("text/csv");
    expect(disposition).toBe('attachment; filename="hours-2026-03-02-to-2026-03-08.csv"');

    expect(lines).toEqual([
      HEADER,
      `${GIA},Gia R.,Bartender,2026-03-02,2026-03-08,12.50,200.00,2`,
      `${SOFIA},Sofia T.,,2026-03-02,2026-03-08,5.25,45.50,1`,
      POSTURE,
    ]);
    // Marco worked none of it, so he is not in the file at all
    expect(lines.some((l) => l.includes(MARCO))).toBe(false);

    // the absence that IS the specification: no overtime column, anywhere
    expect(lines[0]).not.toContain("overtime");
    for (const forbidden of ["wage", "rate", "gross", "net_pay", "tax"]) {
      expect(lines[0], `${forbidden} has no business in this file`).not.toContain(forbidden);
    }
  });

  it("splits a shift that runs past midnight into the period each half falls in", async () => {
    const app = await withShifts([
      // on at 8pm on payday, off at 2am the next morning: 4 hours this period,
      // 2 hours the next, and not one of them counted twice
      shift(GIA, "Gia R.", at(2026, 3, 8, 20), at(2026, 3, 9, 2), 9_000),
    ]);
    await setPeriod(app, 1, { payPeriod: "weekly", payPeriodAnchor: "2026-03-02" });

    const first = (await csvFor(app, "2026-03-08")).lines[1]!.split(",");
    expect(first.slice(3, 8)).toEqual(["2026-03-02", "2026-03-08", "4.00", "90.00", "1"]);

    const second = (await csvFor(app, "2026-03-09")).lines[1]!.split(",");
    // the hours follow the clock, but the declared tips do NOT get split: one
    // amount was declared once, and halving it would be inventing a figure
    expect(second.slice(3, 8)).toEqual(["2026-03-09", "2026-03-15", "2.00", "0.00", "1"]);
  });

  it("names an open shift in a footer instead of quietly paying it short", async () => {
    const app = await withShifts([
      shift(SOFIA, "Sofia T.", at(2026, 3, 3, 17), at(2026, 3, 3, 22), 5_000),
      shift(GIA, "Gia R.", at(2026, 3, 4, 16)), // still on the clock
    ]);
    await setPeriod(app, 1, { payPeriod: "weekly", payPeriodAnchor: "2026-03-02" });

    const { lines } = await csvFor(app, "2026-03-08");
    expect(lines).toEqual([
      HEADER,
      `${SOFIA},Sofia T.,,2026-03-02,2026-03-08,5.00,50.00,1`,
      `# 1 open shift excluded: Gia R., clocked in ${at(2026, 3, 4, 16)}`,
      POSTURE,
    ]);
    // she is named, and she is NOT given a row with a truncated total
    expect(lines.some((l) => l.startsWith(GIA))).toBe(false);

    const two = await withShifts([
      shift(GIA, "Gia R.", at(2026, 3, 4, 16)),
      shift(SOFIA, "Sofia T.", at(2026, 3, 5, 16)),
    ]);
    await setPeriod(two, 2, { payPeriod: "weekly", payPeriodAnchor: "2026-03-02" });
    const both = (await csvFor(two, "2026-03-08")).lines;
    expect(both[1]).toContain("2 open shifts excluded: Gia R.");
    expect(both[1]).toContain("Sofia T.");
  });

  it("pays somebody who was let go, and skips somebody who did not work", async () => {
    const app = await withShifts([
      shift(SOFIA, "Sofia T.", at(2026, 3, 3, 17), at(2026, 3, 3, 22), 5_000),
    ]);
    await setPeriod(app, 1, { payPeriod: "weekly", payPeriodAnchor: "2026-03-02" });

    const out = await app.inject({ method: "POST", url: `/v1/staff/${SOFIA}/deactivate`,
      payload: { ...ENV(2), managerPin: MGR } });
    expect(out.statusCode).toBe(200);

    // she does not work here any more and she is still owed for last week
    const { lines } = await csvFor(app, "2026-03-08");
    expect(lines[1]).toBe(`${SOFIA},Sofia T.,,2026-03-02,2026-03-08,5.00,50.00,1`);
    // Gia and Marco are active and worked nothing: no rows, not zero rows
    expect(lines).toHaveLength(3);
  });

  it("asks for a manager on every single call", async () => {
    const app = await withShifts([shift(GIA, "Gia R.", at(2026, 3, 3, 17), at(2026, 3, 3, 22), 1_000)]);

    const bare = await csvFor(app, undefined, null);
    expect(bare.code).toBe(422);
    expect(JSON.parse(bare.raw).reason).toBe("exporting hours requires a manager's PIN");

    const asServer = await csvFor(app, undefined, "2468");
    expect(asServer.code).toBe(422);
    expect(JSON.parse(asServer.raw).reason).toBe("PIN not recognized as a manager");

    expect((await csvFor(app, "2026-03-08")).code).toBe(200);
    // nothing was cached by that success: the next call asks again
    expect((await csvFor(app, "2026-03-08", null)).code).toBe(422);
  });

  it("declares the same tips the day report does, over the same span", async () => {
    const today = new Date();
    const y = today.getFullYear(), m = today.getMonth() + 1, d = today.getDate();
    const ymdToday = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const app = await withShifts([
      shift(GIA, "Gia R.", new Date(y, m - 1, d, 9).toISOString(), new Date(y, m - 1, d, 15).toISOString(), 7_300),
      shift(SOFIA, "Sofia T.", new Date(y, m - 1, d, 10).toISOString(), new Date(y, m - 1, d, 16).toISOString(), 4_200),
    ]);
    // a period wide enough to hold today, with nothing else worked inside it,
    // so the two spans really are the same span
    await setPeriod(app, 1, { payPeriod: "weekly", payPeriodAnchor: ymdToday });

    const { lines } = await csvFor(app, ymdToday);
    const exported = lines.slice(1, -1).reduce((a, l) => a + Number(l.split(",")[6]), 0);
    const dayReport = (await app.inject({ method: "GET", url: "/v1/insights/servers" })).json();
    expect(exported).toBeCloseTo(dayReport.declaredTipsTotalMinor / 100, 2);
    expect(exported).toBe(115);
  });

  it("refuses a pay period it cannot honour, and keeps the one it had", async () => {
    const app = buildServer();
    const bad = await setPeriod(app, 1, { payPeriod: "fortnightly" });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().reason).toBe("pay period must be one of weekly, biweekly, semimonthly");

    const badDate = await setPeriod(app, 2, { payPeriodAnchor: "2026-02-30" });
    expect(badDate.json().reason).toBe("2026-02-30 is not a date (use YYYY-MM-DD)");

    const venue = (await app.inject({ method: "GET", url: "/v1/venue" })).json();
    expect(venue.payPeriod).toBe("biweekly");
    expect(venue.payPeriodAnchor).toBe("2026-01-05");

    const ok = await setPeriod(app, 3, { payPeriod: "semimonthly", payPeriodAnchor: "2026-03-02" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().venue).toMatchObject({ payPeriod: "semimonthly", payPeriodAnchor: "2026-03-02" });
    // the read the Settings screen names the period with follows the setting
    const period = (await app.inject({ method: "GET", url: "/v1/payroll/period?on=2026-05-20" })).json().period;
    expect(period).toEqual({ start: "2026-05-16", end: "2026-05-31" });
  });

  it("the Settings screen carries the picker and the download, and no wage field", async () => {
    const body = (await buildServer().inject({ method: "GET", url: "/settings" })).body;

    expect(body).toContain('id="vPeriod"');
    for (const kind of ["weekly", "biweekly", "semimonthly"]) expect(body).toContain(`data-p="${kind}"`);
    expect(body).toContain('id="vAnchor"');
    expect(body).toContain(">Payroll export<");
    expect(body).toContain('fetch("/v1/staff/hours-export"');
    expect(body).toContain('dget("/v1/payroll/period")');
    expect(body).toContain('id="pGo"');
    // the posture, on the screen, in one sentence
    expect(body).toContain("Your payroll provider applies wage and overtime rules; this system never calculates pay.");
    // and nowhere to type a wage, which is the whole design
    for (const forbidden of ['id="vWage"', 'id="eWage"', "wageMinor", "hourlyRate"]) {
      expect(body, `${forbidden} has no business on this page`).not.toContain(forbidden);
    }
  });
});

/* ---------------- the CSV reader (E22-T2) ----------------
   Its own unit, because the input is a real spreadsheet export and the
   failure modes are the ones a hand-rolled splitter gets wrong. */
describe("reading a spreadsheet's CSV (E22-T2)", () => {
  const fields = (text: string) => {
    const r = parseCsv(text);
    if (!r.ok) throw new Error(`expected a parse, got line ${r.line}: ${r.reason}`);
    return r.records.map((rec) => rec.fields);
  };

  it("reads quoted fields, embedded commas, and doubled quotes", () => {
    expect(fields('name,price\n"Garlic, Pepper & Basil",20')).toEqual([
      ["name", "price"], ["Garlic, Pepper & Basil", "20"],
    ]);
    // "" is one literal quote, which is how a spreadsheet writes 6" Bowl
    expect(fields('a\n"6"" Bowl"')).toEqual([["a"], ['6" Bowl']]);
    // a quote that does not open a field is just a character
    expect(fields("a\n6\" Bowl")).toEqual([["a"], ['6" Bowl']]);
    // a newline inside quotes belongs to the field, not to the file
    expect(fields('a,b\n"one\ntwo",3')).toEqual([["a", "b"], ["one\ntwo", "3"]]);
  });

  it("handles CRLF, a trailing newline, blank lines, and Excel's BOM", () => {
    expect(fields("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
    // a trailing newline is the end of the last row, not an empty extra one
    expect(fields("a,b\n1,2\n")).toHaveLength(2);
    expect(fields("a,b\n1,2")).toHaveLength(2);
    // the BOM belongs to the encoding: unstripped it hides the first column
    const withBom = parseCsv("﻿name,course\nPad Thai,PRIMI\n");
    expect(withBom.ok && withBom.records[0]!.fields[0]).toBe("name");
  });

  it("counts lines the way the spreadsheet does, so a report can be acted on", () => {
    const r = parseCsv("a,b\n1,2\n\n3,4\n");
    expect(r.ok && r.records.map((rec) => rec.line)).toEqual([1, 2, 4]);
    // a record with a newline inside a quoted field is reported where it STARTS
    const spanning = parseCsv('a\n"one\ntwo"\nlast');
    expect(spanning.ok && spanning.records.map((rec) => rec.line)).toEqual([1, 2, 4]);
  });

  it("refuses a file it cannot read, and names the line", () => {
    const unterminated = parseCsv('name,price\n"Pad Thai,18\nPad See Ew,18\n');
    expect(unterminated.ok).toBe(false);
    expect(!unterminated.ok && unterminated.line).toBe(2);
    expect(!unterminated.ok && unterminated.reason).toBe("a quoted field is never closed");

    const ragged = parseCsv('a\n"one"two\n');
    expect(ragged.ok).toBe(false);
    expect(!ragged.ok && ragged.reason).toBe("unexpected text after a closing quote");
  });

  it("converts dollars to cents once, half up, without touching a float", () => {
    expect(parseMajorPrice("14")).toBe(1400);
    expect(parseMajorPrice("13.95")).toBe(1395);
    expect(parseMajorPrice("13.9")).toBe(1390);
    expect(parseMajorPrice("0")).toBe(0);
    // the midpoint 13.955 is 1395.4999... as a float: Math.round would lose a
    // cent here, which is exactly the bug this parser exists to not have
    expect(parseMajorPrice("13.955")).toBe(1396);
    expect(parseMajorPrice("13.954")).toBe(1395);
    // a sheet out of an accounting tool
    expect(parseMajorPrice("$1,234.50")).toBe(123450);
    for (const bad of ["", "free", "-5", "12.3.4", "1e3", "18 "]) {
      expect(parseMajorPrice(bad === "18 " ? bad : bad), bad).toBe(bad === "18 " ? 1800 : undefined);
    }
  });
});

/* ---------------- the menu import (E22-T2, D30) ----------------
   The spec's discipline in three words: draft, idempotent, provenance. */
describe("a spreadsheet becomes a draft (E22-T2)", () => {
  const MGR = "1122";
  const THAI = readFileSync(new URL("../../../docs/examples/nine-thai-menu.csv", import.meta.url), "utf8");

  const importCsv = (app: ReturnType<typeof buildServer>, n: number, csv: string, pin: string | null = MGR) =>
    app.inject({ method: "POST", url: "/v1/menu/import",
      payload: { ...ENV(n), ...(pin === null ? {} : { managerPin: pin }), csv } });

  const report = (res: { json: () => { menu: { import: Record<string, unknown> } } }) => res.json().menu.import;
  const draftOf = async (app: ReturnType<typeof buildServer>) =>
    (await app.inject({ method: "GET", url: "/v1/menu/draft" })).json().draft;

  const SMALL = [
    "name,course,price,station,modifier_groups",
    "Pad Thai,PRIMI,18,SAUTE,Spice Level;Protein",
    "Thai Iced Tea,BEVERAGE,6,,Ice",
    "Mango Sticky Rice,DOLCI,12,,",
  ].join("\n") + "\n";

  it("lands rows on the draft, creating unknown groups optional and empty", async () => {
    const app = buildServer();
    const res = await importCsv(app, 1, SMALL);
    expect(res.statusCode).toBe(200);
    expect(report(res)).toMatchObject({ itemsAdded: 3, itemsUpdated: 0, itemsSkipped: 0 });
    expect(report(res).groupsCreated).toEqual(["Spice Level", "Protein", "Ice"]);

    const draft = await draftOf(app);
    const pad = draft.items.find((m: { id: string }) => m.id === "pad-thai");
    expect(pad).toMatchObject({ name: "Pad Thai", course: "PRIMI", priceMinor: 1800, station: "SAUTE" });
    expect(pad.modifierGroupIds).toEqual(["spice-level", "protein"]);

    // a blank station follows the course rather than being guessed
    expect(draft.items.find((m: { id: string }) => m.id === "thai-iced-tea").station).toBe("BAR");
    expect(draft.items.find((m: { id: string }) => m.id === "mango-sticky-rice").station).toBe("FREDDO");

    // OPTIONAL and EMPTY, never required on the manager's behalf: a required
    // group with no options is a dish nobody can order
    const spice = draft.groups.find((g: { id: string }) => g.id === "spice-level");
    expect(spice).toMatchObject({ name: "Spice Level", minSelect: 0, options: [] });

    // the import is a DRAFT and nothing else: service has not moved
    const live = (await app.inject({ method: "GET", url: "/v1/menu" })).json();
    expect(live.version).toBe(1);
    expect(live.items.some((i: { id: string }) => i.id === "pad-thai")).toBe(false);
    expect(res.json().menu.note).toContain("publish");
  });

  it("marks what it wrote, and keeps that mark off the published snapshot", async () => {
    const app = buildServer();
    await importCsv(app, 1, SMALL);

    const draft = await draftOf(app);
    const pad = draft.items.find((m: { id: string }) => m.id === "pad-thai");
    // provenance the review screen can badge: an imported row must never look
    // identical to one a manager typed
    expect(pad.source).toMatch(/^csv-import \d{4}-\d{2}-\d{2}T/);
    // a hand-typed row alongside it carries no mark
    expect(draft.items.find((m: { id: string }) => m.id === "ragu").source).toBeUndefined();

    const pub = await app.inject({ method: "POST", url: "/v1/menu/publish", payload: { ...ENV(2), managerPin: MGR } });
    expect(pub.statusCode).toBe(200);
    const live = (await app.inject({ method: "GET", url: "/v1/menu" })).json();
    expect(live.items.find((i: { id: string }) => i.id === "pad-thai")).toBeDefined();
    // the snapshot is exactly the shape it has always been
    expect(JSON.stringify(live.items)).not.toContain("csv-import");
    for (const item of live.items) expect(item.source).toBeUndefined();
  });

  it("is safe to run twice: the second pass updates, it never duplicates", async () => {
    const app = buildServer();
    await importCsv(app, 1, SMALL);
    const before = (await draftOf(app)).items.length;

    // "run it again, something looked wrong" is the realistic operator move
    const again = await importCsv(app, 2, SMALL);
    expect(report(again)).toMatchObject({ itemsAdded: 0, itemsUpdated: 3, itemsSkipped: 0 });
    expect(report(again).groupsCreated).toEqual([]); // groups match by name too
    expect((await draftOf(app)).items).toHaveLength(before);

    // a corrected sheet updates in place, matched on name within course
    // case-insensitively, so shouting the name is still the same dish
    const corrected = SMALL.replace("Pad Thai,PRIMI,18", "PAD THAI,primi,19.50");
    const third = await importCsv(app, 3, corrected);
    expect(report(third)).toMatchObject({ itemsAdded: 0, itemsUpdated: 3 });
    const pad = (await draftOf(app)).items.filter((m: { name: string }) => m.name.toLowerCase() === "pad thai");
    expect(pad).toHaveLength(1);
    expect(pad[0]).toMatchObject({ id: "pad-thai", name: "PAD THAI", priceMinor: 1950 });
  });

  it("skips a bad row by line and lands every good one around it", async () => {
    const app = buildServer();
    const messy = [
      "name,course,price,station,modifier_groups",
      "Pad Thai,PRIMI,18,SAUTE,",          // line 2, fine
      "Larb Gai,SIDES,16,SAUTE,",          // line 3, unknown course
      ",PRIMI,12,SAUTE,",                  // line 4, blank name
      "Som Tum,ANTIPASTI,free,SAUTE,",     // line 5, not a price
      "Khao Soi,PRIMI,-4,SAUTE,",          // line 6, negative
      "Sai Ua,SECONDI,17,FRYER,",          // line 7, unknown station
      "Tom Kha,ANTIPASTI,12,SAUTE,",       // line 8, fine
    ].join("\n") + "\n";

    const res = await importCsv(app, 1, messy);
    expect(res.statusCode).toBe(200);
    const r = report(res);
    expect(r).toMatchObject({ itemsAdded: 2, itemsSkipped: 5 });
    expect(r.skipped).toEqual([
      "row 3: unknown course 'SIDES'",
      "row 4: the name is blank",
      "row 5: 'free' is not a price",
      "row 6: '-4' is not a price",
      "row 7: unknown station 'FRYER'",
    ]);

    const draft = await draftOf(app);
    expect(draft.items.some((m: { id: string }) => m.id === "pad-thai")).toBe(true);
    expect(draft.items.some((m: { id: string }) => m.id === "tom-kha")).toBe(true);
    expect(draft.items.some((m: { name: string }) => m.name === "Larb Gai")).toBe(false);
  });

  it("refuses a file it cannot read, or a header it cannot use, whole", async () => {
    const app = buildServer();

    const notCsv = await importCsv(app, 1, 'name,course,price,station,modifier_groups\n"Pad Thai,PRIMI,18,SAUTE,\n');
    expect(notCsv.statusCode).toBe(422);
    expect(notCsv.json().reason).toBe("line 2: a quoted field is never closed");

    const wrongHeader = await importCsv(app, 2, "dish,category,cost\nPad Thai,PRIMI,18\n");
    expect(wrongHeader.json().reason)
      .toBe("the header is missing name, course, price, station, modifier_groups; expected name, course, price, station, modifier_groups");

    expect((await importCsv(app, 3, "   ")).json().reason).toBe("the file is empty");
    expect((await importCsv(app, 4, "name,course,price,station,modifier_groups\n")).statusCode).toBe(200);

    // nothing that was refused touched the draft
    expect(await draftOf(app)).toBeNull();

    // column ORDER is the sheet's business, and extra columns are ignored:
    // a real export carries SKU and cost columns we have no use for
    const shuffled = "sku,price,name,modifier_groups,course,cost,station\n" +
      "PT-01,18,Pad Thai,Spice Level,PRIMI,6.20,SAUTE\n";
    const ok = await importCsv(app, 5, shuffled);
    expect(report(ok)).toMatchObject({ itemsAdded: 1 });
    expect((await draftOf(app)).items.find((m: { id: string }) => m.id === "pad-thai").priceMinor).toBe(1800);
  });

  it("asks for a manager, and replays a dropped import instead of doubling it", async () => {
    const app = buildServer();
    const bare = await importCsv(app, 1, SMALL, null);
    expect(bare.statusCode).toBe(422);
    expect(bare.json().reason).toBe("importing a menu requires a manager's PIN");

    const asServer = await importCsv(app, 2, SMALL, "2468");
    expect(asServer.json().reason).toBe("PIN not recognized as a manager");
    expect(await draftOf(app)).toBeNull();

    const op = { ...ENV(3), managerPin: MGR, csv: SMALL };
    const first = await app.inject({ method: "POST", url: "/v1/menu/import", payload: op });
    const retry = await app.inject({ method: "POST", url: "/v1/menu/import", payload: op });
    expect(first.statusCode).toBe(200);
    expect(retry.json()).toEqual(first.json());
    expect((await draftOf(app)).items.filter((m: { id: string }) => m.id === "pad-thai")).toHaveLength(1);
  });

  it("gives two dishes of one name in different courses ids of their own", async () => {
    const app = buildServer();
    const both = [
      "name,course,price,station,modifier_groups",
      "Tom Yum,ANTIPASTI,12,SAUTE,",
      "Tom Yum,SECONDI,20,SAUTE,",
    ].join("\n") + "\n";
    expect(report(await importCsv(app, 1, both))).toMatchObject({ itemsAdded: 2 });
    const mine = (await draftOf(app)).items.filter((m: { name: string }) => m.name === "Tom Yum");
    expect(mine.map((m: { id: string }) => m.id)).toEqual(["tom-yum", "tom-yum-2"]);
    // and the natural key still holds on a re-run: two updates, no third row
    expect(report(await importCsv(app, 2, both))).toMatchObject({ itemsAdded: 0, itemsUpdated: 2 });
  });

  /* The founder's demo, end to end: a whole restaurant's menu out of a
     spreadsheet, reviewed, published, and sold from. */
  it("takes Nine Thai Kitchen from a spreadsheet to an order on the pass", async () => {
    const app = buildServer();
    const res = await importCsv(app, 1, THAI);
    expect(res.statusCode).toBe(200);
    const r = report(res);
    expect(r).toMatchObject({ itemsAdded: 27, itemsUpdated: 0, itemsSkipped: 0 });
    expect(r.groupsCreated).toEqual(["Spice Level", "Light Options", "Protein", "Entree Options", "Ice"]);

    const draft = await draftOf(app);
    // the demo venue's own nine items are still there: an import ADDS to the
    // draft, and clearing the old menu is the manager's call, not ours
    expect(draft.items).toHaveLength(9 + 27);
    for (const course of ["BEVERAGE", "ANTIPASTI", "PRIMI", "SECONDI", "DOLCI"]) {
      expect(draft.items.filter((m: { course: string; source?: string }) => m.course === course && m.source).length,
        course).toBeGreaterThan(0);
    }

    // the manager fills the one group the kitchen cannot cook without, and
    // makes it required. That step is deliberately theirs.
    const spice = await app.inject({ method: "POST", url: "/v1/menu/draft/group",
      payload: { ...ENV(2), managerPin: MGR, groupId: "spice-level", name: "Spice Level",
        minSelect: 1, maxSelect: 1,
        options: [{ name: "No Spice", priceMinor: 0 }, { name: "Mild", priceMinor: 0 },
          { name: "Medium", priceMinor: 0 }, { name: "Hot", priceMinor: 0 }, { name: "Thai Hot", priceMinor: 0 }] } });
    expect(spice.statusCode).toBe(200);

    const pub = await app.inject({ method: "POST", url: "/v1/menu/publish", payload: { ...ENV(3), managerPin: MGR } });
    expect(pub.statusCode).toBe(200);
    const live = (await app.inject({ method: "GET", url: "/v1/menu" })).json();
    expect(live.version).toBe(2);
    expect(live.groups["spice-level"].options.map((o: { id: string }) => o.id))
      .toEqual(["no-spice", "mild", "medium", "hot", "thai-hot"]);

    // and the pass refuses a Pad Thai nobody specified, because a manager
    // said so in a spreadsheet twenty seconds ago
    const check = await openCheck(app);
    const bare = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(4), itemId: "pad-thai", quantity: 1, seatNo: 1 } });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().modifierErrors).toEqual([{ code: "too_few", groupId: "spice-level", min: 1, got: 0 }]);

    const ordered = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(5), itemId: "pad-thai", quantity: 1, seatNo: 1,
        modifiers: [{ groupId: "spice-level", modifierId: "thai-hot" }] } });
    expect(ordered.statusCode).toBe(200);
    const line = ordered.json().check.lines.at(-1);
    expect(line).toMatchObject({ capturedName: "Pad Thai", unitPriceMinor: 1800 });

    // it cooks: the ticket reaches the rail naming the choice
    expect((await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(6) })).statusCode).toBe(200);
    const fired = (await app.inject({ method: "GET", url: "/v1/kds" })).json().tickets
      .flatMap((t: { items: { name: string; mods: string }[] }) => t.items)
      .find((i: { name: string }) => i.name === "Pad Thai");
    expect(fired.mods).toBe("Thai Hot");
  });
});

/* E22-T3: the page that puts E22-T2's importMenuCsv behind a manager's
 * hands. No engine or route under test here, page-serve assertions only: the
 * import sheet's markup exists (file picker, paste textarea, template link,
 * PIN field) and is wired into the served script, and the existing menu
 * markup (E5, E5-T2, E5-T3) is untouched. */
describe("the menu import lands on the Menu screen (E22-T3)", () => {
  it("serves the Import action, its sheet, the template link, and the report renderer", async () => {
    const app = buildServer();
    const page = (await app.inject({ method: "GET", url: "/menu" })).body;

    // an Import action in the draft area, available with or without a draft
    expect(page).toContain('id="btnImport"');
    expect(page).toContain("Import menu (CSV)");
    expect(page).toContain("function importForm()");
    expect(page).toContain('/v1/menu/import');

    // file picker (read client-side, the raw text is what posts) and a
    // paste-into-textarea alternative for the phone/tablet case
    expect(page).toContain('type="file"');
    expect(page).toContain('accept=".csv,text/csv"');
    expect(page).toContain("new FileReader()");
    expect(page).toContain("readAsText(file)");
    expect(page).toContain('id="f_csv"');
    expect(page).toContain("<textarea");

    // the template link, generated client-side from one column list, not
    // fetched from the server ahead of an import
    expect(page).toContain("function templateCsv()");
    expect(page).toContain("IMPORT_COLUMNS");
    expect(page).toContain("name,course,price,station,modifier_groups");
    expect(page).toContain("Download the template");
    expect(page).toContain('download="restaurantos-menu-template.csv"');

    // the PIN field, asked the way publish already asks for one
    expect(page).toContain('id="f_pin"');
    expect(page).toContain("Manager PIN (demo manager: Marco B. · 1122)");

    // the report, rendered honestly: added/updated/skipped-with-reason and
    // groups created, in the page's existing .row/.blk list styling, plus
    // the one-line next step
    expect(page).toContain("function renderImportReport(imp,note)");
    expect(page).toContain("imp.itemsAdded");
    expect(page).toContain("imp.itemsUpdated");
    expect(page).toContain("imp.skipped.forEach");
    expect(page).toContain("imp.groupsCreated");
    expect(page).toContain("Next: review the draft");
    expect(page).toContain('"Done"');

    // imported rows carry a small badge beside the existing new/changed
    // chips, sourced from the draft read's own `source` field
    expect(page).toContain("i.source");
    expect(page).toContain('<span class="chip mut">imported</span>');

    // the page hands the text over; it never parses a row of CSV itself
    expect(page).not.toContain('split(";")');
  });

  it("still serves everything the E5/E5-T2/E5-T3 menu screen shipped before this ticket", async () => {
    const app = buildServer();
    const page = (await app.inject({ method: "GET", url: "/menu" })).body;
    expect(page).toContain("Live now · 86 board");
    expect(page).toContain('id="live"></div>');
    expect(page).toContain('id="draft"></div>');
    expect(page).toContain('id="draftGroups"></div>');
    expect(page).toContain("function groupForm(src)");
    expect(page).toContain("function publishForm()");
    // D35/UI-T5 trimmed the rail to seven icons (Menu and Reports left it)
    expect(page.match(/<svg viewBox="0 0 24 24" aria-hidden="true">/g)).toHaveLength(7);
  });
});

/* ---------------- the call-in book (E23-T2, D27/D31) ----------------
   A reservation is a PROMISE, not a lock. The assertions below are as much
   about what the book refuses to do (never block a seating, never delete a
   row, never guess at a guest) as about what it records. */
describe("the call-in book (E23-T2)", () => {
  const MGR = "1122";

  /** a local-time instant, the clock the whole calendar runs on */
  const at = (h: number, min = 0, dayOffset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, min, 0, 0);
    return d.toISOString();
  };
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  /** minutes from now, which is how the lead and hold windows are reasoned about */
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

  const book = (app: ReturnType<typeof buildServer>, n: number, body: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: "/v1/reservations",
      payload: { ...ENV(n), name: "Somchai", phone: "917-555-0143", partySize: 4,
        reservedFor: at(19, 30), tableName: "Table 12", ...body } });

  const readBook = async (app: ReturnType<typeof buildServer>, date?: string) =>
    (await app.inject({ method: "GET", url: `/v1/reservations${date ? `?date=${date}` : ""}` })).json();

  const floorOf = async (app: ReturnType<typeof buildServer>) =>
    (await app.inject({ method: "GET", url: "/v1/floor" })).json().tables as
      { name: string; reserved: { name: string; partySize: number; reservedFor: string } | null }[];

  it("takes a booking from whoever answers the phone, and refuses only nonsense", async () => {
    const app = buildServer();
    const res = await book(app, 1);
    expect(res.statusCode).toBe(200); // no manager PIN anywhere: it is a phone call
    expect(res.json().reservation).toMatchObject({
      name: "Somchai", phone: "917-555-0143", partySize: 4, tableName: "Table 12", status: "booked",
    });

    for (const [patch, reason] of [
      [{ name: "  " }, "a booking needs a name"],
      [{ partySize: 0 }, "party size must be a whole number of people, at least 1"],
      [{ partySize: 2.5 }, "party size must be a whole number of people, at least 1"],
      [{ reservedFor: "friday-ish" }, "'friday-ish' is not a date and time"],
      [{ tableName: "Table 99" }, "Table 99 is not a table this room has"],
    ] as [Record<string, unknown>, string][]) {
      const bad = await book(app, 2, patch);
      expect(bad.statusCode, reason).toBe(422);
      expect(bad.json().reason).toBe(reason);
    }

    // a table is OPTIONAL: a call that did not settle one is still a booking
    const floating = await book(app, 3, { tableName: undefined, name: "Anong" });
    expect(floating.json().reservation.tableName).toBeUndefined();

    // and a PAST time is allowed in silence, because a host catching the book
    // up after a rush is back-entering tonight, not making a mistake
    const backEntered = await book(app, 4, { reservedFor: at(12, 0), name: "Kamon" });
    expect(backEntered.statusCode).toBe(200);
  });

  it("cancels and no-shows as STATES, from booked only, keeping the row", async () => {
    const app = buildServer();
    const one = (await book(app, 1)).json().reservation.id as string;
    const two = (await book(app, 2, { name: "Nid" })).json().reservation.id as string;

    const cancelled = await app.inject({ method: "POST", url: `/v1/reservations/${one}/cancel`, payload: ENV(3) });
    expect(cancelled.json().reservation.status).toBe("cancelled");
    const noShow = await app.inject({ method: "POST", url: `/v1/reservations/${two}/no-show`, payload: ENV(4) });
    expect(noShow.json().reservation.status).toBe("no_show");

    // both rows survive: the reason to record a no-show is that it happened
    const rows = (await readBook(app)).reservations;
    expect(rows.map((r: { status: string }) => r.status).sort()).toEqual(["cancelled", "no_show"]);

    // and neither state goes anywhere else
    const twice = await app.inject({ method: "POST", url: `/v1/reservations/${one}/cancel`, payload: ENV(5) });
    expect(twice.statusCode).toBe(422);
    expect(twice.json().reason).toBe("Somchai's booking is already cancelled; only a booked one can be cancelled");
    const seatDead = await app.inject({ method: "POST", url: `/v1/reservations/${two}/seat`, payload: ENV(6) });
    expect(seatDead.json().reason).toBe("Nid's booking is no show; only a booked one can be seated");

    const nobody = await app.inject({ method: "POST", url: "/v1/reservations/not-a-booking/cancel", payload: ENV(7) });
    expect(nobody.json().reason).toBe("no reservation not-a-booking");
  });

  it("seats the party into a real check, covers and table prefilled, in one act", async () => {
    const app = buildServer();
    const id = (await book(app, 1)).json().reservation.id as string;

    const seated = await app.inject({ method: "POST", url: `/v1/reservations/${id}/seat`, payload: ENV(2) });
    expect(seated.statusCode).toBe(200);
    // the party size was typed once, on the phone, and it drives every
    // per-cover figure downstream from here
    expect(seated.json().check).toMatchObject({ tableName: "Table 12", covers: 4, status: "open" });
    expect(seated.json().reservation.status).toBe("seated");

    // one command, so a half-seated reservation cannot exist: the check is
    // real and the book moved in the same breath
    const live = (await app.inject({ method: "GET", url: "/v1/checks" })).json().checks;
    expect(live.filter((c: { tableName: string }) => c.tableName === "Table 12")).toHaveLength(1);
    expect((await readBook(app)).reservations[0].status).toBe("seated");
  });

  it("attaches the guest a human confirmed, and matches a phone EXACTLY", async () => {
    const app = buildServer();
    const guest = (await app.inject({ method: "POST", url: "/v1/guests",
      payload: { ...ENV(1), displayName: "Somchai P.", phone: "917-555-0143" } })).json().guest;

    const id = (await book(app, 2)).json().reservation.id as string;
    // the book PROPOSES the match; it never binds it
    const proposed = (await readBook(app)).reservations[0];
    expect(proposed.guestMatch).toEqual({ id: guest.id, name: "Somchai P." });
    expect(proposed.guestId).toBeUndefined();

    const seated = await app.inject({ method: "POST", url: `/v1/reservations/${id}/seat`,
      payload: { ...ENV(3), guestId: guest.id } });
    expect(seated.statusCode).toBe(200);
    expect(seated.json().check.guests).toEqual([{ id: guest.id, name: "Somchai P." }]);
    expect(seated.json().reservation.guestId).toBe(guest.id);

    // one digit off is a different person (D20: exact, never fuzzy)
    const other = await book(app, 4, { phone: "917-555-0144", name: "Not Somchai" });
    const rows = (await readBook(app)).reservations;
    expect(rows.find((r: { name: string }) => r.name === "Not Somchai").guestMatch).toBeUndefined();
    expect(other.statusCode).toBe(200);

    // and a guest that does not exist is refused rather than silently skipped
    const ghost = (await book(app, 5, { name: "Ghost", tableName: "Table 5" })).json().reservation.id;
    const bad = await app.inject({ method: "POST", url: `/v1/reservations/${ghost}/seat`,
      payload: { ...ENV(6), guestId: "no-such-guest" } });
    expect(bad.json().reason).toBe("no such guest");
  });

  it("warns and allows a reroute, and still never doubles a table up", async () => {
    const app = buildServer();
    const id = (await book(app, 1)).json().reservation.id as string;

    // the promised table is taken, so the host moves them. Deviating from the
    // promise needs an acknowledgement, not a permission.
    const unconfirmed = await app.inject({ method: "POST", url: `/v1/reservations/${id}/seat`,
      payload: { ...ENV(2), tableName: "Table 5" } });
    expect(unconfirmed.statusCode).toBe(422);
    expect(unconfirmed.json().reason)
      .toBe("Somchai was promised Table 12; confirm the override to seat them at Table 5");

    const rerouted = await app.inject({ method: "POST", url: `/v1/reservations/${id}/seat`,
      payload: { ...ENV(3), tableName: "Table 5", confirmOverride: true } });
    expect(rerouted.statusCode).toBe(200);
    expect(rerouted.json().check).toMatchObject({ tableName: "Table 5", covers: 4 });
    expect(rerouted.json().reservation).toMatchObject({ status: "seated", tableName: "Table 5" });

    // the ledger's own rule still stands: one table, one open check. Promise
    // not lock means the HOST reroutes, not that the books double up.
    const second = (await book(app, 4, { name: "Ploy", tableName: "Table 5" })).json().reservation.id;
    const clash = await app.inject({ method: "POST", url: `/v1/reservations/${second}/seat`, payload: ENV(5) });
    expect(clash.statusCode).toBe(422);
    expect(clash.json().reason).toBe("Table 5 already has an open check");

    // a booking with no table at all has to be told where to go
    const floating = (await book(app, 6, { name: "Anong", tableName: undefined })).json().reservation.id;
    const nowhere = await app.inject({ method: "POST", url: `/v1/reservations/${floating}/seat`, payload: ENV(7) });
    expect(nowhere.json().reason).toBe("Anong's booking names no table; choose one to seat them at");
    const placed = await app.inject({ method: "POST", url: `/v1/reservations/${floating}/seat`,
      payload: { ...ENV(8), tableName: "Table 9" } }); // no override needed: nothing was promised
    expect(placed.statusCode).toBe(200);
    expect(placed.json().check.tableName).toBe("Table 9");
  });

  it("badges the floor inside the lead window and stays quiet outside it", async () => {
    const app = buildServer();
    // 30 minutes out, inside the 45 minute default
    const soon = await book(app, 1, { reservedFor: inMinutes(30), tableName: "Table 12" });
    // 4 hours out, well outside it
    await book(app, 2, { reservedFor: inMinutes(240), tableName: "Table 9", name: "Ploy", partySize: 2 });

    const tables = await floorOf(app);
    expect(tables.find((t) => t.name === "Table 12")!.reserved)
      .toMatchObject({ name: "Somchai", partySize: 4 });
    // noise on a table that is busy serving somebody else, so: nothing
    expect(tables.find((t) => t.name === "Table 9")!.reserved).toBeNull();
    expect(tables.find((t) => t.name === "Table 5")!.reserved).toBeNull();

    // widen the window and the later booking appears, with nothing stored
    const widen = await app.inject({ method: "POST", url: "/v1/venue",
      payload: { ...ENV(3), managerPin: MGR, reservationLeadMinutes: 300 } });
    expect(widen.statusCode).toBe(200);
    expect((await floorOf(app)).find((t) => t.name === "Table 9")!.reserved)
      .toMatchObject({ name: "Ploy", partySize: 2 });

    // seating it clears the badge: only a BOOKED row is still expected
    // the id off the command's own reply, not out of the day book: a booking
    // 30 minutes from a late-evening now belongs to TOMORROW's service date,
    // and this assertion is about the badge rather than about the calendar
    const id = soon.json().reservation.id as string;
    await app.inject({ method: "POST", url: `/v1/reservations/${id}/seat`, payload: ENV(4) });
    expect((await floorOf(app)).find((t) => t.name === "Table 12")!.reserved).toBeNull();

    const bad = await app.inject({ method: "POST", url: "/v1/venue",
      payload: { ...ENV(5), managerPin: MGR, reservationLeadMinutes: -1 } });
    expect(bad.json().reason).toBe("the reservation lead window must be a whole number of minutes between 0 and 1440");
  });

  it("keeps a booking on a table the floor editor retired", async () => {
    const app = buildServer();
    await book(app, 1, { tableName: "Table 12" });

    // the room changes between the call and the night
    const retired = await app.inject({ method: "POST", url: "/v1/floor/retire",
      payload: { ...ENV(2), managerPin: MGR, tableName: "Table 12" } });
    expect(retired.statusCode).toBe(200);
    expect((await floorOf(app)).some((t) => t.name === "Table 12")).toBe(false);

    // the booking still resolves, and still says who is coming
    const row = (await readBook(app)).reservations[0];
    expect(row).toMatchObject({ name: "Somchai", tableName: "Table 12", status: "booked" });

    // a NEW booking on the retired name is still accepted: the room has had
    // that table, and the host may be about to bring it back
    const again = await book(app, 3, { name: "Ploy", tableName: "table 12" });
    expect(again.statusCode).toBe(200);
    expect(again.json().reservation.tableName).toBe("Table 12"); // matched case-insensitively
  });

  it("reads the book in time order, with covers per period and past-due flagged", async () => {
    const app = buildServer();
    await book(app, 1, { name: "Dinner late", reservedFor: at(20, 30), partySize: 6, tableName: "Table 9" });
    await book(app, 2, { name: "Lunch", reservedFor: at(12, 30), partySize: 2, tableName: "Table 5" });
    await book(app, 3, { name: "Dinner early", reservedFor: at(18, 0), partySize: 4, tableName: "Table 12" });
    await book(app, 4, { name: "Tomorrow", reservedFor: at(19, 0, 1), partySize: 8, tableName: "Table 14" });

    const day = await readBook(app);
    expect(day.date).toBe(today());
    // time order, and tomorrow's booking is not tonight's problem
    expect(day.reservations.map((r: { name: string }) => r.name)).toEqual(["Lunch", "Dinner early", "Dinner late"]);
    expect(day.periods).toEqual([
      { period: "lunch", reservations: 1, covers: 2 },
      { period: "dinner", reservations: 2, covers: 10 },
    ]);
    expect(day.covers).toBe(12);
    expect(day.holdMinutes).toBe(15);

    // tomorrow's book is its own day
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const tomorrow = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect((await readBook(app, tomorrow)).reservations.map((r: { name: string }) => r.name)).toEqual(["Tomorrow"]);

    // past due is the SOFT prompt, measured past the hold window, and it
    // never releases anything: the row is still booked
    const app2 = buildServer();
    await book(app2, 5, { name: "Late", reservedFor: inMinutes(-20), tableName: "Table 5" });
    await book(app2, 6, { name: "Only just", reservedFor: inMinutes(-5), tableName: "Table 9" });
    const rows = (await readBook(app2)).reservations;
    const flagged = Object.fromEntries(rows.map((r: { name: string; pastDue: boolean }) => [r.name, r.pastDue]));
    expect(flagged).toEqual({ Late: true, "Only just": false });
    expect(rows.every((r: { status: string }) => r.status === "booked")).toBe(true);
  });

  it("replays a dropped booking and a dropped seating instead of doubling them", async () => {
    const app = buildServer();
    const op = { ...ENV(1), name: "Somchai", partySize: 4, reservedFor: at(19, 30), tableName: "Table 12" };
    const first = await app.inject({ method: "POST", url: "/v1/reservations", payload: op });
    const retry = await app.inject({ method: "POST", url: "/v1/reservations", payload: op });
    expect(retry.json()).toEqual(first.json());
    expect((await readBook(app)).reservations).toHaveLength(1);

    const id = first.json().reservation.id as string;
    const seatOp = { ...ENV(2) };
    const seat1 = await app.inject({ method: "POST", url: `/v1/reservations/${id}/seat`, payload: seatOp });
    const seat2 = await app.inject({ method: "POST", url: `/v1/reservations/${id}/seat`, payload: seatOp });
    expect(seat1.statusCode).toBe(200);
    // a dropped reply must not open a second check on the same table
    expect(seat2.json()).toEqual(seat1.json());
    expect((await app.inject({ method: "GET", url: "/v1/checks" })).json().checks
      .filter((c: { tableName: string }) => c.tableName === "Table 12")).toHaveLength(1);
  });
});

/* ---------------- the book on screen (E23-T3) ----------------
   The page is a formatter and nothing else: the covers totals, the past-due
   flag, the guestbook match and the floor badge all arrive already decided by
   E23-T2's two reads. These assertions hold that line, and hold the badge to
   the info triple, because a reservation is information rather than an alarm. */
describe("the reservations screen and the floor badge (E23-T3)", () => {
  it("serves /reservations: the day book, the booking sheet, the seat confirm", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/reservations" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const body = res.body;

    // two reads and no third question
    expect(body).toContain('dget("/v1/reservations?date="+encodeURIComponent(day))');
    expect(body).toContain('dget("/v1/floor")');

    // one day at a time, Today by default
    expect(body).toContain('id="dPrev"');
    expect(body).toContain('id="dNext"');
    expect(body).toContain('id="dToday"');
    expect(body).toContain("let day=todayYmd()");

    // grouped by service period, with the read's OWN covers total per period
    expect(body).toContain("book.periods.map(");
    expect(body).toContain("' booked · '+p.covers+' covers</span>");

    // the four commands, all of them the engine's
    expect(body).toContain('cmd("/v1/reservations"');
    expect(body).toContain('(kind==="cancel"?"/cancel":"/no-show")');
    expect(body).toContain('+"/seat"');

    // the new booking: a name that admits any name, a stepper, a required time
    expect(body).toContain('Any name will do, even "walk-in"');
    expect(body).toContain('data-party="-1"');
    expect(body).toContain('id="nTime" type="time"');
    expect(body).toContain("A booking needs a time.");
    // a past time warns and saves anyway, in amber and disabling nothing
    expect(body).toContain("That time has already gone by");
    expect(body).toContain('<div class="warn" id="nWarn"></div>');

    // the guestbook match is PROPOSED by the read and taken by a person (D20)
    expect(body).toContain("in the guestbook: attach?");
    expect(body).toContain('seat={r:r,table:r.tableName||"",attach:false}');
    expect(body).toContain("seat.attach&&r.guestMatch?{guestId:r.guestMatch.id}:{}");

    // seating away from the promised table says so first, then sends the
    // acknowledgement the engine asks for. Warn and allow, never refuse.
    expect(body).toContain("moved?{confirmOverride:true}:{}");
    expect(body).toContain("was promised ");

    // the command opened the check; the page only goes where the server put it
    expect(body).toContain('location.href="/pos?check="+res.data.check.id');

    // no PIN anywhere: whoever answers the phone at 6pm takes the booking
    expect(body).not.toContain("managerPin");
    expect(body).not.toContain("askPin");

    // past-due is the read's flag, shown, not a comparison made here
    expect(body).toContain("r.pastDue?");
    expect(body).toContain("Past due");
  });

  it("badges a reserved table on the floor and warns before seating over it", async () => {
    const page = (await buildServer().inject({ method: "GET", url: "/tables" })).body;

    // the badge: time, name and party size, all off the floor read's own
    // `reserved` object, in the flow of the tile rather than floating
    expect(page).toContain('<span class="rz">');
    expect(page).toContain("clockOf(r.reservedFor)");
    expect(page).toContain("esc(r.name)");
    expect(page).toContain("r.partySize");
    expect(page).toContain(".tbl .rz{");
    // a 42px two-top on a phone is not a name's worth of room, so the tile
    // drops the name there and the strip below carries the whole promise
    expect(page).toContain("@media (max-width:820px){");
    expect(page).toContain('<i class="rzn">');
    expect(page).toContain(".tbl .rz .rzn{display:none}");
    expect(page).toContain('class="soon-r" data-sr=');
    expect(page).toContain(">Reserved soon<");
    // the info triple, never the red one
    const rule = page.slice(page.indexOf(".tbl .rz{"), page.indexOf(".tbl.open.booked"));
    expect(rule).toContain("var(--info-wash)");
    expect(rule).not.toContain("--red");

    // the warn-and-allow confirm, in the spec's own sentence
    expect(page).toContain('id="ovHold"');
    expect(page).toContain('" is held for "+r.name+" at "+clockOf(r.reservedFor)+", "+awayText(r.reservedFor)+". Seat anyway?"');
    expect(page).toContain(">Seat anyway<");
    expect(page).toContain("if(t.reserved){warnHeld(t);return;}");
    // and confirming runs the seat flow that was already there
    expect(page).toContain('$("#holdGo").onclick=()=>{$("#ovHold").classList.remove("open");openSeat(t);};');

    // the confirm leaves the booking alone: the host may be about to move it,
    // so this page sends no reservation command at all
    expect(page).not.toContain("/v1/reservations");
    expect(page).toContain('href="/reservations"');
  });
});

/* ---------------- the schedule (E24-T4, D28 rung 2) ----------------
   The other half of the clock. Two things are being defended here, and the
   assertions are shaped around them rather than around the CRUD.

   PUBLISHED IS THE GATE: an employee's own view must never, under any
   circumstance, show a row a manager has not published. Half the tests below
   are that one sentence, asked from different angles.

   NOTHING COSTS ANYTHING: not one assertion in this block is about money,
   because there is no wage on the row, on the employee, or in the schema.
   The planned-versus-actual report is in hours and stays there (spec §4). */
describe("the schedule (E24-T4)", () => {
  const MGR = "1122";
  const GIA_PIN = "2468";
  const GIA = "33333333-3333-3333-3333-333333333333";
  const MARCO = "66666666-6666-4666-8666-666666666666";
  const SOFIA = "77777777-7777-4777-8777-777777777777";

  /** a Monday, and the week this block plans against */
  const MON = "2026-09-07";
  const TUE = "2026-09-08";
  const SAT = "2026-09-12";
  const NEXT_MON = "2026-09-14";

  /** a local-time instant: the whole calendar runs on the server's own clock */
  const at = (ymd: string, h: number, min = 0) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(y!, m! - 1, d!, h, min).toISOString();
  };
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const plan = (app: ReturnType<typeof buildServer>, n: number, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/v1/schedule/shift", payload: { ...ENV(n), managerPin: MGR, ...body } });

  const publish = (app: ReturnType<typeof buildServer>, n: number, weekOf: string, pin: string | null = MGR) =>
    app.inject({ method: "POST", url: "/v1/schedule/publish",
      payload: { ...ENV(n), ...(pin === null ? {} : { managerPin: pin }), weekOf } });

  const week = async (app: ReturnType<typeof buildServer>, weekOf?: string, pin: string | null = MGR) => {
    const res = await app.inject({ method: "POST", url: "/v1/schedule/week",
      payload: { ...(pin === null ? {} : { managerPin: pin }), ...(weekOf ? { weekOf } : {}) } });
    return { code: res.statusCode, body: res.json() };
  };

  const mine = async (app: ReturnType<typeof buildServer>, deviceId: string, weekOf?: string) => {
    const res = await app.inject({ method: "GET",
      url: `/v1/schedule/mine?deviceId=${encodeURIComponent(deviceId)}${weekOf ? `&weekOf=${weekOf}` : ""}` });
    return { code: res.statusCode, body: res.json() };
  };

  const labor = async (app: ReturnType<typeof buildServer>, date?: string, pin: string | null = MGR) => {
    const res = await app.inject({ method: "POST", url: "/v1/insights/labor",
      payload: { ...(pin === null ? {} : { managerPin: pin }), ...(date ? { date } : {}) } });
    return { code: res.statusCode, body: res.json() };
  };

  /** every shift the week read holds, flattened out of the by-employee grid */
  const allShifts = (body: { employees: { days: { shifts: unknown[] }[] }[] }) =>
    body.employees.flatMap((e) => e.days.flatMap((d) => d.shifts)) as
      { id: string; published: boolean; date: string; from: string; to: string; hours: number; roleForShift: string }[];

  it("keeps a draft private and publishes the week in one act", async () => {
    const app = buildServer();
    const device = "gia-handheld";
    // Gia signs in, which is how the floor identifies itself; nothing about
    // the schedule needs a PIN beyond that session
    expect((await app.inject({ method: "POST", url: "/v1/session",
      payload: { deviceId: device, pin: GIA_PIN } })).statusCode).toBe(200);

    const drafted = await plan(app, 1, { employeeId: GIA, startsAt: at(TUE, 16), endsAt: at(TUE, 22), roleForShift: "Bar" });
    expect(drafted.statusCode).toBe(200);
    expect(drafted.json().plannedShift).toMatchObject({ employeeId: GIA, roleForShift: "Bar", published: false });

    // the manager sees it; the person it is about does not, and that is the
    // whole promise the publish gate makes
    const draftWeek = await week(app, TUE);
    expect(draftWeek.code).toBe(200);
    expect(draftWeek.body.weekOf).toBe(MON);
    expect(draftWeek.body.totals).toMatchObject({ shifts: 1, draft: 1, published: 0 });
    expect(draftWeek.body.allPublished).toBe(false);
    expect(allShifts(draftWeek.body)).toHaveLength(1);

    const beforePublish = await mine(app, device, TUE);
    expect(beforePublish.code).toBe(200);
    expect(beforePublish.body.employee.name).toBe("Gia R.");
    expect(beforePublish.body.shifts).toBe(0);
    expect(beforePublish.body.days.flatMap((d: { shifts: unknown[] }) => d.shifts)).toEqual([]);

    // one act, the whole week, and any day inside it names the same seven
    const published = await publish(app, 2, SAT);
    expect(published.statusCode).toBe(200);
    expect(published.json().schedule).toMatchObject({ weekOf: MON, shifts: 1, published: 1, alreadyPublished: 0 });
    expect(published.json().note).toContain("the floor can see the week now");

    const after = await mine(app, device, TUE);
    expect(after.body.shifts).toBe(1);
    expect(after.body.plannedHours).toBe(6);
    expect(after.body.plannedMinutes).toBe(360);
    const tuesday = after.body.days.find((d: { date: string }) => d.date === TUE);
    expect(tuesday.shifts[0]).toMatchObject({ roleForShift: "Bar", from: "16:00", to: "22:00", hours: 6, published: true });
    // and the seven days come back whether or not anything is on them
    expect(after.body.days).toHaveLength(7);
    expect(after.body.days[0].date).toBe(MON);
  });

  it("publishes one week without touching the next, and re-publishes after an edit", async () => {
    const app = buildServer();
    await plan(app, 1, { employeeId: GIA, startsAt: at(TUE, 16), endsAt: at(TUE, 22) });
    await plan(app, 2, { employeeId: SOFIA, startsAt: at(NEXT_MON, 17), endsAt: at(NEXT_MON, 23) });

    expect((await publish(app, 3, MON)).statusCode).toBe(200);
    expect((await week(app, MON)).body.totals).toMatchObject({ shifts: 1, draft: 0, published: 1 });
    // next week is still the manager's private draft
    expect((await week(app, NEXT_MON)).body.totals).toMatchObject({ shifts: 1, draft: 1, published: 0 });

    // more edits land as drafts, and the same command publishes them
    await plan(app, 4, { employeeId: MARCO, startsAt: at(SAT, 15), endsAt: at(SAT, 23), roleForShift: "Expo" });
    expect((await week(app, MON)).body.totals).toMatchObject({ shifts: 2, draft: 1, published: 1 });
    const again = await publish(app, 5, MON);
    expect(again.json().schedule).toMatchObject({ published: 1, alreadyPublished: 1 });
    expect((await week(app, MON)).body.allPublished).toBe(true);

    // and running it a third time with nothing to do says exactly that
    const third = await publish(app, 6, MON);
    expect(third.statusCode).toBe(200);
    expect(third.json().note).toContain("was already published; nothing changed");

    // a week with nothing on it is refused rather than silently "published"
    const empty = await publish(app, 7, "2026-10-05");
    expect(empty.statusCode).toBe(422);
    expect(empty.json().reason).toBe("nothing is planned for the week of 2026-10-05");
  });

  it("warns about an overlap and saves it anyway", async () => {
    const app = buildServer();
    await plan(app, 1, { employeeId: GIA, startsAt: at(SAT, 11), endsAt: at(SAT, 15), roleForShift: "Server" });
    // a split double reads as two shifts and a manager double-covering a
    // Saturday is a decision, so this is a warning and never a refusal
    const overlapping = await plan(app, 2, { employeeId: GIA, startsAt: at(SAT, 14), endsAt: at(SAT, 22) });
    expect(overlapping.statusCode).toBe(200);
    expect(overlapping.json().note).toBe(
      "Gia R. is already on 11:00 to 15:00 on 2026-09-12. Saved anyway: a split double is real life.");
    expect((await week(app, SAT)).body.totals.shifts).toBe(2);

    // a genuine split double, touching but not overlapping, says nothing
    const clean = await plan(app, 3, { employeeId: SOFIA, startsAt: at(SAT, 11), endsAt: at(SAT, 15) });
    const second = await plan(app, 4, { employeeId: SOFIA, startsAt: at(SAT, 17), endsAt: at(SAT, 23) });
    expect(clean.json().note).toBeUndefined();
    expect(second.json().note).toBeUndefined();
    // two people on the same hours is not an overlap: it is a Saturday
    expect((await week(app, SAT)).body.totals.shifts).toBe(4);
  });

  it("refuses the typos, and refuses to schedule somebody who no longer works here", async () => {
    const app = buildServer();

    const backwards = await plan(app, 1, { employeeId: GIA, startsAt: at(TUE, 22), endsAt: at(TUE, 16) });
    expect(backwards.statusCode).toBe(422);
    expect(backwards.json().reason).toBe("a shift has to end after it starts");

    const zero = await plan(app, 2, { employeeId: GIA, startsAt: at(TUE, 16), endsAt: at(TUE, 16) });
    expect(zero.json().reason).toBe("a shift has to end after it starts");

    // 2 AM when they meant 2 PM: caught here costs one retype, missed it
    // costs somebody a wrong week
    const marathon = await plan(app, 3, { employeeId: GIA, startsAt: at(TUE, 6), endsAt: at(TUE, 23) });
    expect(marathon.statusCode).toBe(422);
    expect(marathon.json().reason).toBe("17 hours is a typo rather than a double; a planned shift tops out at 16");
    // and exactly 16 is fine, because it is a real double with a break in it
    expect((await plan(app, 4, { employeeId: GIA, startsAt: at(TUE, 7), endsAt: at(TUE, 23) })).statusCode).toBe(200);

    expect((await plan(app, 5, { employeeId: "nobody", startsAt: at(TUE, 16), endsAt: at(TUE, 22) })).json().reason)
      .toBe("that employee is not on the roster");
    expect((await plan(app, 6, { startsAt: at(TUE, 16), endsAt: at(TUE, 22) })).json().reason)
      .toBe("that employee is not on the roster");
    expect((await plan(app, 7, { employeeId: GIA, startsAt: "next tuesday", endsAt: at(TUE, 22) })).json().reason)
      .toBe("'next tuesday' is not a date and time");

    const gone = await app.inject({ method: "POST", url: `/v1/staff/${SOFIA}/deactivate`,
      payload: { ...ENV(8), managerPin: MGR } });
    expect(gone.statusCode).toBe(200);
    expect((await plan(app, 9, { employeeId: SOFIA, startsAt: at(TUE, 16), endsAt: at(TUE, 22) })).json().reason)
      .toBe("Sofia T. is no longer on the roster; only somebody who still works here can be scheduled");
  });

  it("edits keep a published shift published, and removing one takes it off both views", async () => {
    const app = buildServer();
    const device = "gia-handheld";
    await app.inject({ method: "POST", url: "/v1/session", payload: { deviceId: device, pin: GIA_PIN } });

    const first = await plan(app, 1, { employeeId: GIA, startsAt: at(TUE, 16), endsAt: at(TUE, 22) });
    const id = first.json().plannedShift.id as string;
    await publish(app, 2, MON);
    expect((await mine(app, device, TUE)).body.days.find((d: { date: string }) => d.date === TUE).shifts[0].from).toBe("16:00");

    // moving a PUBLISHED shift keeps it published: reverting it to draft
    // would make Gia's Tuesday vanish from her own screen until somebody
    // remembered to publish again, and a shift that disappears is worse
    // than one that visibly moved
    const moved = await plan(app, 3, { id, startsAt: at(TUE, 17), endsAt: at(TUE, 23) });
    expect(moved.json().plannedShift).toMatchObject({ id, published: true });
    const afterEdit = await mine(app, device, TUE);
    expect(afterEdit.body.days.find((d: { date: string }) => d.date === TUE).shifts[0]).toMatchObject({ from: "17:00", to: "23:00" });
    // one row edited, never a second one written
    expect(afterEdit.body.shifts).toBe(1);

    // a blank role falls back to their job title rather than to nothing
    expect(moved.json().plannedShift.roleForShift).toBe("Server");

    const removed = await app.inject({ method: "POST", url: `/v1/schedule/shift/${id}/remove`,
      payload: { ...ENV(4), managerPin: MGR } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().note).toContain("is off the schedule");
    expect(removed.json().note).toContain("It was published");
    expect((await mine(app, device, TUE)).body.shifts).toBe(0);
    expect((await week(app, TUE)).body.totals.shifts).toBe(0);

    const twice = await app.inject({ method: "POST", url: `/v1/schedule/shift/${id}/remove`,
      payload: { ...ENV(5), managerPin: MGR } });
    expect(twice.statusCode).toBe(422);
    expect(twice.json().reason).toBe(`no planned shift ${id}`);
  });

  it("counts planned against actual in hours, and never in money", async () => {
    const store = new MemoryStore();
    await store.init();
    // planted clock records, so a whole day can be lived through inside a test
    const clock = (id: string, name: string, from: number, to?: number): Shift => ({
      id: `sh-${id}-${from}`, employeeId: id, employeeName: name,
      clockIn: at(SAT, from), ...(to === undefined ? {} : { clockOut: at(SAT, to) }),
    });
    await store.putShift(clock(GIA, "Gia R.", 16, 23));      // planned 6, worked 7
    await store.putShift(clock(SOFIA, "Sofia T.", 17));       // planned 6, still on the clock
    await store.putShift(clock(MARCO, "Marco B.", 15, 22));   // never planned, worked 7
    const app = buildServer(store);

    await plan(app, 1, { employeeId: GIA, startsAt: at(SAT, 16), endsAt: at(SAT, 22) });
    await plan(app, 2, { employeeId: SOFIA, startsAt: at(SAT, 17), endsAt: at(SAT, 23) });
    // a DRAFT is a manager's thinking rather than a commitment, so nobody is
    // measured against one they were never shown
    const draftOnly = await labor(app, SAT);
    expect(draftOnly.body.totals.plannedMinutes).toBe(0);

    await publish(app, 3, SAT);
    const report = await labor(app, SAT);
    expect(report.code).toBe(200);
    expect(report.body.date).toBe(SAT);

    const rows = report.body.employees as {
      employeeId: string; name: string; plannedHours: number; actualHours: number;
      varianceHours: number; stillClockedIn: boolean;
    }[];
    expect(rows.map((r) => r.name)).toEqual(["Gia R.", "Marco B.", "Sofia T."]);
    expect(rows[0]).toMatchObject({ plannedHours: 6, actualHours: 7, varianceHours: 1, stillClockedIn: false });
    // planned and never turned up would read the same way with a minus: this
    // one turned up and has not left, which is a different fact and is named
    expect(rows[2]).toMatchObject({ plannedHours: 6, actualHours: 0, varianceHours: -6, stillClockedIn: true });
    // worked without being on the schedule at all
    expect(rows[1]).toMatchObject({ plannedHours: 0, actualHours: 7, varianceHours: 7 });
    expect(report.body.totals).toMatchObject({ plannedHours: 12, actualHours: 14, varianceHours: 2 });
    // the exact figures are the minutes; the hours are their presentation
    expect(report.body.totals).toMatchObject({ plannedMinutes: 720, actualMinutes: 840, varianceMinutes: 120 });
    expect(report.body.note).toContain("no wage is stored");

    // §4, asserted rather than assumed: not one figure anywhere in this
    // report, or in the week it reads from, is about money. The note is
    // stripped first because it is the one place the word "wage" belongs,
    // and it is there to say the report does not use one.
    const money = [{ ...report.body, note: undefined }, (await week(app, SAT)).body];
    for (const payload of money.map((p) => JSON.stringify(p).toLowerCase())) {
      for (const forbidden of ["wage", "rate", "minor", "pay", "gross", "net_", "tax", "overtime"]) {
        expect(payload, `${forbidden} has no business on a labor report`).not.toContain(forbidden);
      }
    }
  });

  it("gates the manager views on a manager, and an employee's own week on nothing but their session", async () => {
    const app = buildServer();
    await plan(app, 1, { employeeId: GIA, startsAt: at(TUE, 16), endsAt: at(TUE, 22) });
    await publish(app, 2, MON);

    // a server's PIN is not a manager's, and no PIN at all is neither
    for (const [pin, reason] of [
      [GIA_PIN, "PIN not recognized as a manager"],
      [null, "reading the schedule requires a manager's PIN"],
    ] as const) {
      const res = await week(app, TUE, pin);
      expect(res.code).toBe(422);
      expect(res.body.reason).toBe(reason);
    }
    expect((await labor(app, TUE, GIA_PIN)).body.reason).toBe("PIN not recognized as a manager");
    expect((await labor(app, TUE, null)).body.reason).toBe("reading the labor report requires a manager's PIN");
    expect((await publish(app, 3, MON, GIA_PIN)).json().reason).toBe("PIN not recognized as a manager");
    expect((await app.inject({ method: "POST", url: "/v1/schedule/shift",
      payload: { ...ENV(4), managerPin: GIA_PIN, employeeId: GIA, startsAt: at(TUE, 16), endsAt: at(TUE, 22) } }))
      .json().reason).toBe("PIN not recognized as a manager");

    // and the employee's own week needs a session and nothing more
    const device = "gia-handheld";
    const anonymous = await mine(app, device, TUE);
    expect(anonymous.code).toBe(401);
    expect(anonymous.body.reason).toBe("sign in on this device to see your shifts");
    await app.inject({ method: "POST", url: "/v1/session", payload: { deviceId: device, pin: GIA_PIN } });
    const signedIn = await mine(app, device, TUE);
    expect(signedIn.code).toBe(200);
    expect(signedIn.body.shifts).toBe(1);
    // it is THEIR week, never anybody else's: Sofia's Saturday is not here
    await plan(app, 5, { employeeId: SOFIA, startsAt: at(TUE, 17), endsAt: at(TUE, 23) });
    await publish(app, 6, MON);
    expect((await mine(app, device, TUE)).body.shifts).toBe(1);
  });

  it("replays a dropped write instead of writing it twice", async () => {
    const app = buildServer();
    const op = { ...ENV(1), managerPin: MGR, employeeId: GIA, startsAt: at(TUE, 16), endsAt: at(TUE, 22) };
    const first = await app.inject({ method: "POST", url: "/v1/schedule/shift", payload: op });
    const retry = await app.inject({ method: "POST", url: "/v1/schedule/shift", payload: op });
    expect(retry.json()).toEqual(first.json());
    expect((await week(app, TUE)).body.totals.shifts).toBe(1);

    // and a dropped publish reply must not double-count the week either
    const pub = { ...ENV(2), managerPin: MGR, weekOf: MON };
    const p1 = await app.inject({ method: "POST", url: "/v1/schedule/publish", payload: pub });
    const p2 = await app.inject({ method: "POST", url: "/v1/schedule/publish", payload: pub });
    expect(p2.json()).toEqual(p1.json());
    expect(p1.json().schedule.published).toBe(1);
  });

  it("defaults both reads to the week and the day nobody named", async () => {
    const app = buildServer();
    const device = "gia-handheld";
    await app.inject({ method: "POST", url: "/v1/session", payload: { deviceId: device, pin: GIA_PIN } });
    const now = today();

    await plan(app, 1, { employeeId: GIA, startsAt: at(now, 16), endsAt: at(now, 22), roleForShift: "Expo" });
    await publish(app, 2, now);

    const thisWeek = await week(app);
    expect(thisWeek.code).toBe(200);
    expect(thisWeek.body.days).toContain(now);
    expect(thisWeek.body.totals.shifts).toBe(1);

    const myWeek = await mine(app, device);
    expect(myWeek.body.shifts).toBe(1);
    expect(myWeek.body.days.find((d: { date: string }) => d.date === now).shifts[0].roleForShift).toBe("Expo");

    const todayLabor = await labor(app);
    expect(todayLabor.body.date).toBe(now);
    expect(todayLabor.body.totals.plannedHours).toBe(6);
    // signing in clocked her in and she has not clocked out, so the actual
    // side is nothing yet and says why
    expect(todayLabor.body.employees[0]).toMatchObject({ name: "Gia R.", actualHours: 0, stillClockedIn: true });

    // a week is named by any day inside it, so a manager cannot publish a
    // different seven days than the ones on their screen
    expect((await publish(app, 3, "not-a-date")).json().reason)
      .toBe("'not-a-date' is not a date; a week is named by any day inside it (YYYY-MM-DD)");
  });
});

/* ---------------- the schedule on a screen (E24-T5) ----------------
   The page is a formatter over E24-T4's three reads. Two things are being
   held here: an employee's own view asks for nothing and shows only what is
   published, and nothing on the page is ever multiplied by money, because
   there is no money to multiply by. */
describe("the schedule screen (E24-T5)", () => {
  it("serves /schedule: my week by default, the manager views behind a PIN", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/schedule" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const body = res.body;

    // three views, and the employee's own is the one that loads
    expect(body).toContain('data-view="mine"');
    expect(body).toContain('data-view="plan"');
    expect(body).toContain('data-view="hours"');
    expect(body).toContain('let view="mine"');

    // the employee's own week reads on the session and nothing else, off the
    // SHARED device key the lock screen signs in with (a per-page id would be
    // a device nobody has ever signed in on)
    expect(body).toContain('localStorage.getItem("ros.device")');
    expect(body).toContain('dget("/v1/schedule/mine?deviceId="+encodeURIComponent(DEVICE)');
    expect(body).toContain("Sign in on this device and your shifts appear here");
    // and it says out loud why a draft is not there
    expect(body).toContain("Published shifts only");

    // the two manager reads are POSTs with the PIN in the body, never a URL
    expect(body).toContain('post("/v1/schedule/week"');
    expect(body).toContain('post("/v1/insights/labor"');
    expect(body).not.toContain("managerPin=");
    // gated once and held for the visit, the way Settings asks
    expect(body).toContain('id="ovPin"');
    expect(body).toContain('if(want==="mine"||mgrPin)go();else askPin(go);');
    expect(body).toContain("/^[0-9]{4,6}$/.test(v)");

    // the three commands
    expect(body).toContain('cmd("/v1/schedule/shift"');
    expect(body).toContain('"/v1/schedule/shift/"+encodeURIComponent(sh.id)+"/remove"');
    expect(body).toContain('cmd("/v1/schedule/publish"');

    // publish is one deliberate act, and the confirm says what it does
    expect(body).toContain('id="ovPub"');
    expect(body).toContain('id="pubGo"');
    expect(body).toContain("Staff can see this week after you publish");

    // draft and live wear the Menu page's own language
    expect(body).toContain('class="pill ${s.published?"live":"draft"}"');
    expect(body).toContain(".pill.draft{background:var(--amber-wash)");
    expect(body).toContain(".pill.live{background:var(--green-wash)");
    expect(body).toContain('<span class="chip amber">${esc(plural(drafts,"draft"))}</span>');

    // the overlap warning comes off the response and sits in the page rather
    // than in a dialog: it is a warning, and it never blocks the work
    expect(body).toContain("warning=r.data.note||\"\"");
    expect(body).toContain('class="warn ${warning?"on":""}"');

    // a phone gets one day at a time, never a grid pushed sideways
    expect(body).toContain('class="dayswitch"');
    expect(body).toContain("function phoneDay()");
    expect(body).toContain("@media (min-width:821px){");
    expect(body).toContain(".dayswitch,.phoneday{display:none}");

    // planned versus actual, in hours, off the read's own figures
    expect(body).toContain("r.plannedHours");
    expect(body).toContain("r.actualHours");
    expect(body).toContain("r.varianceHours");
    // nothing on this page turns an hour into money, and there is nowhere to
    // type a rate: D28 rung 3 is never built (team-labor-spec section 4)
    for (const forbidden of ["wageMinor", "hourlyRate", "payRate", "$\"+", "toFixed(2)", "id=\"shWage\""]) {
      expect(body, `${forbidden} has no business on the schedule`).not.toContain(forbidden);
    }
    // the page formats and never computes: no hour is summed here
    expect(body).not.toContain("reduce((a,s)=>a+s.minutes");
    expect(body).not.toContain("/3600000");
  });
});

/* ------------- four permission levels, enforced (E25-T1, D33) -------------
 * The enum grew from server|manager to owner|manager|kitchen|server, and the
 * point of the ticket is not the enum: it is that the SERVER refuses. Nav
 * hiding is E25-T2 and it is a courtesy. Everything below goes through HTTP,
 * because that is where the rule has to hold.
 *
 * Two shapes of refusal, and they mean different things:
 *   403 FORBIDDEN  the matrix stopped this caller at the door of a screen.
 *   422 REJECTED   the command considered it and said no (a PIN gate).
 * Which one a route produces is itself worth asserting: it says whether the
 * screen or the act did the refusing. */

describe("roles and visibility (E25-T1)", () => {
  const PIN = { owner: "1379", manager: "1122", kitchen: "2580", server: "2468" } as const;

  /** sign a device in as one of the four, and hand back its deviceId */
  const signIn = async (app: ReturnType<typeof buildServer>, role: keyof typeof PIN) => {
    const deviceId = `term-${role}`;
    const res = await app.inject({ method: "POST", url: "/v1/session", payload: { deviceId, pin: PIN[role] } });
    expect(res.statusCode, `${role} could not sign in`).toBe(200);
    expect(res.json().employee.role).toBe(role);
    return deviceId;
  };

  const sessionOf = async (app: ReturnType<typeof buildServer>, deviceId: string) =>
    (await app.inject({ method: "GET", url: `/v1/session?deviceId=${deviceId}` })).json();

  const rosterOf = async (app: ReturnType<typeof buildServer>) =>
    (await app.inject({ method: "GET", url: "/v1/staff" })).json().staff as
      { id: string; name: string; role: string; title?: string }[];

  it("serves the matrix with the session, so no page has to invent one", async () => {
    const app = buildServer();

    const server = await sessionOf(app, await signIn(app, "server"));
    expect(server.employee.name).toBe("Gia R.");
    expect(server.visibility).toEqual({
      service: true, tables: true, reservations: true, schedule: true,
      kitchen: false, reports: false, menu: false, cash: false, settings: false,
    });
    expect(server.ownerActs).toBe(false);

    const kitchen = await sessionOf(app, await signIn(app, "kitchen"));
    expect(kitchen.employee.name).toBe("Nico F.");
    expect(kitchen.visibility).toEqual({
      kitchen: true, schedule: true,
      service: false, tables: false, reservations: false, reports: false, menu: false, cash: false, settings: false,
    });

    // a manager sees every screen: the owner-only acts are acts, not screens,
    // so they are refused to a manager rather than hidden from one
    const manager = await sessionOf(app, await signIn(app, "manager"));
    expect(Object.values(manager.visibility).every(Boolean)).toBe(true);
    expect(manager.ownerActs).toBe(false);

    const owner = await sessionOf(app, await signIn(app, "owner"));
    expect(Object.values(owner.visibility).every(Boolean)).toBe(true);
    expect(owner.ownerActs).toBe(true);
  });

  it("refuses each role at the door of a screen that is not theirs", async () => {
    const app = buildServer();
    const kitchen = await signIn(app, "kitchen");
    const server = await signIn(app, "server");

    /* one representative READ per family the caller may not see */
    for (const [deviceId, url, reason] of [
      [kitchen, "/v1/insights/servers", "Reports is not open to a kitchen sign-in"],
      [kitchen, "/v1/checks", "Service is not open to a kitchen sign-in"],
      [kitchen, "/v1/day", "the cash drawer and the day is not open to a kitchen sign-in"],
      [kitchen, "/v1/floor", "Tables is not open to a kitchen sign-in"],
      [kitchen, "/v1/reservations", "Reservations is not open to a kitchen sign-in"],
      [server, "/v1/kds", "Kitchen is not open to a server sign-in"],
      [server, "/v1/menu/draft", "the Menu editor is not open to a server sign-in"],
      [server, "/v1/insights/heatmap", "Reports is not open to a server sign-in"],
    ] as [string, string, string][]) {
      const res = await app.inject({ method: "GET", url: `${url}?deviceId=${deviceId}` });
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toEqual({ status: "FORBIDDEN", reason });
    }

    /* and one representative MUTATION each */
    const bump = await app.inject({ method: "POST", url: "/v1/kds/toggle",
      payload: { ...ENV(1, { deviceId: server }), ticketId: "t", orderItemId: "i" } });
    expect(bump.statusCode).toBe(403);
    expect(bump.json().reason).toBe("Kitchen is not open to a server sign-in");

    const opened = await app.inject({ method: "POST", url: "/v1/checks",
      payload: { ...ENV(2, { deviceId: kitchen }), tableName: "Table 14", covers: 2 } });
    expect(opened.statusCode).toBe(403);
    expect(opened.json().reason).toBe("Service is not open to a kitchen sign-in");

    // the device header does the same job, for a read with no query string
    const byHeader = await app.inject({ method: "GET", url: "/v1/day", headers: { "x-device-id": kitchen } });
    expect(byHeader.statusCode).toBe(403);
  });

  it("lets a server's device SEND to the kitchen, because sending is a Service act", async () => {
    const app = buildServer();
    const deviceId = await signIn(app, "server");
    const check = (await app.inject({ method: "POST", url: "/v1/checks",
      payload: { ...ENV(1, { deviceId }), tableName: "Table 14", covers: 2 } })).json().check;
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(2, { deviceId }), itemId: "acqua", quantity: 1, seatNo: 1 } });

    const send = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/send`, payload: ENV(3, { deviceId }) });
    expect(send.statusCode).toBe(200);
    expect(send.json().tickets.length).toBeGreaterThan(0);

    // but the ticket she just made is not hers to bump back
    const serve = await app.inject({ method: "POST", url: "/v1/kds/serve",
      payload: { ...ENV(4, { deviceId }), tableName: "Table 14" } });
    expect(serve.statusCode).toBe(403);

    // and the kitchen, who may not open a check, can work that same ticket
    const nico = await signIn(app, "kitchen");
    const tickets = (await app.inject({ method: "GET", url: `/v1/kds?deviceId=${nico}` })).json().tickets;
    expect(tickets.length).toBeGreaterThan(0);
    const toggle = await app.inject({ method: "POST", url: "/v1/kds/toggle",
      payload: { ...ENV(5, { deviceId: nico }), ticketId: tickets[0].id, orderItemId: tickets[0].items[0].orderItemId } });
    expect(toggle.statusCode).toBe(200);
  });

  it("a kitchen PIN cannot read the reports, whichever door it knocks on", async () => {
    const app = buildServer();

    // presented as an approval PIN, the manager gate says no
    const byPin = await app.inject({ method: "POST", url: "/v1/insights/labor", payload: { managerPin: PIN.kitchen } });
    expect(byPin.statusCode).toBe(422);
    expect(byPin.json().reason).toBe("PIN not recognized as a manager");

    // signed in at a terminal, the matrix says no one step earlier
    const nico = await signIn(app, "kitchen");
    const bySession = await app.inject({ method: "POST", url: "/v1/insights/labor",
      payload: { deviceId: nico, managerPin: PIN.kitchen } });
    expect(bySession.statusCode).toBe(403);
    expect(bySession.json().reason).toBe("Reports is not open to a kitchen sign-in");
  });

  it("gives a server the schedule SCREEN and still refuses the manager's week behind it", async () => {
    const app = buildServer();
    const gia = await signIn(app, "server");

    // her own week: no PIN, nothing to configure, and the matrix lets it past
    const mine = await app.inject({ method: "GET", url: `/v1/schedule/mine?deviceId=${gia}` });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().employee.name).toBe("Gia R.");

    // the whole room's week is a different thing, and her own PIN does not buy it
    const week = await app.inject({ method: "POST", url: "/v1/schedule/week",
      payload: { deviceId: gia, managerPin: PIN.server } });
    expect(week.statusCode).toBe(422);
    expect(week.json().reason).toBe("PIN not recognized as a manager");

    // the kitchen gets exactly the same deal: their own week, nothing else
    const nico = await signIn(app, "kitchen");
    expect((await app.inject({ method: "GET", url: `/v1/schedule/mine?deviceId=${nico}` })).json().employee.name).toBe("Nico F.");
  });

  it("passes an owner through every manager gate there is", async () => {
    const app = buildServer();
    const OWNER = PIN.owner;

    // a void approval (E12)
    const check = await openCheck(app);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(1), itemId: "acqua", quantity: 1, seatNo: 1 } });
    const line = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check.lines[0].id;
    const voided = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items/${line}/void`,
      payload: { ...ENV(2), reason: "guest changed mind", managerPin: OWNER } });
    expect(voided.statusCode).toBe(200);
    expect(voided.json().check.lines[0].status).toBe("voided");

    // the gated reads (E24-T2, E24-T3, E24-T4)
    for (const url of ["/v1/staff/directory", "/v1/schedule/week", "/v1/insights/labor", "/v1/staff/hours-export"]) {
      const res = await app.inject({ method: "POST", url, payload: { managerPin: OWNER } });
      expect(res.statusCode, url).toBe(200);
    }

    // and the gated writes (E6-T2, E5-T2)
    const table = await app.inject({ method: "POST", url: "/v1/floor/add",
      payload: { ...ENV(3), managerPin: OWNER, name: "Dehors 9", area: "Dehors", seats: 4, shape: "round", x: 10, y: 10, w: 12, h: 16 } });
    expect(table.statusCode).toBe(200);
    const group = await app.inject({ method: "POST", url: "/v1/menu/draft/group",
      payload: { ...ENV(4), managerPin: OWNER, groupId: "spice", name: "Spice level", minSelect: 1, maxSelect: 1,
                 options: [{ id: "mild", name: "Mild", priceMinor: 0 }] } });
    expect(group.statusCode).toBe(200);
    const publish = await app.inject({ method: "POST", url: "/v1/menu/publish", payload: { ...ENV(5), managerPin: OWNER } });
    expect(publish.statusCode).toBe(200);
  });

  it("makes a promotion the owner's, and leaves the lateral move a manager's", async () => {
    const app = buildServer();
    const setRole = (n: number, id: string, role: unknown, pin: string) =>
      app.inject({ method: "POST", url: `/v1/staff/${id}/role`, payload: { ...ENV(n), managerPin: pin, role } });

    const gia = (await rosterOf(app)).find((s) => s.name === "Gia R.")!;
    const marco = (await rosterOf(app)).find((s) => s.name === "Marco B.")!;

    // between the two lateral levels a manager decides: neither outranks
    // anything, so nothing about who can approve has moved
    const sideways = await setRole(1, gia.id, "kitchen", PIN.manager);
    expect(sideways.statusCode).toBe(200);
    expect(sideways.json().employee).toMatchObject({ name: "Gia R.", role: "kitchen" });
    // the title follows the level only while nobody has typed one over it
    expect(sideways.json().employee.title).toBe("Kitchen");

    // promoting anybody INTO the approving half is not
    const promote = await setRole(2, gia.id, "manager", PIN.manager);
    expect(promote.statusCode).toBe(422);
    expect(promote.json().reason).toBe("changing the role of a manager or an owner is the owner's to do; this PIN is not an owner's");
    expect((await rosterOf(app)).find((s) => s.name === "Gia R.")!.role).toBe("kitchen");
    expect((await setRole(3, gia.id, "manager", PIN.owner)).statusCode).toBe(200);

    // and demoting one is not either
    const demote = await setRole(4, marco.id, "server", PIN.manager);
    expect(demote.statusCode).toBe(422);
    expect(demote.json().reason).toBe("changing the role of a manager or an owner is the owner's to do; this PIN is not an owner's");
    expect((await setRole(5, marco.id, "server", PIN.owner)).statusCode).toBe(200);

    // his PIN stops approving the moment his level does
    const nowAServer = await app.inject({ method: "POST", url: "/v1/staff/directory", payload: { managerPin: PIN.manager } });
    expect(nowAServer.statusCode).toBe(422);
    expect(nowAServer.json().reason).toBe("PIN not recognized as a manager");

    // the malformed cases
    expect((await setRole(6, gia.id, "chef", PIN.owner)).json().reason).toBe("role must be one of owner, manager, kitchen, server");
    expect((await setRole(7, gia.id, "manager", PIN.owner)).json().reason).toBe("Gia R. is already manager");
    expect((await setRole(8, "not-a-real-id", "server", PIN.owner)).json().reason).toBe("no employee not-a-real-id");
  });

  it("never lets the roster lose its last person who can approve", async () => {
    const app = buildServer();
    const setRole = (n: number, id: string, role: string, pin: string) =>
      app.inject({ method: "POST", url: `/v1/staff/${id}/role`, payload: { ...ENV(n), managerPin: pin, role } });

    const marco = (await rosterOf(app)).find((s) => s.name === "Marco B.")!;
    const elena = (await rosterOf(app)).find((s) => s.name === "Elena V.")!;

    // with Marco still approving, nothing is stranded tonight, and the SECOND
    // guard is the one that speaks: only an owner can make another owner, so
    // a venue that loses its last one can never change its own name again
    const orphan = await setRole(1, elena.id, "manager", PIN.owner);
    expect(orphan.statusCode).toBe(422);
    expect(orphan.json().reason).toBe("Elena V. is the only active owner; make somebody else an owner first");

    // Marco leaves the approving half; Elena is still there to say yes to a
    // void at two in the morning, so nothing is stranded yet
    expect((await setRole(3, marco.id, "server", PIN.owner)).statusCode).toBe(200);

    // now she is the only one left, and her own PIN cannot demote her
    const last = await setRole(4, elena.id, "server", PIN.owner);
    expect(last.statusCode).toBe(422);
    expect(last.json().reason).toBe("Elena V. is the only active manager or owner; promote someone else first");
    expect((await rosterOf(app)).find((s) => s.name === "Elena V.")!.role).toBe("owner");

    // and the same guard on the same person through the other door
    const out = await app.inject({ method: "POST", url: `/v1/staff/${elena.id}/deactivate`,
      payload: { ...ENV(5), managerPin: PIN.owner } });
    expect(out.statusCode).toBe(422);
    expect(out.json().reason).toBe("Elena V. is the only active manager or owner; promote someone else first");
  });

  it("resets an approver's PIN only for an owner, and anybody else's for a manager", async () => {
    const app = buildServer();
    const marco = (await rosterOf(app)).find((s) => s.name === "Marco B.")!;
    const nico = (await rosterOf(app)).find((s) => s.name === "Nico F.")!;

    // the kitchen and the floor are still a manager's to look after
    expect((await app.inject({ method: "POST", url: `/v1/staff/${nico.id}/pin`,
      payload: { ...ENV(1), managerPin: PIN.manager, pin: "6160" } })).statusCode).toBe(200);

    // another manager's is not: a PIN reset hands the new PIN to whoever
    // typed it, so a manager who could do this could approve as Marco
    const byManager = await app.inject({ method: "POST", url: `/v1/staff/${marco.id}/pin`,
      payload: { ...ENV(2), managerPin: PIN.manager, pin: "5150" } });
    expect(byManager.statusCode).toBe(422);
    expect(byManager.json().reason).toBe("resetting Marco B.'s PIN is the owner's to do; this PIN is not an owner's");
    // his old PIN still works, so nothing half-happened
    expect((await app.inject({ method: "POST", url: "/v1/session", payload: { deviceId: "d", pin: PIN.manager } })).statusCode).toBe(200);

    expect((await app.inject({ method: "POST", url: `/v1/staff/${marco.id}/pin`,
      payload: { ...ENV(3), managerPin: PIN.owner, pin: "5150" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/session", payload: { deviceId: "d2", pin: PIN.manager } })).statusCode).toBe(401);
  });

  it("hires into any level, and only an owner can hire an owner", async () => {
    const app = buildServer();
    const hire = (n: number, role: string, pin: string, approver: string, extra: Record<string, unknown> = {}) =>
      app.inject({ method: "POST", url: "/v1/staff",
        payload: { ...ENV(n), managerPin: approver, name: `New ${role}`, role, pin, ...extra } });

    // a manager hires a line cook, and the default title is the level's own
    // name until somebody types the room's word over it (D28)
    const cook = await hire(1, "kitchen", "4111", PIN.manager);
    expect(cook.statusCode).toBe(200);
    expect(cook.json().employee).toMatchObject({ role: "kitchen", title: "Kitchen" });
    const titled = await hire(2, "kitchen", "4222", PIN.manager, { name: "Bar", title: "Bartender" });
    expect(titled.json().employee).toMatchObject({ role: "kitchen", title: "Bartender" });

    // but a manager who could hire an owner could hire themselves one
    const sneaky = await hire(3, "owner", "4333", PIN.manager);
    expect(sneaky.statusCode).toBe(422);
    expect(sneaky.json().reason).toBe("hiring somebody in as an owner is the owner's to do; this PIN is not an owner's");
    expect((await hire(4, "owner", "4333", PIN.owner)).statusCode).toBe(200);

    // the new cook signs in and lands on the kitchen's own matrix row
    const session = await app.inject({ method: "POST", url: "/v1/session", payload: { deviceId: "term-new", pin: "4111" } });
    expect(session.json().employee.role).toBe("kitchen");
    expect((await sessionOf(app, "term-new")).visibility.service).toBe(false);
  });

  it("replays a role change exactly once", async () => {
    const app = buildServer();
    const gia = (await rosterOf(app)).find((s) => s.name === "Gia R.")!;
    const payload = { operationId: "role-op-0001", deviceId: "test-terminal", managerPin: PIN.manager, role: "kitchen" };

    const first = await app.inject({ method: "POST", url: `/v1/staff/${gia.id}/role`, payload });
    const retry = await app.inject({ method: "POST", url: `/v1/staff/${gia.id}/role`, payload });
    expect(first.statusCode).toBe(200);
    // a naive re-run would meet "Gia R. is already kitchen"; the journal
    // answers instead, which is what makes a dropped response safe to retry
    expect(retry.json()).toEqual(first.json());
  });

  it("signs a demoted employee's own terminal down to their new level", async () => {
    const app = buildServer();
    const gia = await signIn(app, "server");
    expect((await sessionOf(app, gia)).visibility.service).toBe(true);

    const id = (await sessionOf(app, gia)).employee.id;
    expect((await app.inject({ method: "POST", url: `/v1/staff/${id}/role`,
      payload: { ...ENV(1), managerPin: PIN.manager, role: "kitchen" } })).statusCode).toBe(200);

    // she is still signed in, and the screen she was on is no longer hers
    const now = await sessionOf(app, gia);
    expect(now.employee.role).toBe("kitchen");
    expect(now.visibility).toMatchObject({ service: false, kitchen: true });
    expect((await app.inject({ method: "GET", url: `/v1/checks?deviceId=${gia}` })).statusCode).toBe(403);
  });

  it("leaves an unidentified terminal exactly the access it had, and says so in the session", async () => {
    const app = buildServer();
    // THE NAMED LIMIT of this ticket: with no session and no approval PIN the
    // matrix has nobody to check, so the unsigned terminal E15 supports keeps
    // working. Signing OUT is therefore a way around the matrix, and closing
    // it means making sign-in mandatory, which changes what an unsigned
    // terminal IS and is a founder decision rather than something to smuggle
    // in here. The session read tells the truth about it rather than drawing
    // a nav that hides doors the server would still open.
    for (const url of ["/v1/checks", "/v1/kds", "/v1/day", "/v1/insights/servers", "/v1/menu/draft"]) {
      expect((await app.inject({ method: "GET", url })).statusCode, url).toBe(200);
    }
    const signedOut = await sessionOf(app, "nobody-here");
    expect(signedOut.employee).toBeNull();
    expect(Object.values(signedOut.visibility).every(Boolean)).toBe(true);
    expect(signedOut.ownerActs).toBe(false);
  });

  it("boots only when every /v1 route has said who may call it", async () => {
    // the onRoute/onReady pair in server.ts fails the boot when a route is
    // registered without a row in ROUTE_SCREEN, so this one line is the whole
    // matrix's completeness check: a route added in E26 with nobody assigned
    // to it takes the suite down here rather than shipping open
    await expect(buildServer().ready()).resolves.toBeTruthy();
  });
});

/* -------------- each role sees its own app, on the pages (E25-T2) --------------
 * No engine or route under test here (E25-T1 owns that): page-serve
 * assertions only, over the client-side hooks that consume the session's own
 * matrix. The rail hides a screen as a courtesy; these assertions exist so a
 * later edit cannot quietly drop the hook that does the hiding, or the
 * refusal a role hits when it types past the rail. */
describe("each role sees its own app (E25-T2)", () => {
  const SCREENS = [
    { url: "/pos", screen: "service" },
    { url: "/tables", screen: "tables" },
    { url: "/reservations", screen: "reservations" },
    { url: "/kds", screen: "kitchen" },
    { url: "/menu", screen: "menu" },
    { url: "/close", screen: "cash" },
    { url: "/reports", screen: "reports" },
    { url: "/schedule", screen: "schedule" },
    { url: "/settings", screen: "settings" },
  ];

  it("carries the visibility hook, the refusal notice, and a device-identified read on all nine pages", async () => {
    const app = buildServer();
    for (const { url, screen } of SCREENS) {
      const body = (await app.inject({ method: "GET", url })).body;
      expect(body, `${url} misses THIS_SCREEN`).toContain(`const THIS_SCREEN="${screen}"`);
      expect(body, `${url} misses the rail filter map`).toContain("const RAIL_SCREEN=");
      // hidden with display, never removed: a role switch on the same page
      // (sign in as somebody else without a reload) has to be able to show a
      // rail entry back, not just take it away once
      expect(body, `${url} removes rather than hides a rail entry`).toContain('a.style.display=vis?"":"none";');
      expect(body, `${url} misses the refusal card`).toContain('class="refusal"');
      expect(body, `${url} misses the refusal card class`).toContain('class="refusal-card"');
      expect(body, `${url} does not name who is signed in on a refusal`).toContain("You are signed in as");
      expect(body, `${url} offers no way back from a refusal`).toContain('id="refBack"');
      expect(body, `${url} offers no way to sign out from a refusal`).toContain('id="refOut"');
      // item 6: every GET on this page carries x-device-id, so the visibility
      // gate can bite for a signed-in device on a read, not only a mutation
      expect(body, `${url} does not identify its GET reads`)
        .toContain('function dget(url){return fetch(url,{headers:{"x-device-id":DEVICE}});}');
      // the shared device id, never a per-page one: a per-page id is a device
      // nobody has ever signed in on, and the gate cannot bite for it
      expect(body, `${url} keeps a per-page device id instead of the shared one`)
        .toContain('localStorage.getItem("ros.device")');
      // E24-T5's toast fix, item 5: landing on a bottom sheet's action row
      // must never deaden the button under it
      expect(body, `${url} lets a toast eat taps`).toContain(".toasts{pointer-events:none}");
    }
  });

  it("shows the role under the name on the lock screen", async () => {
    const body = (await buildServer().inject({ method: "GET", url: "/" })).body;
    expect(body).toContain('const ROLE_LABEL={owner:"Owner",manager:"Manager",kitchen:"Kitchen",server:"Server"}');
    expect(body).toContain('emp.name+" · "+(ROLE_LABEL[emp.role]||emp.role)');
  });

  it("gives Settings' hire form all four roles, plainly labeled, with an owner PIN gate on Owner", async () => {
    const body = (await buildServer().inject({ method: "GET", url: "/settings" })).body;
    expect(body).toContain('data-r="owner">Owner<');
    expect(body).toContain('data-r="manager">Manager<');
    expect(body).toContain('data-r="kitchen">Kitchen<');
    expect(body).toContain('data-r="server">Server<');
    // one line each on what a role sees
    expect(body).toContain("<b>Owner</b>");
    expect(body).toContain("<b>Manager</b>");
    expect(body).toContain("<b>Kitchen</b>");
    expect(body).toContain("<b>Server</b>");
    // picking Owner routes the hire through the owner-PIN path the core built
    expect(body).toContain('id="aOwnerGate"');
    expect(body).toContain('id="aOwnPin"');
    expect(body).toContain('role==="owner"?{managerPin:$("#aOwnPin").value.trim()}:{}');
  });
});

/* -------------- the back office gets a front door (D35/UI-T5) -------------- */
describe("the back office hub (UI-T5)", () => {
  it("serves /office with one card per area, matrix-gated like the rails", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/office" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const body = res.body;

    // one card per back-office area, each linking straight to its screen
    expect(body).toContain('card("Menu","/menu"');
    expect(body).toContain('card("Reports","/reports"');
    expect(body).toContain('card("Schedule","/schedule?view=plan"');
    expect(body).toContain('card("Venue & team","/settings"');
    // sub-links land on the anchors the target pages actually carry
    expect(body).toContain('href:"/menu#live"');
    expect(body).toContain('href:"/menu#btnImport"');
    expect(body).toContain('href:"/settings#team"');
    expect(body).toContain('href:"/settings#payroll"');
    // and those anchors land on real ids on the pages they point at
    const settingsBody = (await app.inject({ method: "GET", url: "/settings" })).body;
    expect(settingsBody).toContain('id="team">Team<');
    expect(settingsBody).toContain('id="payroll">Payroll export<');

    // stats read the EXISTING reads only, formatted and never computed
    expect(body).toContain("dget(\"/v1/menu/draft\")");
    expect(body).toContain("dget(\"/v1/day\")");
    expect(body).toContain('/v1/schedule/week"');
    expect(body).toContain('dget("/v1/staff")');
    // a failed fetch degrades the card, never breaks it: every stat function
    // is one try/catch returning an empty string on failure, not a throw
    expect(body.match(/\}catch\(_\)\{return "";\}/g)?.length).toBeGreaterThanOrEqual(4);

    // the hub is matrix-gated like every rail, hardcoded nowhere but the
    // family of screens it stands in for
    expect(body).toContain('const OFFICE_FAMILY=["menu","reports","cash","settings"];');
    expect(body).toContain("OFFICE_FAMILY.some(s=>visibility[s])");

    // phone-first: a single column that grows into a grid, never the other way
    expect(body).toContain(".hub{display:grid;grid-template-columns:1fr;gap:14px");
    expect(body).toContain("@media (min-width:640px){.hub{grid-template-columns:1fr 1fr}}");
  });

  it("restructures the rail on all ten pages: floor screens keep theirs, Menu/Reports/Settings collapse into Office", async () => {
    const app = buildServer();
    for (const url of ["/pos", "/tables", "/reservations", "/kds", "/close", "/schedule", "/office", "/menu", "/reports", "/settings"]) {
      const body = (await app.inject({ method: "GET", url })).body;
      expect(body, `${url} rail missing Office`).toContain('href="/office"');
      expect(body, `${url} rail still carries Menu`).not.toContain('href="/menu"><svg');
      expect(body, `${url} rail still carries Reports`).not.toContain('href="/reports"><svg');
      expect(body, `${url} rail still carries Settings`).not.toContain('href="/settings"><svg');
    }
  });

  it("lands sign-in by role: server on Service, kitchen on Kitchen, manager and owner on the hub", async () => {
    const body = (await buildServer().inject({ method: "GET", url: "/" })).body;
    expect(body).toContain('emp.role==="kitchen"?"/kds":(emp.role==="manager"||emp.role==="owner")?"/office":"/pos"');
  });

  it("still lets a deep link reach Menu, Reports and Settings directly, breadcrumbed back to the hub", async () => {
    const app = buildServer();
    for (const url of ["/menu", "/reports", "/settings"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, `${url} deep link`).toBe(200);
      const body = res.body;
      expect(body, `${url} missing the Office breadcrumb`).toContain('class="office-crumb" href="/office"');
      expect(body, `${url} rail should mark Office current, not itself`)
        .toContain('class="nav-btn on" aria-current="page" href="/office"');
    }
    // the schedule deep link opens straight to the Plan tab
    const schedule = (await app.inject({ method: "GET", url: "/schedule" })).body;
    expect(schedule).toContain('new URLSearchParams(location.search).get("view")');
    expect(schedule).toContain('.view[data-view="${wantView}"]');
  });
});

/* ------------- the terminal sheet goes everywhere (E25-T3) -------------
 * Founder-reported defect: kitchen could not reach /pos, and the only Sign
 * out sat on the sheet that lived there, so a kitchen sign-in was trapped in
 * its own app. Page-serve assertions only: every page gets the same chip and
 * sheet pos.html already had, kds.html (which had neither before this
 * ticket) and schedule.html (which had a read-only chip) get the closest
 * look because the ticket names them explicitly. */
describe("everyone can leave: the terminal sheet goes everywhere (E25-T3)", () => {
  // /pos is the reference implementation this ticket replicates rather than
  // touches: it already had the chip and sheet, under its own older ids
  // (#btnWho/#ovWho), so it is left out of the generic sweep below
  const PAGES = ["/tables", "/kds", "/close", "/reports", "/reservations", "/menu", "/schedule", "/settings", "/office"];

  it("kds.html gains the identity chip and sheet it had none of before", async () => {
    const body = (await buildServer().inject({ method: "GET", url: "/kds" })).body;
    // the chip: no session reads "Not signed in", tapping it opens the sheet
    expect(body).toContain('<button class="who-chip" id="whoChip">Not signed in</button>');
    expect(body).toContain('const ROLE_LABEL={owner:"Owner",manager:"Manager",kitchen:"Kitchen",server:"Server"}');
    expect(body).toContain('document.getElementById("whoChip").onclick=async()=>{');
    // the sheet itself, and the KDS's own always-dark tokens style it (no
    // separate light/dark branch needed since this page has none either)
    expect(body).toContain('<div class="who-ov" id="whoOv">');
    expect(body).toContain('id="whoBody"');
    expect(body).toContain('id="whoFoot"');
    // the same three acts, the same server calls /pos already makes
    expect(body).toContain('fetch("/v1/session",{method:"POST"');
    expect(body).toContain('fetch("/v1/session/signout",{method:"POST"');
    expect(body).toContain('fetch("/v1/shifts/clockout",{method:"POST"');
    // demo-PIN helper list, off the same public endpoint pos.html reads
    expect(body).toContain('dget("/v1/staff/demo-pins")');
    // signing out lands on the lock screen
    expect(body).toContain('location.href="/";');
  });

  it("schedule.html's chip becomes tappable and always shows the role, not just for a manager", async () => {
    const body = (await buildServer().inject({ method: "GET", url: "/schedule" })).body;
    // the chip is a button now, not a read-only span
    expect(body).toContain('<button class="who-chip" id="whoChip">Not signed in</button>');
    expect(body).not.toContain('<span class="chip mut" id="whoChip">');
    // every role shows under the name (lock screen's pattern), not just "manager"
    expect(body).toContain('me?me.name+" · "+(ROLE_LABEL[me.role]||me.role):"Not signed in"');
    expect(body).not.toContain('me.role==="manager"?" · manager":""');
    // tapping it opens the same sheet, and a successful switch re-runs THIS
    // page's own visibility function (loadWho), not a generic one
    expect(body).toContain('$("#whoChip").onclick=async()=>{');
    expect(body).toContain('whoClose();toast("Hi "+data.employee.name);await loadWho();');
  });

  it("gives every page the chip and the sheet's three acts, kitchen included", async () => {
    const app = buildServer();
    for (const url of PAGES) {
      const body = (await app.inject({ method: "GET", url })).body;
      expect(body, `${url} missing the who-chip`).toContain('id="whoChip"');
      expect(body, `${url} missing the sheet`).toContain('id="whoOv"');
      expect(body, `${url} missing sign-in`).toContain('fetch("/v1/session",{method:"POST"');
      expect(body, `${url} missing sign-out`).toContain('fetch("/v1/session/signout",{method:"POST"');
      expect(body, `${url} missing clock-out`).toContain('fetch("/v1/shifts/clockout",{method:"POST"');
      expect(body, `${url} missing the demo-PIN helper`).toContain('/v1/staff/demo-pins');
      // touch and press feedback are non-negotiable (DESIGN.md section 8)
      expect(body, `${url} chip under 44px`).toContain(".who-chip{min-height:44px");
      expect(body, `${url} option rows under 44px`).toContain(".who-opt{min-height:44px");
      expect(body, `${url} sign-in button under 44px`).toContain(".who-go{min-height:44px");
    }
  });
});
