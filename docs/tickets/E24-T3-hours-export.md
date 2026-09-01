# Ticket E24-T3: The payroll hours export (rung 3, computed and never calculated)

**Epic:** E24 team & labor, rung 3 (D28) · **Build model:** Opus · **Review tier:** cross-model (Fable)
**Status:** Ready AFTER E5-T2 in the same Opus session (D22: own commit, suite green first).

## Session preamble

Read `CLAUDE.md`, `DECISIONS.md` (D28), `docs/prd/team-labor-spec.md` §4 IN FULL (it is the contract's contract: the export's columns, the deliberate absence of an overtime column, the open-shift footer rule), and the `Shift` model + `clockOut` in the engine.

## What to build

### 1. Pay period as a venue setting (extends E21)
- The venue settings gain `payPeriod`: `"weekly" | "biweekly" | "semimonthly"` plus an `anchor` date for the weekly/biweekly cycle start. Default biweekly per the spec. Stored beside name/address/timezone, editable through the existing manager-gated venue update, returned by `GET /v1/venue`. PG: expand-only migration 0009 (columns on `location` or the pattern 0007 used).
- Period boundary math: weekly/biweekly roll from the anchor; semimonthly is the 1st-through-15th and the 16th-through-end. Computed on read, tested at month edges (a 28-day February and a 31-day month).

### 2. The export (manager-gated, computed on read, stored nowhere)
- `POST /v1/staff/hours-export` with `{managerPin, periodEnd?}`: PIN checked on every call (the directory read's pattern). `periodEnd` optional; default is the most recently COMPLETED period. Response is `text/csv`.
- Columns exactly per the spec: `employee_id, employee_name, title, period_start, period_end, regular_hours, declared_tips, shift_count`. Hours from `clockIn`..`clockOut` summed within the period, two decimals; declared tips in major units; NO overtime column (that absence is the specification: splitting hours is a legal determination).
- A shift still OPEN at the period boundary is EXCLUDED and named in a `# footer` comment line ("1 open shift excluded: Gia R., clocked in <when>"), never silently truncated. A shift spanning the boundary counts its hours in the period each portion falls in.
- Employees with zero hours in the period get no row; deactivated employees with hours DO get a row (they worked, they get paid).

### 3. Settings screen (`settings.html`, the one page edit allowed)
- The venue section gains the pay period picker (three choices + anchor date for the cycles that need one).
- A new "Payroll export" block: shows the current period's boundaries, a Download hours CSV action that asks the manager PIN (or reuses the page's held one), posts, and hands the CSV to the browser as a file download. Footer text states the posture in one line: "Hours and declared tips only. Your payroll provider applies wage and overtime rules; this system never calculates pay."

## Tests to add

Boundary math at month edges for all three period kinds; a shift spanning a boundary split correctly; the open-shift footer; deactivated-with-hours included, zero-hours excluded; CSV header exact; no PIN and server PIN refused; declared tips match the day report's numbers for the same span; PG round trip of the pay period setting.

## File scope

In scope: `types.ts`, `engine.ts`, both stores, `server.ts`, `migrations/0009_pay_period.sql`, `settings.html`, both test files. Out of scope: wage/tax/bank anything (the E24-T2 test asserting those columns do not exist must still pass), scheduling (rung 2, Matt-gated), all other pages.

## Definition of done

Suite green, typecheck clean, demo note: a two-employee period exported with the exact CSV shown, one open shift named in the footer. Update the E24-T3 row in `BACKLOG.md` to Implemented.
