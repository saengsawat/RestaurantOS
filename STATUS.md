# STATUS

**The at-a-glance view: where the project is right now.** Updated at the end of every working session. Detail lives in [BACKLOG.md](BACKLOG.md) (tickets), [DECISIONS.md](DECISIONS.md) (decisions), and the [master plan](docs/plans/RestaurantOS_Master_Plan_v2.0.md) (the map).

**Last updated:** 2026-08-12 evening

## Where we are

```
Phase 0  Discovery        ████████░░  waiting on Matt sessions (the only blocker)
Phase 1  POS PRD          ██████░░░░  draft v0.1 done, Matt review pending
Phase 2  Domain + arch    ██████░░░░  schema + domain model done; ADRs frozen on D6
Phase 3  V1 backlog       ██░░░░░░░░  epic table exists; ticket contracts not yet written
Phase 4  Build            ███░░░░░░░  E1 + E2 + E3 done, 54 tests green
Phase 5  Pilot            ░░░░░░░░░░  venue not selected
Phase 6  Intelligence     ░░░░░░░░░░  by design, after pilot
```

Phases overlap deliberately (decision D13): everything Matt-independent moves; everything architecture-changing waits for him.

## Done and verified

| What | Proof |
|---|---|
| Flagship prototype (Osteria Nove), desktop + phone | Live at [saengsawat.github.io/RestaurantOS](https://saengsawat.github.io/RestaurantOS/) |
| Design system (Wise-derived, Day/Night, status palette) | `design/restaurantos/` |
| Illustrated operator walkthrough for Matt | `docs/RestaurantOS_User_Guide.docx` + `.pdf` |
| POS PRD draft: 38 FRs, every Matt unknown has a default | `docs/prd/RestaurantOS_POS_PRD.md` |
| Database schema, 44 tables | Verified against PostgreSQL 17: clean apply + constraint tests |
| Domain model: aggregates, state machines, command surface | `docs/domain/domain-model.md` |
| **E1 money engine** | 21 property tests: conservation, fairness, determinism |
| **E2 state machines** (check + kitchen) | Exhaustive transition tables (all 66 check pairs) + random-walk properties |
| **E3 modifier validation** | 17 tests: fixtures + generated-menu properties, nesting, corrupt-snapshot safety |

Run the code: `cd app\domain && npm install && npm test`

## In flight

- Nothing mid-task. Next up on the build track: E4+ waits on ADR-1; the Matt-independent option is drafting ADR-3/ADR-4 comparisons (payment provider, client platform) so decisions are fast when D6 lands.

## Waiting on Andy

1. **Send Matt the link + walkthrough** (WP-0.2a). This starts the only clock that matters.
2. Schedule the Matt session (guide ready: `docs/discovery/operator-session-guide.md`).
3. Decide: keep or delete `prototypes/index_RestaurantOS_Gemini.html` (merged already).

## Waiting on Matt

1. **D6: must orders reach the kitchen when the Internet is down?** Gates ADR-1 (stack) and ADR-2 (edge hardware), which gate the server build (E4+).
2. The question decks (A, A2, B) in the session guide: policy answers that retrofit cleanly.
3. PRD review and scope signoff (WP-1.2).

## Risks being watched

- Matt latency: mitigated by D13 (parallel track) but the pilot clock cannot start without an operator.
- Solo-founder pace: the agent operating model (master plan §5) is the leverage; E1-E3 shipped in one day of sessions.
