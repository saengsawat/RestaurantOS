/** The page you see at http://localhost:3000. Docs, not product UI. */
export function landingPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RestaurantOS Server</title>
<style>
  :root{--bg:#f2f1ec;--surface:#fff;--ink:#0e0f0c;--ink3:#5f635c;--brand:#9fe870;--brand-ink:#163300;
    --ring:0 0 0 1px rgba(14,15,12,.12);--mono:ui-monospace,Consolas,monospace}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--ink);font:15px/1.55 Inter,system-ui,sans-serif;padding:40px 20px}
  main{max-width:760px;margin:0 auto}
  .badge{display:inline-block;background:var(--brand);color:var(--brand-ink);border-radius:999px;
    padding:4px 14px;font-weight:700;font-size:13px;margin-bottom:14px}
  h1{font-size:30px;font-weight:800;letter-spacing:-.02em}
  p.sub{color:var(--ink3);margin:6px 0 26px}
  .card{background:var(--surface);border-radius:16px;box-shadow:var(--ring);padding:18px 20px;margin-bottom:14px}
  h2{font-size:15px;font-weight:700;margin-bottom:8px}
  code,pre{font-family:var(--mono);font-size:12.5px}
  pre{background:#0e0f0c;color:#f2f1ec;border-radius:10px;padding:14px;overflow-x:auto;margin:8px 0}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  td{padding:5px 8px 5px 0;vertical-align:top}
  td:first-child{font-family:var(--mono);white-space:nowrap;color:#116e3b;font-weight:600}
  .note{font-size:12.5px;color:var(--ink3);margin-top:16px}
</style>
</head>
<body><main>
  <span class="badge">RestaurantOS Server · running</span>
  <h1>The command API is live.</h1>
  <p style="margin:14px 0 4px"><a href="/pos" style="display:inline-block;background:var(--brand);color:var(--brand-ink);
    border-radius:999px;padding:12px 26px;font-weight:700;text-decoration:none;font-size:16px">Open the POS →</a></p>
  <p class="sub" style="margin-top:10px">The page above is the point-of-sale web client: every tap is a real command to this server.</p>
  <p class="sub">Every mutation runs the real domain engine (money, state machines, modifier validation)
  and speaks the sync protocol: idempotent operation ids, optimistic versions. Store: in-memory
  (PostgreSQL repository is the next epic). Restarting the server clears state.</p>

  <div class="card"><h2>Endpoints</h2><table>
    <tr><td>GET /health/live</td><td>liveness</td></tr>
    <tr><td>GET /v1/menu</td><td>the published menu snapshot (items + modifier groups)</td></tr>
    <tr><td>GET /v1/checks</td><td>all checks with computed totals</td></tr>
    <tr><td>GET /v1/checks/:id</td><td>one check</td></tr>
    <tr><td>POST /v1/checks</td><td>open a check {tableName, covers}</td></tr>
    <tr><td>POST /v1/checks/:id/items</td><td>add item {itemId, quantity, seatNo, modifiers[]}</td></tr>
    <tr><td>POST /v1/checks/:id/send</td><td>fire unsent lines {course?}</td></tr>
    <tr><td>POST /v1/checks/:id/payments</td><td>{method: card|cash, amountMinor, tipMinor?, offline?}</td></tr>
    <tr><td>POST /v1/checks/:id/close</td><td>close a paid check</td></tr>
  </table>
  <p class="note">Every POST body must include <code>operationId</code> (any unique string, min 8 chars)
  and <code>deviceId</code>. Replaying the same operationId returns the recorded result instead of
  executing twice. Pass <code>expectedVersion</code> to get 409 conflicts on concurrent edits.</p></div>

  <div class="card"><h2>Try a full service in PowerShell</h2>
<pre>$h = @{ "Content-Type" = "application/json" }
$open = Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/checks -Headers $h -Body (@{
  operationId="op-open-1"; deviceId="term-1"; tableName="Table 14"; covers=2 } | ConvertTo-Json)
$id = $open.check.id

# ragu with gluten-free penne (the validator will refuse it without a pasta choice)
Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/checks/$id/items -Headers $h -Body (@{
  operationId="op-item-1"; deviceId="term-1"; itemId="ragu"; quantity=1; seatNo=1
  modifiers=@(@{ groupId="pasta"; modifierId="gf" }) } | ConvertTo-Json -Depth 5)

Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/checks/$id/send -Headers $h -Body (@{
  operationId="op-send-1"; deviceId="term-1" } | ConvertTo-Json)

$check = (Invoke-RestMethod http://localhost:3000/v1/checks/$id).check
Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/checks/$id/payments -Headers $h -Body (@{
  operationId="op-pay-1"; deviceId="term-1"; method="card"; amountMinor=$check.totals.dueMinor } | ConvertTo-Json)

Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/checks/$id/close -Headers $h -Body (@{
  operationId="op-close-1"; deviceId="term-1" } | ConvertTo-Json)</pre></div>

  <div class="card"><h2>Things worth trying on purpose</h2><table>
    <tr><td>skip the pasta group</td><td>422 with the exact validation errors (too_few on "pasta")</td></tr>
    <tr><td>pay before /send</td><td>422: unsent lines block payment (FR-26)</td></tr>
    <tr><td>replay any operationId</td><td>same response again, nothing executes twice</td></tr>
    <tr><td>payments with offline=true</td><td>accepted_offline; /close then refuses until it authorizes</td></tr>
    <tr><td>close before fully paid</td><td>422: only a paid check can close</td></tr>
  </table></div>

  <p class="note">Concept-stage software. Demo menu data. Nothing is charged, printed, or sent anywhere.</p>
</main></body></html>`;
}
