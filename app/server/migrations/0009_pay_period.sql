-- E24-T3: how often the venue pays, so the hours export knows where a period
-- starts and stops.
--
-- Expand-only, the shape 0007 used for the street address: two nullable
-- columns on location, backfilled with the default the spec argues for
-- (biweekly, the most common of the three in US restaurants) so an existing
-- database comes back saying something sensible rather than nothing.
--
-- Note what these columns are NOT. They say when a pay period ends, never
-- what anybody earns in it. There is no wage rate here, no overtime rule, no
-- tax anything, because per D28 this system exports hours and declared tips
-- to a payroll provider and never calculates pay. The provider owns the money;
-- we own the clock.

ALTER TABLE location ADD COLUMN pay_period TEXT
  CHECK (pay_period IN ('weekly', 'biweekly', 'semimonthly'));

-- the day a weekly or biweekly cycle counts from; semimonthly ignores it,
-- because the 1st and the 16th are its anchor
ALTER TABLE location ADD COLUMN pay_period_anchor DATE;

UPDATE location SET pay_period = 'biweekly' WHERE pay_period IS NULL;
UPDATE location SET pay_period_anchor = DATE '2026-01-05' WHERE pay_period_anchor IS NULL;
