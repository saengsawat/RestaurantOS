# RestaurantOS Team and Labor: specification

**Status:** Draft v0.1, 2026-08-28 (E24-T1). Spec only: no code, no migration, no UI in this ticket. Rung 1 builds immediately after it as E24-T2. Answers marked `UNKNOWN` are Matt's (deck F in the operator session guide).
**Decisions it obeys:** D28 (the three-rung ladder: the people directory now, scheduling after Matt, payroll never computed here), D2 (the payments posture this borrows: own the data, integrate the regulated part), D19 (reads are projections, computed and never stored), D14 (schema conventions).
**Evidence labels:** `DOCUMENTED` (research reports, PRD, our own shipped code), `OBSERVED` (founder or operator said it, or a competitor product showed it), `INFERRED` (our reasoning), `UNKNOWN` (needs Matt or the pilot).
**Companions:** `docs/prd/RestaurantOS_POS_PRD.md` (product definition, the P2 scope line on scheduling and payroll), `docs/prd/RestaurantOS_Operator_Console_PRD.md` §6.3 (the Labor pillar this is the staircase to), `docs/prd/guestbook-spec.md` (the PII discipline rung 1 inherits), `docs/domain/schema.sql` (`employee`, `role`, `shift`), master plan §7.2 epic E24, `DECISIONS.md` D28.

---

## 1. Why a ladder, and why the rungs are treated differently

The Operator Console PRD's Labor pillar promises a screen that compares scheduled labor against forecast demand and says "move one server's start from 4:00 to 5:30." `DOCUMENTED` [Operator Console PRD §6.3] Every number on that screen is downstream of things RestaurantOS does not have yet. It has no idea who Marco is beyond a name and a PIN, no idea what anyone was *supposed* to work, and no business computing what anyone is owed.

So the ladder, three rungs, deliberately not one project. Each rung is useful alone, each is gated by something different, and the third one we are never climbing on purpose. `DOCUMENTED` [D28]

| Rung | What it is | Gate |
|---|---|---|
| 1. People directory | Contact and identity on the employee record | None: building now as E24-T2 |
| 2. Scheduling | Planned shifts against the actual clock-ins we already record | Matt (deck F) |
| 3. Payroll | Wage math, overtime, withholding | **Never built.** Export only |

What we already have under all of this: `employee` (id, display name, `pin_hash`, active) with roles and a permission table beside it `DOCUMENTED` [`docs/domain/schema.sql` §1], the roster commands from E21-T1 (`listEmployees`, `addEmployee`, `setEmployeePin`, soft `setEmployeeActive`), and `Shift` (employee, `clockIn`, `clockOut`, `declaredTipsMinor`), where sign-in auto-clocks-in and clock-out is explicit because clock-out is where tips get declared. `DOCUMENTED` [`app/server/src/types.ts`, `app/server/src/engine.ts` `clockOut`] That last detail is the load-bearing one for rung 3: the hours and the declared tips are already in the ledger, honestly captured, as a byproduct of running service.

## 2. Rung 1: the people directory (building now, E24-T2)

Today an employee is a name, a PIN hash, a role, and an active flag. That is enough to sign in and approve a void, and not enough to be a workplace: a manager who needs to call somebody in on a Saturday has no phone number in the system, and an emergency contact lives on a sheet of paper in an office drawer. Rung 1 grows the record to hold contact and identity. `INFERRED`

The build follows two design rules, and both are worth stating as rules rather than leaving as implementation detail.

### Rule 1: job TITLE is separate from permission LEVEL

**Sous chef is what somebody is. "Can approve voids" is what they may do.** These get conflated in POS systems constantly, and the conflation is why a restaurant ends up making the head bartender a "Manager" in the software so they can comp a drink, which then also hands them the close-day button and the reports. `INFERRED`

So the directory gets a `title` field that is free text and means nothing to the code: "Sous chef", "Head bartender", "Server, AM". It is what the schedule prints and what the directory shows. Permission stays exactly where it already is, in `role` and the `permission` key set the domain owns (`check.void_item`, `day.close`, `menu.publish` and the rest), unchanged by this ticket. `DOCUMENTED` [`docs/domain/schema.sql` §1] A title never grants anything. Changing "Server" to "Sous chef" in the directory has precisely zero effect on what a PIN can approve, and that is the point.

### Rule 2: home contact details are manager-eyes-only PII, with guestbook-grade discipline

A phone number, a home address, an emergency contact, and a date of birth are more sensitive than anything in the guestbook, because the person is an employee and the power relationship runs one way. The guestbook spec's privacy defaults (deck C) are the precedent, and this rung inherits the same shape of answers rather than inventing new ones. `INFERRED`

