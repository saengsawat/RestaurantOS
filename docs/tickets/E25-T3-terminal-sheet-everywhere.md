# Ticket E25-T3: Everyone can leave (the terminal sheet goes everywhere)

**Epic:** E25 roles (founder-reported defect, 2026-09-04) · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard
**Status:** Ready.

## The defect, in the founder's words

Nico (kitchen) cannot sign out. The "Who's on this terminal?" sheet (sign in, sign out, clock out) lives only on `/pos`, and E25-T2 correctly made `/pos` unreachable for a kitchen sign-in, so the one role that cannot visit Service is now locked inside its own app. The only Sign out a kitchen user can reach is on the trespass-refusal page, which they only see by going somewhere they should not.

## Session preamble

Read `CLAUDE.md`, `design/restaurantos/DESIGN.md`, the terminal sheet in `pos.html` (the behavior to replicate, not to centralize: pages stay single-file), and the topbar identity chip pattern on `schedule.html`. Sign in as Nico (PIN 2580) and feel the dead end first.

## What to build (pages only)

1. **Every page's topbar shows the signed-in identity chip** (name, and the role under or beside it per the lock screen's pattern); `kds.html` currently shows none and gains one. No session shows the existing Sign in affordance where a page has one, or the chip reading "Not signed in".
2. **Tapping the chip opens the terminal sheet on every page**, with the same three acts `/pos` already has: sign in with a PIN (switching who this terminal is), Sign out, and Clock out. Same server calls `/pos` makes; the demo-PIN helper list appears exactly as it does there (concept-demo framing). Signing out lands on the lock screen. Switching to a role that cannot see the current page shows the existing refusal instead of a broken screen (the E25-T2 machinery already handles this on reload; reuse it).
3. **Theme-faithful**: the sheet on `kds.html` respects the KDS night styling; everywhere else Day/Night as the page already is. Tokens, 44px, press feedback, safe-area insets.
4. Rails and everything else untouched; no engine or route edits (the signout/session routes exist and are public).

## Tests

Page-serve assertions for the chip and sheet hooks on `kds.html` and `schedule.html` at minimum; existing tests stay green.

## Definition of done

Suite green, all touched page scripts parse, demo note with the click path (sign in as Nico on the lock screen, land on Kitchen, tap the chip, sign out, land back on the lock screen; switch users mid-page on /schedule) and screenshots or an honest note. Update the E25-T3 row in `BACKLOG.md` to Implemented. **Commit before ending the session.**
