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