| Concern | Default for the employee record |
|---|---|
| Who can read it | Managers only, behind the manager-PIN gate the void approval already uses. A server sees the public roster (name, title, active) and nothing else. The directory read is a separate, gated endpoint, not a wider version of `/v1/staff` |
| What is public on the roster | Name, title, active. Nothing reachable by a non-manager device includes a phone number, an address, or an emergency contact |
| Retention after separation | Identity and contact fields purge **90 days** after deactivation; the `employee` row itself stays forever, soft-deactivated, because `checks.server_id` and every shift they ever worked still point at it. Same shape as the guestbook's C3 answer: the money history survives, the personal detail need not. `UNKNOWN` (Matt, deck F, and a real one: employment records carry statutory retention periods that a guest record does not, so 90 days is our default and a lawyer's number overrides it) |
| Deletion on request | A manager Delete clears contact fields in place. It never deletes the employee row, never touches a shift, and never touches a check |
| What we deliberately do not store | Wage rate, social security or tax identifiers, immigration documents, bank details. Every one of those is rung 3's territory and belongs to the payroll provider, not to us. Storing a wage rate would also quietly turn the labor report into a payroll calculation, which §4 exists to prevent `INFERRED` |

Field sketch, in D14 conventions, expand-only on the existing table: `title` TEXT, `phone` TEXT, `email` TEXT, `emergency_contact_name` TEXT, `emergency_contact_phone` TEXT, `notes` TEXT, all nullable, all manager-gated on read. E24-T2 writes the actual migration.

## 3. Rung 2: scheduling (waits on Matt)

We already record what actually happened: every `Shift` is a real clock-in and a real clock-out. What is missing is the other half, what was supposed to happen. Scheduling is that half, and once both exist the useful question becomes answerable: not "who is here" but "who was meant to be, and what did the difference cost."

**The entity**, sketched so the shape is agreed before anybody builds it:

