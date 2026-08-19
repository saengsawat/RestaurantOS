# RestaurantOS POS: Product Requirements Document

**Status:** Draft v0.1, 2026-08-12 (WP-1.1). Awaiting operator review (WP-1.2), Matt slots marked `UNKNOWN`.
**Supersedes:** the Operator Console PRD as product definition, per decision D1. That document's intelligence concepts return as Phase 6 features; its discovery questions remain valid.
**Evidence labels:** `DOCUMENTED` (research reports, provider docs), `OBSERVED` (founder or operator said it), `INFERRED` (our reasoning), `UNKNOWN` (needs Matt or the pilot).
**Companions:** `docs/domain/domain-model.md` + `schema.sql` (structure), master plan §7 (epics), the flagship mockup (UX hypothesis, not spec).

---

## 1. Product definition

RestaurantOS V1 is the **smallest sellable full-service restaurant POS**: one location, one operating model (table service with a bar), commodity tablets, integrated payments, and honest offline behavior. "Sellable" means a real restaurant can run every dinner service on it and close every night with numbers that reconcile, not that it demos well. `DOCUMENTED` [Square report framing]

What makes it worth switching for arrives in two layers: correctness under failure now (V1), decision intelligence later (Phase 6). V1 must therefore be boringly reliable rather than feature-maximal.

**Product principle:** the system never lies. Pending is never paid, voided is never hidden, 86'd is never invisible, and the close is blocked rather than fudged.

## 2. Users

| User             | Uses                   | Cares about                                                                              |
| ---------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| Server           | Terminal + handheld    | Speed (2 taps to any item), coursing control, splits that match how guests actually pay  |
| Bartender        | Terminal               | Tabs, fast repeat orders, drinks firing instantly                                        |
| Line cook / expo | KDS                    | What to cook now, what just landed, what is late, batch duplicates`OBSERVED` (founder) |
| Manager          | Terminal + back office | Approvals, voids/comps story, drawer, the close                                          |
| Owner-operator   | Everything             | Trustworthy numbers, staff not fighting the tool, support at 8 PM Friday                 |

## 3. Scope model

| Tier                         | Meaning                              | Contents                                                                                                                              |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| **V1**                 | Pilot cannot run without it          | Everything in §4                                                                                                                     |
| **P1**                 | Fast follow, weeks after pilot start | Printer fallback for KDS, menu publishing UI, reporting projections, device management, bar tabs/preauth if pilot needs it`UNKNOWN` |
| **P2**                 | Integrate, do not build              | Gift cards, reservations/waitlist, loyalty, online ordering/delivery, scheduling                                                      |
| **Never (V1 horizon)** | Explicitly out                       | Proprietary payment processing, custom hardware, multi-location UX (schema stays multi-location ready), franchise/enterprise features |

## 4. Functional requirements

Numbered FR-n, each with evidence and epic traceability (master plan §7.2).

### 4.1 Identity, devices, permissions (E15)

- **FR-1** Employees sign in by PIN on an enrolled device; every mutation records actor + device. `DOCUMENTED` [T]
- **FR-2** Role-based permissions, server-enforced; a permission key exists for every privileged action (void, comp, reopen, drawer, close day, menu publish). `DOCUMENTED` [T]
- **FR-3** Manager approval is a second employee's PIN, captured as approver on the action itself. `DOCUMENTED` [T]
- **FR-4** Clock in/out per employee per business day; declared tips at clock-out. Policy details `UNKNOWN` (Matt: when do lunch servers cash out?).

### 4.2 Floor and seating (E6)

- **FR-5** Spatial floor plan: sections, positioned tables with shape and capacity, drawn and rearranged by the operator (drag-to-move layout editor on the Tables screen, positions persisted per table). Status (open/seated/mains fired/paying/kitchen late) is derived, never stored. `OBSERVED` (prototype validated the pattern; layout editor live 2026-08-18)
- **FR-6** Seat a party with covers; covers editable later but never below a seat holding items. Whether covers is mandatory at seating: `UNKNOWN` (deck A2).
- **FR-7** Transfer a check to another table and switch between open checks in one tap. Merge checks: `UNKNOWN` (Matt: needed night one?).

### 4.3 Menu and configuration (E4, E5)

