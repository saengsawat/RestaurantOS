# Ticket E8-T3: Per-course hold and fire, and the check's own history

**Epic:** E8 dispatch/KDS + E7 check engine · **Build model:** Opus (engine commands + read) · **Review tier:** cross-model (Fable)
**Status:** Ready. SEQUENCING: edits `engine.ts`; not concurrent with any other app/server ticket. Batchable after E2-T2 in one Opus session (D22: own commit each, suite green between).

## Session preamble

1. Read `CLAUDE.md` (no em dashes anywhere), `BACKLOG.md`, `DECISIONS.md` (D25: the flagship mockup is the UX reference for the POS).
2. Open `prototypes/index_RestaurantOS.html` in a browser and use the Service screen's course firing (Fire now / Hold chips per course) until its behavior is familiar. That behavior is the spec.
3. Baseline: `cd app\server && npm test` green (quote the measured count). One ticket per session; commits `Co-Authored-By: Claude Opus <noreply@anthropic.com>`.

## Context (founder, comparing prod to the mockup)

Today Send fires EVERY unsent line at once. Real service fires courses: beverages immediately, primi when the antipasti clear, secondi held until the guests are ready. The mockup has per-course Hold and Fire now; the engine already creates one kitchen ticket per course on send, so the missing piece is course-level control on the check. Also: every action already returns audit payloads, but nothing lets a page READ a check's story back, which UI-T3 needs for its History panel.

## Part 1: hold and fire

- `CheckAggregate` gains `heldCourses?: string[]` (courses currently held; absent = nothing held). Stored on the aggregate, both stores (pg: a jsonb or text[] on checks via an expand-only migration ONLY if a column is needed; prefer riding the existing aggregate persistence if checks are stored as rows + jsonb, follow how `lines` persist today).
- New commands (envelope-idempotent, version-checked like every check command):
  - `holdCourse(checkId, course)` / `releaseCourse(checkId, course)`: toggle membership. Holding a course with no unsent lines is allowed (the hold applies to lines added later). No PIN.
  - `fireCourse(checkId, course)`: sends ONLY that course's unsent lines (one dispatch ticket, exactly like send does for that course today) and removes it from `heldCourses`. Refuses when the course has no unsent lines.
- `send` (the big button) now fires all unsent lines EXCEPT those in held courses; response names what was held back ("SECONDI held, 1 item waiting"). Sending with everything held is a rejection naming the holds, never a silent no-op.
- Payment guard: the existing "no payment while unsent lines exist" rule stays exactly as is; held lines are unsent lines and still block payment (FR-26). State machines untouched.

## Part 2: the check's history, read back

- `GET /v1/checks/:id/history`: a time-ordered timeline derived from what is already stored, nothing new persisted: opened (openedAt, covers, server), each course fired (from the dispatch tickets' firedAt), items added (only if line timestamps exist today; if lines carry no timestamp, add `addedAt` additively at add-item time, both stores, and show history from now on rather than inventing the past), voids (line void metadata; add `voidedAt` additively the same way if absent), adjustments, payments (takenAt, amount, label), close/reopen, holds and fires from Part 1. Each entry: `{at, kind, summary}` with the summary a human sentence ("PRIMI fired to kitchen, 3 items").
- Honesty rule: never fabricate a timestamp. An event whose time was not recorded before this ticket simply does not appear for old checks.

## Tests to add

- Hold SECONDI, send: beverage/antipasti/primi tickets exist, secondi does not, its lines are still unsent, payment refused while they exist.
- `fireCourse` sends exactly that course, clears the hold, and a second fireCourse refuses (nothing unsent).
- Send with all courses held: rejected, names them.
- History: run a full lifecycle and assert the timeline's kinds appear in order (opened, fired, payment, closed) with sane timestamps; PG round trip keeps `heldCourses` and any new timestamps.

## File scope

- In scope: `app/server/src/types.ts`, `engine.ts`, `memoryStore.ts`, `pgStore.ts` (+ migration only if a column is genuinely needed), `server.ts` (routes), both test files.
- Out of scope: all pages (UI-T3 consumes this), `app/domain/` (no state machine change), the KDS page.

## Definition of done

Suite green, typecheck clean, demo note: curl a hold, a send that skips it, a fireCourse, and the history timeline. Update the E8-T3 row in `BACKLOG.md` to Implemented.