```sql
CREATE TABLE planned_shift (
  id            UUID PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organization(id),
  location_id   UUID NOT NULL REFERENCES location(id),
  employee_id   UUID NOT NULL REFERENCES employee(id),
  role_for_shift TEXT NOT NULL,          -- what they are working AS tonight, not their title
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  published     BOOLEAN NOT NULL DEFAULT false,
  created_by    UUID NOT NULL REFERENCES employee(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Two things in that sketch are doing real work. **`role_for_shift`** exists because a person works as different things on different nights: the sous chef runs the pass Tuesday and expedites Saturday, and a server picks up a bar shift. It is neither their title nor their permission level, it is this shift's job, which is why it is a third thing rather than a reuse of either. `INFERRED` **`published`** is the draft gate, the same discipline the menu already has: a manager builds next week in private and publishes it once, because a schedule that staff can see changing under them is worse than no schedule. `INFERRED`

**The one report that matters first: planned versus actual hours per day.** Sum `planned_shift` hours per employee per service date, sum the actual `Shift` hours the clock already recorded, and show the difference. That single line is the Operator Console's labor-cost line item, and it is the first thing on that Labor screen that would be true rather than illustrative. `INFERRED` [Operator Console PRD §6.3] Computed on read from both tables, stored nowhere, per D19.

Note what that report does **not** need: a wage rate. Hours planned against hours worked is a complete, useful, honest answer in hours. Turning hours into dollars is the step that makes it payroll, and §4 is why we do not take it.

**Why this rung is Matt-gated rather than just next.** Scheduling is the most habit-shaped software in a restaurant. Some operators run a whiteboard, some run a group chat, many run 7shifts or similar and would not move; the incumbents have first-party answers (Toast Team Management, Square Shifts) and the specialist integrations exist alongside them. `INFERRED` (we have not reviewed these products; the PRD's own scope model already lists scheduling as P2, integrate rather than build `DOCUMENTED` [PRD §3]). Building a scheduler against a guess at one operator's habits is how a feature gets shipped and never opened. Deck F asks how he schedules today, and the honest possible outcome is that rung 2 becomes an import of somebody else's schedule rather than an editor of our own.

## 4. Rung 3: payroll is never computed here

**RestaurantOS does not calculate what anyone is paid.** Not wage math, not overtime, not tips-to-minimum-wage credits, not withholding. `DOCUMENTED` [D28]

This is not a scoping decision that a later version reverses. Payroll is a compliance product: overtime rules vary by state and change; tip credit and tip pooling law is genuinely intricate and genuinely litigated; withholding means tax filing obligations. Toast Payroll and Square Payroll exist as separately-priced add-ons for exactly that reason, and their price is not the software, it is carrying the liability. `INFERRED` A wrong number here is not a bug, it is somebody's paycheck and a regulator's letter.

**So this is the payments posture, applied to labor: own the data, export cleanly.** `DOCUMENTED` [D2, the same reasoning] We are the best possible source of truth for hours worked and tips declared, because we captured them at the terminal as service happened rather than reconstructing them afterward. We are the worst possible place to decide what they are worth.

### The export

One CSV, one pay period, generated on demand, **computed from clock records on read** and stored nowhere (D19).

| Column | Source |
|---|---|
| `employee_id` | `employee.id`, stable across pay periods so a provider can key on it |
| `employee_name` | `employee.display_name` |
| `title` | rung 1's `title`, blank until then |
| `period_start`, `period_end` | The pay period boundaries, from the venue setting |
| `regular_hours` | Summed from `Shift` `clockIn` to `clockOut` within the period |
| `declared_tips` | Summed `declaredTipsMinor`, presented in major units, sourced from the clock-out where the server declared them |
| `shift_count` | Count of shifts, so a provider or a manager can sanity-check the hours against reality |

**No overtime column, and that absence is the specification.** Splitting hours into regular and overtime is a legal determination (which jurisdiction, which threshold, daily or weekly, how a doubled shift counts) and making that split would be computing payroll by another name. We hand over total hours with their dates; the provider applies its own rules, which is what the venue is paying it for. `INFERRED`

**Pay period is a venue setting**, weekly, bi-weekly, or semi-monthly, alongside the venue's name and timezone from E21. `UNKNOWN` (Matt, deck F) with **bi-weekly** as the default because it is the most common of the three in US restaurants. `INFERRED`

**Shape**: a flat CSV with a header row, one row per employee per period, sized for the manual-upload path that Gusto, ADP, and their peers all provide. Not an API integration in v1: an integration means credentials, a provider-specific mapping, and a support burden for a file a manager can upload in fifteen seconds. `INFERRED` A shift open at the period boundary (somebody still clocked in) is excluded from the period and named in a footer line rather than silently truncated, because a quietly short paycheck is the exact failure mode this whole rung is built to avoid. `INFERRED`

## 5. Questions for the Matt deck (deck F)

Appended to `docs/discovery/operator-session-guide.md` in the guide's existing deck format, each with the default we would ship so a shrug is still an answer.

| # | Question | Recommended default |
|---|---|---|
| F-1 | How does he build the schedule today, and where do staff read it? | A spreadsheet or a group chat rather than a scheduling product. If he is on 7shifts or similar, rung 2 becomes an import rather than an editor, and we would rather import than compete |
| F-2 | What is his pay period, and who runs payroll? | Bi-weekly, run by an outside provider or a bookkeeper. Whatever the provider is, we export to it and never calculate for it |
| F-3 | Does the kitchen clock in on the POS, or somewhere else? | On the POS, same as the floor, since our hours export is only as good as its coverage. If the kitchen punches a separate clock, the export is partial and we must say so on the file rather than let it read as complete |
| F-4 | What does a no-call-no-show actually cost him, and how does he handle it? | Absence is recorded against the planned shift once rung 2 exists, and nothing more: attendance discipline is a management act, not a software feature, and we are not building points or penalties |
| F-5 | Who may see wages? | Owner only, and moot for us since we do not store a wage rate at all. Worth asking anyway, because his answer tells us whether the labor report may be shown in hours to a manager or only to him |

Also worth asking, because it decides whether rung 2 is even the right shape: **when the schedule changes at 3pm on a Saturday, how does the staff find out?** If the answer is the group chat, then the schedule's real product is a notification, and we do not have one.

## 6. Dependencies and sequencing

| Dependency | What it gates | State |
|---|---|---|
| E21-T1 roster | The employee record rung 1 grows, and the manager-PIN gate the directory read sits behind | Done 2026-08-28 |
| E14/E15 shifts and clock-out | Actual hours and declared tips, which are the entire input to rung 3's export | Landed; `declaredTipsMinor` captured at clock-out |
| E19 insights | The read-on-demand projection pattern both the planned-versus-actual report and the export reuse | Landed 2026-08-23 |
| E24-T2 people directory | Rung 1 itself, and the `title` column the export's third column reads | Ready, builds next |
| Matt (deck F) | Rung 2 entirely, and the pay-period default on rung 3 | Pending |

**Sequencing we recommend:** rung 1 now, because it is small, unblocked, and a restaurant with no phone numbers in it is not a system a manager trusts. Rung 3's export next, because it is a read over data we already hold correctly and it is the single highest-value thing here for an operator who currently retypes hours into a payroll portal every fortnight. `INFERRED` Rung 2 only after Matt, and possibly never as an editor.

**Out of V1 pilot scope** except rung 1, on the same test the guestbook and the reservations book were held to: the pilot question is "can this restaurant run every dinner service and close every night." A directory helps that on night one. A scheduler does not.
