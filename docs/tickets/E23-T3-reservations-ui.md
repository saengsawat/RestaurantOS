# Ticket E23-T3: The book on screen, the promise on the floor

**Epic:** E23 reservations (D31) · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard
**Status:** Ready AFTER E23-T2 merges (consumes its commands and reads; the API is fixed, return the ticket if insufficient). D22 batch: build this, commit, then E21-T3 in the same session, own commit, suite green between.

## Session preamble

Read `CLAUDE.md`, `design/restaurantos/DESIGN.md`, `docs/prd/reservations-spec.md` §§1-2, `docs/tickets/E23-T2-reservations-core.md`, and click through `/tables` and the New check flow first. **Phone-first (D31): design every layout at 390px before 1280px**; the host answering the phone is standing up, holding a phone or a small tablet.

## What to build

### 1. A Reservations screen (`/reservations`, new page on the shell)
- The book, one day at a time: date switcher (Today default), reservations in time order grouped by service period with the covers total per period, exactly what the read returns.
- A "New reservation" action: name, phone, party size (stepper), time, optional table (chips from the floor read), optional note. Name, party size, and time are required (the engine refuses a nameless booking); the name field hints that any name will do ("even 'walk-in'"). A past time warns inline and allows.
- Row actions: Seat (primary), No-show, Cancel; past-due booked rows visually flagged. When the read carries a `guestMatch`, the Seat confirm shows "This phone matches Somchai P. in the guestbook: attach?" (attach is opt-in, never silent).
- Seat lands the user on Service with the new check open (the command did the work; the page just navigates).
- Nav: the 8th rail entry, all pages, icon consistent with the set; bottom tab on mobile.

### 2. The floor badge (`tables.html`)
- A table whose floor read carries `reserved` shows a badge: time + name + party size, in the service-status palette (info triple, not red; a reservation is information, not an alarm).
- Tapping a badged table to open a check shows the warn-and-allow confirm from the spec ("held for Somchai at 7:30, in 20 minutes. Seat anyway?"); confirming proceeds exactly as today.

## Invariants

Tokens, 44px, press feedback, Day/Night, safe-area insets; no engine or route edits; the page formats and never derives (the badge and the match come from the reads). Existing Tables flows untouched otherwise.

## Tests

Page-serve assertions for the new page and the badge markup hook; existing page tests stay green.

## Definition of done

Suite green, `node --check` on both page scripts, demo note with the click path (book a party of 4 by phone, watch the badge appear inside the lead window, seat it, see covers prefilled) and screenshots at 390px AND 1280px or an honest note. Update the E23-T3 row in `BACKLOG.md` to Implemented. **Commit before ending the session.**
