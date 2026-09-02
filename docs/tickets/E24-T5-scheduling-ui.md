# Ticket E24-T5: The schedule on a phone

**Epic:** E24 team & labor, rung 2 (D31) · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard
**Status:** Ready AFTER E24-T4 merges (consumes its commands and reads). D22 batch: build this, commit, then E26-T1 in the same session, own commit.

## Session preamble

Read `CLAUDE.md`, `design/restaurantos/DESIGN.md`, `docs/prd/team-labor-spec.md` §3, `docs/tickets/E24-T4-scheduling-core.md`, and click through `/settings`'s Team section first. **Phone-first (D31): a server checks their shifts on a phone in a break room; design 390px first.**

## What to build

### 1. A Schedule screen (`/schedule`, new page on the shell, 9th rail entry)
- **The employee's own view is the default**: this week's published shifts for whoever the device session says is signed in, as a simple day list ("Tue 4:00 PM to close · Bar"). No PIN, nothing to configure, readable in five seconds.
- **The manager view behind the manager PIN** (asked the way Settings asks): the week grid, employees down, days across; on a phone it collapses to one day at a time with a day switcher, never a horizontally scrolled grid. Tap a cell to add or edit a shift (employee prefilled, role-for-shift, start/end); overlap warnings from the response shown inline, never blocking.
- **Publish week** as one deliberate action with a confirm stating what it does ("Staff can see this week after you publish"); draft shifts visibly distinct (the draft-vs-live chip language the Menu page already speaks).
- **Planned vs actual** for a past day, manager view: the hours line per employee from the labor read; hours only, no dollars, and nothing invented client-side.

## Invariants

Tokens, 44px, press feedback, Day/Night, safe-area insets; no engine or route edits; drafts never visible outside the manager view; the page formats and never computes hours itself.

## Tests

Page-serve assertions for the page and the publish confirm hook; existing tests stay green.

## Definition of done

Suite green, `node --check` on the page script, demo note with the click path (sign in as Gia, see your week; manager plans Saturday, publishes, Gia's view updates) and screenshots at 390px AND 1280px or an honest note. Update the E24-T5 row in `BACKLOG.md` to Implemented. **Commit before ending the session.**
