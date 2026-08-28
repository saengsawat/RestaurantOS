# Ticket E6-T3: Floor editor UI (draw your own room)

**Epic:** E6 floor (D26) · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard
**Status:** Ready AFTER E6-T2 merges (consumes its four commands). Batchable BEFORE E21-T2 in one session (D22).

## Session preamble

1. Read `CLAUDE.md`, `design/restaurantos/DESIGN.md` (tokens, 44px, press feedback), and `docs/tickets/E6-T2-floor-editor-core.md` (the API you consume; it is fixed, return the ticket if insufficient).
2. Baseline: suite green; click through `/tables` Edit layout as it exists today first.

## What to build (`app/server/public/tables.html` only)

1. **Manager gate on entry**: entering Edit layout asks the manager PIN once (a small modal, the page's existing patterns); held in a page variable and sent with every structural command. The server re-validates every call; drag-to-move stays exactly as today (no PIN).
2. **Add table**: a "+ Add table" control in edit mode opens a bottom sheet: four shape tiles (rect, round, booth, stool) as 44px CSS mini-previews, name field, seats stepper (minus / count / plus), area chips from the live floor plus a "New area" text field. Default size per shape (rect 16x26, round 12x22, booth 20x30, stool 6x10, in the floor's percent units); the new table spawns centered and is then dragged into place.
3. **Edit a table**: in edit mode, a TAP (not a drag) on a table opens the same sheet pre-filled: rename, seats, shape, size, and a red-outline "Retire table" with a one-tap confirm whose copy says history is kept ("Its past checks stay in the books").
4. **Resize**: S / M / L presets per shape (roughly 0.75x / 1x / 1.3x of the shape default) inside the sheet. No drag handles: on a small table they fall under 44px and fight drag-to-move.
5. **Refusals inline in the sheet** (the engine's reason verbatim), never a silent retry. Add a `.booth` CSS class beside rect/round/stool (booth renders as a rectangle with a visibly larger radius on one side or similar, tokens only).
6. Leaving edit mode re-fetches, as today.

## Invariants

Tokens only, 44px targets, press feedback, Day/Night; the sheet scrolls inside itself on a phone; no engine or route edits; existing seat/jump-to-check behavior outside edit mode untouched.

## Tests

Page-serve assertions for the add-sheet markup and the `.booth` class; existing floor tests stay green.

## Definition of done

Suite green, script parses (`node --check`), demo note with the click path (PIN in, add a booth on a new "Patio" area, resize it L, rename it, retire it) and screenshots or an honest note. Update the E6-T3 row in `BACKLOG.md` to Implemented. Then proceed to E21-T2.
