-- E5 v0: the in-progress menu edit as one document per location.
-- The relational editor tables (schema section 4: menu_item, modifier_group,
-- item_modifier_group, ...) replace this document when the full menu editor
-- arrives; the publishing contract (immutable menu_snapshot rows) is already
-- final and does not change.
CREATE TABLE menu_draft (
  location_id   UUID PRIMARY KEY REFERENCES location(id),
  document      JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
