# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository purpose

This is the **product-discovery and planning repo for RestaurantOS** — a startup building a restaurant POS to compete with Toast and Square, with an operator-intelligence layer as the differentiator. It contains prototypes, research, plans, and a design system. There is no build system, package manager, backend, or test suite (that arrives in Phase 4 per the master plan).

## Commands

None — no build, lint, or test step, and nothing to install. Verify every prototype change by opening the file in a browser and clicking through all screens plus the modals:

```powershell
start prototypes\index_RestaurantOS.html
```

Ignore the CI/lint/test/dependency tooling recommended in the research reports (see below); it targets the future production product, not this repo.

## Layout & files

**`docs/plans/RestaurantOS_Master_Plan_v2.0.md`** — the project's source of truth for *what happens next*: vision, phased roadmap (discovery → POS PRD → domain model → backlog → build → pilot), the **Agent Operating Model** (roles, model assignment, ticket contracts, review rules for Claude Code agents), work breakdown structure, governance, decision log, and design-language decision. **Consult it before starting any non-trivial work.** `docs/plans/archive/` holds the superseded v1.0.

**`prototypes/index_RestaurantOS.html`** ★ — the flagship mockup: "Osteria Nove," a fictional Italian full-service restaurant on the RestaurantOS design system. Four screens (Service / Tables / Kitchen / Insights) plus modals. Features beyond the discovery prototypes: course-based firing with hold/fire, seat-level ordering, live 86/stock counts, offline simulation with honest "pending upload" payment states, manager-PIN void approval, per-check audit trail, split payments (full/even/by-seat), Day/Night themes. Treat it as the default target when the user says "the prototype."

**`prototypes/discovery/`** — three first-generation POS mockups (Thai restaurant "Nine Thai Kitchen"): `index.html` (most developed, Linear-derived tokens, day/night), `index_Claude.html` (dark), `index_Codex.html` (light). Kept for comparison; alternate implementations of one brief — **an edit to one never auto-applies to the others.** The multi-check model differs: `index.html`/`index_Claude.html` hold many concurrent checks (`state.orders{}` + `cur()`), `index_Codex.html` holds a single `state.order`.

**`design/restaurantos/`** — the RestaurantOS design system (decision D11): `DESIGN.md` (9 sections — atmosphere, tokens, typography, components, layout, elevation, do/don't, touch, agent prompt guide) plus Day/Night preview pages. Derived from the Wise design language; adds Night mode, the service-status palette (info/amber/green/red triples + the lime/green rule), and the 44px touch layer. **All new UI must conform to it**; changes to the system itself route through master-plan change control (§8.4).

**`docs/prd/`** — `RestaurantOS_Operator_Console_PRD.md`: the intelligence-layer concept (Today / Food Cost / Labor / Inventory / AI Advisor). Per master-plan decision D1 this is **not a separate product**: its concepts become Phase 6 features on the POS. Its non-goals ("no production POS") reflect its original framing, which D1 superseded. `RestaurantOS_Codex_Prototype_Prompt.md` is its generation prompt.

**`docs/adr/`** — empty until Phase 2; ADRs land here (stack, edge/LAN, payment provider, client platform).

## The research reports (`docs/research/`) — read with a correction in mind

`Toast-deep-research-report.md` and `Square-deep-research-report.md` benchmark the incumbents and propose MVP architecture. **Their shared premise is false here:** both were written without access to the prototypes and mark all code-level findings `Not verifiable` (Toast) / `UNKNOWN` (Square) — the prototypes exist in this repo and predate both reports. Consequences:

- Neither report contains any finding derived from reading our code; ignore their audit/gap sections and any "put `index.html` into the review set" action items.
- `fileciteturn…`/`citeturn…` markers are dangling artifacts; they resolve to nothing.
- **Genuinely reusable** (and already folded into the master plan): Toast's domain model (order ≠ check, modifier graph, immutable menu snapshots, `ORDER_DISPATCH`, two state machines, sync protocol, command API, 21-question operator table, risk register); Square's evidence discipline (`DOCUMENTED/OBSERVED/INFERRED/UNKNOWN`), payment decomposition, four correctness classes, latency budgets.
- **Do not act on**: their npm/CI/tooling prescriptions, GitHub Actions YAML, `package.json` blocks, or diff-formatted "fixes" (the code they fix is invented illustration). Those arrive, adapted, in Phase 4 with the real toolchain.
- Square claims a required deliverable `Square_Restaurants_Deep_Research_and_RestaurantOS_Build_Blueprint.md` that doesn't exist — ask before authoring it.
- The reports contradict the PRD's original scope (intelligence layer vs POS); decision D1 resolved this in favor of the POS.

## Working in this repo

- Every prototype must stay zero-dependency, single-file, openable by double-clicking, working offline. Preserve this when editing.
- Prototype `<script>` blocks are organized into numbered, commented sections (demo data → state → utilities → navigation → per-screen renderers → modals → seed/boot). Put changes in the owning section.
- Demo data is hardcoded near the top of each script (`MENU`/`OG`/`TABLES` in the flagship) — edit in place, never add external data files.
- "Concept Prototype" badges, fictional branding, "demo data only" disclaimers, and notes about deliberate omissions must stay visible — they are the product framing, not placeholders.
- Unimplemented actions toast "…isn't in this prototype yet" — follow that pattern for stubs.
- Touch rules from the design system are non-negotiable: ≥44px targets, press feedback, no hover-only affordances, safe-area insets.
- Seeded demo state opens mid-service on purpose (an empty POS demos badly) — keep it that way.
- New UI uses the tokens in `design/restaurantos/DESIGN.md` — no colors or radii outside the system.
- This repo is a git repository. Branch-per-change and commit conventions per master plan §8.3; commit only when asked.
