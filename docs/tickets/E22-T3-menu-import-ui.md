# Ticket E22-T3: The import lands on the Menu screen

**Epic:** E22 migration/onboarding (D30) · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard
**Status:** Ready AFTER E22-T2 merges (consumes its command; the API is fixed, return the ticket if insufficient).

## Session preamble

Read `CLAUDE.md`, `design/restaurantos/DESIGN.md`, `docs/tickets/E22-T2-menu-import-core.md` (the command, the template, the report shape), and click through `/menu` incl. the E5-T3 groups section first.

## What to build (`app/server/public/menu.html` only)

1. **An Import menu action** in the draft area: opens a sheet with a file picker (`.csv`, read client-side with FileReader; the raw text posts to the command) AND a paste-into-textarea alternative for the phone/tablet case, plus a "Download the template" link that generates the header-row CSV client-side (one source of truth: mirror the documented columns, with two example rows).
2. **The report, rendered honestly**: after import, the sheet shows the per-row outcome the server returned: added, updated, skipped-with-reason, groups created, in the page's existing list styling; skipped rows read like the server wrote them ("row 7: unknown course 'SIDES'"). The sheet's close lands the manager on the draft, where imported items carry a small `imported` badge (the `source` marker the draft read now returns), beside the existing new/changed chips.
3. **The manager's next steps stated in one line** on the report: review the draft, fill any empty groups the import created, publish when ready. Publishing stays exactly the existing gesture; this sheet never publishes.
4. Manager PIN asked the way the page already asks for publish (held for the visit, server validates every call).

## Invariants

Tokens, 44px, press feedback, Day/Night; no engine or route edits; the page still formats and never parses CSV itself beyond handing the text over; existing menu flows (items, groups, 86 board, publish) untouched.

## Tests

Page-serve assertions for the import sheet markup and the template link; existing menu tests stay green.

## Definition of done

Suite green, script parses (`node --check`), demo note with the click path (download template, import the Nine Thai example file, read the report, publish, see the items live) and screenshots or an honest note. Update the E22-T3 row in `BACKLOG.md` to Implemented.
