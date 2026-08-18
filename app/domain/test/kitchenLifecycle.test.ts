import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  KITCHEN_TICKET_STATUSES,
  ORDER_ITEM_STATUSES,
  TICKET_ITEM_STATUSES,
  kitchenTicketTransition,
  orderItemTransition,
  ticketItemTransition,
  type KitchenTicketEvent,
  type KitchenTicketStatus,
  type OrderItemEvent,
  type TicketItemStatus,
} from "../src/kitchenLifecycle.js";

describe("orderItemTransition: exhaustive", () => {
  const events: OrderItemEvent[] = [
    { type: "dispatch" },
    { type: "void_item", approved: true },
    { type: "void_item", approved: false },
  ];

  it("an item dispatches exactly once, from unsent only", () => {
    expect(orderItemTransition("unsent", { type: "dispatch" })).toEqual({ ok: true, next: "sent" });
    expect(orderItemTransition("sent", { type: "dispatch" }).ok).toBe(false);
    expect(orderItemTransition("voided", { type: "dispatch" }).ok).toBe(false);
  });

  it("voiding needs approval and works pre- and post-fire, never twice", () => {
    expect(orderItemTransition("unsent", { type: "void_item", approved: true })).toEqual({ ok: true, next: "voided" });
    expect(orderItemTransition("sent", { type: "void_item", approved: true })).toEqual({ ok: true, next: "voided" });
    expect(orderItemTransition("unsent", { type: "void_item", approved: false }).ok).toBe(false);
    expect(orderItemTransition("sent", { type: "void_item", approved: false }).ok).toBe(false);
    expect(orderItemTransition("voided", { type: "void_item", approved: true }).ok).toBe(false);
  });

  it("full space check: 3 statuses x 3 events, exactly 3 legal (dispatch, void pre-fire, void post-fire)", () => {
    let legal = 0;
    for (const s of ORDER_ITEM_STATUSES) for (const e of events) if (orderItemTransition(s, e).ok) legal++;
    expect(legal).toBe(3);
  });
});

describe("ticketItemTransition: the mis-tap remedy", () => {
  it("toggles freely while the ticket is open", () => {
    expect(ticketItemTransition("pending", { type: "toggle_done", ticketStatus: "open" })).toEqual({ ok: true, next: "done" });
    expect(ticketItemTransition("done", { type: "toggle_done", ticketStatus: "open" })).toEqual({ ok: true, next: "pending" });
  });

  it("refuses on a served ticket (recall first)", () => {
    for (const s of TICKET_ITEM_STATUSES) {
      expect(ticketItemTransition(s, { type: "toggle_done", ticketStatus: "served" }).ok).toBe(false);
    }
  });

  it("double toggle is identity (property)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TICKET_ITEM_STATUSES), (start: TicketItemStatus) => {
        const once = ticketItemTransition(start, { type: "toggle_done", ticketStatus: "open" });
        expect(once.ok).toBe(true);
        if (once.ok) {
          const twice = ticketItemTransition(once.next, { type: "toggle_done", ticketStatus: "open" });
          expect(twice).toEqual({ ok: true, next: start });
        }
      }),
    );
  });
});

describe("kitchenTicketTransition: exhaustive", () => {
  function allEvents(): KitchenTicketEvent[] {
    const bools = [true, false];
    const events: KitchenTicketEvent[] = [];
    for (const allItemsDone of bools)
      for (const fromExpoView of bools)
        events.push({ type: "serve", allItemsDone, fromExpoView });
    for (const withinRecallWindow of bools)
      events.push({ type: "recall", withinRecallWindow });
    return events;
  }

  const LEGAL: Array<{ from: KitchenTicketStatus; event: KitchenTicketEvent; to: KitchenTicketStatus }> = [
    { from: "open", event: { type: "serve", allItemsDone: true, fromExpoView: true }, to: "served" },
    { from: "served", event: { type: "recall", withinRecallWindow: true }, to: "open" },
  ];

  it("allows exactly the legal pairs: expo-only serve, gated on all done; windowed recall", () => {
    for (const from of KITCHEN_TICKET_STATUSES) {
      for (const event of allEvents()) {
        const result = kitchenTicketTransition(from, event);
        const legal = LEGAL.find((l) => l.from === from && JSON.stringify(l.event) === JSON.stringify(event));
        if (legal) {
          expect(result, `${from} + ${JSON.stringify(event)}`).toEqual({ ok: true, next: legal.to });
        } else {
          expect(result.ok, `${from} + ${JSON.stringify(event)} should refuse`).toBe(false);
        }
      }
    }
  });

  it("serve then in-window recall is a safe round trip (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (cycles) => {
        let status: KitchenTicketStatus = "open";
        for (let i = 0; i < cycles; i++) {
          const served = kitchenTicketTransition(status, { type: "serve", allItemsDone: true, fromExpoView: true });
          expect(served).toEqual({ ok: true, next: "served" });
          const recalled = kitchenTicketTransition("served", { type: "recall", withinRecallWindow: true });
          expect(recalled).toEqual({ ok: true, next: "open" });
          status = "open";
        }
      }),
    );
  });

  it("after the recall window, served is final", () => {
    expect(kitchenTicketTransition("served", { type: "recall", withinRecallWindow: false }).ok).toBe(false);
  });
});
