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
