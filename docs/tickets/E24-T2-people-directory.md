# Ticket E24-T2: The people directory (who to call when someone is sick)

**Epic:** E24 team & labor, rung 1 (D28) · **Build model:** Opus (engine + stores + PII gating) · **Review tier:** cross-model (Fable)
**Status:** Ready. SEQUENCING: edits `engine.ts`; not concurrent with any other app/server ticket.

## Session preamble

1. Read `CLAUDE.md` (no em dashes anywhere), `BACKLOG.md`, `DECISIONS.md` (D28), and the E21-T1 roster commands you are extending.
2. Baseline: `cd app\server && npm test` green (quote the measured count). Commits `Co-Authored-By: Claude Opus <noreply@anthropic.com>`.

## Context (founder + D28)

The roster knows a name, a permission role, and a hashed PIN. A manager whose line cook wakes up sick needs a phone number, and the org chart is bigger than servers and managers. Two rules are load-bearing: JOB TITLE is display vocabulary and PERMISSION LEVEL is authority, kept as separate fields so giving the dishwasher a nicer title never gives them refund powers; and home contact details are PII, readable only under a manager's PIN.

## What to build

### 1. The employee record grows (types, both stores, expand-only migration 0008)
- New optional fields: `title` (free text: "Line cook", "Sous chef", "Host"; defaults to the permission role's display name when absent), `phone`, `email`, `emergencyContact` (one free-text line: name + number), `notes`.
- `role` stays exactly the two-value permission enum ("server" | "manager") and keeps meaning what it means everywhere (sign-in, approvals, last-manager guard). A kitchen hire who never touches the POS is role "server" with no expectation of signing in; put that sentence in a code comment. Widening the permission enum is out of scope.
- PG: add the columns to `employee` (check what exists first; expand-only).

### 2. Commands and reads
- `updateEmployee` (manager-gated, envelope-idempotent): edits title/phone/email/emergencyContact/notes and, for symmetry, name. Role changes stay out of scope (a promotion flow deserves its own thought).
- `addEmployee` accepts the new optional fields.
- **The gated directory read**: `POST /v1/staff/directory` with `{managerPin}` returns the full records (still never PIN hashes). The public `GET /v1/staff` stays exactly as it is: names, roles, titles, active, and nothing personal. A wrong PIN gets the standard refusal.

### 3. Settings screen (`settings.html`, the one page edit allowed)
- Each Team row expands on tap: title shown to everyone; the contact block (phone, email, emergency contact, notes) fetched through the gated read using the page's held manager PIN, with an inline "manager PIN required" state when there is none.
- Edit-in-place for the new fields via `updateEmployee`; Add employee gains the optional fields, collapsed behind a "More details" fold so the five-second hire stays five seconds.

## Invariants

- The roster read leaks nothing personal; the directory read requires a manager PIN on EVERY call (no caching server-side).
- Deactivation keeps the record (unchanged from E21-T1); nothing here touches shifts, wages, or scheduling (rungs 2 and 3).
- Tokens, 44px, Day/Night on the page work; suite green both stores.

## Tests to add

Update with each field round-tripping both stores (incl. PG restart); public roster never contains a phone/email/emergency string; directory read refuses without a PIN and with a server's PIN, serves with Marco's; title present while role unchanged; add-with-details works; settings page-serve assertion for the directory markup hooks.

## Definition of done

Suite green, typecheck clean, demo note: hire a line cook with a title and emergency contact, show the public roster staying clean and the gated read serving it. Update the E24-T2 row in `BACKLOG.md` to Implemented.
