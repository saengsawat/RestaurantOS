# Ticket UI-T1: The app shell the design system prescribes (left rail + topbar)

**Epic:** POS UI (rides E6-E8 per master plan §7.2 note) · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard
**Status:** Ready. Touches every page, so not concurrent with any other ticket. First of the UI batch (D22: own commit, suite green, then UI-T2, then UI-T3).

## Session preamble

1. Read `CLAUDE.md`, `design/restaurantos/DESIGN.md` IN FULL (its layout section prescribes exactly this shell), and `DECISIONS.md` (D25).
2. Open `prototypes/index_RestaurantOS.html` next to the live `/pos`: the mockup's shell is the spec, the live pages are the patient.
3. Baseline: suite green; screenshot or eyeball every page before touching it.

## Context (founder + design system, the same verdict)

The live pages grew a top nav where app tabs (Service, Tables, Kitchen, Menu, Close, Reports) sit mixed with session chrome (server name, check number, clock, online dot). DESIGN.md prescribes and the mockup demonstrates the correct anatomy: a LEFT ICON RAIL for navigation with badge counts, and a topbar reserved for identity and session state. Navigation is a place you go; the topbar is where you are.

## What to build, on all six navigable pages (pos, tables, kds, menu, close, reports; the lock screen stays a fullscreen PIN pad)

1. **Left rail** (desktop >820px): the mockup's pattern: icon + label per destination, active state, and live badge counts where the data is already on the page or one existing read away (Tables: open checks count; Kitchen: open ticket count). Inline SVG icons in one consistent stroke style, never emoji. Rail width, spacing, tokens per DESIGN.md.
2. **Topbar**: venue + screen title on the left; session chrome on the right (sign-in/server chip, check number where applicable, clock, online dot), exactly the elements each page has today, just no longer sharing a row with navigation.
3. **Mobile ≤820px**: the rail becomes the mockup's bottom tab bar (safe-area inset respected); the topbar stays one row. The KDS keeps its pinned Night styling with the same anatomy.
4. Zero behavior change: every link, button, poll, and modal works exactly as before. This ticket moves furniture, it does not build any.

## Invariants

- Tokens only, 44px targets, press feedback, no hover-only affordances; Day/Night on every page except the KDS's pinned Night.
- The `--vph` shell pattern stays; the page body never scrolls horizontally.
- Each page stays a self-contained single file (duplicated shell markup per page is the accepted cost of zero-dependency pages; keep the markup identical across pages so a future extraction is mechanical).

## Tests

- Update every page-serve assertion that greps nav markup (`href="/reports"` etc.) to the new structure; add one asserting the rail markup exists on all six pages.
- Demo note: screenshots (or an honest note that you cannot take them) of /pos and /kds at 1280px and 390px.

## File scope

In scope: the six page files + serve assertions in `api.test.ts`. Out of scope: `src/*`, lock.html, any behavior.

## Definition of done

Suite green, page scripts parse (`node --check`), demo note with the click path. Update the UI-T1 row in `BACKLOG.md` to Implemented. Then proceed to UI-T2 per the batch instruction.
