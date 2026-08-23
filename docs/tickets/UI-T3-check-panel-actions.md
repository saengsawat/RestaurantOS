# Ticket UI-T3: The check panel, mockup parity (courses, hold/fire, action bar, history)

**Epic:** POS UI · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard; escalate anything needing an engine change back to the orchestrator
**Status:** Ready after UI-T2 AND after E8-T3 has merged (consumes hold/fire and the history read).

## Session preamble

1. Read `CLAUDE.md`, `DECISIONS.md` (D25), `docs/tickets/E8-T3-course-hold-fire.md` (the API you consume), and use the mockup's check panel until familiar: course sections with Fire now / Hold, the Discount · Void · History · More action row.
2. Baseline: suite green. The API is fixed; if it seems insufficient, return the ticket.

## Context (founder, four complaints in one panel)

The live check panel is a flat line list with three buttons (%, Send, Pay), and tapping a line silently opens a void dialog, a landmine. The mockup groups lines by course with per-course firing controls, and puts corrections behind an explicit action bar. That is the spec.

## What to build (`app/server/public/pos.html` only)

1. **Course grouping**: lines grouped under course headers in course order, seat chips and modifiers as today. Each course header carries its state chip: HELD (amber) when in `heldCourses`, Fire now button when it has unsent lines, fired time when its ticket is on the rail (the check view + tickets read the page already polls).
2. **Hold / fire controls**: Hold and Fire now per course calling E8-T3's commands; the big Send stays and now reports what it held back (the engine response says it; show it as a toast).
3. **Action bar** above Send/Pay: **Discount** (the existing % flow, relabeled), **Void** (new modal: multi-select any voidable lines, one reason from the existing reason set, one manager PIN for the batch, issued as the existing per-line void commands in sequence; partial failure shows exactly which line refused), **History** (modal rendering `GET /v1/checks/:id/history` verbatim, newest first, the mockup's timeline style), **More** (the existing ⋯ menu: transfer, merge, receipt, Guests; unchanged, just relocated).
4. **Line tap no longer voids.** Tapping a line opens a small line sheet (name, seat, modifiers, price, and a Void this line shortcut into the same void modal with it preselected). Nothing destructive happens on a bare tap.
5. Mobile ≤820px: the panel keeps today's bottom-sheet behavior; the action bar wraps to two rows if needed; every target 44px.

## Invariants

- The page formats and never computes money; every figure and every state chip comes from the server's responses.
- No engine or route edits; anything the API cannot express is returned, not stubbed silently.
- Existing flows (modifiers, seats, split payments, receipts, guests) keep working untouched.

## Tests

Page-serve assertions for the action bar and history modal markup; existing POS flow tests stay green.

## Definition of done

Suite green, script parses, demo note with the click path (hold a course, send, fire it, batch-void two lines with one PIN, open History) and screenshots or an honest note. Update the UI-T3 row in `BACKLOG.md` to Implemented.
