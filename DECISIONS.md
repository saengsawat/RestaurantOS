# DECISIONS.md

Running log of project decisions. Nothing is decided until it is here. Mirrors master plan §12; this file is the working copy, the plan is updated at phase gates.

| # | Date | Decision | Status |
|---|---|---|---|
| D1 | 2026-08-11 | RestaurantOS is a POS; intelligence layer is the differentiator, not a separate product | Decided |
| D2 | 2026-08-11 | Integrate payments (Stripe Terminal / Adyen); never build processing; never store PAN | Decided |
| D3 | 2026-08-11 | Modular monolith + PostgreSQL + transactional outbox; no microservices/K8s for V1 | Decided |
| D4 | 2026-08-11 | Local-first write ordering; frontend is never the ledger | Decided |
| D5 | 2026-08-11 | Build with Claude Code per the agent operating model (plan §5) | Decided |
| D6 | | LAN-continuous service during WAN failure = P0? | **Open: Phase 0 gate, needs Matt** |
| D7 | | Stack (React/TS/PWA leading candidate) | Open: Phase 2 ADR-1 |
| D8 | | Payment provider (Stripe vs Adyen) | Open: Phase 2 ADR-3 |
| D9 | | Client platform (PWA/Electron/native) | Open: Phase 2 ADR-4 |
| D10 | | Pilot venue | Open: Phase 0/5 |
| D11 | 2026-08-11 | Design language: RestaurantOS system derived from Wise (`design/restaurantos/`) | Decided |
| D12 | 2026-08-11 | Writing style: no em dashes in any content (docs, UI, commits, chat) | Decided |
