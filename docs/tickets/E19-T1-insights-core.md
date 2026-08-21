# Ticket E19-T1: Server attribution + insights read API

**Epic:** E19 Insights v1 (server report + sales heatmap) · **Build model:** Opus · **Review tier:** cross-model (Fable reviews; aggregates money)
**Status:** Ready. SEQUENCING: this ticket edits `app/server/src/engine.ts`; do not run it concurrently with any other app/server ticket (E11-T2 waits for this or vice versa, founder's call on order).

## Session preamble (read first, in order)

1. Read `CLAUDE.md` (no em dashes anywhere, including code comments and commits), then `BACKLOG.md` and `DECISIONS.md` (D19 authorizes this pull-forward of a Phase 6 slice).
2. Baseline: `cd app\server && npm test` green (29 tests incl. throwaway-PostgreSQL) before any edit. If not green, stop and report.
3. One ticket per session; this file is the whole scope. Scope problems return the ticket.
4. Commits: small, imperative subject, why in the body, `Co-Authored-By: Claude Opus <noreply@anthropic.com>`, never force-push, only commit with the full suite green.

## Context

Founder reviewed Lightspeed Restaurant's reporting and wants a server performance report and a sales heatmap. Both are read-only projections over the ledger we already write. Two attribution gaps block them, then the API is straightforward aggregation. The UI is E19-T2 (separate ticket, do not build any page). The orchestrator prototyped this design and validated it compiles and the semantics hold; follow it exactly.

## Part 1: attribution groundwork

- `app/server/src/types.ts`: `CheckAggregate` gains `serverId?: string` and `serverName?: string` (the employee who opened the check).
- `app/server/src/engine.ts` `openCheck`: stamp both from the device session, falling back to the seeded default so unsigned demo flows keep working:
  `const opener = this.sessions.get(envelope.deviceId) ?? STAFF[0]!;` (import `STAFF` from `./staff.js`).
- `app/server/src/pgStore.ts`:
  - checks upsert: `server_id` becomes `check.serverId ?? EMP` (today it is the hardcoded `EMP`).
  - `hydrate()`: join `employee e ON e.id = ch.server_id`, select `ch.server_id, e.display_name AS server_name`, map to `serverId`/`serverName`.
  - the party UPDATE in `put()` additionally stamps the true turn-time endpoint: `cleared_at = check.status === 'closed' ? check.closedAt : null` (reopen clears it again).

## Part 2: insights reads (computed on read, NOTHING stored; schema rule "totals are computed, never stored" applies to reports too)

`engine.insightsServers()` over today's CLOSED checks (`serviceDateOf(c.openedAt) === serviceDate()`):
- Group by `serverId`. Per server accumulate EXACT integer sums: checks count, covers, `netMinor` (subtotal minus discount from `toView` totals), `totalMinor`, `tipMinor` (sum of payment tips), `discountMinor`, `voidCount`/`voidValueMinor` (voided lines at `(unit+mods)*qty`), per-COURSE value map over non-voided lines (the Lightspeed category-bars equivalent), turn-time ms sum (`closedAt - openedAt`).
- Derive display averages from the sums (`avgCheckMinor`, `perCoverMinor`, `avgTurnMinutes`, `Math.round`); averages are display math, the SUMS are what must conserve.
- `declaredTipsMinor` per server from `listShifts()` filtered by `employeeId`.
- Also return an `average` row (per-server means, Lightspeed style; null when no servers) and `courseKeys` (the fixed course order BEVERAGE/ANTIPASTI/PRIMI/SECONDI/DOLCI filtered to non-zero).
- Sort servers by `netMinor` descending.

`engine.insightsHeatmap()` over ALL closed checks the store holds (memory store only has today; PostgreSQL accumulates history):
- Cell key = day-of-week x hour of `openedAt` in SERVER-LOCAL time (`new Date(c.openedAt).getDay()/.getHours()`, consistent with `serviceDateOf`). Cell carries `netMinor`, `checks`, `covers` sums.
- Also return `dayTotals[7]` (index 0 = Sunday), `grandNetMinor`, `daysCovered` (distinct service dates seen).

Routes in `server.ts`: `GET /v1/insights/servers`, `GET /v1/insights/heatmap`. Reads only; no envelope.

## Invariants that must hold

- Conservation: the sum of per-server `netMinor` equals the day summary's `grossMinor - discountMinor` for the same day; per-server `tipMinor` sums equal the day summary's `tipsMinor`; heatmap `grandNetMinor` equals the same net when the store holds only today.
- Attribution truth: a check opened on a device where Sofia is signed in reports `serverName: "Sofia T."`; an unsigned device falls back to the seeded default, never to null.
- Voided lines contribute to void metrics only, never to course values or net.
- No new arithmetic beyond integer addition and display-only rounding; `toView` is the single money source.
- Read-only: no Store writes anywhere in Part 2.

## Tests to add

- `api.test.ts` (new describe): sign in Gia (`dev-gia`, PIN 2468) and Sofia (`dev-sofia`, PIN 3579); run three full check lifecycles with known items (e.g. Gia: burrata 1600 + acqua x2 1200, tips 100 each; Sofia: tiramisu 1200, tip 100); assert per-server checks/net/tips/courses exactly; assert the conservation invariants against `GET /v1/day`; assert heatmap `grandNetMinor` and total cell checks.
- `pg.test.ts` (additive, keep existing shape): after the restart, the closed check reports `serverName "Gia R."` and `serverId 33333333-3333-3333-3333-333333333333` (nobody signs in inside the PG test, so the seeded default applies and proves the employee join).

## File scope

- In scope: `app/server/src/types.ts`, `app/server/src/engine.ts`, `app/server/src/pgStore.ts`, `app/server/src/server.ts`, `app/server/test/api.test.ts`, `app/server/test/pg.test.ts`.
- Out of scope: `app/server/public/*` (E19-T2), everything under `app/domain/`, `docs/domain/schema.sql`, migrations (no schema change: `checks.server_id` and `party.cleared_at` already exist).

## Definition of done

Full suite green (`npm test`), `npm run typecheck` clean, demo note with two curl lines (`/v1/insights/servers`, `/v1/insights/heatmap`). Update the E19-T1 row in `BACKLOG.md` to Implemented. Do NOT start E19-T2.
