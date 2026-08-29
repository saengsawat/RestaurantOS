# Operator Session Guide (Phase 0, WP-0.2)

Purpose: run 1 or 2 sessions with Matt to close discovery. Everything below feeds the Phase 1 PRD directly. Label every captured answer `OBSERVED` (Matt said it) and every interpretation of ours `INFERRED`.

## Session flow (about 90 minutes)

1. **Demo, 20 min.** Walk `prototypes/index_RestaurantOS.html` in this order: seat a table on the floor plan (note seat dots and party size) → build a coursed order with seats and an allergy modifier → hold Primi, fire it → Kitchen screen (per-item bump, cook-together pane, Serve the table, then recall it) → void with manager PIN → History drawer → toggle Offline, take a card payment, watch "pending upload" → reconnect → split payment by seat → close check → Insights screen. Say little; watch where he leans in. Reload first so ticket ages look like live service.
2. **Open reactions, 10 min.** What felt right? What would servers hate? What is missing that they touch every shift? (The More menu stubs are the prompt list.)
3. **Question deck, 45 min.** Below.
4. **Pilot talk, 15 min.** Venues he knows, and the criteria draft below.

## Question deck A: architecture-deciding (from the Toast research)

The one that gates everything (D6):
- **Must orders reach the kitchen when the Internet is down?** (If yes, LAN survival is P0 and V1 needs an edge/relay design. Freeze the answer.)

Service model:
- Full service only, or bar/counter too? How many simultaneous terminals?
- KDS only, printers only, or both? How many kitchen stations?
- Are courses and hold/fire used routinely? Is seat-level ordering required?
- What split-check behavior is mandatory? Merging checks?

Money:
- Automatic gratuity rules? Tips adjusted after card authorization?
- Bar tabs / card preauthorization required?
- Maximum acceptable offline-card amount?
- Gift cards needed on day one?

Operations:
- What does "close day" mean operationally? Which actions need manager approval?
- How are voids after a kitchen fire handled today?
- How are allergies communicated to the kitchen?
- Menu changes during service?
- What printers/cash drawers exist at candidate venues?
- What existing POS data would have to migrate?
- What happens when support is unreachable at 8 PM on a Friday?

## Question deck A2: settled by the mockup, needs an operator ruling

Each of these is currently a guess baked into the prototype. Cheap to change now, expensive after Phase 4. Full table in master plan section 9.

- Tapping an occupied table: straight into the check, or table actions first? (We show actions first.)
- How long should a just-fired course read as **New** on the kitchen display? (We use 3 minutes.)
- Can a station bump a table out, or is serving expo's job only? (We restrict it to expo.)
- How long should a served table stay recallable? (We use 10 minutes.)
- Should a table with everything plated but not served re-escalate after a few minutes? (We do not alarm. Food dying in the window is a real failure with no current alarm.)
- Auto-gratuity: does a party of 6 or more trigger it, and at what threshold? (Not modeled.)
- Is guest count mandatory at seating, or can a server skip it? (We require it.)
- Does the kitchen want the cook-together pane at all, or does it add noise? (Founder says it removes a manual job; confirm.)

## Question deck B: what to build first (from PRD section 13)

- Which screen would you look at first every morning?
- Which recommendation on the Insights screen would actually change what you do?
- What feels unnecessary? What do current systems already solve well?
- Which numbers do you not trust today?
- How do you decide order quantities and labor levels today?
- What would you pay to have automated? What would make you trust an automated recommendation?

## Question deck C: guest data and privacy (from the guestbook spec, E20)

Only if the guestbook interests him (`docs/prd/guestbook-spec.md` has the full proposal). Every question carries the default we would ship, so a shrug is still an answer.

