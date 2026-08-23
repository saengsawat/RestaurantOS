# Ticket E19-T4: The reporting tab is called Reports, not Insights

**Epic:** E19 (naming follow-up, founder-reported) · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard
**Status:** Ready. May be batched with E20-T3 in one session per D22 (this ticket FIRST, own commit, suite green between).

## Session preamble

1. Read `CLAUDE.md` (no em dashes anywhere, UI copy included) and `DECISIONS.md` entry D24.
2. Baseline: `cd app\server && npm test` green before any edit.

## Context (D24)

The founder flagged that "Insights" is the flagship mockup's name for the AI layer (the same data that runs service, turned into decisions: attention cards, suggestions). The live page at `/insights` is a report: tonight's numbers, the server scorecard, the heatmap. Spending the product's differentiator word on a scorecard misleads. Decision D24: the reporting screen is **Reports**; **Insights** is reserved for the Phase 6 intelligence layer and disappears from the live app until that layer exists.

## What to change

1. `server.ts`: serve the page at `/reports`. Keep `/insights` answering with a 302 redirect to `/reports` (bookmarks and muscle memory survive). The `page()` constant and the html filename: rename the file to `reports.html` and update the loader.
2. `reports.html` (the renamed file): tab title, topbar heading, and the nav's own pill say Reports. The subtitle line ("operator report, live from the ledger") already says what it is; keep it.
3. All six pages' nav: the link text becomes `Reports`, href `/reports`.
4. Do NOT rename the API routes (`/v1/insights/servers`, `/v1/insights/heatmap`): clients and tests point at them, and an API path is not user-facing copy. One code comment in `server.ts` noting D24 covers the naming mismatch.
5. Tests: update the page-serve test (serves at `/reports`, `/insights` redirects with a Location header, nav assertions updated).

## Invariants

- Zero behavioral change beyond the URL and the label: same markup, same data, same polling.
- No sweep-in edits to other pages beyond their one nav line.

## Definition of done

Suite green, typecheck clean. Update the E19-T4 row in `BACKLOG.md` to Implemented.
