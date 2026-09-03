-- E24-T4: the schedule, rung 2 of D28.
--
-- Expand-only, one table and two indexes, the sketch in
-- docs/prd/team-labor-spec.md section 3. Nothing existing changes shape: the
-- clock's own `shift` table is untouched, because this feature never edits
-- what happened, only records what was supposed to.
--
-- Read this table beside `shift` and the two answer different questions.
-- `shift` is a real clock-in and a real clock-out, captured at the terminal
-- while service happened. `planned_shift` is what a manager intended. Until
-- now the system held only the first half, which is why it could say who is
-- here and not who was meant to be. The planned-versus-actual report is a
-- join over the two, computed on read and stored nowhere (D19), because a
-- stored total is a total that can drift from the rows underneath it.
--
-- role_for_shift is a third thing on purpose, neither the employee's job
-- title (E24-T2's `employee.title`, display vocabulary) nor their permission
-- level (`employee_role`, what a PIN may approve). A sous chef runs the pass
-- on Tuesday and expedites on Saturday; a server picks up a bar shift. It is
-- free text and nothing in the engine branches on it.
--
-- published is the draft gate, the same discipline the menu already has: a
-- manager builds next week in private and publishes it in one act, because a
-- schedule staff can watch change under them is worse than no schedule.
--
-- WHAT IS NOT HERE, and the absence is the specification (spec section 4,
-- D28 rung 3): no wage rate, no hourly rate, no overtime flag, no tax or
-- bank anything. Hours planned against hours worked is a complete and honest
-- answer in hours. Multiplying it by a rate is the step that turns a labor
-- report into a payroll calculation, and payroll is a compliance product we
-- deliberately do not sell. The suite asserts these columns stay absent.

CREATE TABLE planned_shift (
  id             UUID PRIMARY KEY,
  org_id         UUID NOT NULL REFERENCES organization(id),
  location_id    UUID NOT NULL REFERENCES location(id),
  employee_id    UUID NOT NULL REFERENCES employee(id),
  role_for_shift TEXT NOT NULL,
  starts_at      TIMESTAMPTZ NOT NULL,
  ends_at        TIMESTAMPTZ NOT NULL,
  published      BOOLEAN NOT NULL DEFAULT false,
  created_by     UUID NOT NULL REFERENCES employee(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- a shift that ends before it starts is a typo, and the engine refuses one
  -- by name; this is the same rule said where it cannot be bypassed
  CONSTRAINT planned_shift_runs_forward CHECK (ends_at > starts_at)
);

-- the manager view asks for one week of the room at a time
CREATE INDEX idx_planned_shift_week ON planned_shift (location_id, starts_at);
-- and an employee checking their own Tuesday asks for one person
CREATE INDEX idx_planned_shift_employee ON planned_shift (employee_id, starts_at);
