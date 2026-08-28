-- E6-T2: the floor becomes editable, so removal has to be SOFT.
-- party.table_id references dining_table and every closed check carries the
-- table NAME in its history, so a real DELETE would orphan the past. A
-- retired table keeps its row and simply stops being room.
--
-- Expand-only: one added column, and one partial unique index that only
-- constrains rows the editor can still see.

ALTER TABLE dining_table ADD COLUMN retired_at TIMESTAMPTZ;            -- NULL = active

-- Ghosts: rows the auto-insert side-door created for a check that named a
-- table nobody had drawn. They have no position, so listFloor already hid
-- them; now they say so out loud instead of relying on a missing key.
UPDATE dining_table SET retired_at = now() WHERE NOT (pos ? 'x');

-- Two ACTIVE tables cannot share a name (case-insensitively): a check header
-- and a kitchen card identify a table by name, so an ambiguous name is an
-- ambiguous ticket. Retired rows are exempt, which is what lets a name be
-- retired and later revived.
CREATE UNIQUE INDEX dining_table_active_name_uq
  ON dining_table (org_id, lower(name)) WHERE retired_at IS NULL;

-- A check must keep the table name it was SERVED under. Until now the name
-- was read live off dining_table through party.table_id, so renaming a table
-- rewrote every past check that ever sat there. captured_name already does
-- exactly this for a menu item; a table deserves the same. NULL means a row
-- written before this migration: fall back to the join, which is what it did.
ALTER TABLE checks ADD COLUMN table_name TEXT;
UPDATE checks ch SET table_name = dt.name
  FROM party p JOIN dining_table dt ON dt.id = p.table_id
  WHERE p.id = ch.party_id;
