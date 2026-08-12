# RestaurantOS — Master Plan

**Status:** Superseded by v2.0 — v1.0, 2026-08-11
**Owner:** Andy Saengsawat · **Operator advisor:** Matt (input pending)
**Mission:** Build a restaurant POS that overtakes Toast and Square — by closing the loop from transactions to the operator's daily decisions.

```
Toast research ──────┐
                     │
Square research ─────┼──► RestaurantOS POS PRD
                     │
Matt/operator input ─┤
                     │
Pilot restaurant ────┘
                           ↓
                  Domain model + architecture
                           ↓
                       V1 backlog
                           ↓
                     Claude Code build
```

Every substantive element in this plan is sourced from the Toast deep-research report ("**[T]**"), the Square deep-research report ("**[S]**"), the Operator Console PRD ("**[PRD]**"), or a decision made by the founder ("**[Decision]**"). Evidence labels follow the Square report's discipline **[S]**: `DOCUMENTED` (in a source we can point to), `INFERRED` (our reasoning), `UNKNOWN` (needs operator/pilot input).

---

## 1. Vision & thesis

**What we're building:** RestaurantOS — a full-service restaurant POS whose intelligence layer is the reason operators switch. Toast and Square sell terminals plus payments; neither closes the loop from the transaction data they already hold to the operator's daily decisions on food cost, labor, and purchasing. The Operator Console concepts — Today / Food Cost / Labor / Inventory / AI Advisor **[PRD §6]** — become RestaurantOS features sitting on our own POS data, not a bolt-on above someone else's.

**Why us:**
- Founder: 7 years in a Thai restaurant, kitchen through dining room — the domain is first-hand, not researched. Plus a genuine love of the craft.
- Matt: decades of operator experience — the reality check every POS startup lacks.
- AI-agent development (Claude Code) collapses the cost of building what used to take a funded team **[Decision]**.

**The honest framing:** "Overtake Toast and Square" is a decade-scale ambition against payments companies with certified hardware fleets. The plan therefore doesn't pretend to out-build them feature-for-feature. It wins a *pilot restaurant* first, proves the two things incumbents are weakest at — correctness under failure and decision intelligence — and scales from evidence, not hope. `INFERRED`

**Product principle (carried from the PRD):** *RestaurantOS is not another dashboard. It should help the operator decide what to do next.* **[PRD §17]**

---

## 2. Where we are (assets inventory)

| Asset | Status | Feeds into |
|---|---|---|
| 3 clickable POS prototypes (`index.html` + 2 variants) | Done | Phase 0 operator conversations — they are **UX hypotheses, not architecture** **[S]** |
| `Toast-deep-research-report.md` | Done | Domain model, sync protocol, API design, priorities, risk register, pilot questions |
| `Square-deep-research-report.md` | Done | Evidence discipline, payment decomposition, correctness classes, latency budgets, quality gates |
| `RestaurantOS_Operator_Console_PRD.md` | Done | Intelligence-layer feature set (Phase 6+), discovery questions (Phase 0), demo-data realism |
| Matt / operator input | **Pending** | Phases 0–2 decision gates |
| Pilot restaurant | **Not selected** | Phase 0 criteria → Phase 5 |

**Caveat on the research reports:** both were written without access to our prototypes, so their prototype-audit sections are empty (`Not verifiable` **[T]** / `UNKNOWN` **[S]**) — ignore those. Their domain research, architecture reasoning, and process discipline are the reusable substance, and this plan is assembled from them.

---

## 3. Competitive reality

- **Payments economics is the moat.** Toast and Square are payments companies wearing POS clothing — processing revenue funds cheap hardware and sales teams. We do not compete there in V1: **integrate payments, never build them** — Stripe Terminal or Adyen behind our own adapter interface; RestaurantOS owns *payment orchestration state* while the provider owns card acquisition, EMV/NFC, encryption, and PCI scope **[T]**. Never store PAN/track data **[T]**.
- **Provider selection detail that matters:** Stripe's server-driven Terminal integration does not support offline collection; its SDK-based integration does. Adyen documents offline EMV store-and-forward with risk controls. The offline requirement therefore constrains the provider choice — decide together in Phase 2 **[T]** `DOCUMENTED` (per report's citations of provider docs).
- **Where incumbents are weak** `INFERRED`: opaque analytics that describe rather than recommend; pricing/processing-fee resentment among independents; full-service complexity (coursing, seat-level splits, transfers) still generating daily workarounds. Matt to confirm or correct in Phase 0. `UNKNOWN`
- **"Do not build yet" list** (adopted verbatim) **[T]**: proprietary payment processing (extreme cost, PCI, certifications), microservice fleet (modular monolith wins during discovery), custom POS hardware (commodity tablets + certified peripherals until the software is proven).

