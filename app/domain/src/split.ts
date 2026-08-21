/**
 * RestaurantOS split computation (epic E11, ticket E11-T1).
 *
 * A split never recomputes money from scratch per portion. It computes the
 * check's totals ONCE with computeCheckTotals, then ALLOCATES each component
 * across the portions with the E1 largest-remainder allocators. Recomputing
 * tax per portion would lose or invent cents (three portions of $10.01 each
 * rounding independently); allocation conserves them by construction. Same
 * reasoning as the schema's "totals are computed, never stored" rule.
 *
 * Pure: no randomness, no clock, no I/O. Same inputs, same output.
 *
 * Invariants (property-tested in test/split.test.ts):
 *   1. Conservation: portion subtotals/discounts/taxes/totals each sum
 *      exactly to the check's, to the cent.
 *   2. Row consistency: totalMinor === subtotalMinor - discountMinor + taxMinor
 *      in every portion.
 *   3. No negative amount in any portion.
 *   4. One-cent fairness and remainder placement come from allocateByWeights /
 *      allocateEvenly; this module implements no allocator of its own.
 *   5. Voided lines contribute nothing, matching computeCheckTotals.
 */

import {
  allocateByWeights,
  allocateEvenly,
  computeCheckTotals,
  lineTotalMinor,
  type Adjustment,
  type CheckLine,
} from "./money.js";

export type SplitPartition =
  /** N equal portions ("split it four ways"). */
  | { kind: "even"; ways: number }
  /**
   * assignment[i] is the portion index of line i: 0-based and dense, so
   * every index from 0 to the highest one used must appear at least once.
   * Both "by seat" and "by item" are byLines from the caller's side; the
   * engine builds the assignment from seat numbers or explicit picks, and
   * the domain never learns about seats.
   */
  | { kind: "byLines"; assignment: readonly number[] };

export interface SplitPortion {
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/**
 * The portion total is DERIVED from the portion's own components, never
 * allocated on its own. Allocating the check total independently would
 * conserve the column while breaking the row (subtotal 34 - 0 + tax 4 is
 * 38, but an independent even split of the total would report 37).
 * Deriving keeps both: the components conserve, so their difference does.
 */
function portionOf(subtotalMinor: number, discountMinor: number, taxMinor: number): SplitPortion {
  return {
    subtotalMinor,
    discountMinor,
    taxMinor,
    totalMinor: subtotalMinor - discountMinor + taxMinor,
  };
}

/** Portion count from a dense assignment, refusing anything that is not one. */
function portionCount(assignment: readonly number[], lineCount: number): number {
  if (assignment.length !== lineCount) {
    throw new RangeError(
      `assignment must have one entry per line, got ${assignment.length} for ${lineCount} lines`,
    );
  }
  const seen = new Set<number>();
  let highest = -1;
  for (const [i, p] of assignment.entries()) {
    if (!Number.isSafeInteger(p) || p < 0) {
      throw new RangeError(`assignment[${i}] must be a non-negative safe integer portion index, got ${p}`);
    }
    seen.add(p);
    if (p > highest) highest = p;
  }
  const count = highest + 1;
  if (seen.size !== count) {
    const missing = [...Array(count).keys()].filter((p) => !seen.has(p));
    throw new RangeError(`assignment portion indexes must be dense from 0, missing ${missing.join(", ")}`);
  }
  return count;
}

/**
 * Split a check into payment portions.
 *
 * `even` allocates each component across `ways` portions with allocateEvenly
 * (earlier portions take the remainder cents). `byLines` gives each portion
 * the subtotal of its own non-voided lines, then allocates the discount by
 * subtotal weight and the tax by taxable weight, so a portion with nothing
 * on it owes nothing.
 *
 * Throws RangeError on a partition that cannot describe a real split.
 */
export function splitCheck(
  lines: readonly CheckLine[],
  adjustments: readonly Adjustment[],
  taxRate: { num: number; den: number },
  partition: SplitPartition,
): SplitPortion[] {
  const totals = computeCheckTotals(lines, adjustments, taxRate);

  if (partition.kind === "even") {
    const { ways } = partition;
    if (!Number.isSafeInteger(ways) || ways < 2) {
      throw new RangeError(`an even split needs at least 2 ways, got ${ways}`);
    }
    // Every component through the same allocator: the columns conserve, and
    // because the discount can never exceed the subtotal on the check it
    // cannot exceed it in a portion either, so no row goes negative.
    const subtotals = allocateEvenly(totals.subtotalMinor, ways);
    const discounts = allocateEvenly(totals.discountMinor, ways);
    const taxes = allocateEvenly(totals.taxMinor, ways);
    return subtotals.map((s, i) => portionOf(s, discounts[i] as number, taxes[i] as number));
  }

  const { assignment } = partition;
  if (lines.length === 0) {
    throw new RangeError("a byLines split needs at least one line");
  }
  const count = portionCount(assignment, lines.length);

  const subtotals = Array.from({ length: count }, () => 0);
  for (const [i, line] of lines.entries()) {
    if (line.voided) continue; // already excluded from totals; keep the two paths consistent
    const p = assignment[i] as number;
    subtotals[p] = (subtotals[p] as number) + lineTotalMinor(
      line.unitPriceMinor,
      line.quantity,
      line.modifierPricesMinor ?? [],
    );
  }

  const discounts = allocateByWeights(totals.discountMinor, subtotals);
  const taxables = subtotals.map((s, i) => s - (discounts[i] as number));
  const taxes = allocateByWeights(totals.taxMinor, taxables);

  return subtotals.map((s, i) => portionOf(s, discounts[i] as number, taxes[i] as number));
}
