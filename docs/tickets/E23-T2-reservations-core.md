# Ticket E23-T2: The call-in book (engine + stores)

**Epic:** E23 reservations (D31 activates the build) · **Build model:** Opus (new aggregate, cross-module: floor + guestbook + checks) · **Review tier:** cross-model (Fable)
**Status:** Ready. SEQUENCING: edits `engine.ts`; not concurrent with any other app/server ticket.

## Session preamble

1. Read `CLAUDE.md` (no em dashes anywhere), `DECISIONS.md` (D27, D31), and `docs/prd/reservations-spec.md` IN FULL; §1 (promise, not a lock), §4 (data sketch), and §6 (build shape) are this ticket's contract.
2. Read the code you compose onto: `openCheck` (covers + table prefill), the guestbook attach command (E20-T2), `Engine.floor()` (where the badge derives), venue settings (E21-T1, where the lead window lives).
3. Baseline: `cd app\server && npm test` green (quote the measured count). Commits `Co-Authored-By: Claude Opus <noreply@anthropic.com>`.

## What to build

### 1. The aggregate and stores
- `Reservation` per spec §4: id, name (required), phone (optional), partySize (required, > 0), reservedFor (UTC ISO), tableName (optional; resolves against active OR retired tables so a booking survives a floor edit), status `booked|seated|no_show|cancelled`, note, createdBy, createdAt, guestId (optional).
- Both stores behind the Store interface; PG migration `0010_reservations.sql`, expand-only, per the spec's sketch (adapted to our actual columns; `table_id` FK to `dining_table`).
- Venue settings gain `reservationLeadMinutes` (default 45) and `reservationHoldMinutes` (default 15), editable through the existing venue update command; no new route.

### 2. Commands (envelope-idempotent, audit like everything else)
- `bookReservation`: name/phone/partySize/reservedFor/tableName?/note?. NOT manager-gated (any signed-in staff answers the phone); records the actor. Refuses partySize < 1, a table name that has never existed, a reservedFor that does not parse. A PAST reservedFor is allowed with no warning server-side (the host may be back-entering); the UI warns.
- `cancelReservation` and `markNoShow`: status transitions from `booked` only; both keep the row (states, not deletions).
- `seatReservation`: ONE command per spec §4: opens the check via the existing open path (covers = partySize, table = the reservation's table or a caller-supplied override), moves the reservation to `seated`, and when the caller confirmed a guest match, attaches that guest to the check via the existing attach path. Refuses if the reservation is not `booked`. If the target table already has an open check, this is the warn-and-allow case: the command takes `confirmOverride: true` to proceed onto a DIFFERENT caller-chosen table, but never seats two checks on one table (the existing open-check refusal stands; promise-not-lock means the HOST reroutes, not that the ledger doubles up).

### 3. Reads (computed, stored nowhere, per D19)
- `GET /v1/reservations?date=YYYY-MM-DD`: the book, time-ordered, with a covers total per service period (reuse the day boundaries reports already use) and past-due `booked` rows flagged.
- Phone match: the book read (and the seat command's response) carries `guestMatch` when the reservation's phone EXACTLY matches one guest (D20: exact, never fuzzy; attach is a human confirmation).
- `Engine.floor()` gains a derived `reserved` field per table: the earliest `booked` reservation within `now + reservationLeadMinutes`, carrying name/partySize/time. Derived at read, exactly like occupancy and the late flag.

## Invariants

A reservation NEVER hard-refuses a seating (E-5 default: warn-and-allow, audited). No new money math. No change to how a check opens beyond prefilled fields. Existing floor/checks/guestbook tests stay green.

## Tests to add

Book/cancel/no-show transitions (and refusals from wrong states); seat converts covers and table and attaches a confirmed guest atomically; seat refuses a non-booked reservation; phone match is exact (a differing digit misses); the floor badge appears inside the lead window and not outside it; a booking on a retired table still resolves; PG round trip incl. restart; replay idempotency; past-due rows flagged in the book read.

## File scope

In scope: `engine.ts`, `server.ts`, `types.ts`, both stores, migration `0010`, both test files. Out of scope: all pages (E23-T3), online booking anything, deposits, waitlist, SMS.

## Definition of done

Suite green, typecheck clean, demo note: a booking taken by curl, visible in the book and as a floor badge, seated into a real check with covers prefilled, and one no-show recorded. Update the E23-T2 row in `BACKLOG.md` to Implemented. **Run `git add` + `git commit` BEFORE ending the session** (three prior sessions ended with work uncommitted; the commit is part of the ticket).
