# Ticket E19-T3: Declared-tips total the tile can trust

**Epic:** E19 Insights v1 (closes the epic) · **Build model:** Opus (money aggregation, small) · **Review tier:** cross-model (Fable)
**Status:** Ready. SEQUENCING: edits `engine.ts`; not concurrent with any other app/server ticket.

## Session preamble (read first, in order)

1. Read `CLAUDE.md` (no em dashes anywhere, UI copy and commits included), `BACKLOG.md`, `DECISIONS.md`.
2. Baseline: `cd app\server && npm test` green (quote the count you measure, the ticket does not predict one) before any edit.
3. One ticket per session; this file is the whole scope. Commits small, `Co-Authored-By: Claude Opus <noreply@anthropic.com>`, never force-push, only commit with the full suite green.

## Context: a confirmed drift between two screens

The /insights Tips tile computes its "declared" figure by summing `declaredTipsMinor` across the scorecard rows. Rows exist only for employees who CLOSED a check today, so an employee who declared cash tips without closing one (Marco the manager at every day close, or a server who only ran food) is invisible to that sum. Reproduced live during the E19-T2 review: Marco clocks out declaring 3400; `/v1/day` reports `declaredTipsMinor: 3400`; the rows sum to 0; the tile shows "declared $0.00" while /close shows $34.00. Two screens, one number, two values. This was recorded as a known nuance at the E19-T1 merge (see the E19-T1 BACKLOG row); this ticket closes it.

## What to build

### 1. Engine (`app/server/src/engine.ts`)
- `insightsServers()` returns one new TOP-LEVEL field alongside `serviceDate`/`courseKeys`/`servers`/`average`: `declaredTipsTotalMinor`, the exact integer sum of `declaredTipsMinor` over the SAME shift window the method already filters (`serviceDateOf(s.clockIn) === date || !s.clockOut`), across ALL employees, row or no row.
- Per-row `declaredTipsMinor` stays exactly as it is (it is correct per server). The `average` row stays untouched. No other shape changes.

### 2. Page (`app/server/public/insights.html`)
- The Tips tile's "declared" component reads `report.declaredTipsTotalMinor` instead of summing rows. Card tips stay the row sum (payments only exist on closed checks, so rows cannot miss any).
- No other visual or behavioral change; this is a one-expression swap plus whatever tiny wording the subtitle needs. Do not restyle anything.

## Invariants

- Conservation, now unconditional: `declaredTipsTotalMinor` equals `/v1/day`'s `summary.declaredTipsMinor` in every state, including when an employee without a scorecard row declared tips.
- The endpoint stays a pure read: no Store writes, nothing stored, integer addition only.
- Rows keep their meaning: a row's `declaredTipsMinor` is that server's own declaration, never a share of anyone else's.

## Tests to add (`api.test.ts`)

- The review's exact reproduction: Gia and Sofia close checks, Marco (zero checks) clocks out declaring tips; assert `declaredTipsTotalMinor` includes Marco's declaration, equals `/v1/day`'s `declaredTipsMinor`, and the rows still show only Gia's and Sofia's own declarations.
- Extend the existing E19 conservation test to assert the new field against `/v1/day` as well.
- Page assertion: `/insights` body contains `declaredTipsTotalMinor` (proving the tile reads the new field, same spirit as the endpoint-string assertions already there).

## File scope

- In scope: `app/server/src/engine.ts` (the one new sum in `insightsServers`), `app/server/public/insights.html` (the tile expression), `app/server/test/api.test.ts`.
- Out of scope: `pgStore.ts`, `types.ts`, `server.ts`, all other pages, everything under `app/domain/`, schema, docs.

## Definition of done

Suite green, typecheck clean, demo note reproducing the review scenario before/after (Marco declares 3400 with no checks: tile source now carries 3400 and matches /close). Update the E19-T3 row in `BACKLOG.md` to Implemented.
