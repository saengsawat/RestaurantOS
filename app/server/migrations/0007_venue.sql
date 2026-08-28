-- E21-T1: the venue stops being source code.
--
-- location already carried name and timezone; only the street address had
-- nowhere to live, so the receipt printed it as a literal. Expand-only: one
-- added column, backfilled with the address the receipt was already showing
-- so an existing demo database comes back saying the same thing it said.
--
-- The roster needed NO schema change: employee already has display_name,
-- pin_hash, and a soft `active` flag, and employee_role already carries the
-- role. E21-T1 only starts USING them.

ALTER TABLE location ADD COLUMN address TEXT;

UPDATE location SET address = '9 Vicolo della Luna, New York' WHERE address IS NULL;
