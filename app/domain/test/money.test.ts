import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  allocateByWeights,
  allocateEvenly,
  applyBasisPoints,
  applyRate,
  computeCheckTotals,
  lineTotalMinor,
} from "../src/money.js";

// Up to $10B in cents: far beyond any check, still well inside safe integers.
const money = fc.integer({ min: 0, max: 1_000_000_000_000 });

describe("allocateEvenly", () => {
  it("conserves every cent, for any total and any party size", () => {
    fc.assert(
      fc.property(money, fc.integer({ min: 1, max: 60 }), (total, parts) => {
        const shares = allocateEvenly(total, parts);
        expect(shares).toHaveLength(parts);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      }),
    );
  });

  it("no two shares differ by more than one cent", () => {
    fc.assert(
      fc.property(money, fc.integer({ min: 1, max: 60 }), (total, parts) => {
        const shares = allocateEvenly(total, parts);
        expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(money, fc.integer({ min: 1, max: 60 }), (total, parts) => {
        expect(allocateEvenly(total, parts)).toEqual(allocateEvenly(total, parts));
      }),
    );
  });

  it("fixture: $120.01 three ways is 40.01 / 40.00 / 40.00", () => {
    expect(allocateEvenly(12_001, 3)).toEqual([4_001, 4_000, 4_000]);
  });

  it("rejects floats, negatives, and zero parts", () => {
    expect(() => allocateEvenly(10.5, 2)).toThrow(RangeError);
    expect(() => allocateEvenly(-1, 2)).toThrow(RangeError);
    expect(() => allocateEvenly(100, 0)).toThrow(RangeError);
  });
});

describe("allocateByWeights", () => {
  const weights = fc.array(fc.integer({ min: 0, max: 1_000_000_000 }), { minLength: 1, maxLength: 50 });

  it("conserves every cent for arbitrary weights", () => {
    fc.assert(
      fc.property(money, weights, (total, ws) => {
        const shares = allocateByWeights(total, ws);
        expect(shares).toHaveLength(ws.length);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      }),
    );
  });

  it("every share is within one cent of its exact proportion", () => {
    fc.assert(
      fc.property(money, weights, (total, ws) => {
        const W = ws.reduce((a, b) => a + BigInt(b), 0n);
        fc.pre(W > 0n);
        const shares = allocateByWeights(total, ws);
        for (let i = 0; i < ws.length; i++) {
          // |share - total*w/W| < 1  <=>  |share*W - total*w| < W, in exact integers
          const diff = BigInt(shares[i] as number) * W - BigInt(total) * BigInt(ws[i] as number);
          expect(diff < W && diff > -W).toBe(true);
        }
      }),
    );
  });

  it("allocating the sum of the weights returns the weights themselves", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 50 }), (ws) => {
        const total = ws.reduce((a, b) => a + b, 0);
        expect(allocateByWeights(total, ws)).toEqual(ws);
      }),
    );
  });

  it("all-zero weights degrade to an even split", () => {
    expect(allocateByWeights(10_001, [0, 0, 0])).toEqual(allocateEvenly(10_001, 3));
  });

  it("is deterministic, including remainder-cent placement", () => {
    fc.assert(
      fc.property(money, weights, (total, ws) => {
        expect(allocateByWeights(total, ws)).toEqual(allocateByWeights(total, ws));
      }),
    );
  });

  it("fixture: the Square example, seats of 40/50/30 on a $120.00 check", () => {
    expect(allocateByWeights(12_000, [4_000, 5_000, 3_000])).toEqual([4_000, 5_000, 3_000]);
  });
});

describe("applyRate / applyBasisPoints", () => {
  it("stays within one cent of the exact rate, never negative", () => {
    fc.assert(
      fc.property(money, fc.integer({ min: 0, max: 10_000 }), (amount, bp) => {
        const result = applyBasisPoints(amount, bp);
        const exact = (BigInt(amount) * BigInt(bp)); // in units of 1/10000 cent
        const low = exact / 10_000n;
        expect(BigInt(result) >= low && BigInt(result) <= low + 1n).toBe(true);
      }),
    );
  });

  it("identity at 100%, zero at 0%", () => {
    fc.assert(
      fc.property(money, (amount) => {
        expect(applyBasisPoints(amount, 10_000)).toBe(amount);
        expect(applyBasisPoints(amount, 0)).toBe(0);
      }),
    );
  });

  it("rounds half up: 2.5 cents becomes 3, 2.4 becomes 2", () => {
    expect(applyRate(250, 1, 100)).toBe(3); // 2.5 -> 3
    expect(applyRate(240, 1, 100)).toBe(2); // 2.4 -> 2
  });

  it("handles the NYC demo tax exactly: 8.875% of $46.00 is $4.08", () => {
    // 4600 * 8875 / 100000 = 408.25 -> 408
    expect(applyRate(4_600, 8_875, 100_000)).toBe(408);
  });
});

describe("lineTotalMinor", () => {
  it("(unit + modifiers) * quantity", () => {
    expect(lineTotalMinor(1_650, 2, [200])).toBe(3_700);
    expect(lineTotalMinor(1_650, 1)).toBe(1_650);
  });

  it("rejects fractional money and zero quantity", () => {
    expect(() => lineTotalMinor(16.5, 1)).toThrow(RangeError);
    expect(() => lineTotalMinor(1_650, 0)).toThrow(RangeError);
  });
});

describe("computeCheckTotals", () => {
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
  const nycTax = { num: 8_875, den: 100_000 };

  it("total = subtotal - discount + tax, discount never exceeds subtotal, nothing negative", () => {
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), fc.array(adjustment, { maxLength: 4 }), (lines, adjs) => {
        const t = computeCheckTotals(lines, adjs, nycTax);
        expect(t.discountMinor).toBeLessThanOrEqual(t.subtotalMinor);
        expect(t.taxableMinor).toBe(t.subtotalMinor - t.discountMinor);
        expect(t.totalMinor).toBe(t.taxableMinor + t.taxMinor);
        for (const v of Object.values(t)) expect(v).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("voided lines contribute nothing", () => {
    const paid = { unitPriceMinor: 1_650, quantity: 1 };
    const voided = { unitPriceMinor: 99_999, quantity: 5, voided: true };
    const a = computeCheckTotals([paid, voided], [], nycTax);
    const b = computeCheckTotals([paid], [], nycTax);
    expect(a).toEqual(b);
  });

  it("a 100% discount zeroes the check, tax included", () => {
    const t = computeCheckTotals(
      [{ unitPriceMinor: 12_345, quantity: 3 }],
      [{ kind: "percent", basisPoints: 10_000 }],
      nycTax,
    );
    expect(t.taxableMinor).toBe(0);
    expect(t.taxMinor).toBe(0);
    expect(t.totalMinor).toBe(0);
  });

  it("splitting any check by seat weights conserves the total (end-to-end)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 500_000 }), { minLength: 1, maxLength: 12 }),
        (seatSubtotals) => {
          const t = computeCheckTotals(
            seatSubtotals.map((s) => ({ unitPriceMinor: s, quantity: 1 })),
            [],
            nycTax,
          );
          const splits = allocateByWeights(t.totalMinor, seatSubtotals);
          expect(splits.reduce((a, b) => a + b, 0)).toBe(t.totalMinor);
        },
      ),
    );
  });
});
