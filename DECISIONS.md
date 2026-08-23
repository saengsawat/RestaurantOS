# DECISIONS.md

Running log of project decisions. Nothing is decided until it is here. Mirrors master plan §12; this file is the working copy, the plan is updated at phase gates.

| # | Date | Decision | Status |
|---|---|---|---|
| D1 | 2026-08-11 | RestaurantOS is a POS; intelligence layer is the differentiator, not a separate product | Decided |
| D2 | 2026-08-11 | Integrate payments (Stripe Terminal / Adyen); never build processing; never store PAN | Decided |
| D3 | 2026-08-11 | Modular monolith + PostgreSQL + transactional outbox; no microservices/K8s for V1 | Decided |
| D4 | 2026-08-11 | Local-first write ordering; frontend is never the ledger | Decided |
| D5 | 2026-08-11 | Build with Claude Code per the agent operating model (plan §5) | Decided |
| D6 | | LAN-continuous service during WAN failure = P0? | **Open: Phase 0 gate, needs Matt** |
| D7 | | Stack (React/TS/PWA leading candidate) | Open: Phase 2 ADR-1 |
| D8 | | Payment provider (Stripe vs Adyen) | Open: Phase 2 ADR-3 |
| D9 | | Client platform (PWA/Electron/native) | Open: Phase 2 ADR-4 |
| D10 | | Pilot venue | Open: Phase 0/5 |
| D11 | 2026-08-11 | Design language: RestaurantOS system derived from Wise (`design/restaurantos/`) | Decided |
| D12 | 2026-08-11 | Writing style: no em dashes in any content (docs, UI, commits, chat) | Decided |
| D13 | 2026-08-12 | Phase overlap: Matt-independent Phase 1/2 work starts now (domain model, schema, PRD draft). Matt's answers retrofit via change control; anything D6-dependent (edge/LAN, stack ADR) stays frozen | Decided (founder) |
| D14 | 2026-08-12 | Schema conventions: client-generated UUID ids, BIGINT minor units for all money, TEXT + CHECK for enums, immutable JSONB menu snapshots, org/location ids on every operational table, computed (never stored) totals | Decided, see `docs/domain/schema.sql` header |
| D15 | 2026-08-12 | Domain language: TypeScript (strict), app tree at `app/`, first package `app/domain` (pure, no I/O). Client framework and server framework remain open (ADR-1 full ratification still waits on D6) | Decided (founder go-ahead) |
| D16 | 2026-08-12 | Server skeleton ships now on Fastify (provisional; matches the leading-candidate stack, swap cost is one thin route layer). Rationale: D6 gates edge/LAN topology, not the cloud command API, and the founder expects a runnable server. Store is in-memory behind a Store interface; the PostgreSQL repository (E4) implements the same interface against schema.sql | Decided (founder) |
| D17 | 2026-08-20 | Worker model pool widened: external models (e.g. Codex) may take Sonnet-class tickets (§5.2 row 3: UI screens, fixtures, scaffolding) under the same ticket contract, review, and escalation rules. Money-touching and cross-module work stays Opus/Fable-class. Founder asked for this explicitly | Decided (founder) |
| D18 | 2026-08-20 | E11 v1 boundary: a split is a PAYMENT PARTITION over one check (preview computed on read, portions settled by labeled payments), not a fork into sibling check aggregates. Party-level check splitting at open time is deferred to a Matt conversation (deck A) | Decided (orchestrator, ticket E11-T2) |
| D19 | 2026-08-20 | Insights v1 (server performance report + sales heatmap) pulls forward NOW as read-only projections over the ledger (new epic E19), inspired by competitor observation (Lightspeed Restaurant). Nothing is stored; reports compute on read, same rule as totals. The guestbook is spec-only for now (E20) | Decided (founder) |
| D20 | 2026-08-20 | Guest identity ladder for E20: manual attach (name/phone) first, phone lookup second, automatic card-fingerprint recognition only after E13 lands (provider tokens only, never PAN, per D2). Privacy questions (consent, retention, staff visibility, deletion) go to the Matt deck with recommended defaults | Decided (founder direction, spec in E20-T1) |
| D21 | 2026-08-20 | Role boundary: the orchestrator session (Fable) plans, writes ticket contracts, assigns models, and reviews; it does NOT write product code. All build work is delegated to worker sessions (Opus for money/domain/cross-module, Sonnet/Codex for UI/docs/scaffolding per D17). Fable serves as the cross-model reviewer for Opus work | Decided (founder) |
| D22 | 2026-08-22 | Ticket batching: at orchestrator discretion, ONE worker session may execute two or more small same-model tickets STRICTLY SEQUENTIALLY, with one clearly labeled commit (group) per ticket and the full suite green at each boundary. Commits are the review unit, so verdicts stay separable (a passing ticket merges even if its batchmate fails). Parallel sessions remain forbidden (shared working folder) | Decided (founder + orchestrator) |
| D23 | 2026-08-23 | Guestbook v0 builds NOW (supersedes D19's spec-only stance): manual-attach rung only, per `docs/prd/guestbook-spec.md`, privacy defaults shipped as coded defaults pending Matt's deck C answers. Motivation: a working "we remember your regulars" demo for the Matt conversation. Fingerprints stay E13-gated, allergen tags stay C5-gated | Decided (founder) |
| D24 | 2026-08-23 | Naming: the live reporting screen is **Reports** (`/reports`); **Insights** is reserved for the Phase 6 intelligence layer (the mockup's "data turned into decisions") and leaves the live app until that layer exists. API paths (`/v1/insights/*`) keep their names: not user-facing copy, not worth the churn | Decided (founder, name proposed by orchestrator) |
