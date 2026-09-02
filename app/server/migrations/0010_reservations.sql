-- E23-T2: the call-in book.
--
-- Expand-only, one table and two indexes, exactly the sketch in
-- docs/prd/reservations-spec.md section 4. Nothing existing changes shape,
-- because a reservation is a PROMISE and a promise does not alter the room:
-- the floor's "reserved soon" badge is DERIVED at read from these rows the
-- same way occupancy is derived from open checks. A stored status is a status
-- that can drift from the book; a derived one cannot.
--
-- name and phone sit here rather than only on guest, and the redundancy is
-- deliberate: a booking taken over the phone is a fact about a call, and it
-- has to be writable in four seconds without creating a person record first.
-- guest_id fills in when a phone matches and a human confirms it (D20: the
-- match is exact and the attach is always a human act).
--
-- table_id points at dining_table, which is soft-retired and never deleted
-- (E6-T2), so a booking taken in March for a table retired in April still
-- resolves on the night.

CREATE TABLE reservation (
  id            UUID PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES organization(id),
  location_id   UUID NOT NULL REFERENCES location(id),
  guest_id      UUID REFERENCES guest(id),
  name          TEXT NOT NULL,
  phone         TEXT,
  party_size    INTEGER NOT NULL CHECK (party_size > 0),
  reserved_for  TIMESTAMPTZ NOT NULL,
  table_id      UUID REFERENCES dining_table(id),
  status        TEXT NOT NULL DEFAULT 'booked'
                CHECK (status IN ('booked','seated','no_show','cancelled')),
  note          TEXT,
  created_by    UUID REFERENCES employee(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the book reads a day at a time, in time order
CREATE INDEX idx_reservation_service ON reservation (location_id, reserved_for);
-- the floor badge asks "what is coming to THIS table soon"
CREATE INDEX idx_reservation_table ON reservation (table_id, reserved_for) WHERE table_id IS NOT NULL;

-- When the venue starts holding tables, and how long it holds them past the
-- time (E23-T2). Both are soft: the lead window decides when a badge appears,
-- the hold window decides when the book nudges. Neither ever refuses a
-- seating, because the host is the only one who can see the room.
ALTER TABLE location ADD COLUMN reservation_lead_minutes INTEGER;
ALTER TABLE location ADD COLUMN reservation_hold_minutes INTEGER;

UPDATE location SET reservation_lead_minutes = 45 WHERE reservation_lead_minutes IS NULL;
UPDATE location SET reservation_hold_minutes = 15 WHERE reservation_hold_minutes IS NULL;
