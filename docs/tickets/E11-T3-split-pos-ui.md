# Ticket E11-T3: Split flow in the POS pay modal + per-portion receipts

**Epic:** E11 Split checks · **Build model:** Sonnet (or Codex, per D17) · **Review tier:** standard (`/code-review`); escalates to Opus after two failed reviews per §5.2
**Status:** Ready after E11-T2 merges

## Session preamble (read first, in order)

1. Read `CLAUDE.md` (writing rules bind UI copy too: no em dashes), `BACKLOG.md`, and `docs/tickets/E11-T2-split-engine-api.md` for the API you consume.
2. Read `design/restaurantos/DESIGN.md` sections 2-8: the Definition of Done includes token conformance, meaning no colors, radii, or spacing outside the system, 44px minimum touch targets, press feedback, no hover-only affordances.
3. Baseline: `cd app\server && npm test` green; open `http://localhost:3000/pos` and click through the existing pay flow before changing it.
4. One ticket per session. The server API is fixed; if it seems insufficient, return the ticket rather than adding endpoints.

## Context

E11-T2 exposes split previews (`GET /v1/checks/:id/split?mode=even&ways=N`, `?mode=bySeat`) and labeled portion payments. The POS pay modal (`app/server/public/pos.html`, the `renderPay` section) currently pays the whole check. The flagship mockup's split UX (Full / Even / By seat) is the reference: `prototypes/index_RestaurantOS.html`. The guest receipt modal (`openReceipt`) already renders the whole check; portions need the same treatment.

## What to build

- Pay modal gains a split selector row: `Whole check` (default, current behavior), `Even`, `By seat`. Even shows a ways picker (2, 3, 4, custom). Selecting a split fetches the preview and renders portion cards: label, due, a Pay button per portion, and a paid state once settled (poll refresh already exists).
- Paying a portion posts the existing payment command with the portion's label and its due (plus the chosen tip on that portion). Tip percent applies per portion.
- Receipt modal gains a portion picker when a split is active: print the whole check or one portion (portion receipt shows that portion's lines when by-seat, or the even-share amounts when even, plus its payments).
- The check header chips show `split: even 3` or `split: by seat` while portions are being settled (client-side state; the server stays stateless about the chosen mode).

## Invariants (UI truthfulness)

- Never do money arithmetic in the page beyond formatting. Every amount shown comes from the server preview or the check totals. No client-side rounding.
- The sum shown across portion cards must be the server's numbers verbatim; if they ever look wrong, that is a server bug to report, not patch in the UI.
- Offline-pending payments keep their amber "pending upload" honesty on portion cards.
- Voided lines stay struck-through on receipts, never hidden.

## Tests to add

- `app/server/test/api.test.ts` reads: `/pos` still serves and contains the split selector markup (same pattern as the existing page-serve tests).
- Manual verification checklist in the demo note: even 3-way on a seeded check, pay two portions, rail shows partially paid, pay the third, close; by-seat with a voided line; print one portion.

## File scope

- In scope: `app/server/public/pos.html` only, plus the one page-serve assertion in `app/server/test/api.test.ts`.
- Out of scope: every `src/` file, every other page, the domain package, schema, docs.

## Definition of done

Suite green, page script parses (`node --check` on the extracted script block), token conformance per DESIGN.md, demo note with the click path. Update the E11-T3 row in `BACKLOG.md` to Implemented.
