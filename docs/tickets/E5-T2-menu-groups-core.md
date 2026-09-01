# Ticket E5-T2: Modifier groups become editable (menu editor core)

**Epic:** E5 menu/config, the "full" remainder (D29) · **Build model:** Opus (draft/publish/validation core) · **Review tier:** cross-model (Fable)
**Status:** Ready. SEQUENCING: edits `engine.ts`; not concurrent with any other app/server ticket. Batchable BEFORE E24-T3 in one Opus session (D22: own commit each, suite green between).

## Session preamble

1. Read `CLAUDE.md` (no em dashes anywhere, commits included), `BACKLOG.md`, `DECISIONS.md` (D29), `app/server/src/menu.ts` (GROUPS: the modifier model you are making editable), `app/domain/src/modifiers.ts` (the validator that must keep working unchanged), and how the existing draft and publish work in `engine.ts` (migration 0003 stores the draft as a document).
2. Baseline: `cd app\server && npm test` green (quote the measured count). Commits `Co-Authored-By: Claude Opus <noreply@anthropic.com>`.

## Context (D29)

Managers can edit items but every modifier group ("choice of pasta", "temperature", their min/max, options, and prices) is hardcoded seed. E5-full's user value is the manager editing the WHOLE menu shape without code. Per D29, the draft STAYS a document (relational draft storage waits until a real menu import demands it); this ticket makes the document carry the modifier graph and the publish compose it into the snapshot, exactly as items already flow.

## What to build

### 1. The draft grows the modifier graph
- The draft document gains `groups` (id, name, min, max, options: [{id, name, priceMinor}]) and per-item `groupIds` (ordered). Existing drafts without these fields behave as today (the live GROUPS seed), so nothing breaks mid-flight.
- Commands (manager PIN via the existing publish-tier gate, envelope-idempotent):
  - `upsertDraftGroup`: create or edit a group. Refuse blank name, min < 0, max < min, max 0, an option with a blank name or a negative price, duplicate option names within a group (case-insensitive).
  - `removeDraftGroup`: refuse while any draft item still assigns it (name the items); otherwise remove.
  - `assignItemGroups(itemId, groupIds)`: ordered; refuse unknown ids; empty array clears.
- Add/edit item commands accept `groupIds` alongside their current fields.

### 2. Publish composes the full snapshot
- Publish (unchanged gate, unchanged immutability) now builds the snapshot's `GroupIndex` from the draft's groups + assignments instead of the static seed, and reprices/validates exactly as today: `modifiers.ts` is UNCHANGED, it just receives manager-authored data.
- Ordered lines keep their captured selections and their old snapshot id, as always (FR-9). A line ordered under the old graph never revalidates against the new one.
- The seed GROUPS becomes the FIRST draft/snapshot's content rather than a live constant read anywhere else; grep for direct GROUPS reads in the engine and route them through the active snapshot.

### 3. Guard the sharp edge
- A published group with min >= 1 makes an item unorderable without a selection: that is correct behavior, but publish must WARN (in the response, listed by item) when an item requires a group that has no options, since that item becomes truly unorderable. Refuse publishing that state outright.

## Tests to add

Group CRUD refusals (each rule above); removeDraftGroup naming assigned items; publish composes the graph and a new order validates against it (required group refusal comes from manager-authored data end to end); an old line survives a publish that deletes its group (captured, never revalidated); the unorderable-item publish refusal; PG round trip of a draft carrying groups; replay idempotency.

## File scope

In scope: `engine.ts`, `menu.ts` (seed role only), `types.ts` if the draft type lives there, both stores if the draft document shape is typed in them, `server.ts` routes, both test files. Out of scope: `app/domain/modifiers.ts` (must not change), `public/menu.html` (E5-T3), schema migrations (the draft stays a document per D29).

## Definition of done

Suite green, typecheck clean, demo note: curl a group created, assigned, published, and an order refused for missing its required manager-authored selection. Update the E5-T2 row in `BACKLOG.md` to Implemented. Then proceed to E24-T3 per the batch instruction.
