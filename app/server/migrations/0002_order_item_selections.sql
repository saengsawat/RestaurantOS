-- The nested modifier-selection tree is part of the captured order line
-- (children like "Add shrimp -> Grilled" carry meaning the flat
-- order_item_modifier rows cannot). Kept as JSONB alongside the flat rows.
ALTER TABLE order_item ADD COLUMN IF NOT EXISTS selections JSONB NOT NULL DEFAULT '[]';
-- Floor geometry rides on the table row (pos jsonb already in 0001).
