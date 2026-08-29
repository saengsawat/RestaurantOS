# RestaurantOS Reservations: specification

**Status:** Draft v0.1, 2026-08-28 (E23-T1). Spec only: no code, no migration, no UI in this ticket. Answers marked `UNKNOWN` are Matt's (deck E in the operator session guide).
**Decisions it obeys:** D27 (a reservation is a promise, not a lock; v1 is the staff-entered call-in book; online booking is integrate-never-build pending Matt), D20 (the identity ladder: manual attach, then phone lookup, then card fingerprint after E13), D19 (reads are projections, computed and never stored), D14 (schema conventions).
**Evidence labels:** `DOCUMENTED` (research reports, PRD, our own shipped code), `OBSERVED` (founder or operator said it, or a competitor product showed it), `INFERRED` (our reasoning), `UNKNOWN` (needs Matt or the pilot).
**Companions:** `docs/prd/RestaurantOS_POS_PRD.md` (product definition, the P2 scope line this partially carves out), `docs/prd/guestbook-spec.md` (the phone rung this feeds), `docs/domain/schema.sql` (the tables this joins to), master plan §7.2 epic E23, `DECISIONS.md` D27.

---

## 1. The design principle: a reservation is a promise, not a lock

A reservation is a restaurant saying "we will have a table for you at 7:30." It is not the software saying "this table is now unavailable." The difference matters because the host is the only one who can see the room: the four-top at 7:30 is lingering over dessert, the two-top by the window just left, the party of six that booked has walked in as four. A POS that enforces a booking as a constraint makes the host fight the software during the exact ten minutes they have no attention to spare. `INFERRED`

So the rule, all the way down: **the floor shows the promise, and the host's judgment always wins.**

- As the hour approaches, the table carries a badge on the Tables screen: `Reserved 7:30 · Somchai, party of 4`. That is information, placed where the host already looks.
- Seating someone else there **warns and allows**. One line, one confirm, and the check opens: "Table 12 is held for Somchai at 7:30, in 20 minutes. Seat anyway?" The reservation stays booked and unattached, still visible in the book, because the host may well be planning to move it.
- Nothing is ever a hard refusal. There is no state in which the software tells a host they may not seat a guest. `INFERRED`

This is the posture the product already takes everywhere human authority is involved: the manager-PIN void asks for an approval rather than forbidding the act, and a closed business day can be reopened. RestaurantOS records what happened and who decided; it does not decide. `DOCUMENTED` [PRD §4, the void-approval and reopen-close flows]

**Where this sits against the PRD's scope model.** The PRD marks reservations and waitlist **P2, integrate, do not build** `DOCUMENTED` [PRD §3, and the Toast report's P2 row at line 201]. D27 does not overturn that line, it splits it. The half the incumbents' integrations do not really cover, a staff member writing down a phone call, is one table and a badge on a screen we already draw. The half that is a genuine product surface, public online booking, stays P2 and unbuilt. `DOCUMENTED` [D27]

## 2. V1 scope: the call-in book

Everything in v1 is something a staff member does at a terminal, because the input is a person on the phone.

**Taking a booking.** Name, phone, party size, and a time, plus an optional table and an optional note ("anniversary", "wheelchair", "regular, likes Sala"). Only the time and the party size are required to save: a call from someone who will not give a name is still worth writing down. `INFERRED`

**The book view**, by service period, one day at a time. Reservations in time order with a covers total per period, so the host can see that Friday's second seating is already at 40 covers before a single walk-in arrives. Past-due bookings that were never seated stay visible until somebody marks them, because a reservation that quietly disappears at 7:31 is how a no-show goes unrecorded. `INFERRED`

**Floor badges inside a lead window.** A table shows its reservation only once the booking is close enough to matter; earlier than that it is noise on a table currently serving someone else. Default lead window **45 minutes**, held as a venue setting rather than a constant. `UNKNOWN` (Matt, deck E-2). The 45 is a guess at "long enough to stop seating a two-hour party there, short enough that a lunch booking does not decorate the floor all morning."

**Seating converts the reservation into the check.** The host taps the reservation, from the badge or from the book, and the ordinary open-check flow runs with **covers prefilled from the party size** and the table prefilled where one was assigned. The reservation moves to `seated` and stops badging the floor. This is the whole reason the book belongs in the POS rather than beside it: the party size was already typed once, and covers drive the per-cover math on every report downstream. `INFERRED`

