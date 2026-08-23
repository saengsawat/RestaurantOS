# Ticket E11-T4: Server-side cross-partition overpay guard

**Epic:** E11 Split checks · **Build model:** Opus · **Review tier:** cross-model (Fable; payment guard = money)
**Status:** Ready. Small ticket. SEQUENCING: edits `engine.ts`; not concurrent with E19-T1.

## Session preamble

1. Read `CLAUDE.md` (no em dashes anywhere), `BACKLOG.md`, `DECISIONS.md` (D18), and the E11-T2/T3 rows for context.
2. Baseline: `cd app\server && npm test` green (35 tests incl. throwaway-PostgreSQL) before any edit.
3. One ticket per session; scope problems return the ticket. Commits small, `Co-Authored-By: Claude Opus <noreply@anthropic.com>`, never force-push.

## Context: a defect found by the E11-T3 worker, confirmed by review

`portionForLabel` bounds a labeled payment against ITS OWN portion's remaining due only. Once money has arrived under another partition's labels (pay "Split 1 of 3", then the party switches to by-seat), a portion can still show a due larger than what the whole check owes, and the server would accept that payment and OVERPAY the check. The POS UI now refuses to offer such a payment (it shows "check owes $X" instead of a Pay button), but a second terminal or a direct API call can still land it. The guard must live on the server; the UI is a courtesy, never the enforcement.

Note the pre-existing nuance: an UNLABELED payment has always been allowed to exceed the check's due (cash handed over expecting change is normal). This ticket does not change unlabeled behavior; the question of card-overpay policy in general goes to the Matt deck, not this ticket.

## What to build

In `engine.ts` `recordPayment`, extend the existing labeled-portion guard: a payment whose label names a current portion is refused when `amountMinor` exceeds `min(portion.dueMinor, check dueMinor) + (tipMinor ?? 0)`, where the check's due is `toView(check).totals.dueMinor`. The refusal reason must name both numbers when the check's due is the binding constraint, e.g. "Split 2 of 3 shows 1960 due but the check only owes 900; payments under other portions already cover the rest". Keep the existing per-portion refusal message when the portion itself is the constraint.

No storage changes, no new endpoints, no domain-package edits. Do NOT implement partition locking (rejected: a stored partition contradicts D18's stateless model; the cap achieves conservation without new state).

## Invariants

- After any sequence of labeled payments across ANY mix of partitions, total payments never exceed the check total plus the sum of tips (i.e. non-tip payment money never exceeds the check total).
- Unlabeled and free-text-labeled payments behave exactly as today (all existing tests stay green untouched).
- The state machine and close rules are untouched.

## Tests to add (`api.test.ts`)

- The exact T3 scenario: even 3-way, pay portion 1, switch to by-seat, attempt to pay a seat whose portion due exceeds the check's remaining due: 422 with a reason naming both amounts. Then pay that seat exactly the check's remaining due (plus a tip): accepted, check reaches paid, closes.
- Property-flavored loop (plain code, no fast-check needed server-side): random alternation of labeled payments across the two partitions, always paying the server-quoted `min(portion due, check due)`; assert non-tip money paid never exceeds the check total and the check ends exactly paid.

## File scope

- In scope: `app/server/src/engine.ts` (the guard block in `recordPayment` only), `app/server/test/api.test.ts`.
- Out of scope: everything else, including `public/*`, `pgStore.ts`, the domain package.

## Definition of done

Suite green, typecheck clean, demo note with the two-curl reproduction before/after. Update the E11-T4 row in `BACKLOG.md` to Implemented.
