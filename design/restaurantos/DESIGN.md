# Design System: RestaurantOS

Derived from the **Wise** design language (`design-md/wise`), adapted for a restaurant POS platform. Three adaptations were required and are woven through every section: a full **Night mode** (bars, kitchens, dim dining rooms), a **service-status palette** (order states must be glanceable under dinner-rush stress), and a **44px touch layer** (POS terminals are tablets operated at arm's length, sometimes with wet hands). Tabular-numeral discipline for money is borrowed from fintech practice; the Day/Night token architecture follows the pattern proven in the `index.html` prototype.

---

## 1. Visual Theme & Atmosphere

RestaurantOS feels like **a well-run dining room five minutes before doors open**: warm, calm, and completely ready. The canvas is a warm off-white — closer to natural linen than to office paper — and the ink is a near-black with a faint green undertone, so even the darkest text feels organic rather than corporate. Against this warmth sits one deliberate jolt of energy: a fresh lime green, used only for the actions that move service forward.

The personality is **hospitality first, precision underneath**. Unlike enterprise dashboards that broadcast complexity, RestaurantOS hides its rigor: money is always tabular and exact, statuses are always unambiguous, but the surfaces stay soft — pill buttons, generously rounded cards, hairline ring borders instead of hard rules. A server should feel the interface is on their side; an owner should feel the numbers are trustworthy.

There are two atmospheres, not one theme with an inverted afterthought:

- **Day** — bright dining rooms, patios, counters. Warm off-white ground, ink text, saturated-dark status colors that survive sunlight.
- **Night** — bars, kitchens, dim service. A warm near-black ground (never blue-black), brightened status colors, the same lime energy. Night is a first-class citizen because half of restaurant service happens in the dark.

Color has a strict constitution: **lime means "go," status hues mean state, and nothing else in the chrome is colored.** That restraint is what makes a red "LATE" badge impossible to miss from four feet away.

## 2. Color Palette & Roles

### Brand

| Token | Day | Night | Role |
|---|---|---|---|
| `--brand` | `#9fe870` | `#9fe870` | Primary action fill — pay, send, confirm. **Always a fill, never text.** |
| `--brand-ink` | `#163300` | `#163300` | The only text color allowed on a brand fill |
| `--brand-hover` | `#8ddd5e` | `#b1f286` | Hover/active shift |
| `--brand-wash` | `rgba(159,232,112,.18)` | `rgba(159,232,112,.14)` | Selected tile, active nav |

### Surfaces & ink

| Token | Day | Night | Role |
|---|---|---|---|
| `--bg` | `#f2f1ec` | `#0e0f0c` | App canvas (warm linen / warm near-black) |
| `--panel` | `#ffffff` | `#161814` | Sidebar, topbar |
| `--surface` | `#ffffff` | `#1d201b` | Cards, tiles, modals |
| `--surface-2` | `#e9ebe4` | `#282c26` | Hover, pressed, wells |
| `--ink` | `#0e0f0c` | `#f2f1ec` | Primary text |
| `--ink-2` | `#3f423d` | `#c9cdc4` | Secondary / body |
| `--ink-3` | `#5f635c` | `#9a9e94` | Tertiary / metadata |
| `--ink-4` | `#787c74` | `#83877d` | Disabled — the AA floor, go no lighter |
| `--line` | `rgba(14,15,12,.12)` | `rgba(242,241,236,.10)` | Hairline borders |
| `--line-subtle` | `rgba(14,15,12,.06)` | `rgba(242,241,236,.05)` | Dividers inside cards |

### Service status — the order-state system

Four hues, one meaning each, everywhere in the product. Each ships as a triple: solid (text/icon), `-wash` (chip/row background), `-line` (chip/row border).

| State | Meaning | Day solid | Night solid | Wash (Day) |
|---|---|---|---|---|
| `--info` | **New** — just placed, not yet fired | `#0a7ea4` | `#4cc3e8` | `rgba(10,126,164,.10)` |
| `--amber` | **Working** — cooking, held, pending upload | `#a16207` | `#e3b341` | `rgba(161,98,7,.10)` |
| `--green` | **Ready** — ready, served, paid, settled | `#116e3b` | `#34d399` | `rgba(17,110,59,.10)` |
| `--red` | **Late** — overdue, voided, declined, 86'd | `#c22f35` | `#f0555a` | `rgba(194,47,53,.09)` |

**The lime/green rule (resolves Wise's built-in collision):** brand lime `#9fe870` is exclusively a *fill with dark ink text* (a button you press); status green is exclusively *ink and line color* (a state you read). The lightness inversion keeps them unmistakable even side by side: a lime "Charge $42.80" button next to an emerald "PAID" chip never reads as the same signal. Never use lime for a status chip; never use status green as a button fill.

**Offline honesty rule:** a payment accepted locally while offline is `--amber` ("Pending upload"), never `--green`. Green means the processor confirmed. This is a product-correctness rule expressed in color.

### What is forbidden

No other chromatic color enters the chrome. No purple, no orange, no teal decorations. Charts in the analytics console may extend the palette, but UI chrome never does.

## 3. Typography Rules

### Font stack

```css
--font: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
--font-mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
```

Inter everywhere (free, variable). Wise's proprietary display face is dropped; its *weight strategy* is kept — RestaurantOS compensates with heavier weights, not a second typeface. Mono is reserved for check numbers, ticket IDs, and timestamps.

### Hierarchy

| Level | Size / weight | Use |
|---|---|---|
| Display | 32–40px / 800, line-height 1.05, tracking −0.02em | Screen titles, big totals on payment screen |
| Heading | 20–24px / 700 | Card and modal titles |
| UI label | 15–16px / **600** | Buttons, tiles, nav — the workhorse. Heavy on purpose: weight 600 at 15px survives glare and distance |
| Body | 15–16px / 450–500, line-height 1.5 | Descriptions, settings |
| Meta | 12–13px / 550 | Timestamps, seat numbers, badges — never below 12px |

### Money

All monetary and quantitative figures use **tabular numerals**:

```css
font-variant-numeric: tabular-nums;
```

Check lines, totals, tips, splits, drawer counts, and every analytics metric align vertically to the cent. Totals additionally get `--font-mono` sizing discipline at Display weight. This is non-negotiable: a POS whose columns of prices wobble reads as untrustworthy.

### Principles

- Weight carries hierarchy; color does not (color is reserved for status).
- Sentence case everywhere except status chips (`READY`, `LATE`), which are uppercase 11–12px / 700 / +0.06em tracking.
- Line lengths stay short; POS text is labels, not prose.

## 4. Component Stylings

### Buttons

- **Primary (service actions):** lime pill. `background: var(--brand); color: var(--brand-ink); border-radius: 9999px; min-height: 48px; padding: 0 24px; font: 600 16px var(--font);` Hover `--brand-hover`; press `transform: scale(0.97)` — physical feedback matters on glass.
- **Secondary:** `background: var(--surface-2); color: var(--ink);` same pill geometry.
- **Destructive (void, comp, cancel):** outline style — `border: 1.5px solid var(--red); color: var(--red); background: transparent`. Destructive actions are never filled red; the confirmation modal is where red gets loud.
- **Quiet/tertiary:** ink text, no fill, underline on hover.
- All buttons: minimum touch height **44px**, primary actions 48px.

### Menu tiles (POS grid)

`background: var(--surface); border-radius: 12px; box-shadow: var(--ring); min-height: 72px; padding: 12px 14px;` Item name at UI-label weight, price in tabular numerals at `--ink-3`. Selected state: `--brand-wash` fill + 1.5px `--brand-ink`-toned border (Day) / lime border (Night). 86'd items: `--surface-2` fill, `--ink-4` text, small red `86` badge — never hidden, staff must see what's off.

### Status chips

`border-radius: 9999px; padding: 3px 10px; font: 700 11px/1 var(--font); letter-spacing: .06em; text-transform: uppercase;` — wash background, line border, solid text of the state's triple. Chips are the single loudest element in any row; nothing else competes.

### Check / order card

White (Day) or `--surface` (Night) card, `border-radius: 16px`, ring shadow. Line items on `--line-subtle` dividers: quantity (mono), name, modifiers indented at `--ink-3` 13px, price right-aligned tabular. Voided lines: strikethrough + red chip, never deleted from view — the audit trail is visible by design. Totals block separated by a full `--line` rule; grand total at Display weight.

### KDS ticket

A card whose **top border is the status**: 4px solid in the state color, wash-tinted header showing table/check (mono) and elapsed time. Elapsed time flips to `--red` solid at the late threshold. Items at 16px/600 — kitchen reading distance is farther than server reading distance. Bump action is a full-width lime pill at the card's bottom.

### Modals

Centered, `border-radius: 16px`, `--overlay` scrim (`rgba(14,15,12,.45)` Day / `rgba(0,0,0,.6)` Night). Title 20px/700; primary action bottom-right as lime pill; destructive confirmations restate consequences in body text with the red outline button.

### Tables (analytics console)

Header row 12px/650 uppercase `--ink-3`; data rows 15px with tabular numerals; row hover `--surface-2`. Deltas use status colors as text only (green up-good / red down-bad), 600 weight, with explicit +/− signs.

## 5. Layout Principles

### Spacing

Base-8 scale, dense by design: `4, 8, 12, 16, 24, 32` px. Cards pad 16–20px; screen gutters 16px (terminal) / 24–32px (console). POS density is intentional — a server should reach any menu item in ≤2 taps, which means more tiles per screen, not more whitespace.

### App shell

Left icon rail or sidebar (nav + badge counts), 60px topbar (venue, employee, check meta, clock), content area per screen. On tablets ≤1024px the check collapses to a bottom sheet with a persistent total bar. Safe-area insets respected (`env(safe-area-inset-bottom)`).

### Grid

Menu tiles: responsive grid, `minmax(148px, 1fr)`, 8–12px gaps. KDS: horizontal ticket lanes, newest right. Console: 12-column, metric cards 3-up.

### Border radius scale

| Token | Value | Use |
|---|---|---|
| `--r-sm` | 8px | Inputs, small chips' containers |
| `--r-tile` | 12px | Menu tiles, list rows |
| `--r-card` | 16px | Cards, modals, KDS tickets |
| `--r-pill` | 9999px | All buttons, status chips, nav pills |

Nothing below 8px — sharp corners read cold and enterprise.

## 6. Depth & Elevation

Elevation is quiet: **ring first, shadow second.**

```css
--ring: 0 0 0 1px rgba(14,15,12,.12);          /* Day; Night uses rgba(242,241,236,.10) */
--shadow-sm: 0 2px 8px rgba(14,15,12,.08);
--shadow-lg: 0 16px 40px rgba(14,15,12,.16);   /* modals only */
```

Cards sit on the canvas with the ring alone. Hover adds `--shadow-sm`. Only modals and the bottom sheet use `--shadow-lg`. In Night mode elevation also steps surface luminance (`--panel` → `--surface` → `--surface-2`), since shadows die on dark grounds. No glassmorphism, no gradients in chrome — the single permitted gradient is a faint brand-wash radial behind empty states.

## 7. Do's and Don'ts

### Do

- Keep lime exclusively for forward actions; a screen should have at most one or two lime elements visible.
- Use the status triples (solid/wash/line) exactly as shipped; the same state must look identical on POS, KDS, tables, and console.
- Keep voided/86'd things visible with their status — the system is honest about history.
- Use tabular numerals for every number that could appear above or below another number.
- Design Night mode surfaces with warm blacks (`#0e0f0c` family), never blue-blacks.
- Show sync/connectivity state explicitly (amber "pending upload" chip) — never fake certainty.

### Don't

- Don't use lime as a text color or status color, and don't use status green as a button fill.
- Don't introduce new chrome colors — no purples, oranges, teals, no decorative accents.
- Don't fill destructive buttons red; red fills are for nothing.
- Don't drop below 12px text, 44px touch targets, or the `--ink-4` contrast floor.
- Don't use pure white on Night surfaces (`--ink` is `#f2f1ec`, warm).
- Don't add hover-dependent affordances — fingers don't hover. Anything hover reveals must also be reachable by tap.
- Don't animate anything on the service-critical path beyond 150ms; a POS that "feels designed" during a rush is a POS that feels slow.

## 8. Responsive Behavior & Touch

### Breakpoints

| Range | Layout |
|---|---|
| ≥1280px | Full: sidebar + content + persistent check panel |
| 768–1279px | Rail nav; check panel collapses to bottom sheet with total bar |
| <768px (handheld) | Single column; nav becomes bottom tabs; tiles 2-up |

### Touch layer (non-negotiable)

- `--tap: 44px` minimum interactive height/width; primary service actions 48px.
- 8px minimum spacing between adjacent targets (fat-finger insurance around VOID).
- Press feedback within 100ms: `scale(0.97)` + `--surface-2`/`--brand-hover` shift.
- Neutralize sticky hover on touch devices (`@media (hover: none)`).
- `viewport-fit=cover`; respect all safe-area insets; the bottom sheet's action bar floats above the home indicator.
- Destructive actions are two-step everywhere (tap → confirm modal); no swipe-to-delete.

## 9. Agent Prompt Guide

### Quick reference

```text
Canvas Day #f2f1ec · Night #0e0f0c (warm blacks only)
Ink Day #0e0f0c/#3f423d/#5f635c/#787c74 · Night #f2f1ec/#c9cdc4/#9a9e94/#83877d
Brand lime #9fe870 (fill only, ink text #163300), pill radius 9999px, 48px tall
Status: info #0a7ea4/#4cc3e8 · amber #a16207/#e3b341 · green #116e3b/#34d399 · red #c22f35/#f0555a (Day/Night), each with wash+line
Radius: 8 / 12 / 16 / pill · Ring border rgba(14,15,12,.12) · Font: Inter, UI at 600, money tabular-nums
Touch: 44px min, 48px primary, scale(.97) press
```

### Example component prompts

- "A RestaurantOS menu tile: white 12px-radius card with ring border on a warm linen canvas, item name Inter 15px/600 ink, price 14px tabular `--ink-3`; selected state lime-wash fill with lime border; 72px min height."
- "A RestaurantOS KDS ticket in Night mode: `#1d201b` card, 16px radius, 4px amber top border, header with mono table number and elapsed time, items 16px/600 `#f2f1ec`, full-width lime pill bump button."
- "A RestaurantOS payment modal: 16px-radius surface card over a warm scrim, total in 36px/800 tabular numerals, tip pills as secondary buttons, one lime 'Charge' pill 48px tall bottom-right, amber 'Pending upload' chip if offline."

### Iteration guide

Too corporate → warm the grays toward the green-undertone neutrals, increase radii toward the pill end, check that lime appears on the primary action. Too playful → reduce lime instances to one per screen, tighten spacing one step, raise type weight not size. Status unclear at distance → chips bigger, never new colors.
