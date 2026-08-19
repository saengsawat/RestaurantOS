import { buildServer } from "./server.js";

const port = Number(process.env["PORT"] ?? 3000);
const app = buildServer();

app.listen({ port, host: "127.0.0.1" }).then(() => {
  console.log("");
  console.log("  RestaurantOS server running");
  console.log(`  http://localhost:${port}          docs + quickstart`);
  console.log(`  http://localhost:${port}/v1/menu  the menu snapshot`);
  console.log("");
  console.log("  Store: in-memory (restart clears state). Ctrl+C to stop.");
});
