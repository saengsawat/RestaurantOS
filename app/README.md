# RestaurantOS application tree

The real product lives here, separate from `prototypes/` (which stays frozen as discovery artifacts per master plan §8.4).

| Package | What | Status |
|---|---|---|
| `domain/` | Pure TypeScript domain logic: money engine, state machines, modifier validation. No I/O, no framework, no clock. Runs identically on client and server. | E1+E2+E3 done, 54 tests |
| `server/` | The command API over the domain engine: envelope protocol (idempotent operation ids, optimistic versions), menu snapshot, check commands. Fastify (provisional, D16). Store: in-memory; PostgreSQL repository against `docs/domain/schema.sql` is next (E4). | Running, 9 API tests |
| `pos/` | POS client (platform per ADR-4) | Not started |

## Run the server

```powershell
cd app\server
npm install     # first time only
npm run dev     # http://localhost:3000 (docs + quickstart on the page)
```

`npm run dev` restarts on file changes; `npm start` runs it plain. State is in-memory, so restarting clears it.

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
