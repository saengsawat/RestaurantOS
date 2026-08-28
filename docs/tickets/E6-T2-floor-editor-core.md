# Ticket E6-T2: Floor editor core (add, edit, resize, retire tables)

**Epic:** E6 floor (editor-full, D26) · **Build model:** Opus (engine + both stores + migration) · **Review tier:** cross-model (Fable)
**Status:** Ready. SEQUENCING: edits `engine.ts`; not concurrent with any other app/server ticket. Batchable BEFORE E21-T1 in one Opus session (D22: own commit each, suite green between).

## Session preamble

1. Read `CLAUDE.md` (no em dashes anywhere, commits included), `BACKLOG.md`, `DECISIONS.md` (D26).
2. Baseline: `cd app\server && npm test` green (quote the count you measure). Commits `Co-Authored-By: Claude Opus <noreply@anthropic.com>`, only with the full suite green.

## Context (founder + incumbent posture)

The floor can only MOVE tables; a new customer cannot draw their own room. PG already has the columns (`dining_table.shape` incl. `booth`, `seats`, `pos`; `dining_area.sort`); the API never exposed them. Incumbents treat floor editing as a manager act done rarely, so every structural command is manager-PIN-gated server-side. History constraint that shapes everything: `party.table_id` references tables and checks/tickets carry table NAMES, so removal must be SOFT and renames must be guarded.

## What to build

### 1. Types and the booth fix
- `FloorTable.shape` gains `"booth"` (types.ts union). Fix pgStore's read that collapses booth to rect (pgStore.ts ~502).

### 2. Store methods (both stores, identical behavior)
- `addTable(table: FloorTable)`: creates the area if new (PG `sort = MAX(sort)+1`; memory first-seen order). On a case-insensitive name match with a RETIRED row, REVIVE that row (same id, clear retired_at, set seats/shape/pos/area) so party history stays on one identity.
- `updateTable(name, patch: {name?, seats?, shape?})`, `retireTable(name, at)`.
- Resize needs NO new store method: `moveTable` already writes w/h.
- `listFloor()` excludes retired; PG orders `da.sort, da.name, dt.name`.

### 3. Engine commands (envelope-idempotent, replay-checked, `this.manager(pin)` gate; `moveTable` stays ungated)
- `addTable(env, {managerPin, name, area, seats, shape, x, y, w, h})`: refuse bad PIN, blank name/area, seats not a positive integer, unknown shape, w/h outside 3..40; clamp x/y like moveTable; refuse an ACTIVE case-insensitive name collision (and translate the PG unique-index race into the same "name in use" rejection).
- `updateTable(env, {managerPin, tableName, newName?, seats?, shape?})`: refuse empty patch; rename refused while a LIVE check (not closed/voided) OR an OPEN kitchen ticket carries the name; case-only self-rename allowed; newName uniqueness as above. Seats/shape edits are allowed even with a live check (only rename/retire are gated).
- `resizeTable(env, {managerPin, tableName, w, h})`: w/h 3..40, then re-clamp `x=min(x,100-w)`, `y=min(y,100-h)`.
- `retireTable(env, {managerPin, tableName})`: refused with a live check or open kitchen ticket; afterwards the table is gone from `listFloor` and `moveTable` reports unknown.

### 4. Migration `0006_floor_editor.sql` (expand-only)
```sql
ALTER TABLE dining_table ADD COLUMN retired_at TIMESTAMPTZ;            -- NULL = active
UPDATE dining_table SET retired_at = now() WHERE NOT (pos ? 'x');      -- ghosts become explicitly retired
CREATE UNIQUE INDEX dining_table_active_name_uq
  ON dining_table (org_id, lower(name)) WHERE retired_at IS NULL;
```
- The pgStore auto-insert side-door (unknown table named by a check) starts inserting `retired_at = now()` so ghosts never appear on the floor, and `addTable` revives such a row on name match.

### 5. Routes
POST `/v1/floor/add`, `/v1/floor/update`, `/v1/floor/resize`, `/v1/floor/retire` (managerPin coerced like `/v1/day/close`).

## Tests to add (api.test.ts + pg.test.ts parity)

Happy paths + operationId replay; no-PIN and server-PIN refusals; case-insensitive duplicate refused; new area appended with stable order; rename refused with a live check then allowed after close (closed checks keep the OLD name in history); rename to a taken name refused, case-only self-rename allowed; resize clamps position at the right/bottom edges; retire with live check refused, then listFloor omits it and move says unknown; retire then re-add revives the SAME PG row id with party history intact; booth survives a PG round trip; both stores return identical refusal reasons.

## File scope

In scope: `types.ts`, `engine.ts`, `memoryStore.ts`, `pgStore.ts`, `server.ts`, `migrations/0006_floor_editor.sql`, both test files. Out of scope: all pages (E6-T3), decor elements (later per D26), the domain package.

## Definition of done

Suite green, typecheck clean, demo note: curl an add (new area), a rename refusal with a live check, a retire, and a revive. Update the E6-T2 row in `BACKLOG.md` to Implemented. Then proceed to E21-T1 per the batch instruction.
