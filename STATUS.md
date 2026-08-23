# STATUS

**The at-a-glance view: where the project is right now.** Updated at the end of every working session. Detail lives in [BACKLOG.md](BACKLOG.md) (tickets), [DECISIONS.md](DECISIONS.md) (decisions), and the [master plan](docs/plans/RestaurantOS_Master_Plan_v2.0.md) (the map).

**Last updated:** 2026-08-23

## Where we are

```
Phase 0  Discovery        ████████░░  waiting on Matt sessions (the only blocker)
Phase 1  POS PRD          ██████░░░░  draft v0.1 done, Matt review pending
Phase 2  Domain + arch    ██████░░░░  schema + domain model done; ADRs frozen on D6
Phase 3  V1 backlog       ██░░░░░░░░  epic table exists; ticket contracts not yet written
Phase 4  Build            █████████░  12 epics done (E11 splits closed), E5/E17/E19 in progress: lock screen + six screens + PostgreSQL (118 tests)
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
| **API server** (Fastify, D16): the command protocol live over HTTP: open/order/fire/pay/close, idempotent operation ids, 409 version conflicts, modifier refusals with exact errors, offline cards block close | 10 API tests + verified against the running server with curl |
| **Insights read APIs (E19-T1)**: every check records the server who opened it; `/v1/insights/servers` (server scorecard: net, tips, covers, avg check, per cover, turn minutes, voids, per-course value, Average row) and `/v1/insights/heatmap` (day x hour net sales). Computed on read, nothing stored | 4 API tests incl. conservation against `/v1/day` (per-server net = gross - discount, per-server tips = day tips) + verified with curl against the running server |
| **Insights screen (E19-T2)** at `/insights`: tonight-at-a-glance tiles, the server scorecard (stacked course bars per server, muted Average row, tap for rank/actual/average/variance on eleven metrics plus net by course), and the hour x day heatmap with a per-day share row | Verified in Chrome, Day and Night at 1280px and at 390px, against a seeded two-server service; tiles agree with `/close` to the cent |
| **POS web client v0** at `/pos`: the page experience on the real engine: checks rail, menu, modifier modal (required groups, nesting), seats, send, tip/pay, close, 409 recovery, mobile tabs | Screenshot-verified against the running server with seeded live state |

## Run it

```powershell
cd app\server
npm install    # first time only
npm run dev    # then open http://localhost:3000
```

The app opens on the **lock screen**: a PIN pad, like a real POS terminal boots to. Enter a staff PIN (below) and it signs the device in, clocks you in, and lands on Service. Sign-out or clock-out locks the terminal again.

**Demo staff (E15):** Gia R. (server, PIN 2468), Marco B. (manager, PIN 1122), Sofia T. (server, 3579). Sign in from the POS header; anything privileged (voids, discounts, pay-outs, day close, menu publish, merges) needs a MANAGER's PIN now, so use Marco's 1122. A server's PIN refuses.

Six live screens, all real commands to the server:

- **/pos** Service: checks rail, table picker from the live floor, modifier modal (required groups, nesting), seats, send, tip/pay (offline simulation), close. Tap a line to void it (reason + manager PIN, audited); the % button applies discounts/comps; the ⋯ button transfers, merges (manager), or shows the **printable guest receipt**
- **/tables** Floor: the spatial room per section, live status (open/seated/paying/kitchen-late), tap an open table to seat a party, tap an occupied one to jump to its check. **Edit layout** mode: drag tables to match your real room; each drop saves to the server and shows on every device
- **/kds** Kitchen: one card per table, New flags, per-item bump, expo-gated Serve, 10-minute recall, cook-together pane. A voided item shows struck-through in red and never blocks Serve. A card whose check already paid or closed carries an amber "check closed" chip and stops counting late: settled guests are a cleanup task, not a late table
- **/menu** Menu manager: edit a draft (add/change/remove items), then a manager publish freezes it into the next immutable snapshot version; new orders reprice, ordered lines never move. The live 86 board (instant 86, running counts that auto-86 at zero) needs no publish and shows on POS tiles as "3 left" badges
- **/close** End of day: this is the lunch+dinner close-out. Drawers from counted float to frozen over/short, the Team section (clock out + declared cash tips, confirmed by the employee's own PIN), today's closed checks with a manager Reopen button, and the day close that refuses until every check is settled, every drawer counted, the kitchen rail swept (unbumped tickets are named by table and course), and everyone is clocked out. Blockers link straight to the offending item

- **/insights** Operator report: covers, checks, net sales, avg check and tips for tonight, then the server scorecard (one stacked bar per server, a segment per course, the Average row muted underneath) and the busiest-times grid of hour x day shaded by net sales. Tap a server for their card (rank, actual, average, variance, net by course), tap a cell for that hour's net, checks and covers. Read-only: every figure is computed by the server from closed checks, nothing on this page is stored

Try the two-device demo: `/pos` on a phone, `/kds` on the laptop, fire an order and watch it land.

**Persistence:** by default state is in-memory. Set `DATABASE_URL` and the same server runs on PostgreSQL (migrations apply automatically, checks survive restarts):

```powershell
$env:DATABASE_URL = "postgres://postgres:YOURPASSWORD@localhost:5432/restaurantos"
npm run dev
```

Domain tests: `cd app\domain && npm test` (70). Server tests incl. a throwaway-PostgreSQL integration: `cd app\server && npm test` (48).

## How work runs now (D21)

The orchestrator (Fable) plans, writes ticket contracts under `docs/tickets/`, assigns models, and reviews; worker sessions build, ONE at a time (all sessions share this folder). Merged so far: E11-T1 through T4, E8-T2, and all of E19 (T1 attribution + read APIs, T2 the /insights page, T3 the declared-tips fix found in T2's review). Epic E19 closed 2026-08-23: the reporting slice is live end to end. E20-T1 (the guestbook spec) merged the same day. The founder then approved building the guestbook v0 now (D23) and renaming the reporting tab to Reports (D24, "Insights" is reserved for the AI layer). Firing order: 1) E20-T2 (Opus, guestbook core). 2) ONE Sonnet/Codex session batching E19-T4 (rename) then E20-T3 (guestbook screens) per D22. Then the queue waits on Matt or on an E5-full ticket. One-liner to fire a ticket: "You are a worker session. Execute the ticket at docs/tickets/<name>.md exactly; it is your entire scope."

## In flight

- Next queued: payment provider adapter (E13, wants ADR-3 with Matt), per-seat receipts, relational menu editor (E5-full). The Matt-independent epic list is built through; remaining work deepens what exists or waits on decisions.

## Waiting on Andy

1. **Send Matt the link + walkthrough** (WP-0.2a). This starts the only clock that matters.
2. Schedule the Matt session (guide ready: `docs/discovery/operator-session-guide.md`).
3. Decide: keep or delete `prototypes/index_RestaurantOS_Gemini.html` (merged already).

## Waiting on Matt

1. **D6: must orders reach the kitchen when the Internet is down?** Gates ADR-1 (stack) and ADR-2 (edge hardware), which gate the server build (E4+).
2. The question decks (A, A2, B, and now C: guest data and privacy) in the session guide: policy answers that retrofit cleanly.
3. PRD review and scope signoff (WP-1.2).

## Risks being watched

- Matt latency: mitigated by D13 (parallel track) but the pilot clock cannot start without an operator.
- Solo-founder pace: the agent operating model (master plan §5) is the leverage; E1-E3 shipped in one day of sessions.
