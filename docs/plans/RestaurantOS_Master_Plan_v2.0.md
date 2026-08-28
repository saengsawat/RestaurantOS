# RestaurantOS: Master Plan

**Status:** Living document, **v2.0**, 2026-08-11
**Owner:** Andy Saengsawat · **Operator advisor:** Matt (input pending)
**Mission:** Build a restaurant POS that overtakes Toast and Square, by closing the loop from transactions to the operator's daily decisions.

**Changelog**
- v2.4 (2026-08-12): D13 phase overlap: Matt-independent Phase 2 work started. Domain model + 44-table PostgreSQL schema delivered and verified against Postgres 17 (`docs/domain/`). D14 schema conventions. ADR-1/ADR-2 remain frozen on D6.
- v2.3 (2026-08-12): Flagship mockup matured through founder review: KDS rebuilt on sous-chef feedback (one card per table, per-item bump, cook-together pane), editable party size, spatial floor plan, phone layout fixed. New operator questions added to §9. Design system gained motion, focus, viewport-height, and KDS pattern rules.
- v2.2 (2026-08-11): Repo reorganized into `docs/` `design/` `prototypes/` layers and placed under git (WP-0.1 partially done). Flagship Italian mockup (`prototypes/index_RestaurantOS.html`) added to assets (§2).
- v2.1 (2026-08-11): Added Design Theme & Atmosphere (§14), Wise-derived RestaurantOS design system adopted; template at `design/restaurantos/`. Decision D11.
- v2.0 (2026-08-11): Added Agent Operating Model (§5), Work Breakdown Structure (§7), Governance & Cadence (§8), Quality System (§10), agent-specific risks (§11), Traceability appendix (§13). Deepened phase detail with entry criteria and RACI.
- v1.0 (2026-08-11): Initial strategy, phased roadmap, decision log, assembled from the Toast and Square research reports and the Operator Console PRD.

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

**Contents:** 1 Vision · 2 Where we are · 3 Competitive reality · 4 Engineering principles · **5 Agent operating model** · 6 Phased roadmap · **7 Work breakdown structure** · **8 Governance & cadence** · 9 Room for Matt · **10 Quality system** · 11 Risks & kill criteria · 12 Decision log · **13 Traceability appendix** · **14 Design theme & atmosphere**

---

## 1. Vision & thesis

**What we're building:** RestaurantOS, a full-service restaurant POS whose intelligence layer is the reason operators switch. Toast and Square sell terminals plus payments; neither closes the loop from the transaction data they already hold to the operator's daily decisions on food cost, labor, and purchasing. The Operator Console concepts, Today / Food Cost / Labor / Inventory / AI Advisor **[PRD §6]**, become RestaurantOS features sitting on our own POS data, not a bolt-on above someone else's.

**Why us:**
- Founder: 7 years in a Thai restaurant, kitchen through dining room, the domain is first-hand, not researched. Plus a genuine love of the craft.
- Matt: decades of operator experience, the reality check every POS startup lacks.
- AI-agent development (Claude Code) collapses the cost of building what used to take a funded team **[Decision]**.

**The honest framing:** "Overtake Toast and Square" is a decade-scale ambition against payments companies with certified hardware fleets. The plan therefore doesn't pretend to out-build them feature-for-feature. It wins a *pilot restaurant* first, proves the two things incumbents are weakest at, correctness under failure and decision intelligence, and scales from evidence, not hope. `INFERRED`

**Product principle (carried from the PRD):** *RestaurantOS is not another dashboard. It should help the operator decide what to do next.* **[PRD §17]**

---

## 2. Where we are (assets inventory)

| Asset | Status | Feeds into |
|---|---|---|
| **Flagship mockup** `prototypes/index_RestaurantOS.html` (Osteria Nove, Italian): coursing, seats, 86 counts, spatial floor plan, party size, table-consolidated KDS with per-item bump and cook-together pane, offline sim, audit trail, splits, Day/Night, full phone layout | Done, iterating on founder review | Phase 0 operator conversations; the UX hypothesis for Phase 1 PRD |
| `docs/discovery/` session guide + founder KDS notes | Done | WP-0.2 agenda; kitchen requirements for Phase 1 PRD |
| 3 discovery prototypes `prototypes/discovery/` (Thai, first generation) | Done | Kept for comparison, **UX hypotheses, not architecture** **[S]** |
| Design system `design/restaurantos/` (D11) | Done | All UI work, §14 |
| `docs/research/Toast-deep-research-report.md` | Done | Domain model, sync protocol, API design, priorities, risk register, pilot questions |
| `docs/research/Square-deep-research-report.md` | Done | Evidence discipline, payment decomposition, correctness classes, latency budgets, quality gates |
| `docs/prd/RestaurantOS_Operator_Console_PRD.md` | Done | Intelligence-layer feature set (Phase 6+), discovery questions (Phase 0), demo-data realism |
| Matt / operator input | **Pending** | Phases 0–2 decision gates |
| Pilot restaurant | **Not selected** | Phase 0 criteria → Phase 5 |

**Caveat on the research reports:** both were written without access to our prototypes, so their prototype-audit sections are empty (`Not verifiable` **[T]** / `UNKNOWN` **[S]**), ignore those. Their domain research, architecture reasoning, and process discipline are the reusable substance, and this plan is assembled from them.

---

## 3. Competitive reality

- **Payments economics is the moat.** Toast and Square are payments companies wearing POS clothing, processing revenue funds cheap hardware and sales teams. We do not compete there in V1: **integrate payments, never build them**, Stripe Terminal or Adyen behind our own adapter interface; RestaurantOS owns *payment orchestration state* while the provider owns card acquisition, EMV/NFC, encryption, and PCI scope **[T]**. Never store PAN/track data **[T]**.
- **Provider selection detail that matters:** Stripe's server-driven Terminal integration does not support offline collection; its SDK-based integration does. Adyen documents offline EMV store-and-forward with risk controls. The offline requirement therefore constrains the provider choice, decide together in Phase 2 **[T]** `DOCUMENTED` (per report's citations of provider docs).
- **Where incumbents are weak** `INFERRED`: opaque analytics that describe rather than recommend; pricing/processing-fee resentment among independents; full-service complexity (coursing, seat-level splits, transfers) still generating daily workarounds. Matt to confirm or correct in Phase 0. `UNKNOWN`
- **"Do not build yet" list** (adopted verbatim) **[T]**: proprietary payment processing (extreme cost, PCI, certifications), microservice fleet (modular monolith wins during discovery), custom POS hardware (commodity tablets + certified peripherals until the software is proven).