---

## 4. Non-negotiable engineering principles

These come out of both reports and hold for every phase:

1. **What sinks a pilot** is not UI polish — it's a mis-split check, an order lost in an outage, a duplicate kitchen fire after reconnection, or a payment we think succeeded when the processor doesn't **[T]**. Priorities follow from that.
2. **Four correctness classes** structure all acceptance criteria **[S]**: *interaction* (fast, obvious order entry), *financial* (taxes/discounts/tips/tenders reconcile exactly), *distributed-state* (two terminals + crashed device + flaky WAN cannot destroy or duplicate orders), *operational* (managers can explain every void, short drawer, and settlement).
3. **Local-first, in this exact order:** UI → local domain transaction → local durable store → synchronization. Anything else "is merely a cloud app with retries" **[T]**. Frontend state is never the ledger — the UI is a projection of persisted state **[S]**.
4. **Order ≠ check.** The check is the financial grouping settled by one or more tenders; kitchen fulfillment lives in a *separate* state machine from check payment state **[T]**.
5. **Money is integer minor units** with deterministic rounding in one central money/tax engine **[T]**.
6. **Payment state is never one boolean.** `PaymentIntent → PaymentAttempt(s) → Payment → Tender / Refund / Tip` — the $120 check paid $40 Visa + $50 cash + $30 Mastercard must model cleanly **[S]**, and retries are observable rows, not overwrites **[T]**.
7. **"Locally accepted, pending upload" must never display as "Paid."** Offline-accepted payments can later decline **[T]**.
8. **The prototypes are UX hypotheses.** *Do not refactor `index.html` into "cleaner frontend code" and call that V1 architecture* **[S]**. V1 is built domain-first; the UI sits on top.
9. **Evidence discipline everywhere:** claims in our PRD, ADRs, and competitor statements get labeled `DOCUMENTED / OBSERVED / INFERRED / UNKNOWN` **[S]**. The correct finding for anything untested is UNKNOWN, not "looks fine" **[S]**.

---

## 5. Phased roadmap

Calibrated for a part-time solo founder + Claude Code. Durations are honest estimates, not promises; phases gate on exit criteria, not dates.

### Phase 0 — Close out discovery (now → ~1 month)

**Goal:** Convert prototypes + research into validated requirements; make the project auditable.

| # | Deliverable | Source |
|---|---|---|
| 0.1 | Put the repo under git; one-command "how to open/demo" doc | Reproducibility-first sequencing **[S]**, adapted |
| 0.2 | Operator sessions with Matt: walk the prototypes, run the **21-question pilot table** **[T §open decisions]** + the 13 discovery questions **[PRD §13]** | **[T] [PRD]** |
| 0.3 | Discovery-notes doc: answers, surprises, feature requests — each labeled `OBSERVED` (Matt said it) vs `INFERRED` | **[S]** |
| 0.4 | Pilot-selection criteria (service style, terminal count, KDS vs printers, existing hardware, owner relationship, tolerance for shadow-running) | **[T]** pilot questions |
| 0.5 | **Decision gate — freeze or reject:** "LAN-continuous service during WAN failure is P0." Toast's report insists this be frozen *now* because retrofitting an edge coordinator is close to a rewrite. Matt's answer to "must orders reach the kitchen with the Internet down?" decides it. | **[T]** |

**Room for Matt:** the whole phase is his. Key questions reserved for him: void-after-fire handling, what "close day" means operationally, seat-level ordering, auto-gratuity policy, post-auth tip adjustment, bar tabs/preauth, offline-card risk tolerance, printers vs KDS reality **[T]**.

**Exit criteria:** 21-question table answered (or explicitly deferred); LAN/WAN decision frozen; pilot criteria written.

### Phase 1 — RestaurantOS POS PRD (~1–2 months)

