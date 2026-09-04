# Ticket UI-T5: The back office gets a front door

**Epic:** app shell (D35) · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard
**Status:** Ready AFTER E25-T2 merges (consumes the session's visibility matrix; rails are rebuilt there first). D22 batch: same session as E25-T2, AFTER it, own commit.

## Session preamble

Read `CLAUDE.md`, `design/restaurantos/DESIGN.md`, `DECISIONS.md` (D33, D35), `docs/tickets/E25-T2-roles-ui.md` (the matrix you consume and the rail pattern you restructure), and click through every screen signed in as each role first.

## Context (D35)

The rail is at nine entries and still growing (inventory, guest screens, food cost are all coming). D35 splits the app into two faces: the floor keeps the rail (zero taps to work), and every management surface collapses into one rail entry, **Office**, opening a card hub. The founder's reference is his company portal's card-per-category layout; take the structure, never the look: this page is built entirely from our tokens.

## What to build

### 1. `/office`, the hub page (new page on the shell, one page-serve route)
- **One card per back-office area**, on the design system (radius, elevation, 44px, press feedback, Day/Night):
  - **Menu**: link to `/menu`; sub-links 86 board and Import (anchors on that page); live stat from the menu read ("37 items live · draft in progress" or "no draft").
  - **Reports**: link to `/reports`; live stat from the day read (tonight's net so far, or "no sales yet").
  - **Schedule**: link to `/schedule` (Plan tab); live stat from the week ("week published" / "N drafts").
  - **Venue & team**: link to `/settings`; sub-links Team and Hours export (anchors); stat: venue name + headcount from the public roster.
- **Cards obey the matrix** from `/v1/session` exactly as the rails do after E25-T2: a card outside the signed-in role is absent, never grayed. An empty hub (a role with no office surfaces) never happens because the Office rail entry itself is matrix-gated.
- Stats are read from the EXISTING reads only, formatted and never computed; a failed fetch degrades to the card without its stat line, never to a broken card.
- Phone-first: cards stack single-column at 390px; every tap target 44px.

### 2. The rail, restructured (all pages)
- Rail entries become: Service, Tables, Bookings, Kitchen, Close, Shifts, **Office** (each still matrix-filtered per E25-T2). Menu, Reports, and Settings LEAVE the rail; they are reached through the hub. Shifts stays on the rail because My week is personal to every role.
- The Office entry carries an icon consistent with the set and is active on `/office`, `/menu`, `/reports`, and `/settings` (you are "in the office" on any of them). Those three pages gain a small "Office" breadcrumb affordance back to the hub in their topbar area.

### 3. Landing by role (lock.html)
- After sign-in: server lands on Service, kitchen lands on Kitchen, manager and owner land on `/office`. The lock screen already knows the role from the session response; this is one routing decision, stated in a comment.

## Invariants

Tokens only, no colors or radii outside the system; no engine or route edits beyond the one page-serve route; the matrix comes from the session response and is hardcoded nowhere; deep links to `/menu`, `/reports`, `/settings` still work directly (the hub is a front door, not a wall); existing tests stay green.

## Tests

Page-serve assertion for the hub markup and the Office rail entry; existing page tests updated where they assert the old rail set.

## Definition of done

Suite green, `node --check` on changed page scripts, demo note with the click path (sign in as Marco, land on the hub, read the four stats, tap into Menu and come back via the breadcrumb; sign in as Gia and see neither Office nor its pages) and screenshots at 390px AND 1280px or an honest note. Update the UI-T5 row in `BACKLOG.md` to Implemented. **Commit before ending the session.**