---

## 4. Non-negotiable engineering principles

These come out of both reports and hold for every phase:

1. **What sinks a pilot** is not UI polish, it's a mis-split check, an order lost in an outage, a duplicate kitchen fire after reconnection, or a payment we think succeeded when the processor doesn't **[T]**. Priorities follow from that.
2. **Four correctness classes** structure all acceptance criteria **[S]**: *interaction* (fast, obvious order entry), *financial* (taxes/discounts/tips/tenders reconcile exactly), *distributed-state* (two terminals + crashed device + flaky WAN cannot destroy or duplicate orders), *operational* (managers can explain every void, short drawer, and settlement).
3. **Local-first, in this exact order:** UI → local domain transaction → local durable store → synchronization. Anything else "is merely a cloud app with retries" **[T]**. Frontend state is never the ledger, the UI is a projection of persisted state **[S]**.
4. **Order ≠ check.** The check is the financial grouping settled by one or more tenders; kitchen fulfillment lives in a *separate* state machine from check payment state **[T]**.
5. **Money is integer minor units** with deterministic rounding in one central money/tax engine **[T]**.
6. **Payment state is never one boolean.** `PaymentIntent → PaymentAttempt(s) → Payment → Tender / Refund / Tip`, the $120 check paid $40 Visa + $50 cash + $30 Mastercard must model cleanly **[S]**, and retries are observable rows, not overwrites **[T]**.
7. **"Locally accepted, pending upload" must never display as "Paid."** Offline-accepted payments can later decline **[T]**.
8. **The prototypes are UX hypotheses.** *Do not refactor `index.html` into "cleaner frontend code" and call that V1 architecture* **[S]**. V1 is built domain-first; the UI sits on top.
9. **Evidence discipline everywhere:** claims in our PRD, ADRs, and competitor statements get labeled `DOCUMENTED / OBSERVED / INFERRED / UNKNOWN` **[S]**. The correct finding for anything untested is UNKNOWN, not "looks fine" **[S]**.

---

## 5. Agent Operating Model

How every unit of work is managed and delegated. This is Claude Code's real machinery, orchestrator session, worker subagents, review passes, not a fictional org chart. **[Decision]**

### 5.1 Roles

| Role | Who | Responsibilities | May merge code? |
|---|---|---|---|
| **Product owner** | Andy (founder) | Approves scope, PRD amendments, and decision-log entries; reviews milestone demos; final verification of every merge | Yes, and only after seeing it run |
| **Domain authority** | Matt | Reserved decisions per phase (§9); milestone demo feedback; pilot introduction | No |
| **Orchestrator agent** | Interactive Claude Code session, Opus or Fable | Grooms `BACKLOG.md`; decomposes milestones → epics → tickets; writes ticket contracts; delegates to workers; integrates results; updates `DECISIONS.md`; reports status to founder | No |
| **Worker agent** | Subagent or separate session, model per §5.2 | Implements exactly one ticket per session, within the ticket's file scope, with its tests | No |
| **Reviewer agent** | `/code-review` + cross-model pass, model per §5.2 | Reviews diffs against ticket invariants; critical-path code is reviewed by a **different model** than the one that wrote it | No |

Two hard rules fall out of this table: **no agent merges its own work**, and **nothing merges without founder verification** (§5.4).

### 5.2 Model assignment policy

