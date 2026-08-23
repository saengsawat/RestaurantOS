/**
 * Check lifecycle (epic E2): the FINANCIAL state machine.
 *
 * Kitchen fulfillment appears nowhere here by design (order != check,
 * domain-model.md section 2). Events carry the facts the guard needs as
 * booleans computed by the command layer; the machine itself never reads
 * the database and never does money math (that is E1's job).
 *
 * Rules encoded here, sourced from the PRD:
 *   FR-26  no payment while unsent lines exist
 *   FR-28  a check with payments cannot be voided (refund first)
 *   D-rule close from paid, or from a reopened check whose payments still
 *          cover the total (E2-T2); reopen only from closed, approved, audited
 */
import { allow, refuse, type TransitionResult } from "./transition.js";

export const CHECK_STATUSES = [
  "open",
  "partially_paid",
  "paid",
  "closed",
  "reopened",
  "voided",
] as const;

export type CheckStatus = (typeof CHECK_STATUSES)[number];

export type CheckEvent =
  | {
      type: "payment_recorded";
      /** cumulative accepted payments now cover the total, to the cent */
      coversTotal: boolean;
      /** any order line still in 'unsent' */
      hasUnsentLines: boolean;
    }
  | {
      type: "close";
      /** accepted payments still cover the total, to the cent. Always true on
       *  a paid check by construction; a REOPENED one can be edited, so it has
       *  to be asked again before the check is allowed to leave. */
      coversTotal: boolean;
    }
  | { type: "reopen"; approved: boolean }
  | { type: "void_check"; approved: boolean; hasPayments: boolean };

const PAYABLE: readonly CheckStatus[] = ["open", "partially_paid", "reopened"];

export function checkTransition(
  status: CheckStatus,
  event: CheckEvent,
): TransitionResult<CheckStatus> {
  switch (event.type) {
    case "payment_recorded": {
      if (!PAYABLE.includes(status)) {
        return refuse(`cannot record a payment on a ${status} check`);
      }
      if (event.hasUnsentLines) {
        return refuse("check has unsent lines; send or void them before payment");
      }
      return allow(event.coversTotal ? "paid" : "partially_paid");
    }
    case "close": {
      if (status !== "paid" && status !== "reopened") {
        return refuse(`only a paid or reopened check can close, this one is ${status}`);
      }
      /* A reopened check that needs no correction has to be able to leave
       * again. Before E2-T2 it could not: close wanted 'paid', the only road
       * to 'paid' was another payment, and a settled check has nothing left
       * to pay, so the table sat occupied and the day could not close.
       *
       * The guard is the money question, asked of the command layer: if an
       * edit while reopened raised the total, the difference gets collected
       * the ordinary way before the check closes. Nobody resets the due, and
       * an overpayment is the house's obligation, not a reason to refuse. */
      if (!event.coversTotal) {
        return refuse("payments no longer cover the total; collect the difference first");
      }
      return allow("closed");
    }
    case "reopen": {
      if (status !== "closed") {
        return refuse(`only a closed check can reopen, this one is ${status}`);
      }
      if (!event.approved) {
        return refuse("reopen requires manager approval");
      }
      return allow("reopened");
    }
    case "void_check": {
      if (status !== "open" && status !== "reopened") {
        return refuse(`cannot void a ${status} check`);
      }
      if (event.hasPayments) {
        return refuse("check has payments; refund them before voiding");
      }
      if (!event.approved) {
        return refuse("voiding a check requires manager approval");
      }
      return allow("voided");
    }
  }
}

/** Terminal: no event leads anywhere from here. */
export function isTerminalCheckStatus(status: CheckStatus): boolean {
  return status === "voided";
}
