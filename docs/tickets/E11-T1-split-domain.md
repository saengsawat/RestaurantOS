# Ticket E11-T1: Split computation in the domain package

**Epic:** E11 Split checks · **Build model:** Opus · **Review tier:** cross-model (Fable reviews; §5.2 row 1, this touches money)
**Status:** Ready

## Session preamble (read first, in order)

1. Read `CLAUDE.md` at the repo root. The writing rules bind you (no em dashes anywhere, including code comments and commit messages).
2. Read `BACKLOG.md` and `DECISIONS.md` for current state. Do not trust chat recall.
3. Baseline: `cd app\domain && npm test` must be green (54 tests) before you write anything. If it is not, stop and report.
4. One ticket per session: this file is your entire scope. If you find yourself wanting to touch anything under "Out of scope", stop and return the ticket with a note instead of improvising.
5. Commit style: small commits, imperative subject, body explains why. End with `Co-Authored-By: Claude Opus <noreply@anthropic.com>`. Never force-push. Commit only when the full suite is green.

## Context

RestaurantOS checks need to split for payment: by seat, by items, or evenly N ways. The flagship mockup (`prototypes/index_RestaurantOS.html`) demonstrated the UX; the server has no split support yet beyond payments carrying a free-text label. E1 (`app/domain/src/money.ts`) already provides the exact primitives: `applyRate` (single half-up rounding site), `allocateEvenly` and `allocateByWeights` (largest-remainder, BigInt-exact, tie broken by lowest index), and `computeCheckTotals` (subtotal, discount capped at subtotal, tax, total). This ticket adds the pure split computation. The engine command and API are E11-T2; the POS UI is E11-T3. Master plan §7.2 row E11; PRD FR family "split checks"; Toast report requirement "multi-check parties / split by seat".

## The design decision, already made (do not re-derive)

A split NEVER recomputes money from scratch per portion. It computes the check's totals ONCE via `computeCheckTotals`, then ALLOCATES each component (discount, tax, total) across portions with `allocateByWeights` / `allocateEvenly`. Recomputing tax per portion loses or invents cents (three portions of $10.01 each rounding independently). Allocation conserves them by construction. This is the same reasoning as the schema's "totals are computed, never stored" rule.

## API to implement

New file `app/domain/src/split.ts`, exported from `app/domain/src/index.ts`:

```ts
export type SplitPartition =
  | { kind: "even"; ways: number }                       // N equal portions
  | { kind: "byLines"; assignment: readonly number[] };  // assignment[i] = portion index of line i (0-based, dense)

export interface SplitPortion {
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
}

export function splitCheck(
  lines: readonly CheckLine[],          // reuse the E1 CheckLine shape (voided lines contribute 0)
  adjustments: readonly Adjustment[],
  taxRate: { num: number; den: number },
  partition: SplitPartition,
): SplitPortion[];
```

Semantics:
- `even`: every component of the check total is allocated with `allocateEvenly` across `ways` portions. Subtotal/discount/tax reported per portion must also sum exactly (allocate each with the same function so the columns and the rows both reconcile).
- `byLines`: portion subtotal = sum of its assigned non-voided line totals (`lineTotalMinor`). Discount is allocated across portions by subtotal weights; tax by taxable (subtotal minus allocated discount) weights; portion total = subtotal - discount + tax. A portion with zero subtotal gets zero discount and zero tax.
- "By seat" and "by item" are both `byLines` from the caller's perspective (the engine builds the assignment from seat numbers or explicit choices). The domain does not know about seats.
- Refusals throw `RangeError` with a clear message (matching money.ts style): `ways < 2` or not a safe integer; assignment length differing from lines length; assignment referencing a negative or non-dense portion index; empty lines with `byLines`.

## Invariants that must hold (sourced [T] / §4)

- Conservation, always, for every component: sum of portion `subtotalMinor` equals the check's, same for `discountMinor`, `taxMinor`, `totalMinor`. To the cent, no epsilon.
- Row consistency: within every portion, `totalMinor === subtotalMinor - discountMinor + taxMinor`.
- No negative amounts in any portion.
- Determinism: same inputs, same output. No randomness, no clock, no I/O (this package stays pure).
- One-cent fairness: remainders distribute by the largest-remainder rule already in `allocateByWeights`; do not implement a second allocator.
- Voided lines contribute nothing to any portion (they are already excluded by `computeCheckTotals`; keep the two paths consistent).

## Tests to add (`app/domain/test/split.test.ts`, same style as `money.test.ts`)

- Property: for randomly generated checks (1..30 lines, random prices/quantities/modifiers, 0..3 adjustments mixing amount and percent) and random partitions (even 2..8 ways; random dense assignments), every invariant above holds. Use the same generator approach as the existing property tests.
- Fixture: $100.01 split evenly 3 ways = 33.34 + 33.34 + 33.33 (largest remainder, lowest index gets the extra cent).
- Fixture: by-seat split where one seat ordered everything: that portion carries the full total, the other portions are all zeros.
- Fixture: discount larger than one portion's subtotal still conserves (discount allocation is by weight, so no portion goes negative).
- Fixture: a check with a voided line splits as if the line did not exist.
- Refusal cases: ways=1, ways=0, non-dense assignment, wrong assignment length.

## File scope

- In scope: `app/domain/src/split.ts` (new), `app/domain/src/index.ts` (export line only), `app/domain/test/split.test.ts` (new).
- Out of scope (do not touch): `app/domain/src/money.ts` and every other existing domain file (import them, never edit), everything under `app/server/`, `docs/domain/schema.sql`, all prototypes and docs.

## Definition of done

`cd app\domain && npm test` green with the new tests included (expect 54 + roughly 10-15 new). `npm run typecheck` clean if the package has one. No lint errors. Demo note in the final report: one sentence + the command to run the tests. Update the E11-T1 row in `BACKLOG.md` to Implemented. Do NOT start E11-T2.
