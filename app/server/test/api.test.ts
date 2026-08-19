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
      payload: { ...ENV(4), managerPin: "1234" } });
    expect(noReason.statusCode).toBe(422);
    const noPin = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items/${ragu.id}/void`,
      payload: { ...ENV(5), reason: "guest changed mind" } });
    expect(noPin.statusCode).toBe(422);
    expect(noPin.json().reason).toMatch(/approval/);

    const voided = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/items/${ragu.id}/void`,
      payload: { ...ENV(6), reason: "guest changed mind", managerPin: "1234" } });
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
      payload: { ...ENV(9), reason: "double tap", managerPin: "1234" } });
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
      payload: { ...ENV(3), percentBp: 1000, reason: "industry guest", managerPin: "4321" } });
    expect(pct.statusCode).toBe(200);
    expect(pct.json().check.totals.discountMinor).toBe(240);
    expect(pct.json().check.totals.dueMinor).toBe(2160 + 192);

    // both amount AND percent in one call is refused (schema XOR)
    const both = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/adjustments`,
      payload: { ...ENV(4), amountMinor: 100, percentBp: 500, reason: "confused", managerPin: "4321" } });
    expect(both.statusCode).toBe(422);

    // no PIN refused
    const noPin = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/adjustments`,
      payload: { ...ENV(5), amountMinor: 100, reason: "no approval" } });
    expect(noPin.statusCode).toBe(422);

    // amount comp stacks with the percent
    const amt = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/adjustments`,
      payload: { ...ENV(6), kind: "comp", amountMinor: 500, label: "Kitchen delay", reason: "long wait on primi", managerPin: "4321" } });
    expect(amt.statusCode).toBe(200);
    expect(amt.json().check.totals.discountMinor).toBe(740);

    // pay in full, then a further discount is refused
    const due = amt.json().check.totals.dueMinor as number;
    await app.inject({ method: "POST", url: `/v1/checks/${check.id}/payments`,
      payload: { ...ENV(7), method: "card", amountMinor: due } });
    const late = await app.inject({ method: "POST", url: `/v1/checks/${check.id}/adjustments`,
      payload: { ...ENV(8), amountMinor: 100, reason: "too late", managerPin: "4321" } });
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
    const pub = await app.inject({ method: "POST", url: "/v1/menu/publish", payload: { ...ENV(5), managerPin: "1234" } });
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
    await app.inject({ method: "POST", url: "/v1/menu/publish", payload: { ...ENV(9), managerPin: "1234" } });
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
      payload: { ...ENV(8), sessionId, kind: "pay_out", amountMinor: 1500, reason: "produce run", managerPin: "1234" } });
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
    const early = await app.inject({ method: "POST", url: "/v1/day/close", payload: { ...ENV(3), managerPin: "1234" } });
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
    const midway = await app.inject({ method: "POST", url: "/v1/day/close", payload: { ...ENV(7), managerPin: "1234" } });
    expect(midway.statusCode).toBe(422);
    expect(midway.json().reason).toMatch(/drawer/);

    await app.inject({ method: "POST", url: "/v1/drawer/close", payload: { ...ENV(8), sessionId, countedMinor: 10000 } });

    // no PIN, no close
    const noPin = await app.inject({ method: "POST", url: "/v1/day/close", payload: ENV(9) });
    expect(noPin.statusCode).toBe(422);

    // all clear: the close carries the sealed summary
    const done = await app.inject({ method: "POST", url: "/v1/day/close", payload: { ...ENV(10), managerPin: "1234" } });
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
    const again = await app.inject({ method: "POST", url: "/v1/day/close", payload: { ...ENV(12), managerPin: "1234" } });
    expect(again.statusCode).toBe(422);

    // reopen (manager) and service resumes
    const reopen = await app.inject({ method: "POST", url: "/v1/day/reopen", payload: { ...ENV(13), managerPin: "1234" } });
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
