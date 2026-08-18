import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  CHECK_STATUSES,
  checkTransition,
  isTerminalCheckStatus,
  type CheckEvent,
  type CheckStatus,
} from "../src/checkLifecycle.js";

/** Every event shape with every combination of its guard booleans. */
function allEvents(): CheckEvent[] {
  const bools = [true, false];
  const events: CheckEvent[] = [];
  for (const coversTotal of bools)
    for (const hasUnsentLines of bools)
      events.push({ type: "payment_recorded", coversTotal, hasUnsentLines });
  events.push({ type: "close" });
  for (const approved of bools) events.push({ type: "reopen", approved });
  for (const approved of bools)
    for (const hasPayments of bools)
      events.push({ type: "void_check", approved, hasPayments });
  return events;
}

/**
 * THE EXHAUSTIVE TABLE. Every legal (status, event) pair and its outcome.
 * Anything not listed here must refuse. If a rule changes, this table is
 * the diff the reviewer reads.
 */
const LEGAL: Array<{ from: CheckStatus; event: CheckEvent; to: CheckStatus }> = [
  // payments (guards: no unsent lines)
  { from: "open", event: { type: "payment_recorded", coversTotal: false, hasUnsentLines: false }, to: "partially_paid" },
  { from: "open", event: { type: "payment_recorded", coversTotal: true, hasUnsentLines: false }, to: "paid" },
  { from: "partially_paid", event: { type: "payment_recorded", coversTotal: false, hasUnsentLines: false }, to: "partially_paid" },
  { from: "partially_paid", event: { type: "payment_recorded", coversTotal: true, hasUnsentLines: false }, to: "paid" },
  { from: "reopened", event: { type: "payment_recorded", coversTotal: false, hasUnsentLines: false }, to: "partially_paid" },
  { from: "reopened", event: { type: "payment_recorded", coversTotal: true, hasUnsentLines: false }, to: "paid" },
  // close / reopen
  { from: "paid", event: { type: "close" }, to: "closed" },
  { from: "closed", event: { type: "reopen", approved: true }, to: "reopened" },
  // voiding an unpaid check, approved
  { from: "open", event: { type: "void_check", approved: true, hasPayments: false }, to: "voided" },
  { from: "reopened", event: { type: "void_check", approved: true, hasPayments: false }, to: "voided" },
];

const eventKey = (e: CheckEvent) => JSON.stringify(e);

describe("checkTransition: exhaustive table", () => {
  it("allows exactly the legal pairs and refuses all others", () => {
    for (const from of CHECK_STATUSES) {
      for (const event of allEvents()) {
        const result = checkTransition(from, event);
        const legal = LEGAL.find((l) => l.from === from && eventKey(l.event) === eventKey(event));
        if (legal) {
          expect(result, `${from} + ${eventKey(event)}`).toEqual({ ok: true, next: legal.to });
        } else {
          expect(result.ok, `${from} + ${eventKey(event)} should refuse`).toBe(false);
        }
      }
    }
  });

  it("covers the whole space (sanity on the test itself)", () => {
    // 6 statuses x 11 event variants = 66 pairs examined above
    expect(CHECK_STATUSES.length * allEvents().length).toBe(66);
    expect(LEGAL.length).toBe(10);
  });
});

describe("checkTransition: properties over random event walks", () => {
  const eventArb: fc.Arbitrary<CheckEvent> = fc.constantFrom(...allEvents());

  it("never leaves the legal status set and never throws", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 60 }), (events) => {
        let status: CheckStatus = "open";
        for (const e of events) {
          const r = checkTransition(status, e);
          if (r.ok) status = r.next;
          expect(CHECK_STATUSES).toContain(status);
        }
      }),
    );
  });

  it("voided is terminal: no event sequence escapes it", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
        let status: CheckStatus = "voided";
        for (const e of events) {
          const r = checkTransition(status, e);
          expect(r.ok).toBe(false);
        }
        expect(isTerminalCheckStatus(status)).toBe(true);
      }),
    );
  });

  it("the only way out of closed is an approved reopen", () => {
    for (const event of allEvents()) {
      const r = checkTransition("closed", event);
      if (r.ok) {
        expect(event).toEqual({ type: "reopen", approved: true });
        expect(r.next).toBe("reopened");
      }
    }
  });

  it("unsent lines block every payment, in every payable state", () => {
    fc.assert(
      fc.property(fc.constantFrom(...CHECK_STATUSES), fc.boolean(), (status, coversTotal) => {
        const r = checkTransition(status, { type: "payment_recorded", coversTotal, hasUnsentLines: true });
        expect(r.ok).toBe(false);
      }),
    );
  });

  it("a check that has ever been paid can never be voided", () => {
    // hasPayments guard refuses regardless of status or approval
    fc.assert(
      fc.property(fc.constantFrom(...CHECK_STATUSES), fc.boolean(), (status, approved) => {
        const r = checkTransition(status, { type: "void_check", approved, hasPayments: true });
        expect(r.ok).toBe(false);
      }),
    );
  });
});