**The guestbook's phone rung gets its data for free.** When the reservation's phone exactly matches an existing `guest`, seating offers that guest for attach, the same attach a server does by hand from the check's More menu today; no match offers the same quick-create the guestbook build already has. This is precisely the **v1 phone lookup** rung of the D20 ladder, which the guestbook spec expected to arrive when "a reservations integration (P2, integrate never build) hands us the phone for free." `DOCUMENTED` [guestbook-spec.md §3] The call-in book hands it to us instead, out of our own data, which is a better trade than an integration we do not have. The ladder's two rules still hold: the match is exact, never fuzzy, and the attach is a human confirmation rather than a silent binding. `INFERRED`

**No-show and cancel are one tap each**, and both are states on the reservation rather than deletions, because the reason to record a no-show is that it happened. Both write an `audit_event` with the actor and the time like every other mutation in the system (D14 conventions), so "who cancelled the eight-top" has an answer on Monday. `INFERRED`

## 3. What v1 deliberately excludes

| Excluded | Why, and what happens instead |
|---|---|
| **Online booking**: a public reservation page, deposits taken at booking, SMS confirmations and reminders, and the no-show economics that come with them | A real product with real surface area: a public web presence, a payment flow, a messaging provider, and cancellation-policy logic. It is also the half of the problem that already has strong incumbents. Ours is **integrate, never build, pending Matt**. `DOCUMENTED` [D27] |
| **Waitlist management**: the walk-in queue, quoted wait times, "your table is ready" texts | Adjacent but a different problem. The waitlist is about people already standing in the room, and most of its value is the messaging layer we just declined to build. Named so it reads as a deliberate omission rather than an oversight; the PRD groups it with reservations at P2. `DOCUMENTED` [PRD §3] |
| **Deposits and card holds for large parties** | Needs E13 (real payments) and ADR-3 to exist at all, so it is E13-gated at best. Holding a card against a booking also means a stored provider token, which is a D2 policy conversation rather than a feature. `INFERRED` |

