import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { computeCheckTotals, type Adjustment, type CheckLine } from "../src/money.js";
import { splitCheck, type SplitPortion } from "../src/split.js";

const nycTax = { num: 8_875, den: 100_000 };
const noTax = { num: 0, den: 1 };

const line = fc.record({
  unitPriceMinor: fc.integer({ min: 0, max: 100_000 }),
  quantity: fc.integer({ min: 1, max: 20 }),
  modifierPricesMinor: fc.array(fc.integer({ min: 0, max: 5_000 }), { maxLength: 4 }),
  voided: fc.boolean(),
});
const adjustment = fc.oneof(
  fc.record({ kind: fc.constant("amount" as const), amountMinor: fc.integer({ min: 0, max: 50_000 }) }),
  fc.record({ kind: fc.constant("percent" as const), basisPoints: fc.integer({ min: 0, max: 10_000 }) }),
);
const lines = fc.array(line, { minLength: 1, maxLength: 30 });
const adjustments = fc.array(adjustment, { maxLength: 3 });

/** Compress arbitrary portion labels into a dense 0-based assignment. */
function densify(raw: readonly number[]): number[] {
  const rank = new Map<number, number>();
  for (const v of raw) if (!rank.has(v)) rank.set(v, rank.size);
  return raw.map((v) => rank.get(v) as number);
}

const sum = (ns: readonly number[]) => ns.reduce((a, b) => a + b, 0);

/** Every invariant from the ticket, checked against the check's own totals. */
function expectInvariants(
  ls: readonly CheckLine[],
  adjs: readonly Adjustment[],
  taxRate: { num: number; den: number },
  portions: readonly SplitPortion[],
): void {
  const t = computeCheckTotals(ls, adjs, taxRate);

  // Conservation, per component, to the cent.
  expect(sum(portions.map((p) => p.subtotalMinor))).toBe(t.subtotalMinor);
  expect(sum(portions.map((p) => p.discountMinor))).toBe(t.discountMinor);
  expect(sum(portions.map((p) => p.taxMinor))).toBe(t.taxMinor);
  expect(sum(portions.map((p) => p.totalMinor))).toBe(t.totalMinor);

  for (const p of portions) {
    // Row consistency and non-negativity.
    expect(p.totalMinor).toBe(p.subtotalMinor - p.discountMinor + p.taxMinor);
    expect(p.subtotalMinor).toBeGreaterThanOrEqual(0);
    expect(p.discountMinor).toBeGreaterThanOrEqual(0);
    expect(p.taxMinor).toBeGreaterThanOrEqual(0);
    expect(p.totalMinor).toBeGreaterThanOrEqual(0);
  }
}

describe("splitCheck: even", () => {
  it("holds every invariant for random checks split 2..8 ways", () => {
    fc.assert(
      fc.property(lines, adjustments, fc.integer({ min: 2, max: 8 }), (ls, adjs, ways) => {
        const portions = splitCheck(ls, adjs, nycTax, { kind: "even", ways });
        expect(portions).toHaveLength(ways);
        expectInvariants(ls, adjs, nycTax, portions);
      }),
    );
  });

  it("keeps every component within a cent across portions", () => {
    fc.assert(
      fc.property(lines, adjustments, fc.integer({ min: 2, max: 8 }), (ls, adjs, ways) => {
        const portions = splitCheck(ls, adjs, nycTax, { kind: "even", ways });
        for (const key of ["subtotalMinor", "discountMinor", "taxMinor"] as const) {
          const vs = portions.map((p) => p[key]);
          expect(Math.max(...vs) - Math.min(...vs)).toBeLessThanOrEqual(1);
        }
      }),
    );
  });

  it("fixture: $100.01 three ways is 33.34 / 33.34 / 33.33", () => {
    const portions = splitCheck([{ unitPriceMinor: 10_001, quantity: 1 }], [], noTax, {
      kind: "even",
      ways: 3,
    });
    expect(portions.map((p) => p.totalMinor)).toEqual([3_334, 3_334, 3_333]);
    expect(portions.map((p) => p.subtotalMinor)).toEqual([3_334, 3_334, 3_333]);
  });

  it("fixture: a taxed check splits so both the rows and the columns reconcile", () => {
    // $46.00 of food, 8.875% tax is $4.08, total $50.08, three ways.
    const portions = splitCheck([{ unitPriceMinor: 4_600, quantity: 1 }], [], nycTax, {
      kind: "even",
      ways: 3,
    });
    expect(portions).toEqual([
      { subtotalMinor: 1_534, discountMinor: 0, taxMinor: 136, totalMinor: 1_670 },
      { subtotalMinor: 1_533, discountMinor: 0, taxMinor: 136, totalMinor: 1_669 },
      { subtotalMinor: 1_533, discountMinor: 0, taxMinor: 136, totalMinor: 1_669 },
    ]);
    expect(sum(portions.map((p) => p.totalMinor))).toBe(5_008);
  });

  it("an empty check splits into zero-value portions rather than refusing", () => {
    const portions = splitCheck([], [], nycTax, { kind: "even", ways: 4 });
    expect(portions).toEqual(
      Array.from({ length: 4 }, () => ({
        subtotalMinor: 0,
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 0,
      })),
    );
  });
});

