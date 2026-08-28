# Ticket E24-T1: Team and labor spec (the ladder from directory to payroll export)

**Epic:** E24 team & labor (D28, spec first above the directory) · **Build model:** Sonnet (docs only) · **Review tier:** standard
**Status:** Ready. Docs only. Batchable with E22-T1 and E23-T1 in one Sonnet docs session (D22: own commit each).

## Session preamble

Read `CLAUDE.md`, `docs/prd/guestbook-spec.md` (format and voice), `DECISIONS.md` (D28), the existing shift/clock model (`Shift` in `app/server/src/types.ts`, clock-out in `engine.ts`), the E21-T1 roster commands, and the Operator Console PRD's Labor pillar (this spec is that pillar's staircase).

## The deliverable: `docs/prd/team-labor-spec.md`

1. **The ladder (D28), three rungs treated differently on purpose**:
   - **Rung 1, the people directory (building now as E24-T2)**: contact and identity on the employee record. State the two design rules the build follows: JOB TITLE is separate from PERMISSION LEVEL (sous chef is what someone is; "can approve voids" is what someone may do), and home contact details are manager-eyes-only PII with guestbook-grade discipline (C-deck style defaults: retention, who sees what, deletion on separation).
   - **Rung 2, scheduling (waits on Matt)**: planned shifts vs the actual clock-ins we already record; who works Tuesday; sick-day swaps. Sketch the entity (`planned_shift`: employee, role-for-the-shift, start/end, published flag) and the one report that matters first: planned vs actual hours per day, which is the Operator Console's labor-cost line item. Name the incumbent landscape (Toast Team Management, Square Shifts, 7shifts integrations) and why operator habits make this a Matt-gated design.
   - **Rung 3, payroll: NEVER computed here (D28)**. Wage math, overtime rules, and tax withholding are a compliance product (Toast Payroll, Square Payroll exist as paid add-ons for a reason). Ours is the payments posture applied to labor: own the data, export cleanly. Spec the export: hours per employee per pay period (weekly/bi-weekly/semi-monthly as a venue setting) as CSV shaped for Gusto/ADP-style import, declared tips included, computed from clock records on read.
2. **Questions for the Matt deck (deck F)**, defaults on each: how he schedules today; pay period and payroll provider; does the kitchen clock in on the POS or elsewhere; what a no-call-no-show costs him; who may see wages (owner only vs managers).

Append deck F to the session guide; one cross-reference line in the Operator Console PRD's Labor section pointing here.

## Definition of done

Spec in the PRD voice, evidence-labeled, defaults on every UNKNOWN; deck F landed; no em dashes; no code. Update the E24-T1 row in `BACKLOG.md` to Implemented.