- **FR-8** Menu graph: menus, groups, items, variations, reusable modifier groups with min/max/defaults, nested modifier groups (V1 UI depth 2, model unbounded). `DOCUMENTED` [T]
- **FR-9** Publishing freezes the menu into an immutable snapshot; devices cache snapshots for offline boot; order lines reference their snapshot forever. Editing never rewrites history. `DOCUMENTED` [T]
- **FR-10** Live 86 board with optional counts; hitting zero 86s the item everywhere within seconds; voids restock. `OBSERVED` (prototype)
- **FR-11** Menu changes during service: `UNKNOWN` (Matt), affects publishing UX only, not the model.

### 4.4 Ordering and coursing (E7, E3)

- **FR-12** Items carry seat, course, quantity, modifiers, and a kitchen note. Required modifier groups block adding until satisfied; the same validator runs on client and server. `DOCUMENTED` [T]
- **FR-13** Courses group automatically; a course can be held and fired manually; beverages fire on add. Whether coursing is routinely used: `UNKNOWN` (deck A2), default-on for full service. `INFERRED`
- **FR-14** Allergy flags ride the item from order to KDS, visually loud at every step. `OBSERVED` (founder)
- **FR-15** Nothing is silently editable after fire: post-fire changes are voids (with reason + approval) plus new items. `DOCUMENTED` [T]

### 4.5 Kitchen (E8)

- **FR-16** One card per table on the KDS; dispatches stack in fire order; just-fired work is flagged New (window `UNKNOWN`, default 3 min). `OBSERVED` (founder, 3 yrs sous chef)
- **FR-17** Per-item bump, toggleable (a mis-tap is its own remedy). Card state derives from items. `OBSERVED` (founder)
- **FR-18** Serve releases the whole table, only when all items are done, only from the expo view; served tables stay recallable (window `UNKNOWN`, default 10 min). `OBSERVED` (founder)
- **FR-19** Cook-together pane: identical unplated dishes across tables aggregate so the line fires them once. `OBSERVED` (founder)
- **FR-20** Station views filter to that station's items and cannot serve. Station list is location config. Late threshold per ticket with visible escalation; whether ready-but-unserved re-escalates: `UNKNOWN` (deck A2).
- **FR-21** A dispatch reaches the kitchen exactly once, no matter how the network behaves. Duplicate fire is a release blocker, tested under retry and reconnection. `DOCUMENTED` [T, critical risk]

### 4.6 Payments and splits (E11, E13)

- **FR-22** Split by whole check, evenly (2 to 6+), or by seat; mixed tenders on one check; conservation to the cent is property-tested. `DOCUMENTED` [T][S]
- **FR-23** Card payments through one integrated provider (ADR-3) behind an adapter; RestaurantOS stores provider references only, never card data. `DOCUMENTED` [T][S]
- **FR-24** Tips: percentage prompts plus custom; post-auth tip adjustment `UNKNOWN` (Matt), constrains provider choice.
- **FR-25** Offline card acceptance up to a configurable cap (`UNKNOWN`, Matt sets risk tolerance); displayed as Pending upload, never Paid, until the processor confirms; declines after reconnect surface as manager-visible exceptions. `DOCUMENTED` [T]
- **FR-26** A check with unsent items cannot take payment. Refunds are async, provider-driven, approval-gated. `DOCUMENTED` [T]

### 4.7 Discounts, voids, audit (E12, E15)

- **FR-27** Discounts/comps as auditable adjustments (amount or percent) with reason and approver; auto-gratuity as an adjustment kind, threshold `UNKNOWN` (Matt).
- **FR-28** Voids require reason + approval; pre-fire voids just remove revenue expectation, post-fire voids also notify the kitchen; both restock counted items. `DOCUMENTED` [T]
- **FR-29** Every check has a human-readable history (timeline) assembled from audit events: opened, items, fires, voids, adjustments, payments, transfers, reopen. `OBSERVED` (prototype)

### 4.8 Cash and the close (E14, E16)

- **FR-30** Drawer sessions per physical drawer per business day: opening float, immutable cash event ledger, count at close, over/short computed and frozen. Between-services swap is close + reopen, same day. `DOCUMENTED` [T] + close-day design
- **FR-31** Business-day close is a **workflow with blockers**: open checks, unclosed drawer sessions, unresolved offline payments, unclocked employees each block or warn (block-vs-warn split `UNKNOWN`, Matt). Close produces the day summary (sales, tenders, tips, comps/voids, over/short) and locks the day. `DOCUMENTED` [T]
- **FR-32** Whether lunch gets its own close or one nightly close: `UNKNOWN` (Matt). The model supports both without change.

