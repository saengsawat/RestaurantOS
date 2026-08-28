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

  it("reads without a session, and a manager can rename, move, and re-zone it", async () => {
    const app = buildServer();
    const seeded = (await app.inject({ method: "GET", url: "/v1/venue" })).json();
    expect(seeded).toEqual({
      name: "Osteria Nove",
      address: "9 Vicolo della Luna, New York",
      timezone: "America/New_York",
    });

    const res = await app.inject({ method: "POST", url: "/v1/venue",
      payload: { ...ENV(1), managerPin: MGR, name: "Trattoria Sedici", address: "16 Elm St, Austin", timezone: "America/Chicago" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().venue).toEqual({ name: "Trattoria Sedici", address: "16 Elm St, Austin", timezone: "America/Chicago" });
    expect((await app.inject({ method: "GET", url: "/v1/venue" })).json().name).toBe("Trattoria Sedici");

    // an omitted field is left alone; a blank address is a real edit, because
    // a kitchen with no street frontage is a real thing
    const partial = await app.inject({ method: "POST", url: "/v1/venue",
      payload: { ...ENV(2), managerPin: MGR, address: "" } });
    expect(partial.json().venue).toEqual({ name: "Trattoria Sedici", address: "", timezone: "America/Chicago" });
  });

  it("refuses the edit without a manager, and refuses a name or a timezone it cannot honor", async () => {
    const app = buildServer();
    const bare = await app.inject({ method: "POST", url: "/v1/venue", payload: { ...ENV(1), name: "Nope" } });
    expect(bare.statusCode).toBe(422);
    expect(bare.json().reason).toBe("editing the venue requires a manager's PIN");

    const asServer = await app.inject({ method: "POST", url: "/v1/venue",
      payload: { ...ENV(2), managerPin: "2468", name: "Nope" } });
    expect(asServer.json().reason).toBe("PIN not recognized as a manager");

    const blank = await app.inject({ method: "POST", url: "/v1/venue",
      payload: { ...ENV(3), managerPin: MGR, name: "   " } });
    expect(blank.statusCode).toBe(422);
    expect(blank.json().reason).toBe("a restaurant needs a name");

    const zone = await app.inject({ method: "POST", url: "/v1/venue",
      payload: { ...ENV(4), managerPin: MGR, timezone: "America/Atlantis" } });
    expect(zone.statusCode).toBe(422);
    expect(zone.json().reason).toBe("America/Atlantis is not a timezone this machine knows");

    // nothing stuck
    expect((await app.inject({ method: "GET", url: "/v1/venue" })).json().name).toBe("Osteria Nove");
  });

  it("replays a venue edit exactly once", async () => {
    const app = buildServer();
    const payload = { operationId: "venue-op-0001", deviceId: "test-terminal", managerPin: MGR, name: "Trattoria Sedici" };
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
    expect(staff.map((s) => s.name)).toEqual(["Gia R.", "Marco B.", "Sofia T."]);
    expect(staff.every((s) => s.active)).toBe(true);
    for (const s of staff) expect(Object.keys(s).sort()).toEqual(["active", "id", "name", "role"]);
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
      [{ role: "chef" }, "role must be server or manager"],
      [{ pin: "12" }, "a PIN is 4 to 6 digits"],
      [{ pin: "1234567" }, "a PIN is 4 to 6 digits"],
      [{ pin: "12a4" }, "a PIN is 4 to 6 digits"],
      [{ pin: "2468" }, "that PIN already belongs to Gia R."],
    ] as [Record<string, unknown>, string][]) {
      const res = await hire(app, 2, patch);
      expect(res.statusCode, reason).toBe(422);
      expect(res.json().reason).toBe(reason);
    }
    expect(await roster(app)).toHaveLength(3);
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

  it("a deactivated manager cannot approve, and the last one cannot be deactivated", async () => {
    const app = buildServer();
    // a second manager, so Marco is not the last one
    const nina = (await hire(app, 1, { name: "Nina V.", role: "manager", pin: "7788" })).json().employee;

    const out = await app.inject({ method: "POST", url: `/v1/staff/${nina.id}/deactivate`,
      payload: { ...ENV(2), managerPin: MGR } });
    expect(out.statusCode).toBe(200);

    // her PIN no longer approves anything
    const check = await openCheck(app);
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items`,
      payload: { ...ENV(3), itemId: "acqua", quantity: 1, seatNo: 1 } });
    const state = (await app.inject({ method: "GET", url: `/v1/checks/${check.id}` })).json().check;
    const refused = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items/${state.lines[0].id}/void`,
      payload: { ...ENV(4), reason: "guest changed mind", managerPin: "7788" } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().reason).toBe("PIN not recognized as a manager");

    // and now Marco is the last active manager, so he stays
    const marco = (await roster(app)).find((s) => s.name === "Marco B.")!;
    const last = await app.inject({ method: "POST", url: `/v1/staff/${marco.id}/deactivate`,
      payload: { ...ENV(5), managerPin: MGR } });
    expect(last.statusCode).toBe(422);
    expect(last.json().reason).toBe("Marco B. is the only active manager; promote someone else first");
    expect((await roster(app)).find((s) => s.name === "Marco B.")!.active).toBe(true);
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
    // and every other page can reach it, now through its rail entry (UI-T1)
    for (const url of ["/pos", "/tables", "/kds", "/menu", "/close"]) {
      expect((await app.inject({ method: "GET", url })).body).toContain('class="nav-btn" href="/reports"');
    }
  });

  /* UI-T1: the shell DESIGN.md section 5 prescribes. Navigation is a place you
   * go, so it is the left icon rail with its badge counts; the topbar is where
   * you are. The markup is duplicated per page (each page is a self-contained
   * zero-dependency file), so the assertion runs over all six to keep the six
   * copies from drifting apart. */
  it("gives all six navigable pages the app shell: rail navigates, topbar identifies", async () => {
    const app = buildServer();
    const screens = ["/pos", "/tables", "/kds", "/menu", "/close", "/reports"];
    for (const url of screens) {
      const body = (await app.inject({ method: "GET", url })).body;
      expect(body).toContain('<nav class="navrail" aria-label="Screens">');
      expect(body).toContain('class="shellbody"');
      // every screen is reachable from every screen, and exactly one entry is
      // marked current: the one you are on
      for (const dest of screens) expect(body).toContain(`href="${dest}"`);
      expect(body.match(/class="nav-btn on" aria-current="page"/g)).toHaveLength(1);
      expect(body).toContain(`class="nav-btn on" aria-current="page" href="${url}"`);
      // six icons, inline SVG in one stroke style, never emoji
      expect(body.match(/<svg viewBox="0 0 24 24" aria-hidden="true">/g)).toHaveLength(6);
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
    }
    // the lock screen stays a fullscreen PIN pad: no rail, nowhere to go yet
    expect((await app.inject({ method: "GET", url: "/" })).body).not.toContain("navrail");
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
