# Ticket E19-T2: The /insights screen (server scorecard + heatmap)

**Epic:** E19 Insights v1 · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard (`/code-review`); escalates to Opus after two failed reviews (§5.2)
**Status:** Ready after E19-T1 merges (consumes its two endpoints)

## Session preamble (read first, in order)

1. Read `CLAUDE.md` (no em dashes anywhere, UI copy included), `BACKLOG.md`, and `docs/tickets/E19-T1-insights-core.md` for the API shapes you consume.
2. Read `design/restaurantos/DESIGN.md` sections 2-8. Definition of Done includes token conformance: no colors, radii, or spacing outside the system; 44px touch targets; press feedback; no hover-only affordances. This page follows the device theme (Day/Night via `prefers-color-scheme`); it is NOT pinned dark (only the KDS is).
3. Baseline: `cd app\server && npm test` green; run the server and click through `/close` and `/menu` first; copy their page skeleton (topbar, nav, tokens, toasts, `--vph` viewport pattern) rather than inventing a new one.
4. One ticket per session. The API is fixed; if it seems insufficient, return the ticket rather than adding endpoints.

## Context

Founder wants Lightspeed-style operator reporting: a per-server scorecard with category bars and a busy/quiet heatmap. E19-T1 provides `GET /v1/insights/servers` (servers sorted by net sales, each with checks/covers/net/tips/declared tips/avg check/per cover/turn minutes/void and discount counts/per-course value map; plus an `average` row and `courseKeys`) and `GET /v1/insights/heatmap` (cells of day-of-week x hour with net/checks/covers, `dayTotals`, `grandNetMinor`, `daysCovered`). The flagship mockup's Insights screen (`prototypes/index_RestaurantOS.html`, "Tonight at a glance") is the visual reference for the tiles.

## What to build: `app/server/public/insights.html`, served at `/insights`

1. Serve route: add `/insights` beside `/close` in `app/server/src/server.ts` (the one src edit allowed), and add an "Insights" link to the nav of all six pages (pos, tables, kds, menu, close, insights).
2. Section "Tonight at a glance": tiles from live data: covers and checks closed today (from the servers response sums), avg check, total tips (card + declared). Same card style as `/close`.
3. Section "Servers": one horizontal stacked bar per server, segments per course (`courseKeys` order; use the status palette washes so the same course is the same color on every row), bar length proportional to `netMinor` against the max. Include the Average row visually distinct (muted). Tapping a server opens a detail card: rank per metric vs the average with a variance percent, Lightspeed-popover style (rank, actual, average, variance colored green/red). All amounts formatted from server minor units; NO client-side arithmetic beyond percent-for-pixel-width and variance display math.
4. Section "Busiest times": grid of hours (rows, e.g. 8am-11pm) x days Mon-Sun (columns), cell background = info-wash with alpha scaled by that cell's `netMinor` relative to the max cell. Tap a cell for net sales/checks/covers. Footer row: percent of net by day (`dayTotals` over `grandNetMinor`). Caption: "Quiet hours are promotion hours; put your best servers on the dark ones."
5. Footer disclaimer, same voice as the mockup: every figure comes from the ledger; demo data caveat.
6. Poll every 15 seconds (reports change slowly); pause while a detail card is open.

## Invariants (UI truthfulness)

- Every number shown comes from the two endpoints verbatim; formatting only, never recomputation or rounding of money.
- Empty states are honest: no closed checks yet renders a friendly "No closed checks yet today; close a few in Service" rather than fake bars.
- Wide content (the heatmap grid) scrolls inside its own container on narrow screens; the page body never scrolls horizontally; `--vph` pattern for the shell like every other page.

## Tests to add

- `api.test.ts`: `/insights` serves 200 with content-type html and contains "Insights" (same pattern as the other page-serve tests).
- Demo note checklist: seed two servers' checks, screenshot the scorecard showing different bars, tap a server for the detail card, tap a heatmap cell.

## File scope

- In scope: `app/server/public/insights.html` (new), the `/insights` serve route in `app/server/src/server.ts`, the nav link line in the six public pages, one page-serve assertion in `app/server/test/api.test.ts`.
- Out of scope: `engine.ts`, `pgStore.ts`, `types.ts`, everything under `app/domain/`, schema, docs.

## Definition of done

Suite green, page script parses (`node --check` on the extracted script block), token conformance, demo note with the click path. Update the E19-T2 row in `BACKLOG.md` to Implemented.
