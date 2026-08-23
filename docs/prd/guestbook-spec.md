# RestaurantOS Guestbook: specification

**Status:** Draft v0.1, 2026-08-23 (E20-T1). Spec only: no code, no migration, no UI in this ticket. Privacy answers marked `UNKNOWN` are Matt's (deck C in the operator session guide).
**Decisions it obeys:** D20 (identity ladder: manual, then phone, then card fingerprint after E13), D2 (integrate payments, never store PAN), D19 (reports are read-only projections over the ledger, nothing stored), D14 (schema conventions).
**Evidence labels:** `DOCUMENTED` (research reports, provider docs), `OBSERVED` (founder or operator said it, or a competitor product showed it), `INFERRED` (our reasoning), `UNKNOWN` (needs Matt or the pilot).
**Companions:** `docs/prd/RestaurantOS_POS_PRD.md` (product definition), `docs/domain/schema.sql` (the tables this joins to), `docs/prd/RestaurantOS_Operator_Console_PRD.md` (the Phase 6 blueprint this joins), master plan §7.2 epic E20.

---

## 1. Why

Regulars are the business: a full-service house lives on the guests who come back, and the server who knows the usual sells more and serves better ("the corner two-top, Barolo, no shellfish"). Today RestaurantOS knows tables, checks, and money, and knows nothing about the person, so every regular arrives as a stranger and the knowledge lives in one server's head until they quit. The guestbook is the smallest thing that fixes that: a guest record the staff can attach to a check, and a profile computed from the ledger we already write. It is also the next rung of the Phase 6 intelligence ladder (Observe, then Explain, then Recommend): Observe is the profile, Explain is "this table's average check is 40% above the room", Recommend is "seat them in Sala with Gia and open the Barolo". Nothing here changes how service runs, and nothing here is a loyalty program.

