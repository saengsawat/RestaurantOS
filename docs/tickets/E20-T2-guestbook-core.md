# Ticket E20-T2: Guestbook core (tables, attach, derived profile)

**Epic:** E20 Guestbook · **Build model:** Opus (new aggregate, money attribution, both stores) · **Review tier:** cross-model (Fable)
**Status:** Ready. SEQUENCING: edits `engine.ts`, `types.ts`, `pgStore.ts`; not concurrent with any other app/server ticket.

## Session preamble (read first, in order)

1. Read `CLAUDE.md` (no em dashes anywhere, commits included), `BACKLOG.md`, `DECISIONS.md`, and `docs/prd/guestbook-spec.md` IN FULL: it is the product definition this ticket implements and its sections are cited below by number.
2. Baseline: `cd app\server && npm test` green (quote the count you measure) before any edit.
3. One ticket per session; this file is the whole scope. Scope problems return the ticket. Commits small, `Co-Authored-By: Claude Opus <noreply@anthropic.com>`, never force-push, only commit with the full suite green.

## Context

Founder approved building the guestbook v0 now (spec §6 recommended waiting for the pilot; the founder overrode that to have a "we remember your regulars" demo, logged as D23). This ticket is the engine and stores only; the screens are E20-T3. The v0 rung of the D20 ladder ONLY: manual attach. No phone-lookup UX, no card fingerprints (E13), no allergen tags (Matt's C5), no percentile rank (spec says hide it below ~30 guests; v0 simply omits it).

## Part 1: the two tables (spec §2, verbatim shapes)

- PostgreSQL migration, expand-only: `guest` and `check_guest` exactly as sketched in spec §2 (D14 conventions; `marketing_opt_in` defaults false; the two indexes). Do NOT create `guest_card_fingerprint` (E13) or `guest_allergen` (Matt's C5).
- Memory store: equivalent in-memory maps behind new `Store` interface methods. Both stores implement the same interface; the PG test proves the round trip.

## Part 2: commands (all through the envelope, operationId idempotent like every mutation)

- `createGuest`: display name required (non-empty after trim), phone/email/notes optional. No PIN: any signed-in staff can create (spec §3 quick-create "in under five seconds").
- `attachGuest(checkId, guestId)` / `detachGuest`: any staff; attaching to a closed check is allowed (the server remembers who sat there after they leave); attaching the same guest twice is a no-op, not an error.
- `updateGuest`: name/phone/email/notes/marketing_opt_in edits, any staff.
- `mergeGuests(survivorId, absorbedId)`: MANAGER PIN via the existing approval path. Repoints the absorbed guest's `check_guest` rows to the survivor (skipping rows that would duplicate), appends the absorbed record's notes to the survivor's rather than dropping them, deletes the absorbed record, and lands in the audit trail with actor + both names. Merging must not touch any check, line, or payment (spec §3: history is a join, not a copy).
- `deleteGuest`: MANAGER PIN. Clears identity fields and drops the guest's `check_guest` rows (spec C7 default). Checks are never deleted.

## Part 3: reads (computed on read, nothing stored, D19 discipline)

- `GET /v1/guests?q=`: case-insensitive substring match on name or phone, capped list, newest first on empty query.
- `GET /v1/guests/:id`: the derived profile, spec §4's table implemented literally:
  - favorites (top non-voided items by count over the guest's CLOSED checks, ties by most recent), visits (distinct closed checks), distinct service dates, median gap days, last visit, preferred section (mode of the check's table area), preferred server (mode of `serverId`, name included), tip percent of net averaged per check.
  - **Spend attribution (spec §4, the one place money is touched):** one guest attached → the check's total is theirs. Several guests → split with the domain's `splitCheck` (by seat where lines carry seats and the guests can be mapped to seats; EVENLY otherwise, which is the v0 default since v0 has no guest-to-seat mapping), and flag those visits `sharedCheck: true`. Per-guest spend across all attached guests of one check must sum to that check's total exactly. Use the domain allocators; write no new division.
- Attach state rides the check view: `toView` output gains a `guests: [{id, name}]` array (empty when none) so E20-T3 can render chips without a second fetch.

## Invariants

- No stored aggregates anywhere; the profile is a join, so deleting or merging guests never changes any check's totals.
- Conservation: for a check with N attached guests, the N profile shares sum to the check's `totalMinor`.
- Voided lines never appear in favorites; closed checks only feed spend and visits.
- Manager PIN required for merge and delete, refused for a server's PIN, audited.
- Privacy defaults from spec §5 ship as coded defaults (opt-in false, identity purge on delete); Matt's deck C answers retrofit later without schema change.

## Tests to add

- Create, search, attach, profile with known sums (single guest: whole check; two guests on one check: shares sum to the total, visits flagged shared).
- Favorites exclude a voided line; an open check contributes nothing.
- Merge: links repoint, notes append, survivor's profile now spans both histories, and every involved check's totals are byte-identical before and after.
- Delete: identity gone, links gone, checks intact; a server PIN is refused for merge and delete.
- PG round-trip: create + attach, restart the store, profile identical.

## File scope

- In scope: `app/server/src/types.ts`, `engine.ts`, `pgStore.ts`, `memoryStore` (wherever it lives), `server.ts` (routes), a new migration, `test/api.test.ts`, `test/pg.test.ts`.
- Out of scope: every page under `public/` (E20-T3), `app/domain/` (use `splitCheck` as is; if it cannot express what you need, return the ticket), allergens, fingerprints, percentiles.

## Definition of done

Suite green, typecheck clean, demo note: curl a create, an attach, and the profile of a guest with a shared check showing the share arithmetic. Update the E20-T2 row in `BACKLOG.md` to Implemented. Do NOT start E20-T3.