describe("splitCheck: byLines", () => {
  it("holds every invariant for random checks and random dense assignments", () => {
    fc.assert(
      fc.property(
        lines.chain((ls) =>
          fc
            .array(fc.integer({ min: 0, max: Math.max(0, ls.length - 1) }), {
              minLength: ls.length,
              maxLength: ls.length,
            })
            .map((raw) => ({ ls, assignment: densify(raw) })),
        ),
        adjustments,
        ({ ls, assignment }, adjs) => {
          const portions = splitCheck(ls, adjs, nycTax, { kind: "byLines", assignment });
          expect(portions).toHaveLength(Math.max(...assignment) + 1);
          expectInvariants(ls, adjs, nycTax, portions);
        },
      ),
    );
  });

  it("a portion with no items of its own owes nothing", () => {
    fc.assert(
      fc.property(lines, adjustments, (ls, adjs) => {
        // Everything lands on portion 0; portions 1 and 2 exist but ordered nothing.
        const assignment = [...ls.map(() => 0), 1, 2];
        const padded: CheckLine[] = [
          ...ls,
          { unitPriceMinor: 0, quantity: 1, voided: true },
          { unitPriceMinor: 0, quantity: 1, voided: true },
        ];
        const portions = splitCheck(padded, adjs, nycTax, { kind: "byLines", assignment });
        expect(portions).toHaveLength(3);
        for (const p of portions.slice(1)) {
          expect(p).toEqual({ subtotalMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 0 });
        }
        expectInvariants(padded, adjs, nycTax, portions);
      }),
    );
  });

  it("fixture: one seat ordered everything, so the other seats are all zeros", () => {
    // Seat 0 took a no-charge water, seat 2's dish was voided, seat 1 ate.
    // A portion only exists if some line points at it, so an empty seat shows
    // up through a zero-value or voided line, never through a gap in the
    // assignment (that is the non-dense refusal below).
    const ls: CheckLine[] = [
      { unitPriceMinor: 0, quantity: 1 },
      { unitPriceMinor: 1_650, quantity: 2, modifierPricesMinor: [200] },
      { unitPriceMinor: 2_400, quantity: 1 },
      { unitPriceMinor: 1_900, quantity: 1, voided: true },
    ];
    const t = computeCheckTotals(ls, [], nycTax);
    const portions = splitCheck(ls, [], nycTax, { kind: "byLines", assignment: [0, 1, 1, 2] });
    const zero = { subtotalMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 0 };
    expect(portions[0]).toEqual(zero);
    expect(portions[2]).toEqual(zero);
    expect(portions[1]).toEqual({
      subtotalMinor: t.subtotalMinor,
      discountMinor: 0,
      taxMinor: t.taxMinor,
      totalMinor: t.totalMinor,
    });
    expectInvariants(ls, [], nycTax, portions);
  });

  it("fixture: a discount bigger than one portion's subtotal still conserves and stays non-negative", () => {
    // Seat 0 ordered $10, seat 1 ordered $90, and the manager took $50 off.
    const ls: CheckLine[] = [
      { unitPriceMinor: 1_000, quantity: 1 },
      { unitPriceMinor: 9_000, quantity: 1 },
    ];
    const adjs: Adjustment[] = [{ kind: "amount", amountMinor: 5_000 }];
    const portions = splitCheck(ls, adjs, nycTax, { kind: "byLines", assignment: [0, 1] });
    // $50 by subtotal weight is $5 and $45, so the $10 seat never goes negative.
    expect(portions.map((p) => p.discountMinor)).toEqual([500, 4_500]);
    expectInvariants(ls, adjs, nycTax, portions);
  });

  it("fixture: a voided line splits as if it were never ordered", () => {
    const live: CheckLine[] = [
      { unitPriceMinor: 1_650, quantity: 1 },
      { unitPriceMinor: 2_400, quantity: 1 },
    ];
    const withVoid: CheckLine[] = [
      live[0] as CheckLine,
      { unitPriceMinor: 99_999, quantity: 5, voided: true },
      live[1] as CheckLine,
    ];
    expect(splitCheck(withVoid, [], nycTax, { kind: "byLines", assignment: [0, 0, 1] })).toEqual(
      splitCheck(live, [], nycTax, { kind: "byLines", assignment: [0, 1] }),
    );
  });

  it("a single-portion assignment returns the whole check untouched", () => {
    const ls: CheckLine[] = [{ unitPriceMinor: 1_650, quantity: 3 }];
    const t = computeCheckTotals(ls, [], nycTax);
    expect(splitCheck(ls, [], nycTax, { kind: "byLines", assignment: [0] })).toEqual([
      {
        subtotalMinor: t.subtotalMinor,
        discountMinor: 0,
        taxMinor: t.taxMinor,
        totalMinor: t.totalMinor,
      },
    ]);
  });

  it("is deterministic, remainder cents included", () => {
    fc.assert(
      fc.property(lines, adjustments, (ls, adjs) => {
        const assignment = densify(ls.map((_, i) => i % 3));
        const partition = { kind: "byLines" as const, assignment };
        expect(splitCheck(ls, adjs, nycTax, partition)).toEqual(splitCheck(ls, adjs, nycTax, partition));
      }),
    );
  });
});

