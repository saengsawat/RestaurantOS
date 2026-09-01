# Ticket E5-T3: Modifier groups on the Menu screen

**Epic:** E5 menu/config (D29) · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard
**Status:** Ready AFTER E5-T2 merges (consumes its commands; the API is fixed, return the ticket if insufficient).

## Session preamble

Read `CLAUDE.md`, `design/restaurantos/DESIGN.md` (tokens, 44px, press feedback), `docs/tickets/E5-T2-menu-groups-core.md`, and click through `/menu` as it exists (draft rows, publish flow, the 86 board) before touching it.

## What to build (`app/server/public/menu.html` only)

1. **A Modifier groups section** on the draft side, beside the items: one row per group (name, min-max badge, option count, price range), Add group, and a tap-to-edit sheet: name, min/max steppers, the option list (name + price each, add/remove), and Remove group with the engine's named-items refusal shown inline.
2. **Item assignment**: the item editor gains group chips (tap to toggle, drag or ordered-tap to order); an item requiring a group shows it plainly ("requires: Temperature").
3. **Publish stays the same gesture** and now carries the graph; the publish confirmation lists what changed (groups added/edited/removed) alongside items, and surfaces the engine's unorderable-item refusal verbatim.
4. Draft-vs-live badging matches how item edits already read ("edited on draft" chips) so a changed group reads the same way.

## Invariants

Tokens, 44px, press feedback, Day/Night; no engine or route edits; the 86 board and everything else on the page untouched; the page formats and never validates modifier math itself (the engine refuses, the page shows the reason).

## Tests

Page-serve assertions for the groups section markup; existing menu tests stay green.

## Definition of done

Suite green, script parses (`node --check`), demo note with the click path (create Temperature min 1 max 1 with three options, assign to the steak, publish, order the steak on POS and watch the required-choice modal carry the manager's own data) and screenshots or an honest note. Update the E5-T3 row in `BACKLOG.md` to Implemented.