| Work class | Build model | Review model | Rationale |
|---|---|---|---|
| Domain modeling, state machines, sync protocol, payment orchestration, **anything touching money**, schema migrations, ADRs | **Opus / Fable** | Opus/Fable, cross-model (Fable reviews Opus's work and vice versa) | Highest blast radius; the [T] risk register's Critical rows all live here |
| Check engine, dispatch/KDS logic, RBAC/audit, EOD close | Opus / Fable | Sonnet first-pass + Opus on flagged findings | Cross-module invariants |
| CRUD endpoints, UI screens, fixtures, test scaffolding, docs, refactors already covered by tests | **Sonnet** | Sonnet (`/code-review`) | Token cost matters; existing tests catch regressions **[Decision]** |
| Exploration/search (find where X is handled) | Explore subagent (cheap) | n/a | Read-only |

Per **D17**, external models (e.g. Codex) may take row-3 (Sonnet-class) tickets under the same contract, review, and escalation rules; rows 1-2 stay with Opus/Fable. Per **D21**, the orchestrator session (Fable) does not implement product code itself: it plans, writes contracts, assigns, and serves as the cross-model reviewer; Fable-tier build work goes to Opus worker sessions.

**Escalation rules:**
- A Sonnet ticket that **fails review twice**, or turns out to touch a §4 invariant, is re-run on Opus with the review findings attached.
- A worker that wants to change anything **outside its ticket's file scope** stops and returns the ticket to the orchestrator instead of improvising.
- Disagreement between build and review agents on a correctness question → founder decides; the resolution is written to `DECISIONS.md`.

### 5.3 The ticket contract (delegation artifact)

Every delegated ticket uses this template. The contract is the unit of management: an agent session receives one contract and nothing else is in scope.

```markdown
## Ticket E{epic}-T{n}: {title}
**Epic:** E{n} {epic name} · **Build model:** {Opus|Fable|Sonnet} · **Review tier:** {cross-model|standard}
**Status:** Draft → Ready → Delegated → Implemented → Agent-reviewed → Founder-verified → Merged

### Context
{2–5 sentences: why this exists, what the adjacent code does, links to ADR/PRD sections}

### Invariants that must hold  (sourced [T]/[S]/PRD)
- {e.g., sum of split-check totals == original total to the cent, always}

### Acceptance criteria  (by correctness class [S])
- Financial: …
- Distributed-state: …
- Interaction: …
- Operational: …

### Tests to add
- Property test: {generator + conserved quantity}
- Fault case(s) from the 10-case suite, if applicable: {#}

### File scope
- In scope: {paths}
- Out of scope (do not touch): {paths, especially money engine, schema}

### Definition of done
Code + tests green locally and in CI + no lint errors + review findings resolved + demo note (1–3 lines: how founder can see it run)
```

### 5.4 Ticket lifecycle

```
Draft ──ready criteria met──► Ready ──orchestrator assigns──► Delegated
   ▲                                                              │
   │                                                     worker implements
   │                                                              ▼
   └──scope problem discovered──────────────────────── Implemented
                                                              │
                                                       reviewer agent(s)
                                                              ▼
              findings ◄──fail── Agent-reviewed ──pass──► Founder-verified
                 │                                            │
                 └────────► back to Delegated                 ▼
                            (findings attached)            Merged
```

Rules: every ticket lands **with its tests**; a failed review returns to `Delegated` with findings attached (never silently reworked); `Founder-verified` means Andy ran it or watched it run; only then merge. Critical-path tickets (§5.2 row 1) additionally require the cross-model review before `Founder-verified`.

### 5.5 Session & context hygiene: the repo is the memory

Agents have no memory across sessions. Durable project state therefore lives in-repo, not in chat history:

| File | Owner | Contents |
|---|---|---|
| `BACKLOG.md` | Orchestrator | All tickets with current status; the only authoritative ticket list |
| `DECISIONS.md` | Orchestrator (founder approves) | Running log of decisions + rationale; supersedes chat |
| `docs/adr/ADR-{n}.md` | Orchestrator | Architecture decision records (§6 Phase 2) |
| `CLAUDE.md` | Founder | Standing instructions every session reads first |

Session rules: **one ticket per worker session** (fresh context, the contract is self-sufficient); the orchestrator session starts each work block by reading `BACKLOG.md` + `DECISIONS.md`, not by trusting recall; anything worth remembering gets written down before a session ends.

### 5.6 Escalation to human: always

Agents stop and ask the founder before: any requirement ambiguity (never guess on money/domain semantics); any scope change or new dependency; anything irreversible or external, schema migrations against shared data, payment-provider account actions, spend, publishing, deleting. These mirror the change-control rules in §8.4.

### 5.7 Token budget policy

Sonnet by default; the Opus/Fable list in §5.2 is the exception set, not the rule **[Decision]**. Batch small same-area tickets into one session. Review effort scales with blast radius: money/sync/payments get the expensive cross-model review; a fixture file does not. Exploration uses Explore subagents, never a full Opus session.

---

## 6. Phased roadmap

Calibrated for a part-time solo founder + Claude Code. Durations are honest estimates, not promises; phases gate on exit criteria, not dates. Per-phase RACI: **R**esponsible, **A**pproves, **C**onsulted, **I**nformed across Founder / Matt / Orchestrator / Workers.

### Phase 0: Close out discovery (now → ~1 month)

**Goal:** Convert prototypes + research into validated requirements; make the project auditable.
**Entry criteria:** this plan approved. **RACI:** Founder R/A · Matt C (heavily) · Orchestrator R (docs) · Workers -.

| # | Deliverable | Source |
|---|---|---|
| 0.1 | Put the repo under git; one-command "how to open/demo" doc | Reproducibility-first sequencing **[S]**, adapted |
| 0.2 | Operator sessions with Matt: walk the prototypes, run the **21-question pilot table** **[T §open decisions]** + the 13 discovery questions **[PRD §13]** | **[T] [PRD]** |
| 0.3 | Discovery-notes doc: answers, surprises, feature requests, each labeled `OBSERVED` (Matt said it) vs `INFERRED` | **[S]** |
| 0.4 | Pilot-selection criteria (service style, terminal count, KDS vs printers, existing hardware, owner relationship, tolerance for shadow-running) | **[T]** pilot questions |
| 0.5 | **Decision gate, freeze or reject:** "LAN-continuous service during WAN failure is P0." Toast's report insists this be frozen *now* because retrofitting an edge coordinator is close to a rewrite. Matt's answer to "must orders reach the kitchen with the Internet down?" decides it. | **[T]** |

**Room for Matt:** the whole phase is his. Key questions reserved for him: void-after-fire handling, what "close day" means operationally, seat-level ordering, auto-gratuity policy, post-auth tip adjustment, bar tabs/preauth, offline-card risk tolerance, printers vs KDS reality **[T]**.

**Exit criteria:** 21-question table answered (or explicitly deferred); LAN/WAN decision frozen (D6); pilot criteria written.

### Phase 1: RestaurantOS POS PRD (~1–2 months)

**Goal:** One new source-of-truth PRD for the POS (superseding, not editing, the Operator Console PRD, that document's intelligence content moves to Phase 6).
**Entry criteria:** Phase 0 exit met. **RACI:** Founder R/A · Matt C (review + strikes) · Orchestrator R (drafting) · Workers -.

- Scope = the **smallest *sellable* full-service POS, not the smallest demo** **[S]**, single location, one operating model.
- Checklist = Toast report's requirements-distillation table **[T]**: FOH (login/clock-in through shift close), table service (floor plans, seats, transfers, multi-check parties), menu (hierarchy, variations, modifier groups with min/max/defaults/nesting, 86ing, dayparts), order/check, kitchen, reliability, payments, security/RBAC/audit, cash/EOD.
- Every requirement carries an evidence label and an owner (founder / Matt / pilot) **[S]**.
- Explicit non-goals for V1: gift cards (integrate later), reservations/waitlist, loyalty, online ordering/delivery, scheduling, all P2-integrate per **[T]**; multi-location UX (but keep `organization_id`/`location_id` on every table from day one **[T]**).
- Include the failure cases as *requirements*, not test afterthoughts: Internet loss, sync recovery, duplicate requests, terminal crash, KDS disconnect, printer failure, simultaneous two-terminal edits **[S]**.

**Room for Matt:** review draft PRD; strike anything a real operator wouldn't use; add what's missing. His requests get first-class PRD status.

**Exit criteria:** PRD reviewed by Matt; V1/P1/P2/never boundaries signed off.

### Phase 2: Domain model + architecture (~1–2 months)

**Goal:** The transaction system's skeleton, on paper, before code.
**Entry criteria:** PRD signed off; D6 frozen. **RACI:** Founder A · Matt C (kitchen semantics, hardware, payment behaviors) · Orchestrator R (Opus/Fable, this is critical-path design work) · Workers C (research spikes only).

Adopt from **[T]** (MVP backend API and domain design):
- The **ER model** as drafted: immutable `MENU_SNAPSHOT`; `MENU_GROUP_ITEM` join (items in multiple menu paths); modifier graph with inheritance/nesting/min-max; `ORDER_DISPATCH` batches ("what did we tell the kitchen, and when?"); `PAYMENT` + `PAYMENT_ATTEMPT`.
- The **two state machines**: check lifecycle (Open → PartiallyPaid → Paid → Closed → Reopened/Voided) and kitchen lifecycle (Held → Fired → InPreparation → Ready → Completed, + VoidedAfterFire, Recalled), kitchen states validated with the pilot restaurant, since prep and expo stations differ.
- The **sync protocol**: operation envelope (`operationId`, `deviceId`, `aggregateVersion`), idempotent replay (same `operationId` returns the known result, never re-executes), `APPLIED` / `CONFLICT` + `STALE_AGGREGATE_VERSION` semantics.
- The **command-oriented API**: `POST /checks/{id}/split`, never "`PATCH /checks/123` with whatever the browser has"; the ~30-endpoint table as the V1 API sketch; device registration + employee PIN sessions + single-use manager-approval tokens.

Merge from **[S]**: the `PaymentIntent/PaymentAttempt/Payment/Tender/Refund/Tip` decomposition (compatible with Toast's payment model, use Square's naming for the intent layer); the UI-as-projection pipeline as the client architecture rule.

Write as **ADRs** in `docs/adr/` (each with evidence label and a "Matt input?" flag):
1. **ADR-1 Stack.** The reports conflict here: Toast picks React + TypeScript + PWA/IndexedDB + Fastify-style modular monolith *now*; Square says don't lock client tech before domain/offline/hardware are understood. **Resolution: Square's sequencing, Toast's stack as leading candidate**, decide only after ADR-2 and Matt's hardware answers. Agreed by both reports regardless: **modular monolith, PostgreSQL, transactional outbox; no microservices, no Kubernetes, Cloud Run or Fargate class hosting** **[T]**.
2. **ADR-2 Edge/LAN strategy**, direct consequence of D6. If LAN-continuity is P0: lightweight edge process (designated terminal or small appliance) for LAN discovery, KDS fan-out, printer adapters, SQLite buffering **[T]**.
3. **ADR-3 Payment provider**, Stripe Terminal (SDK-based, for offline) vs Adyen, chosen against Matt's answers on tips-after-auth, bar tabs, offline-card limits **[T]**.
4. **ADR-4 Client platform**, PWA vs Electron vs native, decided against the pilot's actual hardware **[S]**.

**Exit criteria:** ER model + state machines + sync protocol documented; 4 ADRs decided; Square's C→D gate formally passed, *we now have an explicit domain model independent of any UI* **[S]**.

### Phase 3: V1 backlog (~2–4 weeks)

**Goal:** Convert PRD + architecture into `BACKLOG.md`, ordered, agent-executable ticket contracts (§5.3).
**Entry criteria:** ADRs 1–4 decided. **RACI:** Founder A · Matt I · Orchestrator R · Workers -.

- **Seed = Toast's P0/P1/P2 table** **[T §prioritized implementation plan]**, re-scoped by pilot answers, structured as the §7 WBS.
- Acceptance criteria per ticket organized by the **four correctness classes** **[S]**.
- Model/review tier assigned per §5.2; property-test list drafted up front: split/merge conservation of money, quantity, tax **[T]**; partial-payment allocation **[S]**.

**Exit criteria:** every E1–E6 ticket in full contract form; remaining epics at epic-level detail; first milestone cut.

### Phase 4: Build V1 with Claude Code (~4–6 months part-time)

**Goal:** Working software, milestone by milestone, following the priority spine **[T]**:

> **P0 domain correctness → local persistence/sync → menu/order/check state → KDS → integrated payments → permissions/audit → close/reconciliation → operational hardening.**

**Entry criteria:** Phase 3 exit; CI skeleton exists. **RACI:** Founder A (verification, merges) · Matt C (monthly demos) · Orchestrator R (decomposition, integration) · Workers R (implementation) · Reviewers R (findings).

Milestones (each independently demoable, epic mapping in §7):
1. **Domain core** (E1–E3), money engine, state machines, modifier validation as a pure package with property tests. No UI.
2. **Order entry vertical slice** (E4–E7, E9), menu → check → send-to-kitchen against local durable store; crash-kill test passes (active check survives forced termination **[S]**).
3. **KDS + dispatch** (E8), immutable dispatch batches, station routing, bump/recall; duplicate-fire test passes **[T]**.
4. **Sync engine** (E10), operation journal, idempotent upload, conflict handling; **the 10-case network-fault suite** **[T §testing]** automated (request never leaves device; server commits but response lost; stale version; crash between write and enqueue; WAN down/LAN up; LAN down; two-terminal same-check edit; KDS gets local event before cloud; retry; payment authorizes only after reconnect).
5. **Splits, discounts, voids** (E11–E12), property-based conservation tests green **[T]**.
6. **Payments** (E13), provider sandbox integration behind the adapter; webhook dedup; "pending upload" vs "authorized" visibly distinct **[T]**.
7. **Cash, RBAC, audit, EOD close** (E14–E16), drawer sessions, manager approvals, append-only audit events, business-day close with blockers **[T]**.
8. **Hardening** (E17–E18), Square's latency budgets become measured SLOs **[S]**: tap-to-check perceptually immediate, local commit before sync, crash restore in seconds, 100+ line check re-render without lag; telemetry per Toast's "can the restaurant serve dinner?" list (queue depth, oldest unsynced operation age, duplicate-operation count, KDS dispatch latency, payment states by age) **[T]**.

**Quality gates arrive with the toolchain** (this is when Node tooling first exists, not before) **[S]**: lockfile + `npm ci`, ESLint/Stylelint/Prettier, Playwright (+ axe) E2E including multi-terminal scenarios, CI on every PR, dependency audit (never `npm audit fix --force` in CI), expand/contract migrations only **[T]**. Security posture from day one of real code: `textContent` over `innerHTML` for anything user-originated (item names, notes, guest names are untrusted **[S]**), CSP report-only → enforce, no secrets in client code, self-hosted dependencies.

**Exit criteria:** milestones 1–7 done; fault suite + property tests green in CI; SLOs measured.

### Phase 5: Pilot (~2–3 months)

**Goal:** One real restaurant running RestaurantOS.
**Entry criteria:** Phase 4 exit; venue committed. **RACI:** Founder R/A · Matt C (introduction, go/no-go counsel) · Orchestrator R (fix tickets) · Workers R.

- Select venue via Phase 0 criteria (Matt's network is the pipeline). `UNKNOWN` until then.
- **Shadow-run first:** RestaurantOS beside the existing POS before any cutover, the existing system remains the ledger of record until reconciliation matches for an agreed period. `INFERRED`
- Hardware-in-loop testing on the venue's actual devices: card terminal, printers, cash drawer, KDS networking **[T]**.
- **Pilot-ready gate = an evidence table, Square-style** **[S]**: every specified failure case (required modifiers, taxes, discounts, comps, pre/post-fire voids, splits, partial cash/card, card decline, reopened checks, transfers, Internet failure/recovery, duplicate requests, terminal restart, KDS disconnect, printer failure, simultaneous terminal updates) has a passing automated or hardware-in-loop test, `DOCUMENTED`, not assumed.
- Operational support plan: health screen, remote diagnostics, and a runbook for "what does the restaurant do when we're asleep" **[T]**.

**Exit criteria:** full service days on RestaurantOS alone; EOD reconciliation matches; the operator would recommend it.

### Phase 6+: The differentiator, then scale

- **Intelligence layer on our own data**, the Operator Console concepts **[PRD §6]** rebuilt on RestaurantOS's transaction stream: Today dashboard → Food Cost (actual vs theoretical usage) → Labor recommendations → Inventory/purchasing suggestions → AI Advisor. Progression: **Observe → Explain → Predict → Recommend → Automate** **[PRD §16]**, with the PRD's AI principle intact: DB = truth, deterministic logic = calculations, ML = predictions, LLM = explanation and interface only, the AI never invents numbers **[PRD §6.5]**.
- Multi-location (schema already carries it **[T]**), menu-publishing UI, device management, reporting projections, the P1 tier **[T]**.
- Integrations tier (gift cards, reservations, delivery, scheduling), integrate, don't build **[T]**.
- Hardware stays commodity until the software wins on its own **[T]**.

---

## 7. Work Breakdown Structure

### 7.1 Phases 0–3 and 5, work packages

| WP | Phase | Package | Executor | Output |
|---|---|---|---|---|
| WP-0.1 | 0 | Git init + demo doc | Orchestrator | Repo under version control |
| WP-0.2 | 0 | Matt session prep (question decks from [T]+[PRD]) | Orchestrator | Session agenda |
| WP-0.3 | 0 | Matt sessions + discovery notes | Founder + Matt | `discovery-notes.md`, labeled |
| WP-0.4 | 0 | Pilot criteria + D6 decision memo | Founder (Orchestrator drafts) | Criteria doc; D6 in `DECISIONS.md` |
| WP-1.1 | 1 | POS PRD draft (per [T] requirements table) | Orchestrator (Opus) | `RestaurantOS_POS_PRD.md` draft |
| WP-1.2 | 1 | Matt review cycle + scope signoff | Founder + Matt | PRD v1.0 |
| WP-2.1 | 2 | Domain model doc (ER + state machines + sync) | Orchestrator (Opus/Fable) | `docs/domain-model.md` |
| WP-2.2 | 2 | ADR-1..4 | Orchestrator (Opus/Fable), Founder approves | `docs/adr/` |
| WP-3.1 | 3 | WBS → ticket contracts for E1–E6 | Orchestrator | `BACKLOG.md` |
| WP-3.2 | 3 | Property-test + fault-suite specification | Orchestrator (Opus) | Test spec appended to epics |
| WP-5.1 | 5 | Venue selection + shadow-run plan | Founder + Matt | Pilot agreement |
| WP-5.2 | 5 | Hardware-in-loop test campaign | Founder | Evidence table |
| WP-5.3 | 5 | Runbook + support plan | Orchestrator (Sonnet) | `docs/runbook.md` |

### 7.2 Phase 4: build epics

Dependency-ordered; matches the [T] priority spine. **Build/Review** per §5.2 (✱ = critical path: Opus/Fable build + cross-model review mandatory).

**Status** tracks build reality, not intent: ✅ Completed = shipped, running in `app/`, its tests green; 🔄 In progress = a working slice is live but the epic's exit test is not yet satisfied; ⬜ In queue = not started. Status is refreshed at the end of every working session alongside `STATUS.md`; per-ticket detail lives in `BACKLOG.md`. **Build** is the model the epic is assigned to, so an epic can be picked up by reading one row: status says whether it is open, Build says who to bring.

| Epic | Name | Status | Goal | Depends on | Key invariants (source) | Exit test | Build |
|---|---|---|---|---|---|---|---|
| **E1**✱ | Money engine | ✅ Completed | Integer minor units, deterministic rounding, tax calc |, | Rounding allocation sums exactly; no floats anywhere **[T]** | Property: allocation conserves cents for arbitrary splits | Opus |
| **E2**✱ | State machines | ✅ Completed | Check + kitchen lifecycles as pure functions |, | Illegal transitions impossible; kitchen ≠ check state **[T]** | Exhaustive transition-table test | Opus |
| **E3**✱ | Modifier validation | ✅ Completed | min/max/defaults/nesting enforced everywhere |, | Same validator on every client/server path **[T]** | Property: generated menus never accept invalid configs | Opus |
| **E4**✱ | Schema + migrations | ✅ Completed | Postgres schema per [T] ER model; expand/contract discipline | E1–E3 | `MENU_SNAPSHOT` immutable; org/location IDs on every table **[T]** | Migration up/down round-trip; snapshot immutability test | Opus |
| **E5** | Menu/config domain | 🔄 In progress | Versioned menu graph, publishing snapshots | E3, E4 | Editing draft never mutates published snapshot **[T]** | Publish → order → edit menu → yesterday's check unchanged | Opus |
| **E6** | Floor plan / tables | ✅ Completed 2026-08-28 (full editor: add/edit/resize/retire, soft removal; decor elements deferred per D26) | Areas, tables, parties, guest counts | E4 | Table status derived from domain state, not UI **[T]** | Two-terminal table-state consistency test | Sonnet |
| **E7**✱ | Check engine | ✅ Completed | Commands: open/add/move/transfer; aggregate versions | E1–E5 | Order ≠ check; optimistic versioning **[T]** | Command idempotency + version-conflict tests | Opus |
| **E8**✱ | Dispatch + KDS | ✅ Completed | Immutable `ORDER_DISPATCH`; station routing; bump/recall | E7 | A dispatch fires exactly once; late acks never re-fire **[T]** | Duplicate-fire test under retry | Opus |
| **E9**✱ | Local durable store | ⬜ In queue | Local DB + write-ahead of every command | E7 | Local commit precedes any sync attempt **[T][S]** | Crash-kill: active check survives forced termination | Opus |
| **E10**✱ | Sync engine | ⬜ In queue | Operation journal, idempotent `/sync`, conflict handling | E8, E9 | Replayed `operationId` returns known result **[T]** | **10-case network-fault suite** green **[T]** | Opus |
| **E11**✱ | Split checks | ✅ Completed | By item/seat/amount as domain commands | E7, E1 | Money/quantity/tax conservation **[T]** | Property: random partitions conserve totals | Opus |
| **E12** | Discounts/comps/voids | ✅ Completed | Reason + approval + audit; pre/post-fire void semantics | E7, E8 | Post-fire void hits kitchen + audit, not just totals **[T]** | Void-after-fire scenario test | Opus |
| **E13**✱ | Payment adapter | ⬜ In queue | PaymentIntent/Attempt model; one provider (ADR-3); webhooks | E1, E7 | Never store PAN; pending-upload ≠ authorized **[T][S]** | Sandbox: decline, timeout, duplicate webhook, late auth | Opus |
| **E14** | Cash + drawer | ✅ Completed | Cash tender, drawer sessions, pay-in/out ledger | E13 | Cash events immutable **[T]** | Over/short reconciliation test | Sonnet |
| **E15** | RBAC + audit | ✅ Completed | PIN sessions, manager-approval tokens, append-only audit | E4 | Server-enforced permissions; audit has actor+device+reason **[T]** | Privilege-escalation + audit-completeness tests | Opus |
| **E16** | EOD close | ✅ Completed | Business-day close with blockers | E13–E15 | Close is a workflow with blockers, not a report **[T]** | Close blocked by open check / unreconciled drawer | Sonnet |
| **E17** | Offline UX + recovery | 🔄 In progress | Cloud/LAN/payment status indicators; crash restore | E9, E10 | Staff always know what's safe to do **[T]** | Status-indicator truth test per fault case | Sonnet |
| **E18** | Hardening + SLOs | ⬜ In queue | Latency budgets measured; telemetry live | all | SLOs per **[S]** latency table | Measured: tap-to-check, crash-restore, 100-line re-render | Sonnet |
| **E19** | Insights v1 (server report + heatmap) | ✅ Completed | Per-server scorecard + hour/day sales heatmap as read-only ledger projections (D19; Phase 6 slice pulled forward) | E15 | Reports computed on read, never stored; per-server sums conserve against the day summary | Insights totals equal the close-day summary to the cent | Opus (core) + Sonnet/Codex (UI) |
| **E20** | Guestbook / guest intelligence | ✅ v0 completed 2026-08-23 (spec + core + screens; card-recognition rung waits on E13) | Guest profiles: favorites, spend, visit history, preferred section/server (D20 identity ladder) | E13, E19 | Never store PAN (D2); privacy defaults per Matt deck | Spec signed off; later: returning-guest recognition in sandbox | Sonnet (spec), build TBD |
| **E21** | Venue settings + staff management | ✅ Completed 2026-08-28 | Venue identity (name/address/timezone) and the staff roster as DATA, not source: Settings screen, roster CRUD with hashed PINs | E15 | Last-manager guard; PINs never displayed or imported | Rename the venue and every header, receipt, and lock screen follows | Opus (core) + Sonnet/Codex (UI) |
| **E22** | Migration / onboarding | ⬜ In queue (spec first, D26) | Import a switching restaurant: menu CSV into draft-then-publish, staff CSV with fresh PINs, floor redrawn | E5, E21 | Imports land as drafts, idempotent, source-audited; no sales history or gift-card liabilities in v1 | Spec signed off against a real customer export | Sonnet (spec), build TBD |

**Status as of 2026-08-28** (15 completed, 2 in progress, 5 in queue). Where the non-clean rows stand:

- **E5 menu/config**: the draft → manager publish → immutable snapshot loop is live at `/menu`, with the 86 board and repricing. The draft is still a document (migration 0003) rather than the relational menu graph; group/modifier editing (E5-full) is the remainder.
- **E17 offline UX**: offline card payments are honest today (pending-upload state, and the day close refuses to seal on them). The cloud/LAN status indicators and crash restore wait on E9 and E10, which is what the dependency column says.
- **E9, E10** (local durable store, sync engine): the sync journal table and idempotent operation ids exist from E4/E7, but no local write-ahead store and no `/sync` endpoint. Both are gated on **D6** (Matt) via ADR-1/ADR-2: whether orders must reach the kitchen with the Internet down decides the whole shape.
- **E11 split checks (closed 2026-08-22)**: T1 (pure `splitCheck`), T2 (split preview API + labeled portion payments), T3 (POS split flow + per-portion receipts), and T4 (server-side cross-partition overpay guard) all merged, each built by a delegated worker session and cross-model reviewed. The same D22-batched session also shipped E8-T2 (KDS settled-check chip + day-close rail sweep) as a guardrail on the completed E8/E16 epics.
- **E19 insights (closed 2026-08-23)**: T1 (server attribution + the two read APIs), T2 (the /insights page: tiles, server scorecard, heatmap), and T3 (the declared-tips total fix from T2's review) all merged, each built by a delegated worker session and reviewed. The reporting slice inspired by Lightspeed is live end to end.
- **E13 payment adapter**: blocked on **ADR-3** (provider choice) with Matt. Payment is simulated end to end today, which is why E14 and E16 could ship ahead of it despite the stated dependency.

UI epics (order-entry screens, KDS screen, floor-plan screen) ride alongside E6–E8 as Sonnet tickets, the prototypes are the UX reference **[S]**, the domain package is the only source of truth.

### 7.3 Worked example: one ticket in full contract form

```markdown
## Ticket E1-T3: Rounding allocation for proportional splits
**Epic:** E1 Money engine · **Build model:** Opus · **Review tier:** cross-model (Fable)
**Status:** Ready

### Context
Splitting a $120.01 check three ways cannot produce 3 × $40.0033…. The money engine
needs a largest-remainder allocation: distribute integer cents proportionally, assign
remainder cents deterministically (by line order), never lose or invent a cent.
See docs/adr/ADR-1; invariant #5 in Master Plan §4.

### Invariants that must hold
- sum(allocations) == original amount, exactly, for every input [T §money]
- Allocation is deterministic: same input → same output (no Map-iteration-order dependence)
- No floating-point arithmetic anywhere in the call path [T]

### Acceptance criteria
- Financial: $120.01 / 3 → [$40.01, $40.00, $40.00]; works for any n ≥ 1, any amount ≥ 0
- Distributed-state: pure function, no I/O, no clock, usable identically client- and server-side
- Interaction: n/a
- Operational: allocation recorded per split line so EOD reconciliation can explain each cent

### Tests to add
- Property test: ∀ amount ∈ [0, 10^9] cents, ∀ n ∈ [1, 50], ∀ weight vectors:
  sum conserved, each allocation within 1 cent of exact proportion, deterministic
- Fixture: the [S] $120 = $40 Visa + $50 cash + $30 MC example

### File scope
- In scope: packages/domain/src/money/allocate.ts, packages/domain/test/money/allocate.test.ts
- Out of scope: tax engine, check engine, any schema file

### Definition of done
Code + property tests green in CI + no lint errors + cross-model review findings resolved
+ demo note: run `npm test -w packages/domain -- allocate` and read the property-test output
```

---

## 8. Governance & cadence

### 8.1 Weekly rhythm (part-time founder)

| Block | Session | Content |
|---|---|---|
| **Plan** (1×/wk) | Orchestrator (Opus) | Read `BACKLOG.md`+`DECISIONS.md`; groom tickets; promote Draft→Ready; assign the week's Delegated set |
| **Build** (2–4×/wk) | Workers (per §5.2) | One ticket per session, contract-scoped |
| **Review** (1×/wk) | Founder + reviewer agents | Verify Agent-reviewed tickets; run demos; merge; update decision log |

### 8.2 Gates
- **Milestone gate** (Phase 4): all epic exit tests green in CI + founder demo + go/no-go checklist (any Critical-risk regression blocks).
- **Phase gate:** exit criteria in §6, checked explicitly, results recorded in `DECISIONS.md`.
- **Matt demo** (monthly during Phase 4): feedback triaged in the next Plan block, "that's not how a restaurant works" is a P0 bug class, entering the backlog as tickets, never as ad-hoc changes.

### 8.3 Repo conventions
Git from Phase 0.1 (WP-0.1). Branch per ticket (`e07-t2-transfer-command`); commit messages reference ticket IDs; ADRs in `docs/adr/`; `BACKLOG.md` and `DECISIONS.md` at root (§5.5). CI required on every PR once the toolchain exists (Phase 4, milestone 1).

**Writing style (all documents, UI copy, commit messages):** never use em dashes. Use commas, colons, periods, or parentheses instead. [Decision, 2026-08-11: founder preference, applies to human and agent-written content alike.]

### 8.4 Change control
Scope changes route **PRD amendment → decision-log entry → new/changed tickets**, never straight into a worker session. Schema changes are expand/contract only **[T]** and always founder-approved. The prototypes remain frozen as discovery artifacts; V1 code lives in its own tree.

---

## 9. Room for Matt: standing reservations

Decisions never made without operator input, by phase:

| Phase | Reserved for Matt |
|---|---|
| 0 | All 21 pilot questions **[T]**; the mockup-raised questions below; which prototype UX feels right; pilot criteria |
| 1 | PRD review; scope strikes/additions; what "sellable" means to a real operator |
| 2 | Kitchen state semantics (prep vs expo); payment behaviors (tips post-auth, preauth/tabs, offline-card limit); venue hardware reality |
| 3–4 | Milestone demos; workflow-reality bug reports |
| 5 | Pilot venue introduction; shadow-run tolerance; go/no-go on cutover |
| 6+ | Which intelligence recommendation he'd actually act on **[PRD §14]** |

### Questions the mockup itself raised

Building the flagship forced choices that only an operator can settle. Each is currently a defensible guess, marked `INFERRED`, and each is cheap to change now and expensive to change after Phase 4.

| Question | What we guessed | Why it matters |
|---|---|---|
| Should tapping an occupied table open the check directly, or show table actions first? | Actions modal first | One tap on the most repeated action of the shift, against discoverability of transfer and guest count |
| How long should a just-fired course read as `New` on the KDS? | 3 minutes | Too short and the line misses it; too long and everything looks new |
| Can a station bump a table out, or only expo? | Expo only, from the all-stations view | Determines whether station screens are cook-only surfaces |
| How long should a served table stay recallable? | 10 minutes | The recovery window for a mis-bump during a rush |
| Should an all-plated but unserved table re-escalate? | No | Food dying in the window is a real failure mode with no current alarm |
| Does a party of 6 or more trigger auto-gratuity, and at what threshold? | Not modeled | Changes check math, not just display **[T]** |
| Should covers be forced at seating, or optional? | Required to seat | Affects per-cover reporting integrity |

Founder kitchen experience (3 years sous chef) already shaped the KDS design and is logged as `OBSERVED` in `docs/discovery/notes-2026-08-12-andy.md`. Matt's answers either confirm those or override them.

---

## 10. Quality system

### 10.1 Definition-of-Done ladder

| Level | Done means |
|---|---|
| **Ticket** | Contract's tests green in CI; lint clean; review findings resolved; founder verified; merged |
| **Epic** | All tickets merged; epic exit test (§7.2) green; invariants demonstrated, not asserted |
| **Milestone** | Demoable end-to-end; gate checklist passed; no Critical-risk regression |
| **Phase** | §6 exit criteria checked and recorded in `DECISIONS.md` |

### 10.2 Test pyramid → ownership

| Layer | What | Who writes | Who runs |
|---|---|---|---|
| Property/invariant | Money/quantity/tax conservation; modifier validity **[T]** | Worker (per ticket contract) | CI, every PR |
| Domain unit | State transitions, permissions, totals **[T]** | Worker | CI |
| Sync/fault | 10-case network-fault suite **[T]** | E10 epic (Opus) | CI (fault harness) |
| Multi-terminal E2E | Concurrent same-check edits; Playwright **[T][S]** | Sonnet tickets | CI nightly |
| Hardware-in-loop | Card terminal, printers, drawer, KDS network **[T]** | Founder, scripted checklists | Phase 5, on venue hardware |
| SLO measurement | [S] latency budgets | E18 | Milestone 8 + pilot |

### 10.3 Review depth by blast radius
Cross-model review (build model ≠ review model) is mandatory for §5.2 row 1 (money, sync, payments, schema). Standard `/code-review` for everything else. A finding of `CONFIRMED` severity on a money path blocks the milestone gate, not just the ticket.

---

## 11. Risks & kill criteria

**Critical risks** (from Toast's register **[T]**, plus ours):

| Risk | Mitigation |
|---|---|
| Offline synchronization ("basic demos work perfectly online") | Operation journal + IDs + versions; 10-case fault suite from milestone 4, not after |
| Payment state ("charge card looks like one action") | Provider-neutral state machine, signed webhooks, reconciliation |
| Split checks / tenders (huge state space) | Domain command + property-based conservation tests |
| Money/tax rounding | Central integer-minor-unit engine + fixtures (E1) |
| Kitchen duplication (retries become duplicate food) | Idempotent dispatch/ticket IDs (E8) |
| **Part-time pace vs incumbent speed** `INFERRED` | Milestone discipline; scope ruthlessly to one restaurant's operating model; AI-agent leverage |
| **Pilot dependency** `UNKNOWN` | Matt's network; criteria defined in Phase 0 so the search starts early |
| Operational support (pilot can't debug our stack) | Telemetry + health screen + runbook before cutover **[T]** |

**Agent-specific risks** `INFERRED` **[Decision]**:

| Risk | Mitigation |
|---|---|
| Hallucinated APIs / invented library behavior | Ticket contracts pin file scope; reviewer verifies against real deps; CI catches what review misses |
| Invariant drift across sessions (agent "simplifies" a rule it never saw justified) | Invariants restated inside every ticket contract; §4 principles in `CLAUDE.md`; repo-as-memory (§5.5) |
| Review blind spots when one model writes and reviews | Cross-model review mandatory on critical paths (§5.2) |
| Scope creep inside a session | Out-of-scope file list in every contract; workers return the ticket rather than improvise (§5.2) |
| Chat-history decisions getting lost | Nothing is decided until it's in `DECISIONS.md` (§5.5, §8.4) |

**Kill / pivot criteria** `INFERRED`: if by end of Phase 1 no operator (Matt included) identifies a recommendation or workflow they'd switch POS for, or if by Phase 5 no venue will shadow-run, pivot back to the Operator-Console-above-existing-POS strategy **[PRD §1]**, keeping the domain model and research as assets. The PRD's success metric stands: **learning, not visual polish** **[PRD §14]**.

---

## 12. Decision log

| # | Decision | Status | Evidence |
|---|---|---|---|
| D1 | RestaurantOS is a POS; intelligence layer is the differentiator, not a separate product | **Decided** 2026-08-11 | [Decision]; resolves PRD §15 open question |
| D2 | Integrate payments (Stripe Terminal / Adyen); never build processing; never store PAN | **Decided** | **[T] [S]** unanimous |
| D3 | Modular monolith + PostgreSQL + transactional outbox; no microservices/K8s for V1 | **Decided** | **[T]**, consistent with **[S]** |
| D4 | Local-first write ordering; frontend is never the ledger | **Decided** | **[T] [S]** unanimous |
| D5 | Build with Claude Code, Opus/Fable for domain/sync/payments, Sonnet for routine tickets; operating model per §5 | **Decided** 2026-08-11 | [Decision] |
| D6 | LAN-continuous service during WAN failure = P0? | **Open, Phase 0 gate** | **[T]** says freeze early; needs Matt. `UNKNOWN` |
| D7 | Stack (React/TS/PWA leading candidate) | **Open, Phase 2 ADR-1** | **[T]** vs **[S]** timing conflict, resolved to decide post-D6 |
| D8 | Payment provider (Stripe vs Adyen) | **Open, Phase 2 ADR-3** | Constrained by offline + tip/preauth needs **[T]** |
| D9 | Client platform (PWA/Electron/native) | **Open, Phase 2 ADR-4** | Decided against pilot hardware **[S]** |
| D10 | Pilot venue | **Open, Phase 0/5** | Matt's network. `UNKNOWN` |
| D11 | Design language = RestaurantOS system, derived from Wise (`design/restaurantos/`) | **Decided** 2026-08-11 | [Decision]; evaluated 8 of 54 candidate themes, see §14 |

---

## 13. Traceability appendix (skeleton: filled during Phase 3)

Requirement → source → epic → test, one row per PRD requirement. Seed rows:

| Requirement | Source | Epic | Exit evidence |
|---|---|---|---|
| Split check conserves money/quantity/tax | **[T]** risk register, **[S]** financial correctness | E11 | Property test: random partitions conserve totals |
| Order survives terminal crash | **[S]** persistence layer, **[T]** crash recovery | E9 | Crash-kill test |
| Duplicate kitchen fire impossible under retry | **[T]** kitchen duplication risk | E8 | Duplicate-fire test |
| Offline-accepted payment never shows "Paid" | **[T]** offline payments | E13, E17 | Status-truth test per fault case |
| Post-fire void reaches kitchen + audit | **[T]** pilot question | E12 | Void-after-fire scenario |
| Menu edit never rewrites yesterday's check | **[T]** MENU_SNAPSHOT | E5 | Snapshot immutability test |
| *…(one row per PRD requirement, Phase 3)* | | | |

---

## 14. Design Theme & Atmosphere

**Decision (D11):** RestaurantOS ships its own design system, **derived from the Wise design language** and adapted for POS. The full spec lives at **`design/restaurantos/`** (`DESIGN.md` + Day/Night preview pages), that folder is the single source of truth for all UI work; this section records only the decision and its rationale.

**How it was chosen:** 8 of 54 candidate themes from the design-template library were evaluated against RestaurantOS's two surfaces, the touch POS terminal (Phase 4) and the operator analytics console (Phase 6): Linear, Stripe, Airbnb, Uber, Cal.com, Superhuman, Wise, Vercel. Wise scored highest on both (8/10 + 8/10) as the **only theme with a genuine semantic/status palette** (5 hues vs 0–3 everywhere else), hospitality-appropriate warmth (warm off-white, pills, large radii, not enterprise-cold), a free body typeface (Inter), and dense-enough spacing for data. Runners-up were split single-surface specialists: Uber (POS 7, contrast + only 44px spec, but zero color) and Stripe/Vercel (console 9, tabular numerals, metric cards, but cold and light-only). `OBSERVED` from the template docs.

**The three adaptations** (all specified in `design/restaurantos/DESIGN.md`):
1. **Night mode**, full warm-black theme; no candidate shipped a real dual-mode system, and half of restaurant service happens in dim rooms. Token architecture follows the pattern proven in the `index.html` prototype.
2. **Service-status palette**, four state triples (info=new, amber=working, green=ready, red=late), each solid/wash/line, identical across POS, KDS, tables, and console. Includes the **lime/green rule** (brand lime = fill-only CTA; status green = ink/line-only state) resolving Wise's CTA-vs-ready collision, and the **offline honesty rule** (locally-accepted payment = amber "pending upload," never green "paid"), §4 principle 7 expressed in color.
3. **Touch layer**, 44px minimum / 48px primary targets, press feedback ≤100ms, hover-independence, two-step destructive actions.

**Atmosphere in one line:** *a well-run dining room five minutes before doors open*, warm linen and near-black by day, warm black by night, one lime jolt for forward actions, and status colors loud enough to read from the pass.

**Binding effect on the WBS:** UI tickets in §7.2 (tile grids, check card, KDS tickets, console metric cards) inherit their acceptance criteria from `DESIGN.md` §§2–8; a UI ticket's Definition of Done includes token-conformance (no colors or radii outside the system). Design-system changes route through change control (§8.4) like any scope change.

---

*Sources: `Toast-deep-research-report.md` **[T]**, `Square-deep-research-report.md` **[S]**, `RestaurantOS_Operator_Console_PRD.md` **[PRD]**, `design/restaurantos/DESIGN.md` (design system). See CLAUDE.md for what in the reports is load-bearing vs ungrounded.*
