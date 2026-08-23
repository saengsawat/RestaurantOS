-- E20 guestbook v0 (D23), the two tables from docs/prd/guestbook-spec.md
-- section 2, verbatim. Expand-only: nothing existing is touched, because
-- everything a guest profile shows is a JOIN over the ledger we already
-- write. No aggregate is stored here, so a profile can never drift from the
-- money, and deleting a guest can never change a check.
--
-- Deliberately NOT here, each gated on its own decision:
--   * guest_card_fingerprint (returning-guest recognition) waits for E13,
--     and will store the provider's opaque token only, never a card number (D2)
--   * guest_allergen waits for Matt's answer to privacy question C5

CREATE TABLE guest (
  id                UUID PRIMARY KEY,
  org_id            UUID NOT NULL REFERENCES organization(id),
  location_id       UUID NOT NULL REFERENCES location(id),
  display_name      TEXT NOT NULL,              -- what the check header shows
  phone             TEXT,                       -- nullable: the v1 lookup key
  email             TEXT,                       -- nullable, marketing only
  notes             TEXT,                       -- staff-authored, free text
  marketing_opt_in  BOOLEAN NOT NULL DEFAULT false,
  created_by        UUID NOT NULL REFERENCES employee(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_guest_phone ON guest (location_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_guest_name  ON guest (location_id, display_name);

-- The attachment. A check carries zero or more guests, a guest has many checks.
CREATE TABLE check_guest (
  check_id     UUID NOT NULL REFERENCES checks(id),
  guest_id     UUID NOT NULL REFERENCES guest(id),
  attached_by  UUID NOT NULL REFERENCES employee(id),
  attached_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (check_id, guest_id)
);
