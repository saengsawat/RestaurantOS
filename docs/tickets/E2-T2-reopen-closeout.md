# Ticket E2-T2: A reopened check can always close out

**Epic:** E2 state machines + E7 check engine (defect, founder-reported) · **Build model:** Opus (domain state machine + money-adjacent) · **Review tier:** cross-model (Fable)
**Status:** Ready. SEQUENCING: edits `app/domain` and `engine.ts`; not concurrent with any other ticket.

## Session preamble (read first, in order)

1. Read `CLAUDE.md` (no em dashes anywhere, commits included), `BACKLOG.md`, `DECISIONS.md`.
2. Baseline: BOTH suites green (`app/domain` and `app/server`; quote the counts you measure) before any edit.
3. One ticket per session; this file is the whole scope. Commits small, `Co-Authored-By: Claude Opus <noreply@anthropic.com>`, only commit with both suites green.

## The founder's reproduction (a real dead end)

Table 2 pays in full ($165.49) and the check closes. A manager reopens it (PIN, audited). Nothing needs correcting, so the server tries to close it again: the check is `reopened`, `close` is only legal from `paid`, and the only road to `paid` is `payment_recorded`, which refuses a non-positive amount. The check is trapped, the table is stuck occupied, and the day can never close. The POS surfaces it as a "Charge $0.00" button that errors with "amountMinor must be a positive integer".

Industry posture (Toast, Lightspeed): reopening makes the check editable and then it simply closes again; no new payment when nothing changed. Edits that RAISE the total collect the difference (our existing path). Edits that LOWER it leave the guest overpaid, and the house owes the difference back before the books close. Nobody resets the due: taken money stays taken.

## What to build

### 1. Domain (`app/domain/src/checkLifecycle.ts`)
- The `close` event gains the guard fact the machine needs: `{ type: "close"; coversTotal: boolean }` (a boolean computed by the command layer, like every other guard; the machine still does no money math).
- New legal transition: `reopened` + `close` with `coversTotal: true` → `closed`. A reopened check whose payments no longer cover the total refuses with a reason naming what is owed ("payments no longer cover the total; collect the difference first").
- `paid` + `close` behaves exactly as today (`coversTotal` is true there by construction; assert it anyway).
- Update the exhaustive transition table (every status x every event stays asserted) and extend the random-walk property with the liveness fact this bug violated: **from `reopened` with payments covering the total, `closed` is always reachable without a new payment.**

### 2. Engine (`app/server/src/engine.ts` `closeCheck`)
- Compute `coversTotal` as `toView(check).totals.dueMinor <= 0` and pass it to the transition.
- Overpaid close-out (dueMinor < 0, possible after a void or discount on a reopened check): requires MANAGER PIN (reuse the existing approval path; the plain close of an exactly-settled check stays PIN-free), records an audit entry `refund_due` with the overpaid amount and both actor and approver, and returns `refundDueMinor` on the response. This BOOKS the obligation; actually moving money back is the payment provider's job (E13) and is out of scope. No stored aggregate: `refundDueMinor` is computed on read like everything else.
- Day close treats a check closed with a recorded refund_due like any closed check (it is settled paperwork, not an open item).

### 3. POS (`app/server/public/pos.html`)
- When the current check's `dueMinor <= 0` and it is payable-or-reopened: the footer's Pay button reads **Close check** and closes directly (no payment modal for the exactly-settled case).
- If `dueMinor < 0`: the button reads **Close + refund due**, and the confirm asks for the manager PIN with copy naming the amount ("$13.49 goes back to the guest; the refund is recorded on the check").
- The pay modal never again offers "Charge $0.00": if it is somehow open when due hits zero, its action button becomes the same Close.
- Receipt: a check carrying a refund_due entry prints "Refund due to guest" with the amount.

## Invariants

- No negative payments, ever; the payments list is append-only and untouched by this ticket.
- Money conservation: closing never changes totals; `refundDueMinor` equals `-dueMinor` at the moment of close and is recorded, not stored as state.
- The existing paths stay byte-identical: normal pay-then-close, reopen-then-collect-more, void-empty-reopened-check.
- Liveness (the point of this ticket): no reachable check state has zero legal exits while the table is occupied.

## Tests to add

- Domain: the new transition rows in the exhaustive table; the liveness property above.
- Server (`api.test.ts`): the founder's exact scenario (pay in full, close, manager reopen, close again with NO new payment: 200, status closed, table free, day close no longer blocked). Overpaid variant: reopen, void a line with manager PIN, close refused without a PIN, close with Marco's PIN returns `refundDueMinor` equal to the overpayment and lands the audit entry. Raised-total variant: reopen, add an item, close refused naming the amount owed, pay the difference, close succeeds.
- Page assertion: pos.html contains the Close-check button markup.

## File scope

- In scope: `app/domain/src/checkLifecycle.ts` + its tests, `app/server/src/engine.ts`, `app/server/public/pos.html`, `app/server/test/api.test.ts`.
- Out of scope: refund execution (E13), `pgStore.ts` schema, all other pages, the kitchen machine.

## Definition of done

Both suites green, typecheck clean, demo note reproducing the founder's scenario before (trapped) and after (closes clean), plus the overpaid close-out with the refund line. Update the E2-T2 row in `BACKLOG.md` to Implemented.
