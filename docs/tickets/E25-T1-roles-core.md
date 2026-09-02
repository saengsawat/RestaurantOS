# Ticket E25-T1: Four permission levels, enforced where it counts

**Epic:** E25 roles & visibility (D33) · **Build model:** Opus (touches auth on every route family) · **Review tier:** cross-model (Fable)
**Status:** Ready AFTER E24-T4 merges (engine sequencing).

## Session preamble

1. Read `CLAUDE.md`, `DECISIONS.md` (D28 rule 1, D33), `app/server/src/staff.ts` (the role enum, `defaultTitle`, the roster commands), the session model (`/v1/session`, `Engine.who`), and how `manager()` gates commands today.
2. Baseline suite green (quote the count). Commits `Co-Authored-By: Claude Opus <noreply@anthropic.com>`.

## Context (D33)

Today permission is `server | manager` and every page shows every nav entry. The founder wants: servers see what servers need, kitchen sees what kitchen needs, managers see almost everything, the owner sees everything. TITLE stays vocabulary (D28: "Chef" and "Bartender" are titles on a kitchen-level person); this ticket only grows the permission enum and enforces it.

## What to build

### 1. The enum and the matrix
- `Employee.role` grows to `owner | manager | kitchen | server`. Migration `0012` (expand-only: widen the CHECK). Existing rows keep their roles; the seed gains an owner (Elena V., the demo padrona) and a kitchen employee (Nico F., title "Chef").
- A single `VISIBILITY` map in one place, screens x roles, served at `GET /v1/session` alongside the employee (the page never invents it):
  - **server**: Service, Tables, Reservations, Schedule (own view)
  - **kitchen**: Kitchen, Schedule (own view); plus Inventory when E26 builds
  - **manager**: everything except owner-only acts
  - **owner**: everything
- OWNER-ONLY acts (not screens): changing venue identity (name/address/timezone/pay period), and changing the role of a manager or owner. Everything manager-gated today stays manager-gated (owner passes every manager check: the ladder is owner > manager; kitchen and server are lateral, neither passes the other's checks).

### 2. Enforcement, server-side first
- Page routes (`/tables`, `/kds`, ...) stay public to serve (the lock screen is the door); every READ and MUTATION route carrying restricted data gains a role check against the device session or the presented PIN, per the matrix. Nav hiding (E25-T2) is courtesy; the route refusal is the rule.
- `manager()` becomes `atLeast("manager")` on the ladder; a new lateral check covers kitchen-only routes (bump/recall stay kitchen+manager+owner; a server's device can still SEND to the kitchen: sending is a Service act).
- The last-manager guard (E21-T1) becomes a last-OWNER-or-manager guard: the venue can never lose its last person who can approve.
- Roster commands accept the new roles; `resetPin`/`deactivate` on a manager or owner require an OWNER PIN (D33); on kitchen/server, manager suffices as today.

### 3. What does NOT change
Sign-in flow, PIN rules, titles, `demoPins`, the existing per-command manager approvals (voids etc.), and any public read a screen needs to boot before sign-in.

## Tests to add

Matrix served with the session; each role's refusal on one representative route per family (a kitchen PIN cannot read reports; a server session cannot read the schedule manager view; a manager cannot change the venue name; an owner can); owner passes every manager gate; last-owner-or-manager guard; role change on a manager needs owner; migration round trip with all four roles; replay idempotency on the changed commands; existing suite green untouched where behavior is unchanged.

## File scope

In scope: `staff.ts`, `engine.ts`, `server.ts`, `types.ts`, both stores, migration `0012`, both test files. Out of scope: all pages (E25-T2), per-employee custom permissions, audit-log UI.

## Definition of done

Suite green, typecheck clean, demo note: four sign-ins by curl, one allowed and one refused read each, and the owner doing the one thing the manager cannot. Update the E25-T1 row in `BACKLOG.md` to Implemented. **Commit before ending the session.**
