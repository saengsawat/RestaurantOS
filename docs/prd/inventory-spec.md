# RestaurantOS Inventory and Ingredients: specification

**Status:** Draft v0.1, 2026-09-03 (E26-T1). Spec only: no code, no migration, no UI in this ticket. **The founder is the domain reviewer for this one** (7 years in a restaurant, 3 as sous chef); his sign-off gates the build, not Matt's `DOCUMENTED` [D34].
**Decisions it obeys:** D34 (inventory goes spec-first, ingredient-level stock with per-serving recipe links, depletion computed from kitchen fires, ties into and never replaces the existing 86 board), D19 (reads are projections, computed and never stored), D14 (schema conventions), D28 (job TITLE is vocabulary, permission is the enum: the "chef" is a title on a kitchen-level person), D33 (the kitchen permission level this lands on).
**Evidence labels:** `DOCUMENTED` (our own shipped code, the PRDs, a decision), `OBSERVED` (the founder or an operator said it), `INFERRED` (our reasoning), `UNKNOWN` (needs the founder's answer, or the pilot).
**Companions:** `docs/prd/RestaurantOS_Operator_Console_PRD.md` §6.4 (the Inventory and Purchasing concept this makes real), `docs/prd/RestaurantOS_POS_PRD.md`, `docs/domain/schema.sql` (`menu_item`, `prep_station`, `order_item`, `kitchen_ticket`), `app/server/src/engine.ts` (`set86`, `remaining`, the fire path), master plan §7.2 epic E26, `DECISIONS.md` D34.

---

## 1. The founding scenario

**Branzino al Forno sells well, and each order uses one whole fish.** `OBSERVED` (the founder) If the house sells twelve of them, that has to be comparable against the fish actually in the walk-in, or the kitchen finds out it has run out in the middle of service, which is the worst possible moment to learn it. The same shape of problem sits at the bar, where a Negroni is three pours out of three bottles and nobody notices the gin going until it is gone.

The person who owns this is the chef: knowing what is in stock and what has to be ordered is their job, not the manager's and not the owner's. `OBSERVED` "Chef" here is a **title** on somebody whose permission level is kitchen, which is the D28 rule doing exactly the work it was written for: the room calls them Chef, the software knows them as kitchen. `DOCUMENTED` [D28, D33]

What the system already knows, and has known since E8: **exactly what was fired, when, and how many.** `DOCUMENTED` [`engine.ts`, the fire path and `kitchen_ticket`] Every dispatch to the kitchen is a real event with a real timestamp and a real quantity, captured while service happened rather than reconstructed afterwards. Inventory is that fact joined to one new fact, how much of what a dish consumes, and nothing more. This is the same posture the labor rung took: we own the data we capture honestly, and we do not invent the parts we cannot see. `INFERRED`

## 2. The model

### 2.1 Ingredient

A thing the house buys and holds.

| Field | Meaning |
|---|---|
| `name` | "Branzino", "Gin", "Rice noodles". What the chef writes on the order list |
| `unit` | How it is COUNTED: `count`, `weight`, or `volume`, with the concrete unit beside it (each, lb, kg, ml, L) |
| `parLevel` | The level the house wants to be at. Below this it goes on the order list |
| `station` | Kitchen or bar. This decides whose list it lands on, and it reuses the station key the menu already carries `DOCUMENTED` [`MenuEntry.station`] |

**On-hand is not a field.** It is derived, and §2.3 is the whole of why.

### 2.2 The recipe link

One row saying **this menu item consumes this much of this ingredient, per serving**. Branzino al Forno consumes 1 branzino. A Negroni consumes 30ml of each of three bottles.

**A modifier option can carry its own link.** `INFERRED` The menu model already lets a Protein group swap what is on the plate `DOCUMENTED` [`GROUPS`, `modifierGroupIds`], and a Pad Thai with shrimp depletes shrimp rather than chicken. Without this the whole model is wrong for exactly the dishes that sell most, because a protein choice is the commonest modifier in a restaurant. The link therefore attaches to either a menu item or a modifier option, and a fired line consumes the union of both.

**A dish with no recipe simply does not deplete.** This is the load-bearing design rule of the entire feature, not a limitation of it. Nobody enters two hundred recipes on day one; a chef enters the six things that run out and cost money, and the other hundred and ninety-four dishes carry on working exactly as they do today. `INFERRED` A feature that only pays off after a week of data entry is a feature that never gets switched on, which is the same reasoning that made the menu import worth building. Partial adoption has to be useful on the first afternoon: link the branzino, count the branzino, and the system is already earning its place.

### 2.3 Depletion is derived, never stored

```
on-hand = the last counted baseline
        + everything received since that count
        - everything fired since that count, at recipe quantities
```

Every term is a row that already exists or is appended once and never edited, so the number can be recomputed from scratch at any moment and can never drift from the events underneath it. `DOCUMENTED` [D19, and the same discipline the day report, the floor's occupancy, and the labor read already use]

**A physical count RESETS the baseline, and reality outranks arithmetic.** `INFERRED` Kitchens waste, spill, drop, comp, eat, and give away, and none of that passes through a POS. A stored on-hand number would quietly diverge from the walk-in a little more every day until nobody trusted it, which is how inventory modules end up switched off in real restaurants. So the count is not a correction to the system's number; it IS the number, and everything after it is arithmetic on top. When the chef counts nine fish, there are nine fish, whatever the ledger thought.

**Depletion triggers on kitchen FIRE.** Not on order entry, not on bump. The reasoning, in the order it matters:

- **Not order entry**, because an unsent line is not food. It can be voided, moved to another check, merged, or abandoned when the party changes their mind, and nothing has left the walk-in. `INFERRED`
- **At fire**, because that is the moment the ticket reaches the pass and the fish goes in the oven. It is also the moment the system already records as a first-class event with a quantity and a timestamp, so the projection has something exact to sum rather than something inferred. `DOCUMENTED` [E8, `ORDER_DISPATCH`]
- **Not on bump**, for two reasons. A bump says the plate is finished and leaving the pass, which is later than the fish was committed, and the KDS lets a cook un-bump a card with a second tap `DOCUMENTED` [flagship prototype and `/kds`], while stock is not a thing you can un-cook.
- **A void AFTER a fire returns nothing.** The food was made. Comping a dish is a money decision, not a stock one, and quietly crediting a fish back to the walk-in would be the system telling the chef a lie it would have to correct at the next count anyway. `INFERRED` (This one is worth the founder's explicit ruling: see G-6.)

### 2.4 How this sits beside the 86 board, which already exists

The live 86 board holds a per-item `remaining` count that a manager types ("six branzino left"), and that count **decrements at order entry**, not at fire. `DOCUMENTED` [`engine.ts`, `addItem`: `remaining - quantity`, and `is86: remaining === 0`]

That is not an inconsistency to fix. The two numbers answer different questions:

| | The 86 board's count | Ingredient on-hand |
|---|---|---|
| Question | May a server still sell this? | What is physically in the room? |
| Moves at | Order entry | Kitchen fire |
| Set by | A human typing a number | A count, plus receipts, minus fires |
| Why then | Two servers must not sell the same last portion, so the gate has to bite the moment the item is committed to a check | The fish leaves the walk-in when the pass cooks it |

They are allowed to disagree, and the size of the disagreement is exactly the quantity ordered but not yet fired. That gap is a real fact about a restaurant at 8pm, not a bug. `INFERRED`

## 3. The chef's two screens

Both are reads, both filter by station, and the bar gets the identical mechanism with bar-station ingredients rather than a second feature. `INFERRED`

**What is low.** Every ingredient with a recipe, on-hand against par, sorted by how far under par it is. This is the screen the chef opens at 3pm. It carries the count action, because the moment you notice a number is wrong is the moment you want to fix it, and fixing it is counting.

**The order list.** Everything below par, with a suggested quantity of par minus on-hand, grouped by station now and by supplier when suppliers exist (§4). It is a list to read off while on the phone to a purveyor, so it prints and it copies, and it carries no money at all. `INFERRED`

**Entering a count** is the one thing that has to be fast enough to do while standing in a walk-in holding a clipboard: a list of that station's ingredients, one number per line, one save. A count is an append, never an edit `DOCUMENTED` [D14 conventions], so last Tuesday's count survives being wrong and the record of who counted survives with it.

**Receiving** is the mirror: what arrived, how much, added to the running total since the last count. Whether that is a quick add or a structured delivery record is G-5.

## 4. The 86 bridge: propose, never impose

When a recipe'd ingredient reaches zero, the system **proposes** the 86 on every menu item whose recipe depends on it, naming them, and a human takes it or leaves it. It never 86s anything by itself. `DOCUMENTED` [D34]

This is the reservations posture generalized: the software says what it knows once, and the person who can see the room decides. `DOCUMENTED` [D27, reservations-spec §1] The chef may know a delivery landed twenty minutes ago and has not been received into the system yet, or that there is enough trim for two more covers, or that the dish can be plated with something else tonight. A POS that closes a dish on the strength of its own arithmetic will be wrong in front of a full dining room, and the chef will remember it. `INFERRED`

Note the deliberate asymmetry with the existing board, which DOES auto-86 at zero `DOCUMENTED` [`engine.ts`, `is86: remaining === 0`]. That is correct there and wrong here: the board's zero is a human's own typed instruction reaching its end, and honouring it is obeying the person. An ingredient zero is a calculation, and a calculation does not get to close a dish. `INFERRED`

## 5. What v1 deliberately excludes

| Excluded | Why, and what happens instead |
|---|---|
| **Suppliers, vendors, and purchase orders** | A purchase order is a document sent to another company with terms, units, and an expectation of a delivery against it, which makes it a small B2B product rather than a screen. V1 produces a LIST a chef reads off while on the phone, which is what most independent restaurants actually do. Ingredients group by station now; a `supplier` column is the natural expand later `INFERRED` |
| **Invoice scanning and receiving against an invoice** | OCR over a purveyor's fax-quality invoice is a machine-learning product with its own failure modes, and a wrong number entered confidently is worse than a number a human typed. `INFERRED` Receiving is a person saying what arrived |
| **Food-cost dollars** | Costing needs a price per ingredient, and the moment ingredients carry prices this stops being a stock list and becomes a margin report. That is the Operator Console's Food Cost screen `DOCUMENTED` [Operator Console PRD §6.4], and it is the natural place this ties in later. **No dollars anywhere in v1**, and that absence is the specification, exactly as it is on the labor rung `DOCUMENTED` [D28, team-labor-spec §4] |
| **Waste and spoilage reasons** | Recording that four fish were binned, and why, is a management report with a taxonomy behind it. V1 absorbs waste where it actually lands, in the gap between the arithmetic and the next count, which is honest and costs nobody any typing. If the founder wants the reason captured, it is one field on the count and easy to add later `INFERRED` |
| **Multi-location transfers** | The whole system is single-location today `DOCUMENTED` [one `location_id` throughout the schema]. Moving stock between two rooms is a second-location feature and belongs with the rest of them |
| **Barcodes, scales, and any hardware** | A scanner is a hardware integration, a procurement problem, and a support burden, and a chef holding a clipboard in a walk-in is not scanning anything `INFERRED` |
| **Forecast-driven suggested ordering** | The Operator Console's example table suggests an order quantity from forecast demand, safety stock, shelf life, and a delivery schedule `DOCUMENTED` [PRD §6.4]. V1 suggests par minus on-hand, which is arithmetic the chef can check in their head. Forecasting arrives when there is a season of real fire data to forecast from, and it arrives explainable or not at all `INFERRED` |

## 6. Questions for the founder

**These are Andy's, not Matt's.** They do not go in the operator session guide; they are the domain calls that decide the shape of the build, and the founder is the person in the room who has counted a walk-in. Each carries the default we would ship, so a shrug is still an answer.

| # | Question | Recommended default |
|---|---|---|
| G-1 | **At the bar, what is the unit: a bottle or a pour?** | Both, one conversion. The ingredient is COUNTED in the unit you can actually count on a shelf (bottles) and CONSUMED in the unit a recipe uses (ml), with a single `unitsPerCountedItem` on the ingredient (750). A chef counting "four gin" and a recipe saying "30ml" then agree without anybody doing arithmetic twice. Making the bar count in millilitres is asking somebody to eyeball a bottle to the nearest tenth, which is how a number stops being believed |
| G-2 | **Who besides a kitchen-level person may count stock?** | Kitchen and manager may count; server may not. Counting is the act that overwrites the system's number with reality, so it wants a name against it, and D33's enum already has the shape. Bar stock is counted by whoever is kitchen or manager, since the bartender's own permission level is `UNKNOWN` until D33 lands |
| G-3 | **Are prep items (a sauce made from ingredients, then used by dishes) in v1 or v2?** | **V2.** One level of links first: dish to ingredient. Prep items make the graph two levels deep and bring a yield question with them (a batch of sugo makes how many portions, and how much does it lose on the stove), which is a real modelling problem and not a small one. A house that preps sauces can model the sauce itself as an ingredient counted in litres in the meantime, which is imprecise and useful, and that trade is exactly what v1 is for |
| G-4 | **When does the count actually happen?** | Whenever somebody does it, and the system never asks for one. No scheduled count, no nag, no "your count is overdue" banner. A count is just the most recent one, and its date is shown next to the number so a chef can see the arithmetic has been running for three days and judge it accordingly. `UNKNOWN` whether he wants a nudge; the default is no |
| G-5 | **Is receiving a quick add or a structured delivery record?** | **Quick add** in v1: ingredient, quantity, save, with who and when recorded. A structured delivery (a purveyor, a docket number, several lines received together) is the front half of purchase orders, which §5 excluded, and adding it early drags the whole B2B surface in behind it |
| G-6 | **A dish is fired and then voided or comped. Does the stock come back?** | **No.** The food was cooked; the fish is gone. Crediting it back would be the system telling the chef something the next count will contradict. This is the one rule most likely to be argued with, which is why it is here rather than assumed |
| G-7 | **Does a line cook see counts, or only the chef?** | Kitchen-level sees, only kitchen and manager write. A cook who can see that there are three branzino left plates differently, and that is the entire point of putting the number where the work happens rather than in an office |

Also worth asking, because it decides whether any of this survives contact with a Saturday: **when the walk-in is counted, is it counted by station or by shelf?** If the answer is by shelf, the count screen wants a sort order the chef controls rather than the one the system finds convenient, and that is a small thing to get right and an annoying thing to retrofit.

## 7. Data sketch

In the schema's own conventions (D14: client-generated UUIDs, `org_id` and `location_id` on every operational table, TEXT plus CHECK instead of enums, `timestamptz` in UTC). A sketch, not a migration; the build ticket writes one, expand-only, after the founder's review.

```sql
CREATE TABLE ingredient (
  id            UUID PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organization(id),
  location_id   UUID NOT NULL REFERENCES location(id),
  name          TEXT NOT NULL,
  unit_kind     TEXT NOT NULL CHECK (unit_kind IN ('count','weight','volume')),
  unit_label    TEXT NOT NULL,                    -- 'each', 'lb', 'ml'
  -- G-1: counted in bottles, consumed in ml. 1 when they are the same thing.
  units_per_counted_item NUMERIC NOT NULL DEFAULT 1 CHECK (units_per_counted_item > 0),
  par_level     NUMERIC NOT NULL DEFAULT 0 CHECK (par_level >= 0),
  station_key   TEXT NOT NULL,                    -- whose list it lands on
  retired_at    TIMESTAMPTZ,                      -- soft, like dining_table
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- what a serving consumes. EITHER a menu item or a modifier option, never
-- both: a Pad Thai depletes noodles, and its Protein: Shrimp option depletes
-- shrimp, and a fired line consumes the union of the two.
CREATE TABLE recipe_link (
  id             UUID PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organization(id),
  location_id    UUID NOT NULL REFERENCES location(id),
  ingredient_id  UUID NOT NULL REFERENCES ingredient(id),
  menu_item_id   UUID,                            -- id within the snapshot document
  modifier_option_id UUID,                        -- likewise
  qty_per_serving NUMERIC NOT NULL CHECK (qty_per_serving > 0),
  CHECK ((menu_item_id IS NULL) <> (modifier_option_id IS NULL))
);

-- reality, appended and never edited. The most recent one per ingredient is
-- the baseline everything after it is arithmetic on.
CREATE TABLE stock_count (
  id            UUID PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organization(id),
  location_id   UUID NOT NULL REFERENCES location(id),
  ingredient_id UUID NOT NULL REFERENCES ingredient(id),
  counted_qty   NUMERIC NOT NULL CHECK (counted_qty >= 0),
  counted_by    UUID NOT NULL REFERENCES employee(id),
  counted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stock_receipt (
  id            UUID PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organization(id),
  location_id   UUID NOT NULL REFERENCES location(id),
  ingredient_id UUID NOT NULL REFERENCES ingredient(id),
  received_qty  NUMERIC NOT NULL CHECK (received_qty > 0),
  received_by   UUID NOT NULL REFERENCES employee(id),
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_count_latest   ON stock_count (ingredient_id, counted_at DESC);
CREATE INDEX idx_stock_receipt_since  ON stock_receipt (ingredient_id, received_at);
CREATE INDEX idx_recipe_link_item     ON recipe_link (menu_item_id) WHERE menu_item_id IS NOT NULL;
```

**Note what is not in that sketch.** There is no `on_hand` column, because §2.3; no `price` or `cost` column anywhere, because §5; and no `supplier_id`, because §5 again and because adding one later is one expand-only migration rather than a redesign. `INFERRED`

**NUMERIC rather than BIGINT minor units** is a deliberate departure from D14's money rule, and it is not money: 0.5 lb of anything is a real quantity and the rule it obeys is the one about not lying, which here means not forcing a weight into integers. Money stays minor units everywhere, and there is no money here. `INFERRED`

## 8. Build shape, honestly estimated

`INFERRED`, so the founder can price the decision he is being asked to make.

| Ticket | Model | What is in it |
|---|---|---|
| **E26-T2** inventory core | Opus | One expand-only migration (four tables, three indexes); the ingredient and recipe-link aggregates in both stores; commands to add and edit an ingredient, link a recipe, count, and receive, all kitchen-or-manager gated and envelope-idempotent; the derived on-hand projection joining counts, receipts and fires; the what-is-low and order-list reads; and the 86 PROPOSAL read, which proposes and never writes |
| **E26-T3** inventory screens | Sonnet | The chef's two screens phone-first (a walk-in is not a place you take a laptop), the count sheet, the receive action, recipe links on the Menu screen's item editor, and the 86 proposal surfaced where the 86 board already lives |

Two tickets, one migration, no new money math, and no change to how a check or a kitchen ticket works: the fire event this reads is one the system has recorded since E8 and this feature only ever reads it. The riskiest part is not the code, it is whether a real kitchen will keep the counts up, which is why §2.2's partial-adoption rule is a design requirement rather than a nicety.

## 9. Dependencies and sequencing

| Dependency | What it gates | State |
|---|---|---|
| E5 menu (items, modifier groups, publish) | What a recipe links TO, including the modifier options that swap a protein | Done; a manager can shape the whole menu graph (E5-T3) |
| E8 coursed firing and kitchen tickets | The fire event depletion is computed from | Done 2026-08-24 |
| The 86 board | The bridge in §4, which proposes onto the board rather than replacing it | Live since E5 |
| D33 roles (owner / manager / kitchen / server) | Who may count and who may see, per G-2 and G-7 | In queue as E25; until it lands, kitchen-level means manager-gated |
| **The founder's review of this spec** | **The entire build.** No E26 code before it | Pending `DOCUMENTED` [D34] |

**Out of V1 pilot scope** unless the founder says otherwise, on the same test the guestbook, the book, and the schedule were held to: the pilot question is "can this restaurant run every dinner service and close every night", and a kitchen that runs out of branzino still closes the night. `INFERRED` What makes this one different from those is that its input is already in the ledger. Every fire since E8 is a depletion event nobody has read yet, which means the day this ships it is not starting from zero; it is starting from however long the restaurant has been running service.
