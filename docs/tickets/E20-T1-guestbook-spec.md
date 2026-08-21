# Ticket E20-T1: Guestbook specification (docs only, no code)

**Epic:** E20 Guestbook / guest intelligence · **Build model:** Sonnet · **Review tier:** standard; the orchestrator (Fable) reviews for domain and privacy soundness
**Status:** Ready (independent of all code tickets)

## Session preamble

1. Read `CLAUDE.md` (no em dashes), `DECISIONS.md` (D20 sets the identity ladder this spec must follow), `docs/prd/RestaurantOS_Operator_Console_PRD.md` (the Phase 6 blueprint this joins), `docs/domain/schema.sql` (sections 3 and 6: party, checks, order_item; there is NO guest table today), and `docs/discovery/operator-session-guide.md` (where the privacy questions land).
2. This ticket produces ONE document and small cross-references. No code, no schema migration, no UI.

## Context

Founder reviewed Lightspeed Restaurant's Guestbook: per-guest profiles showing popular items, total/average spend, visit history, notes, percentile rankings against other guests. He wants the equivalent for RestaurantOS: know a guest's favorite dishes, spend, preferred section and server. Nothing in our schema models a guest yet, and automatic recognition (Lightspeed matches returning card fingerprints) depends on the payment provider integration (E13/ADR-3), which waits on a decision with Matt. Decision D20 therefore sets an identity ladder: manual attach first, phone lookup second, card fingerprint automatic once E13 lands.

## Deliverable: `docs/prd/guestbook-spec.md`

Sections required:

1. **Why** (3-5 sentences): the operator value (regulars are the business; a server who knows the guest's usual sells more and serves better), and how this feeds the Phase 6 intelligence ladder (Observe -> Explain -> Recommend).
2. **Guest entity proposal** (schema sketch, not a migration): `guest` (id, org, location, display_name, phone nullable, email nullable, notes, created_at, marketing_opt_in boolean) and `check_guest` (check_id, guest_id, attached_by, attached_at) so a check can carry zero or more guests and history derives from the existing ledger by join. Explicitly: NO card numbers ever (D2); the future card link stores only the provider's opaque fingerprint token, in a separate table added with E13.
3. **Identity ladder per D20**: v0 manual (server attaches a guest to the check by name/phone search or quick-create), v1 phone lookup at reservation/seating, v2 automatic card-fingerprint match post-E13, with the guest merge problem (same person, two records) named as a known issue.
4. **Profile screen contents**, derived (never stored): favorites (top items by count from order history), total and average spend, visit count and cadence, last visit, preferred section and server (mode over history), tip percent average, notes (free text, staff-authored). Percentile framing like Lightspeed's scorecard is optional polish.
5. **Privacy and policy questions for Matt** (these go verbatim into a new deck in `docs/discovery/operator-session-guide.md`): what does the guest know about the record; is consent asked; retention period; who on staff can see notes; do we allow health/allergy notes (safety value vs sensitivity); does marketing use require opt-in; what happens on a deletion request. Frame each with a recommended default so nothing blocks.
6. **Dependencies and sequencing**: E13 for auto-recognition; E19 established the read-only projection pattern this reuses; explicitly out of V1 pilot scope unless Matt disagrees.

Cross-references to update: one line in `docs/prd/RestaurantOS_Operator_Console_PRD.md` linking the spec as a Phase 6 addition sourced from competitor observation (Lightspeed); the new question deck in the session guide; the E20-T1 row in `BACKLOG.md` to Implemented.

## Writing rules

Match the existing PRD voice: short sections, tables where they help, every UNKNOWN carries a recommended default, evidence labels (OBSERVED for what the Lightspeed video showed, INFERRED for mechanism guesses like card fingerprints). No em dashes.

## Definition of done

The spec file exists and reads clean; the two cross-references are in place; no other file touched.
