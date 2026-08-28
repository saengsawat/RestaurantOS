# Ticket E21-T1: Venue settings + staff management core

**Epic:** E21 venue settings (D26: RestaurantOS must not be locked to the demo venue) · **Build model:** Opus · **Review tier:** cross-model (Fable)
**Status:** Ready AFTER E6-T2 in the same Opus session (D22: own commit, suite green first).

## Context

"Osteria Nove", its address, its timezone, and its three staff PINs are source code. A second restaurant cannot exist. This ticket makes venue identity and the roster DATA; the demo values become the seed so the app still opens mid-service (repo rule: an empty POS demos badly).

## What to build

### 1. Venue settings
- Shape: `{name, address, timezone}`. Memory store: a settings object seeded with the demo values. PG: `location.name`/`location.timezone` update in place; migration `0007_venue.sql` (expand-only) adds `location.address TEXT`, seeded with the demo address.
- `GET /v1/venue`: public read (no envelope), returns the three fields.
- `updateVenue(env, {managerPin, name?, address?, timezone?})`: manager-gated, envelope-idempotent; blank name refused; timezone validated with `Intl.supportedValuesOf("timeZone")` membership (refuse unknown, message names the input). NOTE: `serviceDateOf` uses server-local time today; changing the stored timezone does NOT change day bucketing in this ticket. Put that one sentence in a code comment and the demo note, not more (wiring serviceDate to the venue timezone is its own future ticket).

### 2. Staff management
- Commands (manager-gated, idempotent): `addEmployee({name, role: "server"|"manager", pin})` (4-6 digit PIN, stored hashed exactly like staff.ts's `pinHash`; duplicate ACTIVE pin hash refused so sign-in stays unambiguous), `resetPin({employeeId, pin})`, `deactivateEmployee({employeeId})` with the LAST-MANAGER guard (refuse deactivating the only active manager).
- Read: `GET /v1/staff` (roster: id, name, role, active; NEVER pins or hashes).
- `STAFF` in staff.ts becomes seed-only: both stores seed it once; sign-in, `this.manager()`, and the unsigned-device opener fallback (today `STAFF[0]`) read the STORE roster (fallback = first active server, else first active employee). A deactivated employee's PIN refuses sign-in and manager approval; their history (checks.server_id) is untouched.
- PG: the `employee` table already exists; add columns only if genuinely missing (check first; expand-only in 0007 if so).

## Tests to add

Venue round trip both stores (update, read back, PG restart survival); blank-name and bad-timezone refusals; add employee then sign in with their PIN on a device and open a check attributed to them; duplicate-PIN refusal; reset PIN (old refuses, new works); deactivate a server (their PIN refuses, history intact); last-manager guard refuses; opener fallback works after deactivating the seeded default (falls to another active employee, never null).

## File scope

In scope: `types.ts`, `engine.ts`, `staff.ts` (seed-only role), `memoryStore.ts`, `pgStore.ts`, `server.ts`, `migrations/0007_venue.sql`, both test files. Out of scope: all pages (E21-T2 renders this), multi-tenancy (LOC stays a single-location constant, out of scope by design), menu import (E22).

## Definition of done

Suite green, typecheck clean, demo note: curl the venue rename and the roster flow. Update the E21-T1 row in `BACKLOG.md` to Implemented. Do NOT start any page work.
