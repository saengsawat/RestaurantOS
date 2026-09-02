# Ticket E22-T2: The menu import (a spreadsheet becomes a draft)

**Epic:** E22 migration/onboarding (D30 activates the build half) · **Build model:** Opus (parser + draft composition + idempotency) · **Review tier:** cross-model (Fable)
**Status:** Ready. SEQUENCING: edits `engine.ts`; not concurrent with any other app/server ticket.

## Session preamble

1. Read `CLAUDE.md` (no em dashes anywhere), `BACKLOG.md`, `DECISIONS.md` (D30), `docs/prd/migration-spec.md` IN FULL (§2.1 and §4 are this ticket's contract: draft-only, idempotent, provenance), and the E5-T2 draft commands you compose onto (`upsertDraftGroup`, item add/edit with `groupIds`, the publish guard).
2. Baseline: `cd app\server && npm test` green (quote the measured count). Commits `Co-Authored-By: Claude Opus <noreply@anthropic.com>`.

## Context (D30)

The migration spec held the import until the menu's data model stabilized; E5-full stabilized it (the draft now carries the whole modifier graph). This ticket builds the spec's v0: OUR template, landing as a DRAFT a manager reviews and publishes, idempotent so "run it again, something looked wrong" is safe. No vendor converters (no real export file exists yet), no guest import (Matt's consent deck), no staff CSV yet (a hire is five seconds; batch hiring can wait for a real roster).

## What to build

### 1. The template (documented in the response and in a comment, one source of truth)
CSV with a header row, UTF-8, quoted fields supported:
`name, course, price, station, modifier_groups`
- `course` one of the five (case-insensitive); `price` in MAJOR units with optional decimals ("14" or "13.95"), converted to minor once, half-up, at parse; `station` one of the four (case-insensitive, defaulted by course when blank: BEVERAGE to BAR, DOLCI to FREDDO, else SAUTE, stated in the docs); `modifier_groups` a semicolon-separated list of group NAMES.
- A hand-rolled CSV parser (zero dependencies, quoted fields, escaped quotes, CRLF), unit-tested on its own.

### 2. The command: `importMenuCsv` (manager PIN, envelope-idempotent)
- `POST /v1/menu/import` with `{managerPin, csv}` (the file's text; the page reads the file client-side, so the server never learns filenames).
- Rows land on the DRAFT through the same composition E5-T2 built, never directly on a snapshot. Existing draft or not, same rules.
- Group names resolve case-insensitively against the draft graph; an unknown name CREATES the group as optional and empty (minSelect 0, no options) so the manager fills its options before making it required; the publish guard already refuses the dangerous state (required and empty), so nothing unorderable can slip through.
- **Idempotent by natural key** (spec §4): an item matches on name within course, case-insensitively; a matched row UPDATES price/station/groups instead of duplicating; a re-run of the same file reports "0 added". Same rule for groups by name.
- **Provenance** (spec §4): the response reports per-row outcomes, and imported/updated draft items carry a `source` marker ("csv-import <ISO date>") that the draft read returns so the review screen can badge them. Nothing about provenance is stored on published snapshots (they stay exactly the shape they are).
- **All-or-nothing parse, per-row apply report**: a file that does not parse as CSV is refused whole with the line number; a file that parses applies row by row, and rows with invalid values (unknown course, negative price, blank name) are SKIPPED and named in the report ("row 7: unknown course 'SIDES'") while valid rows land. The manager reads the report, fixes the sheet, re-runs; idempotency makes that loop safe.
- Never publishes. The response ends with the draft summary (items added/updated/skipped, groups created) and the reminder that publish is a separate manager act.

### 3. The demo asset that doubles as the founder's pitch
- `docs/examples/nine-thai-menu.csv`: a complete Thai menu extracted from the discovery prototype (`prototypes/discovery/index.html` carries Nine Thai Kitchen's menu data), 20-40 rows across all five courses with at least two modifier groups (e.g. spice level, protein choice). Used by the tests as a fixture, and by the founder as the "watch me set up your restaurant" file.

## Tests to add

CSV parser unit cases (quotes, embedded commas, CRLF, trailing newline, bad row named by line); import creates items + optional empty groups; re-run of the same file is a no-op reporting 0 added; a changed price on re-run updates in place; unknown course row skipped and named while the rest lands; the Nine Thai fixture imports whole, publishes after a manager fills one required group, and an order validates against it end to end; PG round trip of an imported draft; no-PIN and server-PIN refusals; replay idempotency by operationId.

## File scope

In scope: `engine.ts`, `server.ts`, the CSV parser module (new file under `src/`), `docs/examples/nine-thai-menu.csv`, both stores only if the draft shape needs a `source` field, both test files. Out of scope: `menu.html` (E22-T3), vendor-specific column mappings, staff/guest import, `app/domain/`.

## Definition of done

Suite green, typecheck clean, demo note: the Nine Thai file imported by curl, the report shown, the draft published, one Thai dish ordered with its spice level. Update the E22-T2 row in `BACKLOG.md` to Implemented. Do NOT start the UI.
