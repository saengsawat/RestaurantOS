# RestaurantOS

**Mission:** a restaurant POS that overtakes Toast and Square, by closing the loop from transactions to the operator's daily decisions.

This repository is the product-discovery and planning stage of that journey: prototypes, research, the master plan, and the design system. There is no build step anywhere, every prototype opens by double-clicking the HTML file and works offline.

## Repository layout

```
├── docs/
│   ├── plans/        RestaurantOS_Master_Plan_v2.0.md, THE roadmap + agent operating model
│   │   └── archive/  superseded plan versions
│   ├── prd/          Operator Console PRD (intelligence-layer concept) + its generation prompt
│   ├── research/     Toast + Square deep-research reports (see CLAUDE.md for caveats)
│   └── adr/          architecture decision records (Phase 2, empty until then)
├── design/
│   └── restaurantos/ the RestaurantOS design system: DESIGN.md + Day/Night previews
├── prototypes/
│   ├── index_RestaurantOS.html   ★ flagship mockup, Osteria Nove (Italian), new design system
│   └── discovery/                first-generation POS mockups (Thai restaurant, three variants)
└── index.html                    published copy of the flagship, served by GitHub Pages
```

**Live demo:** [saengsawat.github.io/RestaurantOS](https://saengsawat.github.io/RestaurantOS/). The root `index.html` is a copy of the flagship, so re-copy it after any mockup change or the live demo goes stale.

## Start here

1. **See the product:** open `prototypes/index_RestaurantOS.html`. Service (coursed ordering, seat-level items, hold and fire, live 86 counts), Tables (spatial floor plan, party size, transfers), Kitchen (one card per table, per-item bump, cook-together pane), and Insights, plus split payments, manager-PIN voids, a per-check audit trail, offline simulation with honest pending-upload states, Day/Night themes, and a full phone layout.
2. **Understand the plan:** read `docs/plans/RestaurantOS_Master_Plan_v2.0.md`, vision, phased roadmap (discovery → PRD → domain model → backlog → build → pilot), and how work is delegated to AI agents.
3. **Build UI like the product:** follow `design/restaurantos/DESIGN.md`, the design language every RestaurantOS surface uses.

## Status

Phase 0 (discovery close-out), awaiting operator (Matt) input sessions. Decisions taken so far are logged in the master plan §12.

*All prototypes are concept artifacts with fictional demo data. Nothing charges, prints, or transmits.*