### 4.9 Offline and sync (E9, E10, E17)

- **FR-33** Local-first: every command commits to the device's durable store before any network attempt; the UI is a projection of local state. `DOCUMENTED` [T][S]
- **FR-34** Sync via idempotent operation journal (client operation ids); replay returns the recorded result; version conflicts surface for rebase or human resolution. `DOCUMENTED` [T]
- **FR-35** Explicit connectivity states in the UI: cloud, LAN, payments each honest and distinct. Staff always know what is safe to do. `DOCUMENTED` [T]
- **FR-36** Orders reaching the KDS during a WAN outage: **`UNKNOWN`, this is D6**, the one answer that changes architecture (edge/LAN relay) rather than configuration. Frozen until Matt answers.
- **FR-37** A terminal restart never loses an open check or a queued operation; crash recovery is tested by process kill. `DOCUMENTED` [S]

### 4.10 Reporting (V1 floor)

- **FR-38** V1 reporting is the close-day summary plus a same-day view of sales, tenders, comps/voids, and item counts, computed from the ledger, not a parallel bookkeeping path. Real analytics and intelligence are Phase 6 by design. `INFERRED`

## 5. Non-functional requirements

- **NFR-1 Latency budgets** `DOCUMENTED` [S]: tap-to-check and category switch perceptually immediate (<100ms); send-order local commit immediate, sync async; crash restore seconds with check intact; 100+ line check renders without input lag. Measured as SLOs in E18.
- **NFR-2 Correctness classes** `DOCUMENTED` [S]: interaction, financial, distributed-state, operational. Every epic's acceptance criteria are grouped by these.
- **NFR-3 Money**: integer minor units end to end; totals computed, never stored; conservation property-tested (E1).
- **NFR-4 Security**: PINs hashed (argon2id), server-enforced permissions, append-only audit, no card data anywhere, webhook signature verification, per-device credentials revocable.
- **NFR-5 Touch and accessibility**: design system rules are requirements (44px targets, press feedback, no hover dependence, focus-visible, reduced-motion, status never color-only).
- **NFR-6 Supportability**: health screen on-device, telemetry that answers "can the restaurant serve dinner" (queue depth, oldest unsynced op, duplicate ops, KDS latency, payment states by age), and a runbook. `DOCUMENTED` [T]

## 6. Failure cases are requirements

V1 ships only when these pass as automated tests plus hardware-in-loop before pilot `DOCUMENTED` [T][S]: request never leaves device; server commits but response lost; stale version conflict; crash between local write and enqueue; WAN down with LAN up; LAN down; two terminals editing one check; KDS receives local event before cloud; sync retry storms; payment authorizes only after reconnect; card decline after offline acceptance; duplicate provider webhooks; printer failure (P1 path); KDS disconnect mid-service.

## 7. Non-goals for V1

Multi-location operation, table-side guest-facing displays, custom hardware, gift cards, reservations, loyalty, online ordering, payroll/scheduling, invoice ingestion, and the intelligence layer itself (Phase 6). The Operator Console PRD's five screens remain the Phase 6 blueprint.

## 8. Open questions (the Matt register)

All consolidated from master plan §9 + decks A/A2/B: D6 (WAN-down kitchen, the architecture gate), close cadence (per service or nightly), block-vs-warn at close, offline card cap, auto-gratuity threshold, post-auth tip adjustment, bar tabs/preauth, mandatory covers, table-tap depth, New window, expo-only serve, recall window, ready re-escalation, merge checks, printers vs KDS reality, migration needs. Each has a default marked in this document so the absence of an answer never blocks the build; answers retrofit through change control (§8.4).

## 9. Traceability

| FR group | Epics        | Property/fault tests                                  |
| -------- | ------------ | ----------------------------------------------------- |
| 4.1      | E15          | privilege escalation, audit completeness              |
| 4.2      | E6           | two-terminal table state                              |
| 4.3      | E4, E5       | snapshot immutability                                 |
| 4.4      | E3, E7       | modifier validity generation, idempotent commands     |
| 4.5      | E8           | duplicate-fire under retry                            |
| 4.6      | E1, E11, E13 | split conservation, decline/timeout/duplicate-webhook |
| 4.7      | E12, E15     | void-after-fire scenario                              |
| 4.8      | E14, E16     | over/short reconciliation, close blockers             |
| 4.9      | E9, E10, E17 | the 10-case network-fault suite, crash-kill           |
| 5        | E18          | measured SLOs                                         |
