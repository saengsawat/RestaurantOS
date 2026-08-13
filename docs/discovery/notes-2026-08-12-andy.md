# Discovery notes, 2026-08-12, Andy (founder, 3 years sous chef)

Source: founder domain experience, treated as operator-grade input.

## KDS feedback
- OBSERVED: Multiple tickets per table clutter the rail; kitchens think in tables, not dispatches. Consolidate to one card per table, with newly fired items flagged so the line sees what just landed.
- OBSERVED: Whole-ticket bumping hides progress. The line needs per-item ready marking to see what is plated vs still working.
- OBSERVED: The same dish ordered on several tickets should be visible as one batch (2x Burrata across two tables) so the line fires them together instead of someone manually organizing tickets.
- INFERRED: These three imply the real product's KDS needs a projection keyed by table AND a projection keyed by dish (production view), on top of immutable dispatch records. Feeds the Phase 2 domain model (kitchen state machine, dispatch vs presentation separation) and Phase 1 PRD kitchen requirements.

## Implementation status
All three are now in the flagship mockup (commit c97d5b4).

## Follow-on questions from the same session
- OBSERVED: Servers need to change party size after seating (two more join). Guest count is now editable from the table modal and the check More menu, guarded so covers cannot drop below a seat that already has items (commit 2b5f9c6).
- OBSERVED: Asked whether opening a check from the floor plan should land on Service rather than a table-specific page. Answer given: full-service POS treats the table as a context, not a destination; floor plan answers "what is happening in the room" and order entry answers "what does this party want". Labeled INFERRED, since neither research report verified vendor navigation. Our extra actions modal before the check is the part worth testing with Matt.
- INFERRED: The specifics still need an operator ruling. Consolidated as deck A2 in the session guide and section 9 of the master plan: New-flag window (3 min), serve-only-from-expo, recall window (10 min), ready-but-unserved re-escalation, auto-gratuity threshold, mandatory guest count, and whether the cook-together pane helps or adds noise.
