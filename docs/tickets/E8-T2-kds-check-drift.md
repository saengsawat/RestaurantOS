# Ticket E8-T2: KDS closed-check awareness + day-close rail sweep

**Epic:** E8 dispatch/KDS + E16 EOD close (guardrail, founder-reported) · **Build model:** Opus · **Review tier:** cross-model (Fable; touches the day-close gate)
**Status:** Ready. SEQUENCING: edits `engine.ts`; not concurrent with any other app/server ticket.

## Session preamble

1. Read `CLAUDE.md` (no em dashes anywhere), `BACKLOG.md`, `DECISIONS.md`.
2. Baseline: `cd app\server && npm test` green before any edit.
3. One ticket per session; scope problems return the ticket. Commits small, `Co-Authored-By: Claude Opus <noreply@anthropic.com>`, never force-push.

## Context: founder-reported scenario

Table 3's guests paid and the check closed, but the kitchen never bumped the tiramisu. The KDS kept the table's card up, escalating red-late at 35 minutes, with no hint that the table had settled; and nothing would ever force the rail to be cleaned. The check and kitchen state machines are SEPARATE on purpose (order is not check; auto-killing tickets on payment would vanish legitimate work like a to-go dessert), so the fix is visibility plus an end-of-day sweep, never auto-clearing. Industry posture is the same: the kitchen owns the rail; payment status is surfaced on the ticket; the closing manager sweeps the rail.

## What to build

### 1. Enrich the KDS read with the check's financial status
- In `engine.kds()` (and anywhere `activeTickets()` feeds a view), attach `checkStatus` to each ticket by looking up the ticket's `checkId` in `store.list()` (statuses: open/partially_paid/paid/closed/reopened/voided). This is a read-time join, nothing stored.
- Extend the `KitchenTicket` VIEW payload only; do NOT add the field to the stored aggregate (it would be a second truth).

### 2. KDS page (`app/server/public/kds.html`)
- A card whose every open dispatch belongs to a paid or closed check renders with a `check closed` chip (mut/amber, not red) in the card header and is EXCLUDED from the red-late escalation (`late` derivation skips tickets whose checkStatus is paid or closed): guests who already settled are a cleanup task, not a late table.
- Everything else about the card stays: items still bump one by one, Serve still gates on all items done, recall unchanged. No auto-clear anywhere.

### 3. Day close blocker (engine `dayReport` + `closeDay` + `/close` page)
- `blockers` gains `openKitchenTickets`: open (non-served) tickets, listed by table name and course. `closeDay` refuses while any exist, message like "2 kitchen ticket(s) still open (Table 3 DOLCI)".
- `/close` page renders the new blocker rows with the hint "bump and serve them on the Kitchen screen, or void the items if they were never made", linking to `/kds`.
- The Close-the-day button's client-side `clear` calculation includes the new blocker.

### 4. Floor consistency check (verify, likely no change)
- The floor's kitchen-late derivation already matches tickets by table against OPEN checks only; confirm a closed check's lingering ticket does not mark a free table late, and add a test asserting it.

## Invariants

- No state machine changes; no auto-bump, no auto-serve, no stored status copies.
- A ticket for a PAID (not yet closed) check is treated like closed for the chip and late-suppression (the guests settled either way).
- Day close conservation of behavior: all existing blocker tests stay green; the new blocker only ADDS a refusal case.

## Tests to add (`api.test.ts`)

- Close a check while one of its tickets has an unbumped item: `/v1/kds` reports that ticket with `checkStatus: "closed"`; the floor shows the table free and NOT late.
- Day close refuses with the open ticket named; bump the item and serve the table; day close then proceeds (with everything else clear).
- The `/close` page serve test still passes; `/kds` page contains the `check closed` chip markup.

## File scope

- In scope: `app/server/src/engine.ts` (kds read enrichment, dayReport blockers, closeDay gate), `app/server/public/kds.html`, `app/server/public/close.html`, `app/server/test/api.test.ts`.
- Out of scope: the domain package, `pgStore.ts`, `types.ts` stored shapes (the view field rides the JSON response, not the aggregate), schema, all other pages.

## Policy note (do not implement)

Whether closing a check should offer a manager a one-tap "serve remaining courses" goes to the Matt question deck; the default shipped here is kitchen-owns-the-rail with the day-close sweep as enforcement.

## Definition of done

Suite green, typecheck clean, demo note reproducing the founder's exact scenario before/after (closed check, unbumped dessert: chip shown, late pulse gone, day close blocked until the rail is swept). Update the E8-T2 row in `BACKLOG.md` to Implemented.
