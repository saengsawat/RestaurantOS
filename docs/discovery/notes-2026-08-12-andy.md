# Discovery notes, 2026-08-12, Andy (founder, 3 years sous chef)

Source: founder domain experience, treated as operator-grade input.

## KDS feedback
- OBSERVED: Multiple tickets per table clutter the rail; kitchens think in tables, not dispatches. Consolidate to one card per table, with newly fired items flagged so the line sees what just landed.
- OBSERVED: Whole-ticket bumping hides progress. The line needs per-item ready marking to see what is plated vs still working.
- OBSERVED: The same dish ordered on several tickets should be visible as one batch (2x Burrata across two tables) so the line fires them together instead of someone manually organizing tickets.
- INFERRED: These three imply the real product's KDS needs a projection keyed by table AND a projection keyed by dish (production view), on top of immutable dispatch records. Feeds the Phase 2 domain model (kitchen state machine, dispatch vs presentation separation) and Phase 1 PRD kitchen requirements.

## Implementation status
All three are now in the flagship mockup (commit c97d5b4). Validate the specifics with Matt: NEW-flag window (3 min?), serve-only-from-expo rule, recall window (10 min?), and whether ready-but-unserved should re-escalate.
