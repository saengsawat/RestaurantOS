import { buildServer } from "./server.js";
import { MemoryStore } from "./memoryStore.js";
import { PgStore } from "./pgStore.js";

const port = Number(process.env["PORT"] ?? 3000);
const databaseUrl = process.env["DATABASE_URL"];

const store = databaseUrl ? new PgStore(databaseUrl) : new MemoryStore();
const storeName = databaseUrl ? "postgres" : "memory";

await store.init();
const app = buildServer(store, storeName);

await app.listen({ port, host: "127.0.0.1" });
console.log("");
console.log("  RestaurantOS server running");
console.log(`  http://localhost:${port}/pos     the POS`);
console.log(`  http://localhost:${port}/tables  the floor plan`);
console.log(`  http://localhost:${port}/kds     the kitchen`);
console.log(`  http://localhost:${port}/close   end of day (drawers + close)`);
console.log(`  http://localhost:${port}         API docs`);
console.log("");
if (storeName === "memory") {
  console.log("  Store: in-memory (restart clears state).");
  console.log("  Set DATABASE_URL for PostgreSQL persistence, e.g.");
  console.log("  $env:DATABASE_URL = \"postgres://postgres:PASSWORD@localhost:5432/restaurantos\"");
} else {
  console.log("  Store: PostgreSQL (state survives restarts).");
}
console.log("  Ctrl+C to stop.");
