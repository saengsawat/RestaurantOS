# Ticket UI-T4: The New check modal knows the room

**Epic:** POS UI (founder-reported) · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard
**Status:** Ready. Touches only `pos.html`; not concurrent with other tickets.

## Session preamble

1. Read `CLAUDE.md` (no em dashes anywhere, UI copy included) and `design/restaurantos/DESIGN.md` (tokens, 44px, press feedback).
2. Baseline: `cd app\server && npm test` green.

## Context (founder)

The New check modal lists bare table names. A server has no idea Table 9 seats two until they have memorized the floor, and picking a party of 5 happily offers tables that hold 2. The floor read the modal is already built from (`/v1/floor`) carries `seats` and `area` for every table; the modal just does not use them.

## What to build (`app/server/public/pos.html` only)

1. **Capacity on every pill**: "Table 9 · 2" (the seat count, compact; the design system's mono numerals). The Walk-in pseudo-table shows no count.
2. **Group by area**: small section labels (Sala, Terrazza, Bar) from each table's `area`, in the floor's own order, Walk-in last on its own line. Same pills, same tap behavior.
3. **Soft capacity guard, both directions**:
   - With covers selected, any table whose seats are fewer than the party grays to a muted state (still 44px, still tappable).
   - Tapping a muted table does not open the check: it arms a one-line inline note in the modal ("Party of 5 on Table 9, which seats 2. Tap again to squeeze them in.") and a second tap proceeds. No browser confirm(), no separate modal.
   - Same rule when the table is picked first and the covers are raised past its seats: the note appears; changing either clears it.
   - NEVER a hard block: pulling up a chair is normal service, and the guard is a nudge, not a refusal. The engine is untouched; it accepts what it accepted before.
4. The covers row itself is unchanged (1 through 8 plus whatever exists today).

## Invariants

- Tokens only, 44px targets, press feedback, Day/Night; the modal scrolls inside itself on a phone and the body never scrolls sideways.
- Zero engine or route edits; `/v1/floor` is already fetched, so no new request per open.
- Occupied-table behavior (whatever exists today) is untouched.

## Tests

- Page-serve assertion: the modal markup carries the seats rendering hooks; existing open-check tests stay green.

## Definition of done

Suite green, script parses (`node --check`), demo note with the click path (pick 5 covers, see small tables mute, squeeze onto one with a second tap) and screenshots or an honest note. Update the UI-T4 row in `BACKLOG.md` to Implemented.
