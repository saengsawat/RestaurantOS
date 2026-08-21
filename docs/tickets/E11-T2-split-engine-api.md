# Ticket E11-T2: Split commands on the check engine and API

**Epic:** E11 Split checks · **Build model:** Opus · **Review tier:** cross-model (touches money flow)
**Status:** READY (E11-T1 merged 2026-08-20, cross-model review passed). SEQUENCING: not concurrent with E19-T1 (both edit engine.ts); one app/server ticket in flight at a time.

**Handoff note from the E11-T1 worker (binding):** a dense `byLines` assignment cannot express a portion with no lines at all, so "seat 3 ordered nothing" must be handled by the ENGINE: build the by-seat preview only over seats that have non-voided lines (drop empty seats), never by padding placeholder lines into the domain call.

## Session preamble (read first, in order)

1. Read `CLAUDE.md`, `BACKLOG.md`, `DECISIONS.md`, and `docs/tickets/E11-T1-split-domain.md` (the domain function you consume; do not reimplement it).
2. Baseline: `cd app\server && npm test` green (29 tests incl. the throwaway-PostgreSQL integration) before any edit.
3. One ticket per session. Scope problems return the ticket; they are not improvised around.
4. Commit style: small commits, why in the body, `Co-Authored-By: Claude Opus <noreply@anthropic.com>`, never force-push.

## Context

E11-T1 gives us a pure, conservation-proven `splitCheck`. This ticket exposes splitting on the server: a preview read (what would each portion owe) and split-aware payments. The existing engine (`app/server/src/engine.ts`) already supports partial payments with a free-text `label` and enforces the financial state machine (partially_paid until covered). The schema already has `payment_intent.split_label`. We are NOT forking a check into sibling check aggregates in this epic; a split is a payment partition over one check (the mockup's model). Recording that as the epic's v1 boundary is deliberate: party-level check splitting (separate aggregates per guest at open time) is a later decision with Matt.

## Commands and reads to implement

- `GET /v1/checks/:id/split?mode=even&ways=3` and `?mode=bySeat`: returns `{ portions: [{ label, seatNos?, subtotalMinor, discountMinor, taxMinor, totalMinor, paidMinor, dueMinor }] }`. bySeat builds one portion per seat that has non-voided lines, labeled `Seat 2`; even labels `Split 1 of 3`. `paidMinor` per portion = payments whose label matches; `dueMinor` = portion total minus that (floor at 0).
- Extend `recordPayment` so a payment can carry the portion label it settles (it already has `label`; keep it, but validate: if the label matches a current split portion, refuse paying more than that portion's remaining due plus tip). A check still closes only when TOTAL payments cover the check total (existing machine, unchanged).
- Engine derives seat portions from `line.seatNo` and passes a `byLines` assignment into the domain function. The engine never does arithmetic on portion amounts itself.

## Invariants that must hold

- The state machine is untouched: `checkLifecycle.ts` and every other domain file are read-only.
- Portion previews always conserve (guaranteed by T1; assert it anyway in tests through the HTTP layer).
- A voided line never appears in any portion.
- Idempotent envelope rules apply to every mutation exactly as the existing routes do (operationId min 8 chars, expectedVersion honored).
- Never store computed portion amounts; the split preview is computed on read, like totals and floor status.

## Tests to add (`app/server/test/api.test.ts`, plus one PG assertion)

- Even split of a real check over HTTP: portions conserve; pay portion 1 with its label; check goes partially_paid; pay the rest; paid then closed.
- By-seat split: seats with items each get a portion; seat labels correct; a voided line vanishes from its seat's portion.
- Overpaying a labeled portion (beyond its due plus tip) is refused with a clear reason.
- Split preview on a check with a discount conserves the discount across portions.
- PG test: after the existing restart sequence, a labeled split payment survives with its `split_label` in `payment_intent` (one added assertion, keep the test's existing shape).

## File scope

- In scope: `app/server/src/engine.ts`, `app/server/src/server.ts`, `app/server/src/types.ts`, `app/server/test/api.test.ts`, `app/server/test/pg.test.ts` (additive only), `app/server/package.json` only if the domain package version reference needs no change (it should not).
- Out of scope: everything under `app/domain/` (consume, never edit), `app/server/public/*` (UI is E11-T3), `docs/domain/schema.sql`, migrations (no schema change is needed; `split_label` exists).

## Definition of done

Full server suite green (`cd app\server && npm test`), typecheck clean, demo note with curl lines for preview + labeled payment. Update the E11-T2 row in `BACKLOG.md` to Implemented. Do NOT start E11-T3.