**What the competitor showed** `OBSERVED` (founder reviewed Lightspeed Restaurant's Guestbook): per-guest profiles with popular items, total and average spend, visit history, staff notes, and percentile rankings of a guest against the rest of the guest base. That feature set is the target; the mechanisms below are ours.

## 2. Guest entity proposal

A sketch in the schema's own conventions (D14: client-generated UUIDs, `org_id` and `location_id` on every operational table, `timestamptz` in UTC, TEXT plus CHECK instead of enums). This is not a migration; E20's build ticket writes one, expand-only, when the founder schedules it.

```sql
-- The person. Identity only: no money, no counts, no aggregates.
CREATE TABLE guest (
  id                UUID PRIMARY KEY,
  org_id            UUID NOT NULL REFERENCES organization(id),
  location_id       UUID NOT NULL REFERENCES location(id),
  display_name      TEXT NOT NULL,              -- what the check header shows
  phone             TEXT,                       -- nullable: the v1 lookup key
  email             TEXT,                       -- nullable, marketing only
  notes             TEXT,                       -- staff-authored, free text
  marketing_opt_in  BOOLEAN NOT NULL DEFAULT false,
  created_by        UUID NOT NULL REFERENCES employee(id),  -- audit parity with every other table
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_guest_phone ON guest (location_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_guest_name  ON guest (location_id, display_name);

-- The attachment. A check carries zero or more guests, a guest has many checks.
CREATE TABLE check_guest (
  check_id     UUID NOT NULL REFERENCES checks(id),
  guest_id     UUID NOT NULL REFERENCES guest(id),
  attached_by  UUID NOT NULL REFERENCES employee(id),
  attached_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (check_id, guest_id)
);
```

Two tables, and that is the whole write surface today. Two conditional additions are named where they belong rather than smuggled in here: the fingerprint table below, which arrives with E13, and a small `guest_allergen` tag table (guest_id, allergen, added_by) if Matt confirms the C5 default in §5, since an allergen that pre-flags an order has to be structured data and not prose in `notes`. Everything a profile shows is a join away through the existing ledger: `guest` to `check_guest` to `checks`, then out to `order_item` (favorites), `payment` (spend and tips), `party` and `dining_table` and `dining_area` (preferred section), and `employee` (preferred server, truthful since E19-T1 started stamping `checks.server_id` from the device session).

**Never any card data.** `DOCUMENTED` [D2] No PAN, no expiry, no cardholder name from a card, not in these tables and not anywhere else. When automatic recognition arrives it stores the payment provider's opaque fingerprint token and nothing else, in a separate table added with E13, so the guest record itself stays free of payment material:

```sql
-- E13 only, sketched here so the shape is agreed in advance
CREATE TABLE guest_card_fingerprint (
  id             UUID PRIMARY KEY,
  guest_id       UUID NOT NULL REFERENCES guest(id),
  provider       TEXT NOT NULL,          -- 'stripe' | 'adyen', per ADR-3
  fingerprint    TEXT NOT NULL,          -- the provider's opaque token, never a card number
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, fingerprint)
);
```

**Why the attachment hangs off the check, not the party** `INFERRED`: the check is what carries the lines and the money, so spend and favorites derive with one fewer hop, and a split party keeps each guest with the check they actually ordered and paid on. The cost is that a guest who moves from the bar to a table looks like two visits unless the checks merge. Known trade-off, cheap to revisit: a `party_guest` table can be added later without touching what is written here.

## 3. Identity ladder (D20)

| Rung | Available | How the guest gets identified | Depends on |
|---|---|---|---|
| **v0 manual attach** | With E20's first build | Server opens the check's More menu, searches by name or phone, and attaches, or quick-creates a guest from one field (a name) in under five seconds | Nothing beyond the two tables |
| **v1 phone lookup** | Next | Phone typed at reservation or seating; exact match attaches, no match offers quick-create. A reservations integration (P2, integrate never build) hands us the phone for free | v0 |
| **v2 automatic recognition** | After E13 | On payment, the provider returns a stable fingerprint for the card; a match **proposes** the guest on the check and a human confirms | E13 + ADR-3 `INFERRED` (mechanism) |

Two rules the ladder never breaks. First, attaching is always a human act or a human confirmation: silent recognition is how a POS ends up telling a server that the guest at table 5 is somebody else's ex-wife. Second, a rung never becomes the only way in; manual attach stays available forever, because a guest who paid cash still has a name.

**The merge problem** (named, not solved here). The same person will end up with two records: Maria from a reservation phone number, and Maria M. created by a server on a busy Friday, and later a third from a card fingerprint. `INFERRED` V0 does no automatic dedupe: matching people is exactly where an automatic system does damage. The build gets a manager-gated **Merge guests** action that repoints `check_guest` rows to the surviving id, appends the losing record's notes rather than dropping them, and records who merged what. Merging cannot move money: history is a join, not a copy, so the ledger is untouched and every check keeps its own totals. Unmerging is manual (attach the checks back), which is the honest cost of a destructive action; the alternative, a reversible merge table, is not worth its complexity in V1. `UNKNOWN` whether Matt wants a suggestion list ("these two look like the same person") at all; default is no suggestions in the first build.

## 4. Profile screen contents

Everything on the profile is **derived on read and never stored**, the same rule E19 proved for the day report and the insights projections (D19). One consequence worth stating: a guest's history cannot drift from the money, because it is the money, read through a join. `INFERRED`

| Field | Derivation | Notes |
|---|---|---|
| Favorites | Top menu items by count over non-voided `order_item` on the guest's closed checks, ties broken by most recent | Voided lines never count, as everywhere else |
| Total spend | Sum of the guest's share of each closed check, computed by the domain's own money functions | Never a stored running total |
| Average spend | Total spend over visits | Display math |
| Visits and cadence | Count of distinct closed checks, distinct service dates, and the median gap between visit dates | Cadence is what turns "good guest" into "overdue guest" |
| Last visit | Latest `closed_at` on an attached check | |
| Preferred section | Mode of the dining area over the guest's checks (via `party.table_id`) | |
| Preferred server | Mode of `checks.server_id` | Truthful since E19-T1 |
| Tip percent average | Payment tips over net per check, averaged | Percent of NET, so a discount does not flatter the guest |
| Allergen tags | The guest's `guest_allergen` tags, pre-flagged onto the order and the kitchen ticket | Safety feature, not a note. Conditional on C5 in §5 |
| Notes | Staff-authored free text, the only stored thing on this screen | |
| Percentile rank | Optional polish: the guest's spend and visit count against the rest of the guest base, Lightspeed style `OBSERVED` | Recommend hiding it until roughly 30 guests exist; a percentile over five guests is noise |

**Spend attribution when a check has several guests** `UNKNOWN` (Matt). Recommended default: with one guest attached, the check's total is that guest's spend. With several, split the check with the E11 `splitCheck` allocators (by seat where the lines carry seats, evenly otherwise) and label the visit "shared check" on the profile, so per-guest spend still sums to the check total to the cent instead of double counting the same money on four profiles.

## 5. Privacy and policy questions for Matt

These go to the operator session as **deck C**, each with a recommended default so the absence of an answer never blocks the build. Local law is its own `UNKNOWN`: if the pilot venue sits under GDPR or CCPA-style rules, these defaults need a lawyer's read before the guestbook ships, not after.

| # | Question | Recommended default |
|---|---|---|
| C1 | What does the guest know about the record? | Staff-facing only, no guest-facing surface in V1, and a manager can read a record back to the guest who asks. The record holds only what the guest handed over or what the restaurant observed in its own service |
| C2 | Is consent asked before creating a record? | No prompt for service records (a paper reservation book is the same artifact), explicit opt-in for any marketing use (C6) |
| C3 | How long is a record kept? | 24 months after the last visit, then identity fields purge automatically. The checks stay in the ledger, unattributed: money history must survive, identity need not |
| C4 | Who on staff can see the notes? | All service staff see service notes, because a note only helps if the server on the floor can read it. Anything sensitive belongs in a manager-only field, which the first build does not have, so the policy line is "if you would not say it in front of the guest, do not type it" |
| C5 | Do we allow health and allergy notes? | Yes as **structured allergen tags** (they pre-flag the order and the kitchen ticket, and that safety value is real), no as free prose about a person's medical history. The tag says "shellfish", not "diabetic since 2019" |
| C6 | Does marketing use require opt-in? | Yes, per record, captured by a human, never inferred from a phone number given for a reservation. `marketing_opt_in` defaults to false in the schema for exactly this reason |
| C7 | What happens on a deletion request? | A manager Delete action clears identity fields and drops the guest's `check_guest` rows within the same service day. The checks themselves are never deleted; they simply stop pointing at a person |

## 6. Dependencies and sequencing

| Dependency | What it gates | State |
|---|---|---|
| E13 payments + ADR-3 | The v2 automatic-recognition rung only, and the fingerprint table with it | Waits on Matt (D6 gates ADR-1/2, ADR-3 is its own conversation) |
| E19 insights | The read-on-demand projection pattern this reuses, and `checks.server_id` attribution that makes "preferred server" true | Landed 2026-08-23 |
| Reservations (P2) | Free phone numbers for the v1 rung; not required for it | Integrate, never build |

**Out of V1 pilot scope**, unless Matt disagrees. The pilot question is "can this restaurant run every dinner service and close every night", and a guestbook does not move that answer. Sequencing we recommend: this spec now; the two tables plus manual attach when the pilot is stable or when Matt asks for it first (he may: a full-service operator recognizes regulars as the whole point); phone lookup alongside reservations; automatic recognition only after E13 lands and only as a proposal a human confirms.

**Shape of the build when it comes** `INFERRED`, so the estimate is honest: one expand-only migration (two tables, three indexes), one attach flow on the check's More menu plus a search read, one derived profile read (`GET /v1/guests/:id`) computed exactly like the insights endpoints, and one manager-gated merge and delete. No stored aggregates, no new money math, no change to any existing table.