**The incumbent landscape, named honestly.** Toast fields a first-party reservations and waitlist product (Toast Tables) bundled with its own POS, which is the build-it-yourself answer. `INFERRED` (that a first-party product exists; we have not reviewed it, and the Toast research report treats reservations as an integration question rather than documenting Toast's own offering `DOCUMENTED` [Toast report lines 201, 615]). Lightspeed and Square more typically reach the same outcome by integrating the specialists, OpenTable and Resy, which own the diner-side demand that makes online booking worth anything at all. `INFERRED` A restaurant chooses OpenTable not for its table-management screen but because diners are already searching inside OpenTable, and that network is not a thing a POS startup builds. That, not engineering cost, is the actual reason ours is an integration. `INFERRED` Whether Matt's venue already lives on one of those platforms is `UNKNOWN` and is deck E's first question, because a venue on Resy needs us to not fight Resy far more than it needs a book of our own.

## 4. Data sketch

In the schema's own conventions (D14: client-generated UUIDs, `org_id` and `location_id` on every operational table, `timestamptz` in UTC, TEXT plus CHECK instead of enums). A sketch, not a migration; E23's build ticket writes one, expand-only, when the founder schedules it.

```sql
CREATE TABLE reservation (
  id            UUID PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organization(id),
  location_id   UUID NOT NULL REFERENCES location(id),
  guest_id      UUID REFERENCES guest(id),        -- nullable: set when a phone matches, or by hand later
  name          TEXT NOT NULL,                    -- what the book row and the floor badge show
  phone         TEXT,                             -- nullable, and the guestbook lookup key
  party_size    INTEGER NOT NULL CHECK (party_size > 0),
  reserved_for  TIMESTAMPTZ NOT NULL,             -- UTC, like every other timestamp
  table_id      UUID REFERENCES dining_table(id), -- nullable: a booking need not name a table
  status        TEXT NOT NULL DEFAULT 'booked'
                CHECK (status IN ('booked','seated','no_show','cancelled')),
  note          TEXT,
  created_by    UUID NOT NULL REFERENCES employee(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reservation_service ON reservation (location_id, reserved_for);
CREATE INDEX idx_reservation_table   ON reservation (table_id, reserved_for) WHERE table_id IS NOT NULL;
```

**`name` and `phone` live on the reservation, not only on the guest**, and the redundancy is deliberate. A booking taken over the phone is a fact about a call, and it has to be recordable in four seconds without creating a person record first. `guest_id` fills in when a match happens, or when someone attaches one later. `INFERRED`

**`table_id` points at a table that is soft-retired, never deleted.** E6's floor editor keeps the row on retirement precisely so `party.table_id` and closed checks keep pointing at something real, which means a reservation made on a table that gets retired between the booking and the night still resolves. `DOCUMENTED` [E6-T2, `Store.retireTable`]

**Nothing about "reserved soon" is ever stored on the table.** The badge is computed at read time from the book, the same way `Engine.floor()` already computes a table's occupancy from open checks and its late flag from open kitchen tickets instead of storing a status on the table. `DOCUMENTED` [`app/server/src/engine.ts`, `floor()`] The derivation is: the earliest `booked` reservation for this table whose `reserved_for` falls inside `now + leadWindow`. Same discipline, same reason. A stored status is a status that can be wrong; a derived one cannot drift from the book. `INFERRED`

**Seating is one command, not two.** `seatReservation(reservationId)` opens the check (the existing `openCheck` path, with covers and table prefilled), moves the reservation to `seated`, and attaches the matched guest if the host confirmed one, as a single operation, so a half-seated reservation cannot exist. It travels the same envelope, idempotency, and audit path as every other command. `INFERRED`

## 5. Questions for the Matt deck (deck E)

Appended to `docs/discovery/operator-session-guide.md` in the guide's existing deck format, each with the default we would ship so a shrug is still an answer.

| # | Question | Recommended default |
|---|---|---|
| E-1 | Does his venue live on OpenTable or Resy, on a paper book, or on the phone? | The phone and a paper book, which is exactly what the v1 call-in book is shaped for. If he is on OpenTable or Resy we still build the book (it costs little and feeds the guestbook), but the integration becomes the real question, and it stays integrate-never-build |
| E-2 | How long is a table held past its reserved time before it goes to the next party? | 15 minutes, and as a soft prompt on the book row rather than an automatic release. The separate lead window that governs floor badging defaults to 45 minutes before the time |
| E-3 | Are large parties handled differently? | Yes in practice, no in software for v1: a large party gets a note and the host's attention, not a booking type of its own. If he has a hard threshold (a party of eight needs a manager, or a deposit), that is a rule worth encoding, and the deposit half is E13-gated |
| E-4 | Does he take deposits, and for what? | No deposits in v1. If he takes them today we want to know whether it is a card hold or a real charge, because only one of those is a payments problem we can defer |
| E-5 | Who is allowed to overbook, or to seat over a held table? | Anyone on the floor, with the warn-and-allow confirm and an audit entry. Gating it behind a manager PIN would mean a host hunting for a manager mid-rush, which is the exact failure the promise-not-a-lock principle exists to prevent |

Also worth asking, because it decides whether the book is ever open on a busy night: **who actually answers the phone at 6pm, and are they standing at a terminal when they do?** A book nobody can reach during service is a paper book with extra steps.

## 6. Dependencies and sequencing

| Dependency | What it gates | State |
|---|---|---|
| E6 floor editor | The tables a reservation points at, and the Tables screen the badge lands on | Done 2026-08-28 |
| E20 guestbook | The phone-match attach on seating, and `guest_id` on the reservation | v0 done 2026-08-23 |
| E21 venue settings | Where the lead window and the hold-past-time minutes live as venue data rather than constants | Done 2026-08-28 |
| E13 payments + ADR-3 | Deposits and card holds only, none of which is in v1 scope | Waits on Matt |
| Matt (deck E) | Whether the venue is already on OpenTable or Resy, which decides whether the book is the useful half or the integration is | Pending |

**Out of V1 pilot scope** unless Matt asks for it first, on the same test the guestbook was held to: the pilot question is "can this restaurant run every dinner service and close every night," and a paper book answers reservations well enough for one restaurant. `INFERRED` It earns its build when the guestbook's phone rung starts to matter, because that is the point where the book stops being a book and becomes the thing that makes the house recognize a regular at the door.

**Shape of the build when it comes** `INFERRED`, so the estimate is honest: one expand-only migration (one table, two indexes), three commands (book, cancel-or-no-show, seat), one book read grouped by service period, one derived badge folded into the existing `floor()` projection, and the seating confirm dialog. No new money math, no change to any existing table, and no change to how a check opens beyond prefilling two fields that are already inputs.
