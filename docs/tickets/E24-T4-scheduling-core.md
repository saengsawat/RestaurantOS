# Ticket E24-T4: Planned shifts (engine + stores)

**Epic:** E24 team & labor, rung 2 (D31 lifts the Matt gate) · **Build model:** Opus (new aggregate + the planned-vs-actual read) · **Review tier:** cross-model (Fable)
**Status:** Ready AFTER E23-T2 merges (engine sequencing; one app/server ticket at a time).

## Session preamble

1. Read `CLAUDE.md`, `DECISIONS.md` (D28, D31), `docs/prd/team-labor-spec.md` IN FULL; §3's sketch is this ticket's contract, and §4's rule is absolute: NO wage, rate, tax, or bank data anywhere (the suite already asserts this; keep it true).
2. Read the code you compose onto: the roster (E21-T1/E24-T2: employees, titles, active flags), the clock's actual `Shift` records, the pay-period math (E24-T3), the menu's draft-then-publish pattern (the schedule copies its discipline).
3. Baseline suite green (quote the count). Commits `Co-Authored-By: Claude Opus <noreply@anthropic.com>`.

## What to build

### 1. The aggregate and stores
- `PlannedShift` per spec §3: id, employeeId, roleForShift (free text: "Server", "Bar", "Expo"; NEITHER the title nor the permission enum, it is this shift's job), startsAt/endsAt (UTC), published flag, createdBy, createdAt.
- Both stores; PG migration `0011_planned_shifts.sql`, expand-only, per the sketch.

### 2. Commands (manager PIN, envelope-idempotent)
- `upsertPlannedShift` / `removePlannedShift`: draft edits. Refuse endsAt <= startsAt, a shift longer than 16 hours (a typo, not a double), an inactive or unknown employee. OVERLAP for the same employee is a WARNING in the response, never a refusal (a split double is real life).
- `publishSchedule({weekOf})`: flips `published` on that week's draft shifts in one act, the menu-publish discipline: staff never see a schedule mid-edit. Re-publishing a week after more edits is the same command again.

### 3. Reads (computed, stored nowhere)
- `GET /v1/schedule?weekOf=YYYY-MM-DD&managerPin=...`: the manager view, draft + published, by employee by day.
- `GET /v1/schedule/mine?deviceId=...`: the signed-in employee's OWN published shifts only (no PIN beyond the session; a server checking their Tuesday must not require a manager). Unpublished rows are invisible here, always.
- `GET /v1/insights/labor?date=...` (manager): planned vs actual per employee for the day: planned hours (published shifts), actual hours (the clock's Shift records), and the difference. HOURS ONLY, no dollars, per spec §3.

## Invariants

No wage/rate/tax/bank columns or fields anywhere (extend the existing suite assertion to the new table). Published is the only thing staff can see. Actual shifts are never edited by this feature (the clock owns them). Audit like every mutation.

## Tests to add

Draft invisible to `/mine`, visible after publish; publish is per-week and re-publishable; overlap warns but lands; the 16-hour and inverted-times refusals; planned-vs-actual math on a seeded day (known clock records vs known plan); no-wage assertion covers `planned_shift`; PG round trip + restart; replay idempotency; PIN gating (manager routes refuse a server PIN; `/mine` works with just a session).

## File scope

In scope: `engine.ts`, `server.ts`, `types.ts`, both stores, migration `0011`, both test files. Out of scope: all pages (E24-T5), availability/time-off requests, shift swaps, notifications, anything payroll.

## Definition of done

Suite green, typecheck clean, demo note: a week planned by curl, published, read back as an employee, and the planned-vs-actual line for one day. Update the E24-T4 row in `BACKLOG.md` to Implemented. **Commit before ending the session.**
