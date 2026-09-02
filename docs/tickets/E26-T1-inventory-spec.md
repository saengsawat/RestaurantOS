# Ticket E26-T1: Inventory specification (spec only, no code)

**Epic:** E26 inventory & ingredients (D34) · **Build model:** Sonnet or Codex (docs) · **Review tier:** standard, then FOUNDER review (Andy is the domain expert: 7 years in a restaurant, 3 as sous chef; his review gates the build, not Matt's)
**Status:** Ready. D22 batch: built in the same session as E24-T5, AFTER it, own commit.

## Session preamble

Read `CLAUDE.md`, `DECISIONS.md` (D34, D19, D14), `docs/prd/RestaurantOS_Operator_Console_PRD.md` (the Inventory concept this makes real), the 86/count mechanism (`set86`, `remaining` in engine.ts), the menu model (items, stations, modifier groups: a Protein modifier changes WHICH ingredient depletes), and the evidence-label discipline in `docs/prd/migration-spec.md`.

## What to write: `docs/prd/inventory-spec.md`

### 1. The founding scenario (the founder's own words, keep them)
Branzino al Forno sells well: each order uses one whole fish. Selling 12 must be comparable against fish on hand, or the kitchen runs out mid-service. Same at the bar with pours. The chef (a TITLE on a kitchen-permission person, per D28/D33) owns knowing what is in stock and what to order.

### 2. The model to propose
- **Ingredient**: name, unit (count, weight, volume), on-hand quantity, par level, station (kitchen vs bar decides whose list it lands on).
- **Recipe link**: menu item to ingredient with a quantity per serving (Branzino al Forno: 1 branzino; Negroni: 30ml each of three bottles). Modifier options can carry their own link (Protein: Shrimp depletes shrimp, not chicken). Where a dish has no recipe, it simply does not deplete: partial adoption must be useful, because nobody enters 200 recipes on day one.
- **Depletion is DERIVED, never stored** (D19 discipline): on-hand = counted baseline + receipts - the sum of fired quantities since the count. A physical count RESETS the baseline (reality outranks arithmetic; kitchens waste, spill, and comp). State clearly when depletion triggers: on kitchen FIRE, not on order entry and not on bump, with the reasoning.
- **The chef's two screens**: on-hand vs par ("what is low"), and the order list (below-par items grouped by supplier-later, station-now). Bar identical by station.
- **The 86 bridge**: when a recipe'd ingredient hits zero, PROPOSE the 86 on the affected menu items, never auto-86 (the chef may know a delivery just arrived; same warn-and-allow posture as reservations).

### 3. What v1 deliberately excludes (with reasons)
Supplier/vendor records and purchase orders; invoice scanning; food-cost dollars (needs ingredient prices: name it as the future tie to the Operator Console's Food Cost screen and STOP); waste-reason tracking beyond the count reset; multi-location transfers; barcode anything.

### 4. Questions FOR THE FOUNDER (not Matt), each with a shippable default
At minimum: unit granularity at the bar (bottle vs pour); who besides kitchen-level can count stock; whether prep items (a sauce made from ingredients, then used by dishes) are v1 or v2 (recommend v2, one level of links first); when the daily count happens; whether receiving is a quick add or a structured delivery record.

### 5. Data sketch + build shape
Schema sketch in D14 conventions, expand-only; the honest build estimate (likely: one Opus core ticket, one Sonnet UI ticket, one migration).

## Invariants

Spec only, no code. Evidence labels on every claim. No dollars anywhere in v1. En dashes only in numeric ranges.

## Definition of done

The spec reads in the repo's voice, the founder-question table has defaults, `BACKLOG.md` E26-T1 row updated to Implemented. **Commit before ending the session.**
