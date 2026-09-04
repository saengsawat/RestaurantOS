-- E25-T1: the permission enum grows to owner | manager | kitchen | server (D33).
--
-- THE TICKET ASKED FOR A WIDENED CHECK CONSTRAINT AND THERE IS NONE TO WIDEN.
-- Worth saying plainly rather than quietly doing something else: the
-- permission level has never been a column on `employee` with a CHECK on it.
-- Since 0001 it has been a ROW in `role` joined through `employee_role`, which
-- is why E24-T2's comment could say "the permission level stays in
-- employee_role". So widening the enum is two inserted rows, not a constraint
-- swap, and this migration is expand-only in the strictest sense: it adds
-- data, changes no column, drops nothing, and rewrites no existing row.
--
-- Deliberately NOT adding a CHECK on role.name. 0001 documents that table as
-- holding 'Server', 'Manager', 'Line cook': a venue's own vocabulary. A
-- constraint there would shrink an existing contract, which is the one thing
-- an expand-only migration may not do. The engine parses role.name into the
-- four permission levels and treats anything else as the least-privileged
-- floor role, so an unknown name can never widen what a PIN may approve.
--
-- The uuids are the same constants the seed uses (staff.ts ROLE_IDS), so a
-- fresh install and an upgraded one end up with identical role ids.
--
-- The SELECT-from-organization guard makes this a no-op on a database that
-- has not been seeded yet: migrations run before the seed, so on a fresh
-- install there is no organization to hang a role off and the seed creates
-- both rows a moment later. On an existing install the organization is
-- already there and the two roles land here. Both paths converge.

INSERT INTO role (id, org_id, name)
SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', o.id, 'Owner'
FROM organization o WHERE o.id = '11111111-1111-1111-1111-111111111111'
ON CONFLICT (id) DO NOTHING;

INSERT INTO role (id, org_id, name)
SELECT 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', o.id, 'Kitchen'
FROM organization o WHERE o.id = '11111111-1111-1111-1111-111111111111'
ON CONFLICT (id) DO NOTHING;

-- Existing employees keep the role they already had: there is no UPDATE here
-- on purpose. Nobody is promoted by a deploy. The two new demo people (Elena
-- V. the owner, Nico F. the chef) arrive through the seed, which inserts them
-- ON CONFLICT DO NOTHING like every other seeded person, so a database that
-- already has them is untouched.
