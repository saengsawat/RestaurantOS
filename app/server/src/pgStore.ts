/**
 * PostgreSQL Store (epic E4): persistence against docs/domain/schema.sql
 * (mirrored in ./migrations). Checks survive restarts; the sync journal
 * lives in sync_operation; tickets are order_dispatch + kitchen_ticket
 * rows with per-item done flags.
 *
 * Deliberate v0 simplifications, each a later epic, all noted here:
 *  - one seeded org/location/employee/device (actor identity wiring = E15)
 *  - flat order_item_modifier rows are NOT written yet; the selection
 *    tree persists in order_item.selections jsonb (migration 0002)
 *  - business day = calendar date of opening (rollover hour = pilot config)
 */
import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GROUPS, MENU, SNAPSHOT_ID } from "./menu.js";
import {
  FLOOR,
  serviceDateOf,
  type Availability,
  type CheckAggregate,
  type DrawerSession,
  type FloorTable,
  type KitchenTicket,
  type MenuDraft,
  type MenuSnapshot,
  type OpMeta,
  type Store,
} from "./types.js";

const ORG = "11111111-1111-1111-1111-111111111111";
const LOC = "22222222-2222-2222-2222-222222222222";
const EMP = "33333333-3333-3333-3333-333333333333"; // "Gia R." until E15 wires PIN sessions
const DEV = "44444444-4444-4444-4444-444444444444"; // default device row for FKs
const SNAP = "55555555-5555-5555-5555-555555555555";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export class PgStore implements Store {
  private pool: pg.Pool;
  private partyByCheck = new Map<string, string>();

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  async init(): Promise<void> {
    await this.migrate();
    await this.seed();
  }

  private async migrate(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        const done = await c.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
        if (done.rowCount) continue;
        await c.query("BEGIN");
        try {
          await c.query(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
          await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
          await c.query("COMMIT");
        } catch (err) {
          await c.query("ROLLBACK");
          throw new Error(`migration ${file} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      c.release();
    }
  }

  private async seed(): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("INSERT INTO organization (id, name) VALUES ($1, 'Osteria Nove Group') ON CONFLICT (id) DO NOTHING", [ORG]);
      await c.query(
        "INSERT INTO location (id, org_id, name, timezone) VALUES ($1, $2, 'Osteria Nove', 'America/New_York') ON CONFLICT (id) DO NOTHING",
        [LOC, ORG],
      );
      await c.query(
        "INSERT INTO employee (id, org_id, location_id, display_name, pin_hash) VALUES ($1, $2, $3, 'Gia R.', 'seed:no-pin-until-E15') ON CONFLICT (id) DO NOTHING",
        [EMP, ORG, LOC],
      );
      await c.query(
        "INSERT INTO device (id, org_id, location_id, name, kind) VALUES ($1, $2, $3, 'default-terminal', 'terminal') ON CONFLICT (id) DO NOTHING",
        [DEV, ORG, LOC],
      );
      await c.query(
        `INSERT INTO menu_snapshot (id, org_id, location_id, version, document, published_by)
         VALUES ($1, $2, $3, 1, $4, $5) ON CONFLICT (location_id, version) DO NOTHING`,
        [SNAP, ORG, LOC, JSON.stringify({ snapshotId: SNAPSHOT_ID, items: MENU, groups: GROUPS, publishedAt: new Date().toISOString() }), EMP],
      );
      // floor: areas + positioned tables
      for (const area of [...new Set(FLOOR.map((t) => t.area)), "Altro"]) {
        await c.query(
          `INSERT INTO dining_area (id, org_id, location_id, name)
           SELECT gen_random_uuid(), $1, $2, $3
           WHERE NOT EXISTS (SELECT 1 FROM dining_area WHERE location_id = $2 AND name = $3)`,
          [ORG, LOC, area],
        );
      }
      for (const t of FLOOR) {
        await c.query(
          `INSERT INTO dining_table (id, org_id, area_id, name, seats, shape, pos)
           SELECT gen_random_uuid(), $1, a.id, $2, $3, $4, $5
           FROM dining_area a WHERE a.location_id = $6 AND a.name = $7
             AND NOT EXISTS (SELECT 1 FROM dining_table dt JOIN dining_area da ON da.id = dt.area_id
                             WHERE da.location_id = $6 AND dt.name = $2)`,
          [ORG, t.name, t.seats, t.shape === "stool" ? "stool" : t.shape, JSON.stringify({ x: t.x, y: t.y, w: t.w, h: t.h }), LOC, t.area],
        );
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }

  /** date is a YYYY-MM-DD business-day date (server-local, via serviceDateOf) */
  private async ensureBusinessDay(c: pg.PoolClient, date: string): Promise<string> {
    const found = await c.query("SELECT id FROM business_day WHERE location_id = $1 AND service_date = $2", [LOC, date]);
    if (found.rowCount) return found.rows[0].id as string;
    const inserted = await c.query(
      "INSERT INTO business_day (id, org_id, location_id, service_date) VALUES (gen_random_uuid(), $1, $2, $3) ON CONFLICT (location_id, service_date) DO NOTHING RETURNING id",
      [ORG, LOC, date],
    );
    if (inserted.rowCount) return inserted.rows[0].id as string;
    const again = await c.query("SELECT id FROM business_day WHERE location_id = $1 AND service_date = $2", [LOC, date]);
    return again.rows[0].id as string;
  }

  private async ensureTable(c: pg.PoolClient, name: string): Promise<string> {
    const found = await c.query(
      "SELECT dt.id FROM dining_table dt JOIN dining_area da ON da.id = dt.area_id WHERE da.location_id = $1 AND dt.name = $2",
      [LOC, name],
    );
    if (found.rowCount) return found.rows[0].id as string;
    const inserted = await c.query(
      `INSERT INTO dining_table (id, org_id, area_id, name, seats, shape)
       SELECT gen_random_uuid(), $1, a.id, $2, 1, 'rect' FROM dining_area a
       WHERE a.location_id = $3 AND a.name = 'Altro' RETURNING id`,
      [ORG, name, LOC],
    );
    return inserted.rows[0].id as string;
  }

  /* ------------------------------- checks ------------------------------- */

  async put(check: CheckAggregate): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const dayId = await this.ensureBusinessDay(c, serviceDateOf(check.openedAt));
      let partyId = this.partyByCheck.get(check.id);
      if (!partyId) {
        const existing = await c.query("SELECT party_id FROM checks WHERE id = $1", [check.id]);
        if (existing.rowCount) {
          partyId = existing.rows[0].party_id as string;
        } else {
          const tableId = await this.ensureTable(c, check.tableName);
          const party = await c.query(
            "INSERT INTO party (id, org_id, location_id, table_id, covers, seated_at) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id",
            [ORG, LOC, tableId, check.covers, check.openedAt],
          );
          partyId = party.rows[0].id as string;
        }
        this.partyByCheck.set(check.id, partyId);
      }
      await c.query(
        `INSERT INTO checks (id, org_id, location_id, business_day_id, party_id, check_no, server_id, menu_snapshot_id, status, covers, version, opened_at, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET status = $9, covers = $10, version = $11, closed_at = $13`,
        [check.id, ORG, LOC, dayId, partyId, check.checkNo, EMP, snapUuidFor(check.menuSnapshotId), check.status, check.covers, check.version, check.openedAt, check.closedAt ?? null],
      );
      for (const l of check.lines) {
        await c.query(
          `INSERT INTO order_item (id, check_id, menu_snapshot_id, item_id, captured_name, unit_price_minor, tax_class, course, station_key, quantity, seat_no, status, void_reason, voided_by, void_approved_by, created_by, selections)
           VALUES ($1,$2,$3,$4,$5,$6,'standard',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (id) DO UPDATE SET status = $11, void_reason = $12, voided_by = $13, void_approved_by = $14, seat_no = $10`,
          [
            l.id, check.id, snapUuidFor(l.menuSnapshotId ?? check.menuSnapshotId), uuidFrom(l.itemId), l.capturedName, l.unitPriceMinor, l.course, l.station,
            l.quantity, l.seatNo, l.status,
            l.status === "voided" ? (l.voidReason ?? "voided") : null,
            l.status === "voided" ? EMP : null,
            l.status === "voided" ? EMP : null,
            EMP, JSON.stringify({ modifiers: l.modifiers, modifierPriceMinor: l.modifierPriceMinor }),
          ],
        );
      }
      for (const a of check.adjustments) {
        await c.query(
          `INSERT INTO check_adjustment (id, check_id, kind, captured_name, amount_minor, percent_bp, reason, applied_by, approved_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
          [a.id, check.id, a.kind, a.label, a.amountMinor ?? null, a.percentBp ?? null, a.reason, EMP, EMP],
        );
      }
      for (const p of check.payments) {
        const intentId = uuidFrom("intent:" + p.id);
        const attemptId = uuidFrom("attempt:" + p.id);
        await c.query(
          `INSERT INTO payment_intent (id, check_id, split_label, amount_minor, tip_minor, status, created_by, device_id)
           VALUES ($1,$2,$3,$4,$5,'processing',$6,$7) ON CONFLICT (id) DO NOTHING`,
          [intentId, check.id, p.label, p.amountMinor, p.tipMinor, EMP, DEV],
        );
        await c.query(
          `INSERT INTO payment_attempt (id, intent_id, method, provider, status, amount_minor)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
          [attemptId, intentId, p.method === "cash" ? "cash" : "card_present", p.method === "cash" ? null : "demo",
           p.status === "accepted_offline" ? "offline_pending" : "authorized", p.amountMinor],
        );
        await c.query(
          `INSERT INTO payment (id, intent_id, attempt_id, method, amount_minor, tip_minor, status, taken_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
          [p.id, intentId, attemptId, p.method, p.amountMinor, p.tipMinor, p.status, EMP],
        );
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }

  async get(id: string): Promise<CheckAggregate | undefined> {
    const rows = await this.hydrate("WHERE ch.id = $1", [id]);
    return rows[0];
  }

  async list(): Promise<CheckAggregate[]> {
    return this.hydrate("", []);
  }

  private async hydrate(where: string, params: unknown[]): Promise<CheckAggregate[]> {
    const checks = await this.pool.query(
      `SELECT ch.id, ch.check_no, ch.status, ch.covers, ch.version, ch.opened_at, ch.closed_at, dt.name AS table_name,
              ms.document->>'snapshotId' AS snap_id
       FROM checks ch
       JOIN party p ON p.id = ch.party_id
       JOIN menu_snapshot ms ON ms.id = ch.menu_snapshot_id
       LEFT JOIN dining_table dt ON dt.id = p.table_id
       ${where} ORDER BY ch.opened_at`,
      params,
    );
    if (!checks.rowCount) return [];
    const ids = checks.rows.map((r) => r.id as string);
    const lines = await this.pool.query(
      `SELECT id, check_id, item_id, captured_name, unit_price_minor, course, station_key, quantity, seat_no, status, void_reason, selections
       FROM order_item WHERE check_id = ANY($1) ORDER BY created_at`,
      [ids],
    );
    const adjustments = await this.pool.query(
      `SELECT id, check_id, kind, captured_name, amount_minor, percent_bp, reason
       FROM check_adjustment WHERE check_id = ANY($1) ORDER BY applied_at`,
      [ids],
    );
    const payments = await this.pool.query(
      `SELECT pay.id, pay.method, pay.amount_minor, pay.tip_minor, pay.status, pi.split_label, pay.intent_id, pi.check_id
       FROM payment pay JOIN payment_intent pi ON pi.id = pay.intent_id
       WHERE pi.check_id = ANY($1) ORDER BY pay.taken_at`,
      [ids],
    );
    return checks.rows.map((r) => ({
      id: r.id as string,
      checkNo: Number(r.check_no),
      tableName: (r.table_name as string | null) ?? "Walk-in",
      covers: r.covers as number,
      status: r.status,
      version: Number(r.version),
      menuSnapshotId: (r.snap_id as string | null) ?? SNAPSHOT_ID,
      openedAt: new Date(r.opened_at as string).toISOString(),
      ...(r.closed_at ? { closedAt: new Date(r.closed_at as string).toISOString() } : {}),
      lines: lines.rows
        .filter((l) => l.check_id === r.id)
        .map((l) => {
          const sel = (l.selections ?? {}) as { modifiers?: unknown; modifierPriceMinor?: number };
          return {
            id: l.id as string,
            itemId: l.captured_name as string, // display identity; snapshot ids live in selections
            capturedName: l.captured_name as string,
            unitPriceMinor: Number(l.unit_price_minor),
            quantity: l.quantity as number,
            seatNo: l.seat_no as number,
            course: l.course as string,
            station: (l.station_key as string | null) ?? "",
            modifiers: (sel.modifiers as never[]) ?? [],
            modifierPriceMinor: sel.modifierPriceMinor ?? 0,
            status: l.status,
            ...(l.void_reason ? { voidReason: l.void_reason as string } : {}),
          };
        }),
      adjustments: adjustments.rows
        .filter((a) => a.check_id === r.id)
        .map((a) => ({
          id: a.id as string,
          kind: a.kind === "comp" ? "comp" as const : "discount" as const,
          label: a.captured_name as string,
          ...(a.amount_minor !== null ? { amountMinor: Number(a.amount_minor) } : {}),
          ...(a.percent_bp !== null ? { percentBp: Number(a.percent_bp) } : {}),
          reason: (a.reason as string | null) ?? "",
        })),
      payments: payments.rows
        .filter((p) => p.check_id === r.id)
        .map((p) => ({
          id: p.id as string,
          label: (p.split_label as string | null) ?? "Whole check",
          method: p.method,
          amountMinor: Number(p.amount_minor),
          tipMinor: Number(p.tip_minor),
          status: p.status,
        })),
    }));
  }

  async nextCheckNo(): Promise<number> {
    const r = await this.pool.query("SELECT COALESCE(MAX(check_no), 2040) + 1 AS n FROM checks WHERE location_id = $1", [LOC]);
    return Number(r.rows[0].n);
  }

  /* ----------------------------- operations ----------------------------- */

  async opResult(operationId: string): Promise<unknown | undefined> {
    if (!isUuid(operationId)) operationId = uuidFrom("op:" + operationId);
    const r = await this.pool.query("SELECT result FROM sync_operation WHERE operation_id = $1", [operationId]);
    return r.rowCount ? r.rows[0].result : undefined;
  }

  async rememberOp(operationId: string, result: unknown, meta: OpMeta): Promise<void> {
    const opUuid = isUuid(operationId) ? operationId : uuidFrom("op:" + operationId);
    await this.pool.query(
      `INSERT INTO sync_operation (operation_id, org_id, location_id, device_id, aggregate_type, aggregate_id, command, status, result, client_ts)
       VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,$8, now()) ON CONFLICT (operation_id) DO NOTHING`,
      [opUuid, ORG, LOC, DEV, meta.aggregateType, isUuid(meta.aggregateId) ? meta.aggregateId : uuidFrom(meta.aggregateId), meta.status, JSON.stringify(result)],
    );
  }

  /* ------------------------------- tickets ------------------------------ */

  async putTicket(ticket: KitchenTicket): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const dispatchId = uuidFrom("dispatch:" + ticket.id);
      await c.query(
        `INSERT INTO order_dispatch (id, check_id, course, fired_by, device_id, fired_at)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [dispatchId, ticket.checkId, ticket.course, EMP, DEV, ticket.firedAt],
      );
      await c.query(
        `INSERT INTO kitchen_ticket (id, dispatch_id, status, served_at, served_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET status = $3, served_at = $4, served_by = $5`,
        [ticket.id, dispatchId, ticket.status === "served" ? "served" : "open", ticket.servedAt ?? null, ticket.status === "served" ? EMP : null],
      );
      for (const item of ticket.items) {
        await c.query(
          `INSERT INTO dispatch_item (dispatch_id, order_item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [dispatchId, item.orderItemId],
        );
        await c.query(
          `INSERT INTO kitchen_ticket_item (ticket_id, order_item_id, done, done_at)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (ticket_id, order_item_id) DO UPDATE SET done = $3, done_at = $4`,
          [ticket.id, item.orderItemId, item.done, item.done ? new Date().toISOString() : null],
        );
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }

  async getTicket(id: string): Promise<KitchenTicket | undefined> {
    const rows = await this.hydrateTickets("WHERE kt.id = $1", [id]);
    return rows[0];
  }

  async listTickets(): Promise<KitchenTicket[]> {
    return this.hydrateTickets("", []);
  }

  private async hydrateTickets(where: string, params: unknown[]): Promise<KitchenTicket[]> {
    const tickets = await this.pool.query(
      `SELECT kt.id, kt.status, kt.served_at, od.check_id, od.course, od.fired_at, dt.name AS table_name
       FROM kitchen_ticket kt
       JOIN order_dispatch od ON od.id = kt.dispatch_id
       JOIN checks ch ON ch.id = od.check_id
       JOIN party p ON p.id = ch.party_id
       LEFT JOIN dining_table dt ON dt.id = p.table_id
       ${where} ORDER BY od.fired_at`,
      params,
    );
    if (!tickets.rowCount) return [];
    const ids = tickets.rows.map((r) => r.id as string);
    const items = await this.pool.query(
      `SELECT kti.ticket_id, kti.order_item_id, kti.done, oi.captured_name, oi.quantity, oi.station_key, oi.selections, oi.status AS oi_status
       FROM kitchen_ticket_item kti JOIN order_item oi ON oi.id = kti.order_item_id
       WHERE kti.ticket_id = ANY($1)`,
      [ids],
    );
    return tickets.rows.map((r) => ({
      id: r.id as string,
      checkId: r.check_id as string,
      tableName: (r.table_name as string | null) ?? "Walk-in",
      course: r.course as string,
      firedAt: new Date(r.fired_at as string).toISOString(),
      status: r.status === "served" ? "served" as const : "open" as const,
      ...(r.served_at ? { servedAt: new Date(r.served_at as string).toISOString() } : {}),
      items: items.rows
        .filter((i) => i.ticket_id === r.id)
        .map((i) => {
          const sel = (i.selections ?? {}) as { modifiers?: { groupId: string; modifierId: string }[] };
          return {
            orderItemId: i.order_item_id as string,
            name: i.captured_name as string,
            quantity: i.quantity as number,
            station: (i.station_key as string | null) ?? "",
            mods: describeFromSnapshot(sel.modifiers ?? []),
            allergy: false,
            done: i.done as boolean,
            // derived, not stored: the order item's own status is the truth
            ...(i.oi_status === "voided" ? { voided: true } : {}),
          };
        }),
    }));
  }

  async listFloor(): Promise<FloorTable[]> {
    const r = await this.pool.query(
      `SELECT dt.name, da.name AS area, dt.seats, dt.shape, dt.pos
       FROM dining_table dt JOIN dining_area da ON da.id = dt.area_id
       WHERE da.location_id = $1 AND dt.pos ? 'x' ORDER BY da.name, dt.name`,
      [LOC],
    );
    return r.rows.map((row) => ({
      name: row.name as string,
      area: row.area as string,
      seats: row.seats as number,
      shape: row.shape === "round" ? "round" as const : row.shape === "stool" ? "stool" as const : "rect" as const,
      x: row.pos.x as number, y: row.pos.y as number, w: row.pos.w as number, h: row.pos.h as number,
    }));
  }

  async moveTable(name: string, pos: { x: number; y: number; w: number; h: number }): Promise<void> {
    await this.pool.query(
      `UPDATE dining_table dt SET pos = $1 FROM dining_area da
       WHERE da.id = dt.area_id AND da.location_id = $2 AND dt.name = $3`,
      [JSON.stringify(pos), LOC, name],
    );
  }

  /* ------------------------- cash + business day ------------------------- */

  private async ensureDrawer(c: pg.PoolClient, name: string): Promise<string> {
    const found = await c.query("SELECT id FROM cash_drawer WHERE location_id = $1 AND name = $2", [LOC, name]);
    if (found.rowCount) return found.rows[0].id as string;
    const inserted = await c.query(
      "INSERT INTO cash_drawer (id, org_id, location_id, name) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id",
      [ORG, LOC, name],
    );
    return inserted.rows[0].id as string;
  }

  async putDrawerSession(session: DrawerSession): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const drawerId = await this.ensureDrawer(c, session.drawerName);
      const dayId = await this.ensureBusinessDay(c, serviceDateOf(session.openedAt));
      await c.query(
        `INSERT INTO drawer_session (id, drawer_id, business_day_id, opened_by, opened_at, opening_float_minor, closed_by, closed_at, counted_minor, expected_minor, over_short_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET closed_by = $7, closed_at = $8, counted_minor = $9, expected_minor = $10, over_short_minor = $11`,
        [session.id, drawerId, dayId, EMP, session.openedAt, session.openingFloatMinor,
         session.closedAt ? EMP : null, session.closedAt ?? null,
         session.countedMinor ?? null, session.expectedMinor ?? null, session.overShortMinor ?? null],
      );
      for (const e of session.events) {
        await c.query(
          `INSERT INTO cash_event (id, drawer_session_id, kind, amount_minor, payment_id, reason, employee_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
          [e.id, session.id, e.kind, e.amountMinor, e.paymentId ?? null, e.reason ?? null, EMP, e.at],
        );
      }
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }

  async getDrawerSession(id: string): Promise<DrawerSession | undefined> {
    return (await this.hydrateSessions("WHERE ds.id = $1", [id]))[0];
  }

  async listDrawerSessions(): Promise<DrawerSession[]> {
    return this.hydrateSessions("", []);
  }

  private async hydrateSessions(where: string, params: unknown[]): Promise<DrawerSession[]> {
    const sessions = await this.pool.query(
      `SELECT ds.id, ds.opened_at, ds.opening_float_minor, ds.closed_at, ds.counted_minor, ds.expected_minor, ds.over_short_minor, cd.name AS drawer_name
       FROM drawer_session ds JOIN cash_drawer cd ON cd.id = ds.drawer_id
       ${where} ORDER BY ds.opened_at`,
      params,
    );
    if (!sessions.rowCount) return [];
    const ids = sessions.rows.map((r) => r.id as string);
    const events = await this.pool.query(
      `SELECT id, drawer_session_id, kind, amount_minor, payment_id, reason, created_at
       FROM cash_event WHERE drawer_session_id = ANY($1) ORDER BY created_at`,
      [ids],
    );
    return sessions.rows.map((r) => ({
      id: r.id as string,
      drawerName: r.drawer_name as string,
      openedAt: new Date(r.opened_at as string).toISOString(),
      openingFloatMinor: Number(r.opening_float_minor),
      ...(r.closed_at ? { closedAt: new Date(r.closed_at as string).toISOString() } : {}),
      ...(r.counted_minor !== null ? { countedMinor: Number(r.counted_minor) } : {}),
      ...(r.expected_minor !== null ? { expectedMinor: Number(r.expected_minor) } : {}),
      ...(r.over_short_minor !== null ? { overShortMinor: Number(r.over_short_minor) } : {}),
      events: events.rows
        .filter((e) => e.drawer_session_id === r.id)
        .map((e) => ({
          id: e.id as string,
          kind: e.kind,
          amountMinor: Number(e.amount_minor),
          ...(e.payment_id ? { paymentId: e.payment_id as string } : {}),
          ...(e.reason ? { reason: e.reason as string } : {}),
          at: new Date(e.created_at as string).toISOString(),
        })),
    }));
  }

  /* ------------------------------- menu (E5) ------------------------------- */

  async getActiveSnapshot(): Promise<MenuSnapshot> {
    const r = await this.pool.query(
      "SELECT version, document FROM menu_snapshot WHERE location_id = $1 ORDER BY version DESC LIMIT 1",
      [LOC],
    );
    const doc = r.rows[0].document as { snapshotId: string; items: MenuSnapshot["items"]; groups: MenuSnapshot["groups"]; publishedAt?: string };
    return { id: doc.snapshotId, version: Number(r.rows[0].version), items: doc.items, groups: doc.groups, publishedAt: doc.publishedAt ?? "" };
  }

  async putSnapshot(snapshot: MenuSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO menu_snapshot (id, org_id, location_id, version, document, published_by)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (location_id, version) DO NOTHING`,
      [snapUuidFor(snapshot.id), ORG, LOC, snapshot.version,
       JSON.stringify({ snapshotId: snapshot.id, items: snapshot.items, groups: snapshot.groups, publishedAt: snapshot.publishedAt }), EMP],
    );
  }

  async getDraft(): Promise<MenuDraft | undefined> {
    const r = await this.pool.query("SELECT document FROM menu_draft WHERE location_id = $1", [LOC]);
    return r.rowCount ? (r.rows[0].document as MenuDraft) : undefined;
  }

  async putDraft(draft: MenuDraft): Promise<void> {
    await this.pool.query(
      `INSERT INTO menu_draft (location_id, document, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (location_id) DO UPDATE SET document = $2, updated_at = now()`,
      [LOC, JSON.stringify(draft)],
    );
  }

  async clearDraft(): Promise<void> {
    await this.pool.query("DELETE FROM menu_draft WHERE location_id = $1", [LOC]);
  }

  /** item_availability wants a menu_item row (FK); until the relational
   *  editor owns those rows, we create them on demand with the string item
   *  key bridged through menu_item.description as 'key:<id>'. */
  private async ensureMenuItem(c: pg.PoolClient, itemKey: string): Promise<string> {
    const id = uuidFrom("item:" + itemKey);
    await c.query(
      "INSERT INTO menu_item (id, org_id, name, description) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
      [id, ORG, itemKey, "key:" + itemKey],
    );
    return id;
  }

  async listAvailability(): Promise<Availability[]> {
    const r = await this.pool.query(
      `SELECT mi.description, ia.is_86, ia.remaining
       FROM item_availability ia JOIN menu_item mi ON mi.id = ia.item_id
       WHERE ia.location_id = $1 AND mi.description LIKE 'key:%'`,
      [LOC],
    );
    return r.rows.map((row) => ({
      itemId: (row.description as string).slice(4),
      is86: row.is_86 as boolean,
      ...(row.remaining !== null ? { remaining: Number(row.remaining) } : {}),
    }));
  }

  async setAvailability(availability: Availability): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const itemId = await this.ensureMenuItem(c, availability.itemId);
      await c.query(
        `INSERT INTO item_availability (location_id, item_id, remaining, is_86, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (location_id, item_id) DO UPDATE SET remaining = $3, is_86 = $4, updated_by = $5, updated_at = now()`,
        [LOC, itemId, availability.remaining ?? null, availability.is86, EMP],
      );
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }

  async dayStatus(serviceDate: string): Promise<"open" | "closed"> {
    const r = await this.pool.query("SELECT status FROM business_day WHERE location_id = $1 AND service_date = $2", [LOC, serviceDate]);
    return r.rowCount && r.rows[0].status === "closed" ? "closed" : "open";
  }

  async setDayStatus(serviceDate: string, status: "open" | "closed"): Promise<void> {
    const c = await this.pool.connect();
    try {
      await this.ensureBusinessDay(c, serviceDate);
      await c.query(
        `UPDATE business_day SET status = $1, closed_at = $2, closed_by = $3
         WHERE location_id = $4 AND service_date = $5`,
        [status, status === "closed" ? new Date().toISOString() : null, status === "closed" ? EMP : null, LOC, serviceDate],
      );
    } finally {
      c.release();
    }
  }
}

/* ------------------------------- helpers ------------------------------- */

import { createHash } from "node:crypto";

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** Deterministic UUID from an arbitrary string (op ids, menu item keys). */
function uuidFrom(s: string): string {
  const h = createHash("sha256").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The seeded v1 snapshot keeps its fixed uuid; later versions derive theirs. */
function snapUuidFor(snapshotId: string): string {
  return snapshotId === SNAPSHOT_ID ? SNAP : uuidFrom("snapshot:" + snapshotId);
}

import type { SelectedModifier } from "@restaurantos/domain";
import { GROUPS as MENU_GROUPS } from "./menu.js";

function describeFromSnapshot(sels: readonly SelectedModifier[]): string {
  const names: string[] = [];
  const walk = (list: readonly SelectedModifier[]) => {
    for (const s of list) {
      const option = MENU_GROUPS[s.groupId]?.options.find((o) => o.id === s.modifierId);
      if (option) names.push(option.name);
      if (s.children) walk(s.children);
    }
  };
  walk(sels);
  return names.join(", ");
}
