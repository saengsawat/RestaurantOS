-- E8-T3: per-course holds on a check, and the two timestamps the check's
-- history had no home for. Expand-only: three added columns, every existing
-- row valid as it stands.
--
-- course_state carries BOTH the hold state and its log in one document,
-- because they are one concept ("which courses are waiting, and since when")
-- and a check-level list has no natural row of its own:
--   { "held": ["SECONDI"], "events": [{ "at": "...", "course": "SECONDI", "action": "held" }] }
--
-- The other timestamps a history needs already exist and are simply written
-- from the aggregate now instead of defaulting: order_item.created_at,
-- check_adjustment.applied_at, payment.taken_at.

ALTER TABLE checks ADD COLUMN course_state JSONB NOT NULL DEFAULT '{}'::jsonb;

-- the LAST reopen. One column, so a second reopen overwrites the first, which
-- is the same honest limit closed_at already has.
ALTER TABLE checks ADD COLUMN reopened_at TIMESTAMPTZ;

-- when the void happened. void_reason and void_approved_by were already here;
-- the time was not.
ALTER TABLE order_item ADD COLUMN voided_at TIMESTAMPTZ;
