# RestaurantOS Migration Spec: bringing a restaurant off its old POS

**Status:** Draft v0.1, 2026-08-28 (E22-T1). Spec only: no code, no migration files, no UI in this ticket.
**Decisions it obeys:** D26 (migration/onboarding is spec-only for now; the floor editor and venue/staff settings shipped as builds already, this spec is the third leg), D2 (integrate payments, never store PAN; provider tokens are not portable), D14 (schema conventions), FR-9 (publishing freezes an immutable snapshot; nothing bypasses it, including an import).
**Evidence labels:** `DOCUMENTED` (research reports, provider docs), `OBSERVED` (founder or operator said it, or a competitor product showed it), `INFERRED` (our reasoning), `UNKNOWN` (needs Matt, or a real customer export we do not have in hand).
**Companions:** `docs/prd/RestaurantOS_POS_PRD.md` (product definition, FR-9 snapshot rule), `docs/domain/schema.sql` (`menu_item`/`item_variation`/`modifier_group`, `employee`, `dining_area`/`dining_table`, `guest`/`check_guest`), `docs/prd/guestbook-spec.md` (the guest import's destination and its own consent questions), master plan §7.2 epic E22, `DECISIONS.md` D26.

---

## 1. Why

A restaurant switching point-of-sale systems is not switching software, it is moving a running business: a menu somebody built over years, a staff roster with real people's names and roles, a room shaped like their actual dining floor, and a fear that walking away from the old system means losing the history that proves the business is real. Onboarding friction is a sales blocker for exactly this reason: an operator who has to redo three weeks of setup work before they can open for dinner will stay on the system they already hate. `INFERRED`

The two incumbent research reports name migration tooling as an open question rather than a solved one (`docs/research/Toast-deep-research-report.md`, the operator question "What existing POS data must migrate?" mapped to "Migration tooling" with no answer given). `DOCUMENTED` What we know generally about how incumbents handle this: a combination of spreadsheet-style imports for the mechanical parts (menu, staff) plus a human, an onboarding specialist or reseller, doing the parts that resist automation (the floor, the judgment calls). `INFERRED` We have no incumbent's actual export file in hand, so anything more specific than that is `UNKNOWN` until WP-0.2 or a pilot produces one.

## 1a. The first real artifact: NorthStar's data-loading workbook (added 2026-08-29)

Our operator advisor shared the actual Excel workbook a NorthStar (hospitality/club POS) onboarding used to set up a multi-outlet venue he works with. **The file stays out of this repository permanently** (it carries real staff names and authentication IDs; gitignored, referenced here by description only), but its structure is now our first `DOCUMENTED` evidence, and it is worth more than an export would have been: it is the TARGET vendor's fill-in template, the same role our import plays. A competitor's answer sheet to our own homework. `DOCUMENTED` [NorthStar workbook, on file offline]

What it contains, and what each part confirms or corrects:

| Workbook tab | Structure | What it tells us |
|---|---|---|
| Locations | Name, description, department code, location type (POS vs Banquet) | Multi-outlet venues are real (this one runs a dozen bars and dining rooms); our single-location V1 is a known limit, already on record |
| Servers / Non Servers | Authentication ID, first/last name, employee number, default role | The industry loads staff credentials as PLAINTEXT spreadsheet cells. Our fresh-PINs-always rule (§2.2) is not caution, it is the fix for an observed practice |
| Modifier Groups | Group name, **minimum, maximum**, description, then modifier + price rows | Their modifier model is our modifier model (min/max per group), and their flat sheet links groups to items BY NAME, which is exactly our `modifier_group_hint` mechanism. §2.1's approach is validated by a shipping competitor |
| Item Groups | Name, bill code, GL account, color, kitchen printer, expeditor printer, default modifier groups | Category-level accounting codes and PRINT ROUTING live at the group level; when we meet accounting-minded operators, revenue-category mapping will be asked for |
| Menu Items (+ a beverage twin) | Menu card, category, subcategory, name, description, item group, type, price, member price, cost, open item, price-override flag, hide-on-terminal, auto-fire, printer type, SKU, modifier groups (by name), course, location | The maximal version of our minimal template. Notable columns we chose not to have yet: SKU, cost, per-item printer routing, auto-fire flags. Notably ABSENT everywhere: floor geometry, guest data, sales history, which confirms §2.3 and §3 outright |
| "POS Items - DO NOT USE" | A stale legacy tab left in the live template | Template versioning is a real failure mode: a customer filling the wrong tab is a vendor-made error. Our import template must be one sheet, versioned, with no dead tabs |

Two conclusions worth restating with the stronger label. First, the industry's onboarding mechanism IS the spreadsheet-plus-a-human model this spec assumed (`INFERRED` upgraded to `DOCUMENTED` for at least one shipping vendor). Second, nothing in a real vendor's loading workbook migrates floor geometry, guests, or history; those are rebuilt or abandoned, exactly as §2.3 and §3 argue. One nuance the workbook does NOT answer: it shows how data gets INTO a new system, not what the OLD system exports out, so deck D's ask for a true export file stands.

## 2. What migrates, per object

### 2.1 Menu

**Mechanism:** a CSV template imported into the **existing draft-then-publish flow** (`/menu`, per FR-8/FR-9). An import is a draft the same way a manager's hand-typed edit is a draft: it sits unpublished until a manager reviews it and publishes, and publishing is what freezes it into the next immutable `menu_snapshot`. Nothing about an import skips that gate, because a bad import is exactly the kind of mistake the draft step exists to catch before it reaches a live check. `INFERRED`

**Template columns**, one row per item: `name, course, price, station, modifier_group_hint`. This mirrors `menu_item` (`name`, `course`, `station_id`) and `item_variation` (`price_minor`) directly; `modifier_group_hint` is free text ("choice of protein", "temperature") rather than a structured modifier graph, because V1's modifier groups (`modifier_group`/`modifier`/`modifier_group_option`) are reusable and cross-linked in a way a flat CSV row cannot express on its own. A hint becomes a real modifier group assignment as a manager step in the draft editor, not an automatic mapping. `INFERRED`

**What incumbent exports actually contain**, labeled honestly since we have no file from any of the three in hand:

| Source | What we believe it exports | Label |
|---|---|---|
| Toast | A menu export with item name, price, category/group, and a SKU/PLU; modifier groups are known to exist in Toast's model (the research report documents Toast's own modifier graph) but whether a standard export flattens or preserves that graph is not something we have verified | `INFERRED` (name/price/category), `UNKNOWN` (modifier fidelity, actual column names) |
| Square | Square's Item Library supports CSV export/import for catalog items (name, price, category, SKU) as a documented feature of the product; exact column headers and modifier handling in that file | `INFERRED` (that a CSV catalog export exists), `UNKNOWN` (exact schema) |
| Lightspeed | No export file reviewed | `UNKNOWN` |

