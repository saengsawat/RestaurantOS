/**
 * Kitchen lifecycle (epic E2): the FULFILLMENT state machine, three small
 * machines that between them encode the founder's KDS requirements
 * (discovery notes 2026-08-12) and the Toast report's dispatch rules:
 *
 *   order item:   unsent -> sent -> (voided), void-after-fire approved
 *   ticket item:  pending <-> done, freely toggleable while the ticket is
 *                 open (a mis-tap on the line is its own remedy)
 *   ticket:       open -> served (all items done, expo only) -> recalled
 *                 back to open within the recall window
 *
 * As with the check machine: guards arrive as booleans from the command
 * layer; nothing here touches I/O or the clock.
 */
import { allow, refuse, type TransitionResult } from "./transition.js";

/* ---------------------------- order item ---------------------------- */

export const ORDER_ITEM_STATUSES = ["unsent", "sent", "voided"] as const;
export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];

export type OrderItemEvent =
  | { type: "dispatch" }
  | { type: "void_item"; approved: boolean };

export function orderItemTransition(
  status: OrderItemStatus,
  event: OrderItemEvent,
): TransitionResult<OrderItemStatus> {
  switch (event.type) {
    case "dispatch": {
      if (status !== "unsent") {
        // dispatch_item has a UNIQUE(order_item_id): an item fires once, ever.
        return refuse(`only an unsent item can dispatch, this one is ${status}`);
      }
      return allow("sent");
    }
    case "void_item": {
      if (status === "voided") {
        return refuse("item is already voided");
      }
      if (!event.approved) {
        return refuse("voiding an item requires manager approval");
      }
      // unsent -> voided: revenue expectation removed, kitchen never knew.
      // sent -> voided: kitchen is notified by the command layer (FR-28).
      return allow("voided");
    }
  }
}

/* ---------------------------- ticket item ---------------------------- */

export const TICKET_ITEM_STATUSES = ["pending", "done"] as const;
export type TicketItemStatus = (typeof TICKET_ITEM_STATUSES)[number];

export type TicketItemEvent = {
  type: "toggle_done";
  /** the parent ticket's current status; bumping a served ticket is meaningless */
  ticketStatus: KitchenTicketStatus;
};

export function ticketItemTransition(
  status: TicketItemStatus,
  event: TicketItemEvent,
): TransitionResult<TicketItemStatus> {
  if (event.ticketStatus !== "open") {
    return refuse(`cannot bump items on a ${event.ticketStatus} ticket; recall it first`);
  }
  return allow(status === "pending" ? "done" : "pending");
}

/* ------------------------------ ticket ------------------------------ */

export const KITCHEN_TICKET_STATUSES = ["open", "served"] as const;
export type KitchenTicketStatus = (typeof KITCHEN_TICKET_STATUSES)[number];

export type KitchenTicketEvent =
  | {
      type: "serve";
      /** every item on every ticket of this table is done */
      allItemsDone: boolean;
      /** serving is expo's call: only the all-stations view may serve */
      fromExpoView: boolean;
    }
  | {
      type: "recall";
      /** still inside the recall window (default 10 min, Matt question) */
      withinRecallWindow: boolean;
    };

export function kitchenTicketTransition(
  status: KitchenTicketStatus,
  event: KitchenTicketEvent,
): TransitionResult<KitchenTicketStatus> {
  switch (event.type) {
    case "serve": {
      if (status !== "open") {
        return refuse("ticket is already served");
      }
      if (!event.fromExpoView) {
        return refuse("serving happens from the expo (all stations) view only");
      }
      if (!event.allItemsDone) {
        return refuse("cannot serve until every item is plated");
      }
      return allow("served");
    }
    case "recall": {
      if (status !== "served") {
        return refuse("only a served ticket can be recalled");
      }
      if (!event.withinRecallWindow) {
        return refuse("recall window has passed; the ticket is settled history");
      }
      return allow("open");
    }
  }
}
