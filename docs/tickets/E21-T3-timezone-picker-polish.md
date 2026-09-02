# Ticket E21-T3: The timezone picker shows itself

**Epic:** E21 venue settings (D32) · **Build model:** Sonnet or Codex (D17) · **Review tier:** standard
**Status:** Ready. D22 batch: built in the same session as E23-T3, AFTER it, own commit.

## Context (D32)

`settings.html` already has a first-party timezone picker (the browser's own IANA list via `Intl.supportedValuesOf("timeZone")`, filtered as you type), but it renders nothing until the user types, so the founder read the field as a bare textbox demanding a precisely typed zone. The fix is discoverability, not a new mechanism. Address autocomplete is NOT this ticket (it is third-party by nature and parked per D32).

## What to build (`app/server/public/settings.html` only)

1. **On focus with an empty query**, the list shows immediately: the browser's own zone first (`Intl.DateTimeFormat().resolvedOptions().timeZone`, labeled "This device"), then the current saved value if different, then a short list of common US zones (America/New_York, America/Chicago, America/Denver, America/Los_Angeles, America/Phoenix, Pacific/Honolulu). Typing filters the full list exactly as today.
2. The field hints at the behavior: placeholder "Type a city, or tap a suggestion".
3. A value that is not a real IANA zone cannot be saved: Save venue shows the inline error the page already uses ("Pick a timezone from the list") instead of posting free text. (Guard client-side only; the server contract is unchanged.)

## Invariants

Tokens, 44px, press feedback, Day/Night; no engine or route edits; everything else on Settings untouched; the picker stays dependency-free (no zone data shipped; the browser provides it, and the existing empty-list fallback for old browsers stays).

## Tests

Page-serve assertion for the placeholder/suggestion markup hook; existing settings tests stay green.

## Definition of done

Suite green, `node --check` on the page script, demo note (focus the field, see suggestions, pick one, save) and a screenshot or an honest note. Update the E21-T3 row in `BACKLOG.md` to Implemented. **Commit before ending the session.**
