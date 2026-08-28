# Ticket E22-T1: Migration spec (moving a restaurant off its old POS)

**Epic:** E22 migration/onboarding (D26, spec first) · **Build model:** Sonnet (docs only) · **Review tier:** standard
**Status:** Ready (independent; fits any gap). Docs only: no code, no migration files, no UI.

## Session preamble

Read `CLAUDE.md` (no em dashes), `docs/prd/RestaurantOS_POS_PRD.md` (voice and evidence labels: DOCUMENTED/OBSERVED/INFERRED/UNKNOWN), `docs/prd/guestbook-spec.md` (the format this follows), and skim `docs/research/Toast-deep-research-report.md` + `Square-deep-research-report.md` for migration/onboarding mentions (the Toast report names migration tooling as an open question at ~line 641).

## The deliverable: `docs/prd/migration-spec.md`

1. **Why**: a restaurant switching POS brings a menu, a staff roster, a room, and fear of losing history. Onboarding friction is a sales blocker; the incumbents solve it with spreadsheet imports plus onboarding humans.
2. **What migrates, per object**, each with the v1 mechanism and evidence labels:
   - Menu: a CSV template (columns: name, course, price, station, modifier group hints) imported into the EXISTING draft-then-publish flow (nothing bypasses the immutable snapshot rule). Note what Toast/Square/Lightspeed menu exports actually contain, labeled honestly (OBSERVED/INFERRED; UNKNOWN where we have no export file in hand).
   - Staff: a CSV of names and roles; PINs are always issued fresh (never imported, never asked for).
   - Floor: redrawn in our own editor (E6-full), matching incumbent practice; geometry does not import.
   - Guests: phone/name lists CAN import into the E20 guestbook (manual-attach rung); flag the consent question.
3. **What deliberately does NOT migrate in v1**, with rationale: sales history (belongs to the old system's books; our reports start at day one), gift card liabilities (a legal/financial transfer, not a data import), loyalty balances, card fingerprints (D2: provider tokens are not portable).
4. **The import discipline**: every import lands as a DRAFT a manager reviews and publishes; imports are idempotent (re-running one never duplicates); every imported row carries its source for audit.
5. **Questions for the Matt deck (deck D)**: what data would he refuse to lose in a switch; who does the data entry today; would he trust a self-serve import or want a human; how long can setup take before it kills the sale. Each with a recommended default. Append deck D to `docs/discovery/operator-session-guide.md` in the guide's existing format, and add one cross-reference line to the Operator Console PRD's future-directions list.

## Definition of done

Spec reads in the PRD voice with evidence labels and a recommended default on every UNKNOWN; deck D landed in the session guide; no em dashes; no code. Update the E22-T1 row in `BACKLOG.md` to Implemented.
