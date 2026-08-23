# Ticket UI-T2: Menu category rail on Service

**Epic:** POS UI · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard
**Status:** Ready after UI-T1 (same batch, own commit).

## Context (founder)

The live Service screen lists every menu item in one scroll with course headers. Fine for 7 demo items, useless for a real 80-item menu. The mockup's Service screen has a category rail on the left of the menu area (Antipasti, Insalate, Pizza, Primi, ...) and shows one category's tiles at a time. That is the spec.

## What to build (`app/server/public/pos.html` only)

1. A category rail between the checks rail and the menu tiles, mockup-style: one entry per COURSE present in the live snapshot (the data model's grouping today: Beverage, Antipasti, Primi, Secondi, Dolci), with the mockup's sub-labels where they apply (course number; "fires immediately" for beverages). Selecting a category shows only its tiles; the first category with items is selected on load.
2. The 86 badges, sold-out states, and modifier modal behave exactly as today; tile markup unchanged.
3. Mobile ≤820px: the rail becomes a horizontal chip row above the tiles (a vertical rail does not fit a phone).
4. When the snapshot version changes mid-service (menu publish), the rail rebuilds and keeps the selected category if it still exists.
5. Note in a code comment: the rail reads courses today; when E5-full lands real menu categories, the rail reads those instead. Do not invent a category model here.

## Invariants

Tokens, 44px, press feedback, Day/Night, no behavior change to ordering itself.

## Tests

Page-serve assertion that the rail markup exists; existing order-flow tests stay green.

## Definition of done

Suite green, script parses, screenshots or an honest note. Update the UI-T2 row in `BACKLOG.md` to Implemented. Then proceed to UI-T3.
