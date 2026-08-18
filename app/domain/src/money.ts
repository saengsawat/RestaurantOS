/**
 * RestaurantOS money engine (epic E1).
 *
 * All amounts are integer minor units (cents). Nothing in this module
 * touches floating point on any money path: proportional math runs on
 * BigInt so a $10M check split across 50 seats cannot lose precision.
 *
 * Invariants (property-tested in test/money.test.ts):
 *   1. Conservation: every allocation sums exactly to its input.
 *   2. Fairness: no share differs from the exact proportion by a cent or more.
 *   3. Determinism: same input, same output; remainder cents are assigned
 *      by largest remainder, ties broken by lowest index.
 *   4. Rounding is half-up, in one place, for every rate application.
 */

/** Guard: a monetary amount must be a safe non-negative integer. */
export function assertMinor(n: number, label: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer of minor units, got ${n}`);
  }
}

function assertCount(n: number, label: string): void {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RangeError(`${label} must be a positive integer, got ${n}`);
  }
}

/**
 * Apply an exact rational rate (num/den) to an amount, rounding half-up.
 * This is THE rounding site: tax (8.875% = 8875/100000), percentage
 * discounts (10% = 1000/10000), and anything else rate-shaped comes
 * through here so the product has exactly one rounding policy.
 */
export function applyRate(amountMinor: number, num: number, den: number): number {
  assertMinor(amountMinor, "amountMinor");
  if (!Number.isSafeInteger(num) || num < 0) throw new RangeError(`rate numerator must be a non-negative integer, got ${num}`);
  if (!Number.isSafeInteger(den) || den < 1) throw new RangeError(`rate denominator must be a positive integer, got ${den}`);
  const prod = BigInt(amountMinor) * BigInt(num);
  const d = BigInt(den);
  const halfUp = (2n * prod + d) / (2n * d); // floor((2*p + d) / (2*d)) = round-half-up for non-negatives
  const result = Number(halfUp);
  if (!Number.isSafeInteger(result)) throw new RangeError("rate application overflowed safe integers");
  return result;
}

/** Sugar: basis points (10% = 1000 bp). */
export function applyBasisPoints(amountMinor: number, bp: number): number {
  return applyRate(amountMinor, bp, 10_000);
}

/**
 * Split a total into `parts` shares differing by at most one cent,
 * earlier shares taking the remainder ("Guest 1 pays the extra cent").
 */
export function allocateEvenly(totalMinor: number, parts: number): number[] {
  assertMinor(totalMinor, "totalMinor");
  assertCount(parts, "parts");
  const base = Math.floor(totalMinor / parts);
  const remainder = totalMinor - base * parts;
  return Array.from({ length: parts }, (_, i) => (i < remainder ? base + 1 : base));
}

/**
 * Split a total proportionally to non-negative integer weights (typically
 * seat subtotals), conserving every cent. Largest-remainder method:
 * floor each exact share, then hand the leftover cents to the shares
 * with the largest fractional remainders, ties to the lowest index.
 * All-zero weights degrade to an even split.
 */
export function allocateByWeights(totalMinor: number, weights: readonly number[]): number[] {
  assertMinor(totalMinor, "totalMinor");
  if (weights.length === 0) throw new RangeError("weights must not be empty");
  for (const [i, w] of weights.entries()) assertMinor(w, `weights[${i}]`);

  const W = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (W === 0n) return allocateEvenly(totalMinor, weights.length);

  const T = BigInt(totalMinor);
  const shares: number[] = [];
  const remainders: { i: number; r: bigint }[] = [];
  let allocated = 0n;

  for (const [i, w] of weights.entries()) {
    const exact = T * BigInt(w);
    const share = exact / W;               // floor
    shares.push(Number(share));
    allocated += share;
    remainders.push({ i, r: exact % W });
  }

  let leftover = Number(T - allocated);    // < weights.length, always safe
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (leftover === 0) break;
    shares[i] = (shares[i] as number) + 1;
    leftover--;
  }
  return shares;
}

/** One order line: (unit price + per-unit modifier prices) * quantity. */
export function lineTotalMinor(
  unitPriceMinor: number,
  quantity: number,
  modifierPricesMinor: readonly number[] = [],
): number {
  assertMinor(unitPriceMinor, "unitPriceMinor");
  assertCount(quantity, "quantity");
  let perUnit = unitPriceMinor;
  for (const [i, m] of modifierPricesMinor.entries()) {
    assertMinor(m, `modifierPricesMinor[${i}]`);
    perUnit += m;
  }
  const total = perUnit * quantity;
  if (!Number.isSafeInteger(total)) throw new RangeError("line total overflowed safe integers");
  return total;
}

export type Adjustment =
  | { kind: "amount"; amountMinor: number }
  | { kind: "percent"; basisPoints: number };

export interface CheckLine {
  unitPriceMinor: number;
  quantity: number;
  modifierPricesMinor?: readonly number[];
  voided?: boolean;
}

export interface CheckTotals {
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/**
 * Compute a check's money parts. Percent adjustments are evaluated
 * against the pre-discount subtotal (industry convention and what the
 * prototype demonstrated); the combined discount is capped at the
 * subtotal so a check can reach zero but never go negative.
 * Totals are always computed, never stored (schema rule).
 */
export function computeCheckTotals(
  lines: readonly CheckLine[],
  adjustments: readonly Adjustment[],
  taxRate: { num: number; den: number },
): CheckTotals {
  let subtotal = 0;
  for (const line of lines) {
    if (line.voided) continue;
    subtotal += lineTotalMinor(line.unitPriceMinor, line.quantity, line.modifierPricesMinor ?? []);
    if (!Number.isSafeInteger(subtotal)) throw new RangeError("subtotal overflowed safe integers");
  }

  let discount = 0;
  for (const adj of adjustments) {
    if (adj.kind === "amount") {
      assertMinor(adj.amountMinor, "adjustment.amountMinor");
      discount += adj.amountMinor;
    } else {
      discount += applyBasisPoints(subtotal, adj.basisPoints);
    }
  }
  if (discount > subtotal) discount = subtotal;

  const taxable = subtotal - discount;
  const tax = applyRate(taxable, taxRate.num, taxRate.den);

  return {
    subtotalMinor: subtotal,
    discountMinor: discount,
    taxableMinor: taxable,
    taxMinor: tax,
    totalMinor: taxable + tax,
  };
}
