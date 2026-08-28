# Ticket E23-T1: Reservations spec (the call-in book)

**Epic:** E23 reservations (D27, spec first) · **Build model:** Sonnet (docs only) · **Review tier:** standard
**Status:** Ready. Docs only. Batchable with E22-T1 and E24-T1 in one Sonnet docs session (D22: own commit each).

## Session preamble

Read `CLAUDE.md` (no em dashes), `docs/prd/guestbook-spec.md` (the format and voice: evidence labels, a recommended default on every UNKNOWN), `DECISIONS.md` (D27), and the floor model in `app/server/src/types.ts` (FloorTable) plus how `/v1/floor` derives table status in `engine.ts` (you are describing a future state on that read, not building it).

## The deliverable: `docs/prd/reservations-spec.md`

1. **The design principle (D27): a reservation is a promise, not a lock.** The floor shows the promise as the hour approaches ("reserved 7:30 · Somchai, party of 4"), seating someone else there warns and allows, and the host's judgment always wins. Never a hard refusal.
2. **v1 scope, the call-in book**: staff-entered reservations (name, phone, party size, time, optional table, optional note), a book view by service period, floor badges within a configurable lead window (default 45 minutes, UNKNOWN for Matt), seating converts the reservation into the check (covers prefilled) and attaches the guestbook record when the phone matches (the D20 phone-lookup rung getting its data for free). No-show and cancel are one-tap states with the audit trail everything else gets.
3. **What v1 deliberately excludes**: online booking (public site, deposits, SMS reminders, no-show economics: name the incumbent landscape honestly, Toast Tables vs OpenTable/Resy integrations at Lightspeed, and mark ours "integrate, never build, pending Matt" per D27), waitlist management, and deposit-taking (E13-gated at best).
4. **Data sketch** in D14 conventions: a `reservation` table (id, org/location, guest_id nullable, name, phone, party_size, reserved_for timestamptz, table_id nullable, status booked/seated/no_show/cancelled, note, created_by, created_at) with the same derived-on-read discipline as everything else: the floor's "reserved soon" state is computed from the book, never stored on the table.
5. **Questions for the Matt deck (deck E)**, each with a recommended default: does his venue live on OpenTable/Resy, a paper book, or the phone; how long is a table held past its time; are large parties handled differently; does he take deposits; who is allowed to overbook.

Append deck E to `docs/discovery/operator-session-guide.md` in the existing deck format, and add one line to the Operator Console PRD's future-directions list.

## Definition of done

Spec in the PRD voice, evidence-labeled, a recommended default on every UNKNOWN; deck E landed; no em dashes; no code. Update the E23-T1 row in `BACKLOG.md` to Implemented.
