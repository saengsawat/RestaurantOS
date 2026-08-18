# RestaurantOS application tree

The real product lives here, separate from `prototypes/` (which stays frozen as discovery artifacts per master plan §8.4).

| Package | What | Status |
|---|---|---|
| `domain/` | Pure TypeScript domain logic: money engine, state machines, modifier validation. No I/O, no framework, no clock. Runs identically on client and server. | E1 in progress |
| `server/` | Modular monolith (Fastify-class), PostgreSQL, sync API | Not started; after ADR-1 ratifies |
| `pos/` | POS client (platform per ADR-4) | Not started |

Ground rules (from the master plan and D14):

- `domain/` never imports anything with side effects. Pricing and state rules do not live in button handlers, and they do not live in endpoints either.
- All money is integer minor units. Anything else is a type error on purpose.
- Every invariant the domain enforces has a property test, not just examples.
- TypeScript strict; no `any` in `domain/src`.

Run tests:

```powershell
cd app\domain
npm install
npm test
```