describe("splitCheck: refusals", () => {
  const ls: CheckLine[] = [
    { unitPriceMinor: 1_650, quantity: 1 },
    { unitPriceMinor: 2_400, quantity: 1 },
  ];

  it("refuses an even split of fewer than two ways", () => {
    expect(() => splitCheck(ls, [], nycTax, { kind: "even", ways: 1 })).toThrow(RangeError);
    expect(() => splitCheck(ls, [], nycTax, { kind: "even", ways: 0 })).toThrow(RangeError);
    expect(() => splitCheck(ls, [], nycTax, { kind: "even", ways: -3 })).toThrow(RangeError);
    expect(() => splitCheck(ls, [], nycTax, { kind: "even", ways: 2.5 })).toThrow(RangeError);
  });

  it("refuses an assignment whose length does not match the lines", () => {
    expect(() => splitCheck(ls, [], nycTax, { kind: "byLines", assignment: [0] })).toThrow(
      /one entry per line/,
    );
    expect(() => splitCheck(ls, [], nycTax, { kind: "byLines", assignment: [0, 1, 2] })).toThrow(
      RangeError,
    );
  });

  it("refuses non-dense and negative portion indexes", () => {
    expect(() => splitCheck(ls, [], nycTax, { kind: "byLines", assignment: [0, 2] })).toThrow(/dense/);
    expect(() => splitCheck(ls, [], nycTax, { kind: "byLines", assignment: [1, 2] })).toThrow(/dense/);
    expect(() => splitCheck(ls, [], nycTax, { kind: "byLines", assignment: [0, -1] })).toThrow(RangeError);
    expect(() => splitCheck(ls, [], nycTax, { kind: "byLines", assignment: [0, 1.5] })).toThrow(RangeError);
  });

  it("refuses a byLines split of an empty check", () => {
    expect(() => splitCheck([], [], nycTax, { kind: "byLines", assignment: [] })).toThrow(
      /at least one line/,
    );
  });
});
