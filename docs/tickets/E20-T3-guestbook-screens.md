# Ticket E20-T3: Guestbook screens (attach flow + guest profile)

**Epic:** E20 Guestbook · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard; cross-model if it touches anything beyond the listed files
**Status:** Ready AFTER E20-T2 merges (consumes its commands and reads). May be batched after E19-T4 in one session per D22 (own commit, suite green between).

## Session preamble

1. Read `CLAUDE.md` (no em dashes anywhere, UI copy included), `docs/prd/guestbook-spec.md` §3-§4 (the flows this renders), and `docs/tickets/E20-T2-guestbook-core.md` (the API you consume).
2. Read `design/restaurantos/DESIGN.md` sections 2-8: token conformance, 44px targets, press feedback, no hover-only affordances, Day/Night via `prefers-color-scheme`, `--vph` shell.
3. Baseline: suite green; run the server, click through `/pos` first and copy its modal patterns rather than inventing new ones.
4. The API is fixed. If it seems insufficient, return the ticket.

## What to build

1. **Attach flow in the POS** (`pos.html`): the check's More menu gains **Guests**. It opens a modal with a search box (name or phone, live against `GET /v1/guests?q=`), a result list (name, phone, last visit) each with an Attach button, and a quick-create path: type an unmatched name, one tap creates and attaches (spec §3: under five seconds). Attached guests render as chips on the check header (the `guests` array the check view now carries); tapping a chip opens the profile; a detach control lives inside the profile view, not on the chip (a stray tap must not silently detach someone).
2. **Guest profile** (same modal, second pane): everything `GET /v1/guests/:id` returns, spec §4's order: favorites, total and average spend (shared-check visits labeled as such), visits and cadence, last visit, preferred section and server, tip percent, notes (editable, saved via `updateGuest`). Manager-gated **Merge** (search for the duplicate, PIN, confirm naming both records) and **Delete** (PIN, confirm with the C7 wording: the checks stay, the person is unlinked).
3. Empty states are honest: no guests yet, no visits yet ("Attach this guest to a check and the profile builds itself").
4. Stub nothing silently: anything you cannot reach through the T2 API gets the standard "...isn't in this prototype yet" toast pattern only if unavoidable, and named in the demo note.

## Invariants

- Every figure comes from the profile endpoint verbatim; the page formats, never computes money.
- Tokens only; 44px targets; press feedback; works Day and Night; the modal scrolls inside itself on a phone, the body never scrolls sideways.
- Voids/discounts/PIN flows already on the page keep working untouched: additions only.

## Tests to add

- Page-serve assertions: `/pos` contains the Guests menu item markup and the guest-modal markup hooks.
- Keep the suite green; DOM-level checks in the page-test style already used for the split flow are welcome but not required.

## File scope

- In scope: `app/server/public/pos.html`, `app/server/test/api.test.ts` (serve assertions only).
- Out of scope: engine, stores, routes, other pages, the domain package.

## Definition of done

Suite green, page script parses (`node --check`), demo note with the click path (search, quick-create, attach, profile, merge, delete) and screenshots if you can take them; note honestly if you cannot. Update the E20-T3 row in `BACKLOG.md` to Implemented.
