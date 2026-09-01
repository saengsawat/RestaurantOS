-- E24-T2: the people directory, rung 1 of the D28 team-and-labor ladder.
--
-- employee already carried display_name, pin_hash, and the soft `active`
-- flag, and employee_role already carried the PERMISSION level. What it had
-- nowhere to put was the workplace: the number a manager calls when the line
-- cook wakes up sick, and the person to call if something happens on shift.
--
-- Expand-only, five nullable columns, no backfill. NULL is the honest value
-- for a phone number nobody has typed yet, and the three seeded demo staff
-- have no contact details because they are fictional.
--
-- Note what is NOT here, per D28: no wage rate, no tax identifier, no bank
-- detail. Those belong to a payroll provider, and rung 3 of the ladder exports
-- hours to one rather than storing any of it. A wage column would also quietly
-- turn the labor report into a payroll calculation.

-- Display vocabulary, never authority: "Line cook", "Sous chef", "Host". The
-- permission level stays in employee_role, and nothing in the engine branches
-- on this column. NULL means "call them by their role's name".
ALTER TABLE employee ADD COLUMN title TEXT;

-- The personal half. Manager-gated on read: these never leave the server
-- through GET /v1/staff, only through the PIN-checked directory read.
ALTER TABLE employee ADD COLUMN phone TEXT;
ALTER TABLE employee ADD COLUMN email TEXT;
-- one free-text line, name and number together, because that is how it is
-- written on the sheet of paper in the office drawer this replaces
ALTER TABLE employee ADD COLUMN emergency_contact TEXT;
ALTER TABLE employee ADD COLUMN notes TEXT;
