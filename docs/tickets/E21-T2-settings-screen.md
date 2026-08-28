# Ticket E21-T2: The Settings screen, and the venue's name comes off the walls

**Epic:** E21 venue settings (D26) · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard
**Status:** Ready AFTER E21-T1 merges AND after E6-T3 in the same session (D22: own commit, suite green first).

## Session preamble

Read `CLAUDE.md`, `design/restaurantos/DESIGN.md`, and `docs/tickets/E21-T1-venue-staff-core.md` (the API; it is fixed).

## What to build

### 1. `/settings` (new page on the shell)
- Served beside the others (`server.ts` gains the route + page constant; the one src edit allowed), with a seventh rail entry (Settings, inline SVG icon in the set's stroke style) added to ALL seven pages including itself.
- **Venue section**: name, address, timezone (a filtered text input over `Intl.supportedValuesOf("timeZone")`, not a 400-row select), saved via the manager-gated update; refusals inline.
- **Team section**: the roster from `GET /v1/staff` (name, role chip, active state), add employee (name, role, initial PIN entered twice), reset PIN, deactivate with a confirm; the last-manager refusal shown verbatim. PINs are never displayed.
- The whole page is manager-territory: a PIN prompt on first mutation, held for the visit like the floor editor does.

### 2. De-branding every page
- All seven page headers, the POS receipt (name + address lines), and `lock.html` (title + heading) render the venue from `GET /v1/venue` at boot instead of hardcoded "Osteria Nove" text; fallback text while loading is "RestaurantOS", never a flash of the wrong restaurant's name.
- The `<title>` tags stay generic except lock.html, which follows the venue name.

## Invariants

Tokens, 44px, press feedback, Day/Night; no engine edits; the demo seed still boots as Osteria Nove until someone renames it, so nothing about the demo experience changes out of the box.

## Tests

Page-serve assertions: `/settings` serves 200 with the Team and Venue markup; every page contains the `/v1/venue` fetch hook; lock.html no longer hardcodes the name.

## Definition of done

Suite green, scripts parse, demo note: rename the venue in Settings and show the POS header, receipt, and lock screen following; add an employee and sign in with their PIN. Screenshots or an honest note. Update the E21-T2 row in `BACKLOG.md` to Implemented.