- **What does the guest know about the record?** (Default: staff-facing only, no guest-facing surface, and a manager can read a record back to any guest who asks.)
- **Is consent asked before creating a record?** (Default: no prompt for service records, since a paper reservation book is the same artifact; explicit opt-in for marketing.)
- **How long is a record kept?** (Default: 24 months after the last visit, then identity fields purge automatically. The checks stay in the ledger, unattributed.)
- **Who on staff can see the notes?** (Default: all service staff, because a note only helps if the server on the floor can read it. Sensitive detail belongs in a manager-only field, which the first build does not have.)
- **Do we allow health and allergy notes?** (Default: yes as structured allergen tags that pre-flag the order and the kitchen ticket, no as free prose about a person's medical history.)
- **Does marketing use require opt-in?** (Default: yes, per record, captured by a human, never inferred from a phone number given for a reservation.)
- **What happens on a deletion request?** (Default: a manager Delete clears identity fields and drops the guest's check links within the same service day; the checks themselves are never deleted.)

Also worth asking, because it decides whether this gets built at all: **would his servers actually use it during a rush?** A guest record nobody attaches is worse than no guest record.

## Question deck D: migration and onboarding (from the migration spec, E22)

Only if he is currently on another POS or has switched before (`docs/prd/migration-spec.md` has the full proposal). Every question carries the default we would ship, so a shrug is still an answer.

- **What data would he refuse to lose in a switch?** (Default: menu and the room, because service cannot start without them; staff re-enters in minutes and sales history is assumed expendable since our reports start on day one with us.)
- **Who does the data entry today, when a menu or a roster changes?** (Default: a manager or the owner, not a dedicated administrator.)
- **Would he trust a self-serve import, or want a human involved?** (Default: a human walks the first pilot restaurant through it once; self-serve CSV import is the target from restaurant number two onward.)
- **How long can setup take before it kills the sale?** (Default: under a day for menu and staff combined; the floor redraw fits inside one sit-down session.)

Also worth asking, because it turns every `UNKNOWN` in the migration spec into a `DOCUMENTED` one: **what does his current POS actually let him export, and can he get us a real file before this is built.**

## Question deck E: reservations (from the reservations spec, E23)

Only if he takes bookings at all (`docs/prd/reservations-spec.md` has the full proposal). The principle behind every answer: a reservation is a promise, not a lock, so the floor warns and the host always overrides. Every question carries the default we would ship.

- **Does his venue live on OpenTable or Resy, on a paper book, or on the phone?** (Default: the phone and a paper book, which is what our call-in book is shaped for. If he is already on a platform we still build the book, but the integration becomes the real question, and it stays integrate-never-build.)
- **How long is a table held past its reserved time before it goes to the next party?** (Default: 15 minutes, as a soft prompt on the book row rather than an automatic release. The separate lead window that governs floor badging defaults to 45 minutes before the time.)
- **Are large parties handled differently?** (Default: yes in practice, no in software for v1: a note and the host's attention, not a booking type of its own. A hard threshold, a party of eight needing a manager or a deposit, is worth encoding if he has one.)
- **Does he take deposits, and for what?** (Default: none in v1. If he does take them today, we need to know whether it is a card hold or a real charge, because only one of those is a payments problem we can defer.)
- **Who is allowed to overbook, or to seat over a held table?** (Default: anyone on the floor, with the warn-and-allow confirm and an audit entry. A manager PIN here would mean a host hunting for a manager mid-rush.)

Also worth asking, because it decides whether the book is ever open on a busy night: **who actually answers the phone at 6pm, and are they standing at a terminal when they do?** A book nobody can reach during service is a paper book with extra steps.

## Question deck F: team and labor (from the team and labor spec, E24)

The ladder behind these questions (`docs/prd/team-labor-spec.md` has the full proposal): the people directory builds now, scheduling waits on his answers, and payroll is never computed by us. Every question carries the default we would ship.

- **How does he build the schedule today, and where do staff read it?** (Default: a spreadsheet or a group chat rather than a scheduling product. If he is on 7shifts or similar, our rung 2 becomes an import rather than an editor, and we would rather import than compete.)
- **What is his pay period, and who runs payroll?** (Default: bi-weekly, run by an outside provider or a bookkeeper. Whatever it is, we export hours and declared tips to it and never calculate for it.)
- **Does the kitchen clock in on the POS, or somewhere else?** (Default: on the POS, same as the floor. If the kitchen punches a separate clock, our hours export is partial and the file has to say so rather than read as complete.)
- **What does a no-call-no-show cost him, and how does he handle it?** (Default: absence is recorded against the planned shift once scheduling exists, and nothing more. Attendance discipline is a management act, not a software feature.)
- **Who may see wages?** (Default: owner only, and moot for us since we store no wage rate at all. His answer still tells us whether the labor report may be shown in hours to a manager or only to him.)

Also worth asking, because it decides whether a scheduler is even the right shape: **when the schedule changes at 3pm on a Saturday, how does the staff find out?** If the answer is the group chat, the schedule's real product is a notification, and we do not have one.

## Pilot-selection criteria (WP-0.4 draft, edit with Matt)

| Criterion | Target |
|---|---|
| Service style | Full-service dinner house, single location |
| Terminals | 2 to 4 |
| Kitchen display | Open to KDS (with printer fallback) |
| Owner relationship | Trusts Matt or Andy directly; will give weekly feedback |
| Risk tolerance | Will shadow-run beside existing POS for 2+ weeks |
| Connectivity | Typical (not fiber-perfect); tests the offline story honestly |
| Menu complexity | Real modifiers and coursing, not counter service |

## Notes template (copy per session into docs/discovery/notes-YYYY-MM-DD.md)

```markdown
# Discovery notes, <date>, <who>
## Demo reactions
- OBSERVED: ...
## Deck A answers
- D6 (kitchen during Internet outage): OBSERVED: ...
## Deck B answers
- ...
## Feature requests
- OBSERVED: ...
## Our interpretations
- INFERRED: ...
## Decisions to log in DECISIONS.md
- ...
```
