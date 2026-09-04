# Ticket E25-T2: Each role sees its own app

**Epic:** E25 roles & visibility (D33) · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard
**Status:** Ready AFTER E25-T1 merges (consumes the matrix from `/v1/session`).

## Session preamble

Read `CLAUDE.md`, `design/restaurantos/DESIGN.md`, `docs/tickets/E25-T1-roles-core.md`, `lock.html` (the session boot every page runs), and one page's nav rail markup. All pages share the same rail pattern; the change must land identically on every page including `/reservations` and `/schedule`.

## What to build (pages only)

1. **The rail obeys the matrix**: after the session fetch each page already does, nav entries not in the signed-in role's list are NOT RENDERED (not disabled, not grayed: a server never sees that Reports exists). Same for the mobile bottom tabs. No session (locked device) renders no rail beyond the lock redirect the pages already have.
2. **A refusal that respects the person**: navigating directly to a screen outside the role (typed URL, stale bookmark) shows a calm full-screen notice on that page ("This screen needs a manager. You are signed in as Gia R., server."), with Sign out and Back actions; never a broken half-rendered page. The server-side refusal (E25-T1) is what actually protects the data; this is the honest face on it.
3. **Settings' Team section** gains the two new roles in its role picker, labeled plainly (Owner, Manager, Kitchen, Server) with one line each on what they see; picking owner/manager routes through the owner-PIN path the core built. Titles stay the free-text field they are.
4. **The lock screen** shows the role under the name on successful sign-in ("Nico F. · Kitchen") so the demo reads instantly.
5. **One CSS line on every page while you are in them**: `.toasts{pointer-events:none}` (schedule.html already has it; E24-T5 found toasts landing exactly on a bottom sheet's action row on phones and deadening the button for three seconds).

## Invariants

Tokens, 44px, press feedback, Day/Night, safe-area insets; no engine or route edits; the matrix comes from the session response, never hardcoded per page (one fetch, one source of truth); pages that boot pre-sign-in still boot.

## Tests

Page-serve assertions for the refusal notice hook and the role labels; existing page tests stay green.

## Definition of done

Suite green, `node --check` on changed page scripts, demo note with the click path (sign in as each of the four roles, watch the rail change; hit a forbidden URL as a server and read the notice) and screenshots at 390px AND 1280px or an honest note. Update the E25-T2 row in `BACKLOG.md` to Implemented. **Commit before ending the session.**