Recommended default: our CSV template is deliberately minimal (name/course/price/station/modifier hint) rather than an attempt to match any one incumbent's column names, because matching a schema we have not verified is worse than owning a simple one and asking Matt or a pilot operator to map their export into it by hand or with a short conversion pass. `INFERRED`

The NorthStar workbook (§1a) strengthens this default from the other direction: the one real template we hold links modifier groups to items by NAME in a flat sheet, which is our `modifier_group_hint` mechanism working in a shipping product, and its maximal column set (SKU, cost, printer routing, auto-fire) is a menu of what operators may eventually ask our template to grow, not what v1 needs. `DOCUMENTED` [NorthStar workbook]

### 2.2 Staff

**Mechanism:** a CSV of `name, role` imported into the roster (E21's `POST /v1/staff`, one row per hire). **PINs are always issued fresh: never imported, never asked for.** A PIN is a hashed secret (`employee.pin_hash`, argon2id, NFR-4); an old system's export, if it contains PINs at all, would hand us either a plaintext secret we should never see or a hash we could never use, and importing "the same PIN as before" would mean asking the old system for something it should not give up either way. Every migrated employee gets a new PIN, communicated the same way a manager sets one for a fresh hire today (E21-T1). `DOCUMENTED` [NFR-4]

### 2.3 Floor

**Mechanism:** redrawn by hand in RestaurantOS's own floor editor (E6, the add/edit/resize/retire tables and areas shipped 2026-08-28). **Geometry does not import.** A floor plan is a spatial layout specific to one system's editor and one room's actual walls; there is no portable geometry format across POS systems, and incumbents do not claim one either, this matches observed practice rather than a limitation unique to us. `INFERRED` Redrawing a room the operator already knows by heart is minutes of work with the editor now built, not a migration problem. `INFERRED`

### 2.4 Guests

**Mechanism:** a CSV of `name, phone` imports into the E20 guestbook at the **v0 manual-attach rung** (`guest` rows created directly, unattached to any check until a server attaches one during service). This is a bulk version of the same quick-create the check's More menu already does one guest at a time (E20-T3). Import creates guest identity records only; it never fabricates a visit history, spend, or favorites, because those are derived on read from checks the person has not actually had with us (guestbook-spec.md §4). `INFERRED`

**Flag: consent.** The guestbook's own privacy defaults (guestbook-spec.md §5, C2 and C6) say consent is not required to create a service record but marketing use always requires an explicit, human-captured opt-in, never inferred from a phone number's mere presence. A bulk-imported list is exactly the case that default was written to guard against: a spreadsheet of names and numbers carries no opt-in of its own, so every imported guest lands with `marketing_opt_in = false` regardless of what the old system's export claims, and turning it on stays a deliberate per-record act. `INFERRED` This is a new question for Matt, not a settled one: does the old system's list even distinguish service contacts from marketing subscribers, and if it does not, should we treat the whole import as unconsented by default. `UNKNOWN` (deck D, below).

## 3. What deliberately does not migrate in V1

| Item | Why not |
|---|---|
| Sales history | It belongs to the old system's books, not ours. RestaurantOS's reports start at day one of running on RestaurantOS (`docs/prd/RestaurantOS_POS_PRD.md` §4.10); importing someone else's historical numbers as if we computed them would break the product principle that the system never lies about where a figure came from. `INFERRED` |
| Gift card liabilities | A pre-sold gift card is a financial obligation the old operator owes a guest, a legal and accounting transfer between businesses or systems, not a data import. Gift cards are P2 (integrate, never build) in the PRD's scope model regardless. `DOCUMENTED` [PRD §3] |
| Loyalty balances | RestaurantOS has no loyalty program in V1 (P2, per the PRD scope model); there is nothing on our side for a balance to migrate into. `DOCUMENTED` [PRD §3] |
| Card fingerprints | D2: provider tokens are never portable across payment providers. A card fingerprint stored by the old system's processor is meaningless to ours; the guestbook's own `guest_card_fingerprint` table (E13-gated) is keyed to our provider from ADR-3 and starts empty for every migrated guest, recognition has to happen fresh on their next card payment with us. `DOCUMENTED` [D2] |

## 4. The import discipline

Every migration mechanism above shares three rules, regardless of object:

1. **Every import lands as a draft a manager reviews and publishes.** The menu's draft step is literal (the existing `/menu` draft-then-publish loop, FR-9). Staff and guest imports get the equivalent: rows land created but nothing is presented to a server as ready to use, sign-in enrollment or a guestbook attach still requires a manager's eyes-on pass first. `INFERRED`
2. **Imports are idempotent: re-running one never duplicates.** A second run of the same file against the same restaurant produces zero new rows, matched on a natural key per object (menu: name within a course; staff: name, since PINs are always fresh so there is no PIN to key on; guests: phone where present, else name). This matters because "run it again, something looked wrong" is the realistic operator behavior during setup, not a one-shot event. `INFERRED`
3. **Every imported row carries its source for audit.** Which file, which system it claims to be from, and when, recorded the same way every other mutation in RestaurantOS records who and when (`audit_event`, D14 conventions). An imported menu item or guest should never look indistinguishable from one a manager typed by hand; the provenance is part of the record. `INFERRED`

## 5. Questions for the Matt deck (deck D)

Appended to `docs/discovery/operator-session-guide.md` in the guide's existing deck format (deck C precedent), each with a recommended default so a shrug is still an answer.

| # | Question | Recommended default |
|---|---|---|
| D-1 | What data would he refuse to lose in a switch? | Menu and the room, because service cannot start without them; staff can be re-entered in minutes and PINs reset regardless. Sales history is assumed expendable since the PRD already treats day-one as RestaurantOS's own start line |
| D-2 | Who does the data entry today, when a menu or a roster changes? | A manager or the owner, not a dedicated administrator; the import flow should assume the person running it is busy, not a specialist |
| D-3 | Would he trust a self-serve import, or want a human involved? | A human (Andy or Matt) walks the first pilot restaurant through it once; self-serve CSV import is the target for restaurant number two, once the mapping step from a real export has been proven |
| D-4 | How long can setup take before it kills the sale? | Under a day for menu and staff combined, assuming the CSVs are ready; the floor redraw is the long pole and should be doable inside a single sit-down session with the operator, not homework |

Also worth naming, because it decides whether the CSV template above should have looked different: **what does his current POS actually let him export, and can he get us a real file before this is built.** Everything in §2.1's incumbent-export table stays `UNKNOWN`/`INFERRED` until one arrives.

## 6. Dependencies and sequencing

| Dependency | What it gates |
|---|---|
| E5-full (relational menu editor) | The menu CSV's `modifier_group_hint` becoming a real, reusable modifier-group assignment rather than a manager typing it in by hand after import; v0 import works against today's document-draft editor either way |
| E21 (venue + staff, done 2026-08-28) | The staff CSV's destination, `POST /v1/staff` |
| E6 (floor editor, done 2026-08-28) | Where the redrawn room is built; nothing to migrate, the tool just needs to exist, and it does |
| E20 (guestbook, v0 done 2026-08-23) | The guest CSV's destination at the manual-attach rung |
| A real customer export (Matt or a pilot) | Turning §2.1's `UNKNOWN` rows into `DOCUMENTED` ones; this spec should not be built against until one exists, per D26 |

This spec is **out of V1 pilot scope** unless Matt asks for it first: the pilot question is "can this restaurant run every dinner service and close every night," and a first pilot restaurant can be set up by hand once. Migration tooling earns its build when a second or third restaurant needs onboarding without Andy or Matt doing the typing. `INFERRED`