**Goal:** One new source-of-truth PRD for the POS (superseding, not editing, the Operator Console PRD — that document's intelligence content moves to Phase 6).

- Scope = the **smallest *sellable* full-service POS, not the smallest demo** **[S]** — single location, one operating model.
- Checklist = Toast report's requirements-distillation table **[T]**: FOH (login/clock-in through shift close), table service (floor plans, seats, transfers, multi-check parties), menu (hierarchy, variations, modifier groups with min/max/defaults/nesting, 86ing, dayparts), order/check, kitchen, reliability, payments, security/RBAC/audit, cash/EOD.
- Every requirement carries an evidence label and an owner (founder / Matt / pilot) **[S]**.
- Explicit non-goals for V1: gift cards (integrate later), reservations/waitlist, loyalty, online ordering/delivery, scheduling — all P2-integrate per **[T]**; multi-location UX (but keep `organization_id`/`location_id` on every table from day one **[T]**).
- Include the failure cases as *requirements*, not test afterthoughts: Internet loss, sync recovery, duplicate requests, terminal crash, KDS disconnect, printer failure, simultaneous two-terminal edits **[S]**.

**Room for Matt:** review draft PRD; strike anything a real operator wouldn't use; add what's missing. His requests get first-class PRD status.

**Exit criteria:** PRD reviewed by Matt; V1/P1/P2/never boundaries signed off.

### Phase 2 — Domain model + architecture (~1–2 months)

**Goal:** The transaction system's skeleton, on paper, before code.

Adopt from **[T]** (MVP backend API and domain design):
- The **ER model** as drafted: immutable `MENU_SNAPSHOT`; `MENU_GROUP_ITEM` join (items in multiple menu paths); modifier graph with inheritance/nesting/min-max; `ORDER_DISPATCH` batches ("what did we tell the kitchen, and when?"); `PAYMENT` + `PAYMENT_ATTEMPT`.
- The **two state machines**: check lifecycle (Open → PartiallyPaid → Paid → Closed → Reopened/Voided) and kitchen lifecycle (Held → Fired → InPreparation → Ready → Completed, + VoidedAfterFire, Recalled) — kitchen states validated with the pilot restaurant, since prep and expo stations differ.
- The **sync protocol**: operation envelope (`operationId`, `deviceId`, `aggregateVersion`), idempotent replay (same `operationId` returns the known result, never re-executes), `APPLIED` / `CONFLICT` + `STALE_AGGREGATE_VERSION` semantics.
- The **command-oriented API**: `POST /checks/{id}/split`, never "`PATCH /checks/123` with whatever the browser has"; the ~30-endpoint table as the V1 API sketch; device registration + employee PIN sessions + single-use manager-approval tokens.

Merge from **[S]**: the `PaymentIntent/PaymentAttempt/Payment/Tender/Refund/Tip` decomposition (compatible with Toast's payment model — use Square's naming for the intent layer); the UI-as-projection pipeline as the client architecture rule.

Write as **ADRs** (each with evidence label and a "Matt input?" flag):
1. **Stack.** The reports conflict here: Toast picks React + TypeScript + PWA/IndexedDB + Fastify-style modular monolith *now*; Square says don't lock client tech before domain/offline/hardware are understood. **Resolution: Square's sequencing, Toast's stack as leading candidate** — decide only after ADR-2 and Matt's hardware answers. Agreed by both reports regardless: **modular monolith, PostgreSQL, transactional outbox; no microservices, no Kubernetes, Cloud Run or Fargate class hosting** **[T]**.
2. **Edge/LAN strategy** — direct consequence of the Phase 0 frozen decision. If LAN-continuity is P0: lightweight edge process (designated terminal or small appliance) for LAN discovery, KDS fan-out, printer adapters, SQLite buffering **[T]**.
3. **Payment provider** — Stripe Terminal (SDK-based, for offline) vs Adyen, chosen against Matt's answers on tips-after-auth, bar tabs, offline-card limits **[T]**.
4. **Client platform** — PWA vs Electron vs native, decided against the pilot's actual hardware **[S]**.

**Room for Matt:** kitchen state semantics; hardware inventory at candidate pilot venues; payment behaviors (tip adjustment, preauth) that constrain ADR-3.

**Exit criteria:** ER model + state machines + sync protocol documented; 4 ADRs decided; Square's C→D gate formally passed — *we now have an explicit domain model independent of any UI* **[S]**.

### Phase 3 — V1 backlog (~2–4 weeks)

**Goal:** Convert PRD + architecture into an ordered, Claude-Code-executable backlog.

- **Seed = Toast's P0/P1/P2 table** **[T §prioritized implementation plan]**, re-scoped by pilot answers. The P0 spine, in build order: monetary primitives → shared domain package (state machines as pure functions) → Postgres schema/migrations → menu/config domain → floor plan/tables → check/order-item engine → modifier validation → send/hold/fire dispatch → KDS → local DB → sync engine → split checks → discounts/comps/voids → payment adapter → cash tender → audit log → offline UX → crash recovery → test harness.
- Acceptance criteria per ticket organized by the **four correctness classes** **[S]**.
- Ticket format written for AI agents: context, invariants that must hold, property-based test to add, files touched. **Model policy [Decision]:** Opus/Fable for domain modeling, sync protocol, payment orchestration, and anything touching money; Sonnet for routine tickets (CRUD endpoints, UI screens, fixtures, test scaffolding) where token cost matters.
- Property-test list drafted up front: split/merge conservation of money, quantity, tax **[T]**; partial-payment allocation **[S]**.

**Exit criteria:** backlog ordered; every P0 ticket has invariants + tests specified; first milestone cut.

### Phase 4 — Build V1 with Claude Code (~4–6 months part-time)

**Goal:** Working software, milestone by milestone, following the priority spine **[T]**:

> **P0 domain correctness → local persistence/sync → menu/order/check state → KDS → integrated payments → permissions/audit → close/reconciliation → operational hardening.**

Milestones (each independently demoable):
1. **Domain core** — money engine, state machines, modifier validation as a pure TypeScript package with property tests. No UI.
2. **Order entry vertical slice** — menu → check → send-to-kitchen against local durable store; crash-kill test passes (active check survives forced termination **[S]**).
3. **KDS + dispatch** — immutable dispatch batches, station routing, bump/recall; duplicate-fire test passes **[T]**.
4. **Sync engine** — operation journal, idempotent upload, conflict handling; **the 10-case network-fault suite** **[T §testing]** automated (request never leaves device; server commits but response lost; stale version; crash between write and enqueue; WAN down/LAN up; LAN down; two-terminal same-check edit; KDS gets local event before cloud; retry; payment authorizes only after reconnect).
5. **Splits, discounts, voids** — property-based conservation tests green **[T]**.
6. **Payments** — provider sandbox integration behind the adapter; webhook dedup; "pending upload" vs "authorized" visibly distinct **[T]**.
7. **Cash, RBAC, audit, EOD close** — drawer sessions, manager approvals, append-only audit events, business-day close with blockers **[T]**.
8. **Hardening** — Square's latency budgets become measured SLOs **[S]**: tap-to-check perceptually immediate, local commit before sync, crash restore in seconds, 100+ line check re-render without lag; telemetry per Toast's "can the restaurant serve dinner?" list (queue depth, oldest unsynced operation age, duplicate-operation count, KDS dispatch latency, payment states by age) **[T]**.

**Quality gates arrive with the toolchain** (this is when Node tooling first exists — not before) **[S]**: lockfile + `npm ci`, ESLint/Stylelint/Prettier, Playwright (+ axe) E2E including multi-terminal scenarios, CI on every PR, dependency audit (never `npm audit fix --force` in CI), expand/contract migrations only **[T]**. Security posture from day one of real code: `textContent` over `innerHTML` for anything user-originated (item names, notes, guest names are untrusted **[S]**), CSP report-only → enforce, no secrets in client code, self-hosted dependencies.

**Room for Matt:** monthly demo of each milestone; his "that's not how a restaurant works" feedback is a P0 bug class.

**Exit criteria:** milestones 1–7 done; fault suite + property tests green in CI; SLOs measured.

### Phase 5 — Pilot (~2–3 months)

**Goal:** One real restaurant running RestaurantOS.

- Select venue via Phase 0 criteria (Matt's network is the pipeline). `UNKNOWN` until then.
- **Shadow-run first:** RestaurantOS beside the existing POS before any cutover — the existing system remains the ledger of record until reconciliation matches for an agreed period. `INFERRED`
- Hardware-in-loop testing on the venue's actual devices: card terminal, printers, cash drawer, KDS networking **[T]**.
- **Pilot-ready gate = an evidence table, Square-style** **[S]**: every specified failure case (required modifiers, taxes, discounts, comps, pre/post-fire voids, splits, partial cash/card, card decline, reopened checks, transfers, Internet failure/recovery, duplicate requests, terminal restart, KDS disconnect, printer failure, simultaneous terminal updates) has a passing automated or hardware-in-loop test — `DOCUMENTED`, not assumed.
- Operational support plan: health screen, remote diagnostics, and a runbook for "what does the restaurant do when we're asleep" **[T]**.

**Exit criteria:** full service days on RestaurantOS alone; EOD reconciliation matches; the operator would recommend it.

### Phase 6+ — The differentiator, then scale

- **Intelligence layer on our own data** — the Operator Console concepts **[PRD §6]** rebuilt on RestaurantOS's transaction stream: Today dashboard → Food Cost (actual vs theoretical usage) → Labor recommendations → Inventory/purchasing suggestions → AI Advisor. Progression: **Observe → Explain → Predict → Recommend → Automate** **[PRD §16]**, with the PRD's AI principle intact: DB = truth, deterministic logic = calculations, ML = predictions, LLM = explanation and interface only — the AI never invents numbers **[PRD §6.5]**.
- Multi-location (schema already carries it **[T]**), menu-publishing UI, device management, reporting projections — the P1 tier **[T]**.
- Integrations tier (gift cards, reservations, delivery, scheduling) — integrate, don't build **[T]**.
- Hardware stays commodity until the software wins on its own **[T]**.

---

## 6. Room for Matt — standing reservations

Decisions never made without operator input, by phase:

| Phase | Reserved for Matt |
|---|---|
| 0 | All 21 pilot questions **[T]**; which prototype UX feels right; pilot criteria |
| 1 | PRD review; scope strikes/additions; what "sellable" means to a real operator |
| 2 | Kitchen state semantics (prep vs expo); payment behaviors (tips post-auth, preauth/tabs, offline-card limit); venue hardware reality |
| 3–4 | Milestone demos; workflow-reality bug reports |
| 5 | Pilot venue introduction; shadow-run tolerance; go/no-go on cutover |
| 6+ | Which intelligence recommendation he'd actually act on **[PRD §14]** |

---

## 7. Risks & kill criteria

**Critical risks** (from Toast's register **[T]**, plus ours):

| Risk | Mitigation |
|---|---|
| Offline synchronization ("basic demos work perfectly online") | Operation journal + IDs + versions; 10-case fault suite from milestone 4, not after |
| Payment state ("charge card looks like one action") | Provider-neutral state machine, signed webhooks, reconciliation |
| Split checks / tenders (huge state space) | Domain command + property-based conservation tests |
| Money/tax rounding | Central integer-minor-unit engine + fixtures |
| Kitchen duplication (retries become duplicate food) | Idempotent dispatch/ticket IDs |
| **Part-time pace vs incumbent speed** `INFERRED` | Milestone discipline; scope ruthlessly to one restaurant's operating model; AI-agent leverage |
| **Pilot dependency** `UNKNOWN` | Matt's network; criteria defined in Phase 0 so the search starts early |
| Operational support (pilot can't debug our stack) | Telemetry + health screen + runbook before cutover **[T]** |

**Kill / pivot criteria** `INFERRED`: if by end of Phase 1 no operator (Matt included) identifies a recommendation or workflow they'd switch POS for — or if by Phase 5 no venue will shadow-run — pivot back to the Operator-Console-above-existing-POS strategy **[PRD §1]**, keeping the domain model and research as assets. The PRD's success metric stands: **learning, not visual polish** **[PRD §14]**.

---

## 8. Decision log

| # | Decision | Status | Evidence |
|---|---|---|---|
| D1 | RestaurantOS is a POS; intelligence layer is the differentiator, not a separate product | **Decided** 2026-08-11 | [Decision]; resolves PRD §15 open question |
| D2 | Integrate payments (Stripe Terminal / Adyen); never build processing; never store PAN | **Decided** | **[T] [S]** unanimous |
| D3 | Modular monolith + PostgreSQL + transactional outbox; no microservices/K8s for V1 | **Decided** | **[T]**, consistent with **[S]** |
| D4 | Local-first write ordering; frontend is never the ledger | **Decided** | **[T] [S]** unanimous |
| D5 | Build with Claude Code — Opus/Fable for domain/sync/payments, Sonnet for routine tickets | **Decided** 2026-08-11 | [Decision] |
| D6 | LAN-continuous service during WAN failure = P0? | **Open — Phase 0 gate** | **[T]** says freeze early; needs Matt. `UNKNOWN` |
| D7 | Stack (React/TS/PWA leading candidate) | **Open — Phase 2 ADR-1** | **[T]** vs **[S]** timing conflict, resolved to decide post-D6 |
| D8 | Payment provider (Stripe vs Adyen) | **Open — Phase 2 ADR-3** | Constrained by offline + tip/preauth needs **[T]** |
| D9 | Client platform (PWA/Electron/native) | **Open — Phase 2 ADR-4** | Decided against pilot hardware **[S]** |
| D10 | Pilot venue | **Open — Phase 0/5** | Matt's network. `UNKNOWN` |

---

*Sources: `Toast-deep-research-report.md` **[T]**, `Square-deep-research-report.md` **[S]**, `RestaurantOS_Operator_Console_PRD.md` **[PRD]**. See CLAUDE.md for what in the reports is load-bearing vs ungrounded.*
