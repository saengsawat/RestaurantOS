# STATUS

**The at-a-glance view: where the project is right now.** Updated at the end of every working session. Detail lives in [BACKLOG.md](BACKLOG.md) (tickets), [DECISIONS.md](DECISIONS.md) (decisions), and the [master plan](docs/plans/RestaurantOS_Master_Plan_v2.0.md) (the map).

**Last updated:** 2026-08-28

## Where we are

```
Phase 0  Discovery        ████████░░  waiting on Matt sessions (the only blocker)
Phase 1  POS PRD          ██████░░░░  draft v0.1 done, Matt review pending
Phase 2  Domain + arch    ██████░░░░  schema + domain model done; ADRs frozen on D6
Phase 3  V1 backlog       ██░░░░░░░░  epic table exists; ticket contracts not yet written
Phase 4  Build            █████████░  15 epics done (E6 editor + E21 venue closed), E5/E17 in progress: lock screen + seven screens + PostgreSQL, any restaurant can set itself up (165 tests)
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
| **E2 state machines** (check + kitchen) | Exhaustive transition tables (all 72 check pairs) + random-walk properties, including the liveness fact that a reopened check can always close out (E2-T2) |
| **E3 modifier validation** | 17 tests: fixtures + generated-menu properties, nesting, corrupt-snapshot safety |
| **API server** (Fastify, D16): the command protocol live over HTTP: open/order/fire/pay/close, idempotent operation ids, 409 version conflicts, modifier refusals with exact errors, offline cards block close | 10 API tests + verified against the running server with curl |
| **Insights read APIs (E19-T1)**: every check records the server who opened it; `/v1/insights/servers` (server scorecard: net, tips, covers, avg check, per cover, turn minutes, voids, per-course value, Average row) and `/v1/insights/heatmap` (day x hour net sales). Computed on read, nothing stored | 4 API tests incl. conservation against `/v1/day` (per-server net = gross - discount, per-server tips = day tips) + verified with curl against the running server |
| **Reports screen (E19-T2, renamed by D24)** at `/reports` (`/insights` redirects): tonight-at-a-glance tiles, the server scorecard (stacked course bars per server, muted Average row, tap for rank/actual/average/variance on eleven metrics plus net by course), and the hour x day heatmap with a per-day share row | Verified in Chrome, Day and Night at 1280px and at 390px, against a seeded two-server service; tiles agree with `/close` to the cent |
| **Guestbook API (E20-T2)**: `guest` + `check_guest` (migration 0004) with attach on any check, manager-gated merge and delete, guest search, and the derived profile (favorites, spend, cadence, preferred section and server, tip percent). Nothing aggregated is stored, so merging or deleting a guest cannot move a cent | 7 API tests incl. conservation at two and three guests (a discounted check splits 871+871+871 = 2613), merge and delete proven not to touch a check, plus a PostgreSQL round trip | 
| **Coursed firing + check history (E8-T3)**: per-course Hold / Fire now on the check (`heldCourses` on the aggregate, Send skips holds and says so, one course fires to one ticket) and `GET /v1/checks/:id/history`, the check's story derived on read with no invented timestamps | 5 API tests (hold blocks Send and payment, fire clears the hold, all-held Send refuses by name, the timeline's order and sentences) + a PostgreSQL round trip |
| **POS web client v0** at `/pos`: the page experience on the real engine: checks rail, menu, modifier modal (required groups, nesting), seats, send, tip/pay, close, 409 recovery, mobile tabs | Screenshot-verified against the running server with seeded live state |
| **Nothing is hardcoded to the demo restaurant any more (D26)**: the room is drawn in the Tables editor, the venue and the roster are managed in Settings, and every header, receipt and lock screen reads the venue off the server | 165 tests, plus every screen driven in Chrome after a rename to a second restaurant. A fresh server still boots as Osteria Nove, so the demo out of the box is unchanged |
| **App shell on all six screens (UI-T1)**: navigation left the topbar for a left icon rail (inline-SVG icons, active state, live badge counts for open checks and open tickets); the topbar now carries identity and session state only, and becomes a bottom tab bar on phones | One test asserting the shell on all six pages at once, plus Chrome screenshots at 1280px and a true 390px (CDP device metrics) for /pos, /kds and /tables; every page measures scrollWidth 390 at 390 |
| **New check knows the room (UI-T4)**: seats on every table pill, pills grouped by section in the floor's own order, and a soft capacity guard where an undersized table mutes and takes a second tap to squeeze the party in | Page-serve assertion for the seats and guard hooks, plus the click path driven in Chrome (party of 5 mutes everything under five seats, Table 9 arms then takes, check opens with 5 covers on a 2-seat table, 44px pills at 390px) |
| **Check panel parity (UI-T3)**: lines grouped under course headers that state their own hold / fired / sent state, per-course Hold, Release and Fire now on E8-T3's commands, an explicit Discount · Void · History · More action bar, a batch void (many lines, one reason, one manager PIN) and a line sheet where a bare tap used to open the void dialog | Page-serve assertions for the bar, the history modal, the course controls and the absent void-on-tap, plus the whole click path driven in Chrome against the live server (hold, Send reporting the hold, fire, a two-line void with one PIN, the server-PIN refusal naming both lines, 17 history entries) |
| **Menu by category (UI-T2)**: the Service menu shows one course at a time from a category rail (a chip row on phones) instead of one scroll of everything, with the mockup's sub-labels; a menu publish rebuilds the rail and keeps the selection when it survives | Ordering re-driven end to end from a category in Chrome, 86 and "N left" badges unchanged, both publish cases (selection kept, selection dropped) run live against the server |
| **Floor editor core (E6-T2)**: a customer can draw their own room. Manager-gated add / edit / resize / retire beside the ungated move, removal SOFT (migration 0006 `retired_at` plus a partial unique index over active names only) so `party.table_id` and closed checks keep pointing at something real, re-adding a retired name revives the SAME row, and rename or retire is refused while a live check or an open kitchen ticket carries the name | 10 API tests plus a PostgreSQL test proving the parts only rows can prove: the appended `dining_area.sort`, the partial index, the revived table being the same `dining_table.id` with its party attached, and a booth surviving a restart. Live curl through add-in-a-new-area, both refusals, retire, and revive |
| **Venue + staff core (E21-T1)**: "Osteria Nove", its address, its timezone and three PINs stopped being source code. `GET /v1/venue` reads publicly, a manager-gated update validates the timezone against Intl, and the roster gained hire / reset PIN / deactivate with the last-manager guard. `STAFF` is seed-only now: both stores seed it once and then own their roster, and the PG seed stopped overwriting it on every boot | 10 API tests plus a PostgreSQL test proving a renamed venue, a new hire, a reset PIN and a deactivation all survive a restart with the old PINs still dead. Live curl through the rename, the three refusals, the hire and sign-in, the PIN reset, the deactivation, the last-manager guard, and the unsigned-terminal fallback |
| **Floor editor UI (E6-T3)**, built 2026-08-27, awaiting review: entering Edit layout asks for a manager PIN and holds it for the visit; one sheet adds a table and edits the one you tapped, with four shape tiles as CSS mini-previews, a seats stepper, S / M / L size presets instead of drag handles, area chips plus a New area field, and a two-step Retire whose confirm says the past checks stay in the books. Refusals are the engine's own sentence, inline | Page-serve assertions for the sheet and the `.booth` class, plus the whole path driven in headless Chrome with real pointer events: PIN gate, a booth on a brand-new Patio area, resize to L, rename, both refusals, retire blocked by a live check then landing once it settles, and drag-to-move still ungated |
| **Settings screen (E21-T2)**, built 2026-08-27, awaiting review: `/settings` is the seventh screen. A venue form (name, address, a timezone field that filters the runtime's IANA list rather than listing it) and a team roster with add / reset PIN / deactivate, all manager-gated on the first change. Every header, the receipt and the lock screen now render `GET /v1/venue`, so the demo's name is in nobody's markup; the lock pad and pos.html's eight PIN inputs take 4 to 6 digits at last | Four page-serve tests (the shell across all seven, de-branding, every PIN surface, the Settings page itself), plus the flow driven in Chrome: rename propagating to all seven pages and the lock title, three venue refusals verbatim, a hire on a six-digit PIN signing in and opening a check in his own name, a PIN reset killing the old one, a deactivation, and the last-manager guard |

## Run it

```powershell
cd app\server
npm install    # first time only
npm run dev    # then open http://localhost:3000
```

The app opens on the **lock screen**: a PIN pad, like a real POS terminal boots to. Enter a staff PIN (below) and it signs the device in, clocks you in, and lands on Service. Sign-out or clock-out locks the terminal again.

**Demo staff (E15):** Gia R. (server, PIN 2468), Marco B. (manager, PIN 1122), Sofia T. (server, 3579). Sign in from the POS header; anything privileged (voids, discounts, pay-outs, day close, menu publish, merges) needs a MANAGER's PIN now, so use Marco's 1122. A server's PIN refuses.

Six live screens, all real commands to the server:

- **/pos** Service: checks rail, a category rail that shows one course of tiles at a time, a New check modal that shows the room (seats on every table, grouped by section, oversized parties nudged but never blocked), modifier modal (required groups, nesting), seats, send, tip/pay (offline simulation), close. The check groups its lines by course, and each course header holds, releases or fires that course on its own (Send fires everything else and says what it held back). The action bar under the totals is **Discount · Void · History · More**: Void takes several lines, one reason and one manager PIN in a batch and names anything that refuses; History prints the check's own timeline from the server; a tap on a line opens a detail sheet, never a void. More transfers, merges (manager), shows the **printable guest receipt**, or opens **Guests**: search or quick-create a regular, attach them to the check (chips on the header), and read the profile the ledger builds (favorites, spend, cadence, usual section and server, notes, manager-gated merge and delete)
- **/tables** Floor: the spatial room per section, live status (open/seated/paying/kitchen-late), tap an open table to seat a party, tap an occupied one to jump to its check. **Edit layout** mode: drag tables to match your real room; each drop saves to the server and shows on every device
- **/kds** Kitchen: one card per table, New flags, per-item bump, expo-gated Serve, 10-minute recall, cook-together pane. A voided item shows struck-through in red and never blocks Serve. A card whose check already paid or closed carries an amber "check closed" chip and stops counting late: settled guests are a cleanup task, not a late table
- **/menu** Menu manager: edit a draft (add/change/remove items), then a manager publish freezes it into the next immutable snapshot version; new orders reprice, ordered lines never move. The live 86 board (instant 86, running counts that auto-86 at zero) needs no publish and shows on POS tiles as "3 left" badges
- **/close** End of day: this is the lunch+dinner close-out. Drawers from counted float to frozen over/short, the Team section (clock out + declared cash tips, confirmed by the employee's own PIN), today's closed checks with a manager Reopen button, and the day close that refuses until every check is settled, every drawer counted, the kitchen rail swept (unbumped tickets are named by table and course), and everyone is clocked out. Blockers link straight to the offending item

- **/reports** Operator report: covers, checks, net sales, avg check and tips for tonight, then the server scorecard (one stacked bar per server, a segment per course, the Average row muted underneath) and the busiest-times grid of hour x day shaded by net sales. Tap a server for their card (rank, actual, average, variance, net by course), tap a cell for that hour's net, checks and covers. Read-only: every figure is computed by the server from closed checks, nothing on this page is stored

Try the two-device demo: `/pos` on a phone, `/kds` on the laptop, fire an order and watch it land.

**Persistence:** by default state is in-memory. Set `DATABASE_URL` and the same server runs on PostgreSQL (migrations apply automatically, checks survive restarts):

```powershell
$env:DATABASE_URL = "postgres://postgres:YOURPASSWORD@localhost:5432/restaurantos"
npm run dev
```

Domain tests: `cd app\domain && npm test` (73). Server tests incl. a throwaway-PostgreSQL integration: `cd app\server && npm test` (66).

## How work runs now (D21)

The orchestrator (Fable) plans, writes ticket contracts under `docs/tickets/`, assigns models, and reviews; worker sessions build, ONE at a time (all sessions share this folder). Fourteen delegated tickets merged so far, each after its own review, most recently the full E19 reporting slice (renamed to Reports per D24) and the full E20 guestbook v0 (spec, core, screens; D23), both closed 2026-08-23. Firing order (D25, POS UI parity wave): 1) E2-T2 (reopened-check close-out) reviewed and merged 2026-08-23. 2) E8-T3 (per-course hold/fire + check history read) reviewed and merged 2026-08-24. 3) UI-T1 (left-rail app shell) and UI-T2 (menu category rail) built in one worker session as the D22 batch, reviewed and merged 2026-08-23. 4) UI-T3 (check panel: course grouping, hold/release/fire controls, the Discount/Void/History/More action bar, batch void, line sheet) reviewed and merged 2026-08-24, which completed the D25 parity wave. 5) UI-T4 (founder-reported: the New check modal shows seats per table, groups by area, and soft-guards oversized parties) reviewed and merged 2026-08-25. 6) The any-restaurant wave (D26): E6-T2 (floor editor core) then E21-T1 (venue settings + staff core) built in one Opus session as the D22 batch on 2026-08-27 and merged the same day; E6-T3 (floor editor UI) then E21-T2 (Settings screen + de-branding) built in one Sonnet session the same day, own commit each with the suite green between, both awaiting review. That completes D26's build half. Remaining from the wave: E22-T1 (migration spec, docs only), which fits any gap. After that: E5-full on request, or Matt (E13 via ADR-3, E9/E10 via D6). One-liner to fire a ticket: "You are a worker session. Execute the ticket at docs/tickets/<name>.md exactly; it is your entire scope."

## In flight

- **Awaiting review: E6-T3 and E21-T2** on branch `e06-t3-floor-editor-ui`, one commit each, 92 server tests green at both boundaries. Nothing in either needs a decision, but three fixes went in beyond the ticket text and are called out in their BACKLOG rows: `.ov` raised above the bottom tab bar on every page with a modal (the tab bar was painting over every modal's action row on a phone, the seat modal included), the floor page's toasts brought in line with the other five (neutral, red only for a refusal), and `.tab` raised from 38px to 44px.
- The whole D26 build half is now done: the room, the venue and the roster are all data, and all three have a screen. **E22-T1** (migration spec, docs only, Sonnet) is the last ticket of the wave and is independent.
- Next queued after that: payment provider adapter (E13, wants ADR-3 with Matt), per-seat receipts, relational menu editor (E5-full). The Matt-independent epic list is built through; remaining work deepens what exists or waits on decisions.

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
