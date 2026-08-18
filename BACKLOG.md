# BACKLOG.md

The authoritative ticket list (master plan §5.5). Currently tracking Phase 0 work packages; build epics (E1..E18) arrive in Phase 3.

## Phase 0: Close out discovery

| WP      | Item                                                                                                                       | Status                                 | Owner        |
| ------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------ |
| WP-0.1  | Repo under git, layered layout, demo doc (README)                                                                          | **Done** 2026-08-11              | Orchestrator |
| WP-0.2  | Operator sessions with Matt (guide:`docs/discovery/operator-session-guide.md`)                                           | **Ready, waiting on scheduling** | Andy + Matt  |
| WP-0.2a | Send Matt the walkthrough (`docs/RestaurantOS_User_Guide.docx` / `.pdf`) plus the live demo link, ahead of the session | **Ready to send**                | Andy         |
| WP-0.3  | Discovery notes, labeled OBSERVED/INFERRED                                                                                 | Blocked by WP-0.2                      | Andy         |
| WP-0.4  | Pilot-selection criteria (draft in session guide, finalize with Matt)                                                      | Draft done                             | Andy + Matt  |
| WP-0.5  | Freeze D6 (LAN survival P0?) in DECISIONS.md                                                                               | Blocked by WP-0.2                      | Andy         |

**Phase 0 exit:** question deck answered (or explicitly deferred), D6 frozen, pilot criteria final.

## Phases 1-2, Matt-independent track (opened early per D13)

| WP      | Item                                                                                                                                      | Status                                   | Owner                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------- |
| WP-2.1a | Database schema (`docs/domain/schema.sql`, 44 tables) verified against PostgreSQL 17: clean apply, FK chain, constraint tests           | **Done** 2026-08-12                | Orchestrator (Opus-tier work) |
| WP-2.1b | Domain model doc (`docs/domain/domain-model.md`): aggregates, two state machines, command surface, invariants ledger, Matt-impact table | **Done** 2026-08-12                | Orchestrator                  |
| WP-1.1  | Draft`docs/prd/RestaurantOS_POS_PRD.md`: 38 FRs traced to epics, defaults on every UNKNOWN so nothing blocks                      | **Draft done** 2026-08-12; Matt review pending (WP-1.2)                                 | Orchestrator                  |
| WP-2.2  | ADR-1 (stack), ADR-2 (edge/LAN)                                                                                                           | **Frozen on D6 (Matt)**            | Founder + Orchestrator        |
| WP-2.2b | ADR-3 (payment provider), ADR-4 (client platform)                                                                                         | Draftable as comparisons; decision waits | Orchestrator                  |
| WP-1.2  | Matt review cycle, scope signoff (V1 / P1 / P2 / never)                                                                                   | Blocked on Matt                          | Andy + Matt                   |

## Phase 4: first code (opened per D13 + D15)

| Epic | Ticket | Status |
|---|---|---|
| E1 money engine | `app/domain/src/money.ts`: applyRate (single half-up rounding site), allocateEvenly, allocateByWeights (largest remainder, BigInt-exact), lineTotalMinor, computeCheckTotals. 21 tests green incl. properties: conservation, one-cent fairness, determinism, weights-identity, end-to-end split-after-tax conservation | **Done** 2026-08-12 |
| E1 follow-ups | Tip allocation across splits, cash rounding for non-US currencies, tax-inclusive pricing mode | Backlog, pilot-dependent |
| E2 state machines | `checkLifecycle.ts` + `kitchenLifecycle.ts`: pure transition functions, guards as booleans from the command layer. Exhaustive tables (all 66 check pairs asserted) + random-walk properties (voided inescapable, closed exits only via approved reopen) | **Done** 2026-08-12 |
| E3 modifier validation | `modifiers.ts`: min/max/duplicates/nesting/depth validator, error-collecting, total over corrupt snapshots; selectionPriceMinor + defaultSelections. Fixture suite + generated-menu properties | **Done** 2026-08-12 |
| E4+ | Schema migration tooling, server skeleton | Waits on ADR-1 ratification (D6) |

Suite total: 54 tests green (`app/domain`, vitest + fast-check).

## Flagship mockup: done since first cut

Tracked here because the mockup is the Phase 0 conversation tool, so its state matters to WP-0.2.

| Date  | Change                                                                                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------- |
| 08-11 | Check switching, working table transfer, cancel-empty-check, More menu with stubs                                     |
| 08-11 | Reversible KDS (back-step, recall window) instead of one-way bump                                                     |
| 08-11 | Spatial floor plan: positioned tables, shapes, decor, legend                                                          |
| 08-11 | Phone layout: bottom tabs, check bottom sheet, horizontal category rail                                               |
| 08-11 | Em dashes removed repo-wide; style rule recorded (D12)                                                                |
| 08-12 | KDS rebuilt on founder feedback: one card per table,`New` flags, per-item bump, expo-only serve, cook-together pane |
| 08-12 | Editable party size with seat-assignment guard; seat dots on floor plan                                               |
| 08-12 | Theme transitions, late pulse, focus-visible, reduced-motion (ported from a Gemini pass, minus its CDN font links)    |
| 08-12 | Phone viewport height fix (`--vph`), stock badge no longer overlaps item names                                      |

## Non-blocking side items

- Publish the mockup and master plan as private artifacts to share with Matt (optional, on request)
- Decide whether to keep or delete `prototypes/index_RestaurantOS_Gemini.html` now that its changes are merged
- Mockup-raised operator questions are consolidated in master plan section 9 and the session guide (deck A2)
