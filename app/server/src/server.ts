/**
 * RestaurantOS API server (Fastify, provisional per D16).
 * Thin HTTP skin over the Engine; no business rule lives in a route.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import { Engine, type CommandOutcome } from "./engine.js";
import { landingPage } from "./landing.js";
import { MemoryStore } from "./memoryStore.js";
import type { Screen } from "./staff.js";
import type { Envelope, Store } from "./types.js";

const page = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const POS_PAGE = page("pos.html");
const KDS_PAGE = page("kds.html");
const TABLES_PAGE = page("tables.html");
const CLOSE_PAGE = page("close.html");
const REPORTS_PAGE = page("reports.html");
const MENU_PAGE = page("menu.html");
const SETTINGS_PAGE = page("settings.html");
const RESERVATIONS_PAGE = page("reservations.html");
const SCHEDULE_PAGE = page("schedule.html");
const LOCK_PAGE = page("lock.html");

interface EnvelopeBody {
  operationId?: unknown;
  deviceId?: unknown;
  expectedVersion?: unknown;
}

function readEnvelope(body: EnvelopeBody): Envelope | { error: string } {
  if (typeof body?.operationId !== "string" || body.operationId.length < 8) {
    return { error: "operationId (client-generated, min 8 chars) is required on every mutation" };
  }
  if (typeof body?.deviceId !== "string" || body.deviceId.length < 1) {
    return { error: "deviceId is required on every mutation" };
  }
  if (body.expectedVersion !== undefined && !Number.isSafeInteger(body.expectedVersion)) {
    return { error: "expectedVersion must be an integer when present" };
  }
  const envelope: Envelope = { operationId: body.operationId, deviceId: body.deviceId };
  if (body.expectedVersion !== undefined) envelope.expectedVersion = body.expectedVersion as number;
  return envelope;
}


/** The approval PIN, forwarded only when it really is a string, so a missing
 *  PIN and a numeric one both reach the engine as "no manager approved this"
 *  rather than as the string "undefined". */
function managerPin(body: Record<string, unknown>): { managerPin?: string } {
  return typeof body.managerPin === "string" ? { managerPin: body.managerPin } : {};
}

/** The optional guest fields, passed through only when the caller sent them,
 *  so an omitted field keeps its value and an empty string clears it. */
function guestFields(body: Record<string, unknown>) {
  return {
    ...(typeof body.phone === "string" ? { phone: body.phone } : {}),
    ...(typeof body.email === "string" ? { email: body.email } : {}),
    ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
    ...(typeof body.marketingOptIn === "boolean" ? { marketingOptIn: body.marketingOptIn } : {}),
  };
}

/* ------------------- the visibility gate (E25-T1, D33) -------------------
   Every /v1 route belongs to exactly one screen, or is deliberately public.
   The table below says which, the preHandler hook enforces it, and the boot
   check underneath refuses to start a server whose table has a hole in it.

   ONE TABLE, not fifty guard clauses. The rule itself lives in staff.ts
   (VISIBILITY) and is applied in engine.allow(); this is only the routing
   question, "which screen is this route part of", which is a fact about the
   HTTP surface and therefore belongs to the HTTP file.

   PUBLIC is spelled out per route rather than being the default, so adding a
   route without deciding who may call it fails at boot instead of shipping
   open. The public ones fall into three groups: what a page must read before
   anybody has signed in (venue, roster, demo PINs, the live menu, the session
   itself), what identifies its own caller (sign-in, clock-out, an employee's
   own week), and the 86 board, which is the kitchen and the floor telling
   each other what has run out and is nobody's private screen. */
const PUBLIC = "public" as const;

const ROUTE_SCREEN: Record<string, Screen | typeof PUBLIC> = {
  "GET /v1/venue": PUBLIC,
  "POST /v1/venue": "settings",

  "GET /v1/reservations": "reservations",
  "POST /v1/reservations": "reservations",
  "POST /v1/reservations/:id/cancel": "reservations",
  "POST /v1/reservations/:id/no-show": "reservations",
  "POST /v1/reservations/:id/seat": "reservations",

  "POST /v1/schedule/week": "schedule",
  // an employee's OWN week, on nothing but the session they signed in with,
  // which is the "(own view)" the matrix grants every role including kitchen
  "GET /v1/schedule/mine": PUBLIC,
  "POST /v1/schedule/shift": "schedule",
  "POST /v1/schedule/shift/:id/remove": "schedule",
  "POST /v1/schedule/publish": "schedule",

  "GET /v1/payroll/period": "settings",
  "POST /v1/staff/hours-export": "settings",
  "GET /v1/staff": PUBLIC,
  "GET /v1/staff/demo-pins": PUBLIC,
  "POST /v1/staff/directory": "settings",
  "POST /v1/staff": "settings",
  "POST /v1/staff/:id": "settings",
  "POST /v1/staff/:id/pin": "settings",
  "POST /v1/staff/:id/deactivate": "settings",
  "POST /v1/staff/:id/role": "settings",

  "POST /v1/session": PUBLIC,
  "POST /v1/session/signout": PUBLIC,
  "GET /v1/session": PUBLIC,
  "POST /v1/shifts/clockout": PUBLIC,

  "GET /v1/menu": PUBLIC,
  "GET /v1/menu/draft": "menu",
  "POST /v1/menu/draft/item": "menu",
  "POST /v1/menu/draft/group": "menu",
  "POST /v1/menu/draft/group/remove": "menu",
  "POST /v1/menu/draft/assign": "menu",
  "POST /v1/menu/draft/remove": "menu",
  "POST /v1/menu/draft/discard": "menu",
  "POST /v1/menu/import": "menu",
  "POST /v1/menu/publish": "menu",
  // NOT the menu editor: 86ing the branzino is the kitchen saying it has run
  // out, and gating it behind the editor would lock out the one role most
  // likely to be holding the empty tray
  "POST /v1/menu/86": PUBLIC,

  "GET /v1/floor": "tables",
  "POST /v1/floor/move": "tables",
  "POST /v1/floor/add": "tables",
  "POST /v1/floor/update": "tables",
  "POST /v1/floor/resize": "tables",
  "POST /v1/floor/retire": "tables",

  "GET /v1/kds": "kitchen",
  "POST /v1/kds/toggle": "kitchen",
  "POST /v1/kds/serve": "kitchen",
  "POST /v1/kds/recall": "kitchen",

  "GET /v1/checks": "service",
  "GET /v1/checks/:id": "service",
  "GET /v1/checks/:id/split": "service",
  "GET /v1/checks/:id/history": "service",
  "POST /v1/checks": "service",
  "POST /v1/checks/:id/items": "service",
  // SENDING is a Service act, which is why it sits here and not with the KDS
  // routes above: a server's device puts food in front of the kitchen, and
  // only the kitchen bumps it back
  "POST /v1/checks/:id/send": "service",
  "POST /v1/checks/:id/hold": "service",
  "POST /v1/checks/:id/release": "service",
  "POST /v1/checks/:id/fire": "service",
  "POST /v1/checks/:id/payments": "service",
  "POST /v1/checks/:id/items/:itemId/void": "service",
  "POST /v1/checks/:id/adjustments": "service",
  "POST /v1/checks/:id/transfer": "service",
  "POST /v1/checks/:id/merge": "service",
  "POST /v1/checks/:id/close": "service",
  "POST /v1/checks/:id/reopen": "service",
  "POST /v1/checks/:id/guests": "service",
  "POST /v1/checks/:id/guests/:guestId/detach": "service",
  "GET /v1/guests": "service",
  "GET /v1/guests/:id": "service",
  "POST /v1/guests": "service",
  "POST /v1/guests/:id/update": "service",
  "POST /v1/guests/:id/merge": "service",
  "POST /v1/guests/:id/delete": "service",

  "GET /v1/day": "cash",
  "POST /v1/day/close": "cash",
  "POST /v1/day/reopen": "cash",
  "POST /v1/drawer/open": "cash",
  "POST /v1/drawer/event": "cash",
  "POST /v1/drawer/close": "cash",

  "GET /v1/insights/servers": "reports",
  "GET /v1/insights/heatmap": "reports",
  "POST /v1/insights/labor": "reports",
};

/**
 * Who is asking, as far as HTTP can tell.
 *
 * The device comes from the mutation envelope, a `deviceId` query parameter,
 * or an `x-device-id` header, in that order, so a read can identify itself
 * without a PIN travelling in a URL.
 *
 * The PIN is `managerPin` and ONLY `managerPin`. Never `pin`: on the hire
 * route `pin` is the NEW employee's, and reading it as the caller's would let
 * anybody act as the person they just invented.
 */
function asker(req: FastifyRequest): { deviceId?: string; pin?: unknown } {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const query = (req.query ?? {}) as Record<string, unknown>;
  const header = req.headers["x-device-id"];
  const deviceId = [body.deviceId, query.deviceId, header].find((v) => typeof v === "string" && v) as string | undefined;
  return {
    ...(deviceId ? { deviceId } : {}),
    ...(typeof body.managerPin === "string" && body.managerPin ? { pin: body.managerPin } : {}),
  };
}

function respond(reply: FastifyReply, outcome: CommandOutcome): unknown {
  switch (outcome.kind) {
    case "applied":
      return reply.code(200).send({
        status: "APPLIED",
        ...(outcome.check ? { check: outcome.check } : {}),
        ...(outcome.tickets ? { tickets: outcome.tickets } : {}),
        ...(outcome.session ? { session: outcome.session } : {}),
        ...(outcome.day ? { day: outcome.day } : {}),
        ...(outcome.menu !== undefined ? { menu: outcome.menu } : {}),
        ...(outcome.guest !== undefined ? { guest: outcome.guest } : {}),
        ...(outcome.venue !== undefined ? { venue: outcome.venue } : {}),
        ...(outcome.employee !== undefined ? { employee: outcome.employee } : {}),
        ...(outcome.reservation !== undefined ? { reservation: outcome.reservation } : {}),
        ...(outcome.plannedShift !== undefined ? { plannedShift: outcome.plannedShift } : {}),
        ...(outcome.schedule !== undefined ? { schedule: outcome.schedule } : {}),
        ...(outcome.audit !== undefined ? { audit: outcome.audit } : {}),
        ...(outcome.refundDueMinor !== undefined ? { refundDueMinor: outcome.refundDueMinor } : {}),
        ...(outcome.note !== undefined ? { note: outcome.note } : {}),
      });
    case "replay":
      return respond(reply, outcome.result);
    case "conflict":
      return reply.code(409).send({
        status: "CONFLICT",
        reason: "STALE_AGGREGATE_VERSION",
        expectedVersion: outcome.expectedVersion,
        currentVersion: outcome.currentVersion,
      });
    case "rejected":
      return reply.code(422).send({
        status: "REJECTED",
        reason: outcome.reason,
        ...(outcome.modifierErrors ? { modifierErrors: outcome.modifierErrors } : {}),
      });
    case "not_found":
      return reply.code(404).send({ status: "NOT_FOUND" });
  }
}

export function buildServer(store: Store = new MemoryStore(), storeName = "memory"): FastifyInstance {
  const app = Fastify({ logger: false });
  const engine = new Engine(store);

  /* The gate (E25-T1). preHandler rather than onRequest because the body is
     parsed by now, which is where a mutation's deviceId and a gated read's
     managerPin both live.

     403 FORBIDDEN, not 422 REJECTED. A rejected command is one the engine
     considered and refused; this one never reached the engine and there is no
     operation to remember, so it answers with the HTTP word for "I know who
     you are and the answer is still no". The PIN-level refusals inside
     commands (manager gates, the owner acts) keep their 422, because those
     ARE decisions the engine made. */
  app.addHook("preHandler", async (req, reply) => {
    const screen = ROUTE_SCREEN[`${req.method} ${req.routeOptions.url}`];
    if (!screen || screen === PUBLIC) return;
    const verdict = await engine.allow(screen, asker(req));
    if (!verdict.ok) return reply.code(403).send({ status: "FORBIDDEN", reason: verdict.reason });
  });

  /* Every /v1 route must have decided who may call it. A route registered
     without a row above is a hole in the matrix that nothing else would
     notice, so the server refuses to boot instead of serving it open. */
  const unclassified: string[] = [];
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/v1/")) return;
    for (const method of [route.method].flat()) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      if (!(`${method} ${route.url}` in ROUTE_SCREEN)) unclassified.push(`${method} ${route.url}`);
    }
  });
  app.addHook("onReady", async () => {
    if (unclassified.length) {
      throw new Error(`E25-T1: these routes are not in ROUTE_SCREEN, so nobody has said who may call them: ${unclassified.join(", ")}`);
    }
  });

  app.get("/", async (_req, reply) => reply.type("text/html").send(LOCK_PAGE));
  app.get("/api", async (_req, reply) => reply.type("text/html").send(landingPage()));
  app.get("/pos", async (_req, reply) => reply.type("text/html").send(POS_PAGE));
  app.get("/kds", async (_req, reply) => reply.type("text/html").send(KDS_PAGE));
  app.get("/tables", async (_req, reply) => reply.type("text/html").send(TABLES_PAGE));
  app.get("/close", async (_req, reply) => reply.type("text/html").send(CLOSE_PAGE));
  app.get("/reports", async (_req, reply) => reply.type("text/html").send(REPORTS_PAGE));
  // the screen was called Insights until D24 reserved that word for the
  // Phase 6 intelligence layer; bookmarks and muscle memory still land
  app.get("/insights", async (_req, reply) => reply.redirect("/reports", 302));
  app.get("/menu", async (_req, reply) => reply.type("text/html").send(MENU_PAGE));
  // the seventh screen (E21-T2): the venue's own identity and its roster
  app.get("/settings", async (_req, reply) => reply.type("text/html").send(SETTINGS_PAGE));
  // the eighth (E23-T3): the call-in book, one service day at a time
  app.get("/reservations", async (_req, reply) => reply.type("text/html").send(RESERVATIONS_PAGE));
  // the ninth (E24-T5): a server's own week, and behind a manager PIN the
  // week being built and the hours it turned into
  app.get("/schedule", async (_req, reply) => reply.type("text/html").send(SCHEDULE_PAGE));
  app.get("/health/live", async () => ({ ok: true, service: "restaurantos-server", store: storeName }));

  /* -------------------------- sessions (E15) -------------------------- */

  /* ------------------- venue and roster (E21-T1) -------------------
   * The venue read is public: a lock screen prints the restaurant's name
   * before anybody has signed in. The roster read carries no PIN and no
   * hash, ever. The demo PINs the lock screen and the sign-in sheet print
   * on purpose come from their own route off the seed constant, so a PIN a
   * real manager sets can never be served by the roster. */

  app.get("/v1/venue", async () => engine.venue());

  app.post("/v1/venue", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.updateVenue(envelope, {
      ...managerPin(body),
      // absent means "leave it alone"; an empty string is a real edit
      ...(body.name !== undefined ? { name: String(body.name) } : {}),
      ...(body.address !== undefined ? { address: String(body.address) } : {}),
      ...(body.timezone !== undefined ? { timezone: String(body.timezone) } : {}),
      ...(body.payPeriod !== undefined ? { payPeriod: String(body.payPeriod) } : {}),
      ...(body.payPeriodAnchor !== undefined ? { payPeriodAnchor: String(body.payPeriodAnchor) } : {}),
      ...(body.reservationLeadMinutes !== undefined ? { reservationLeadMinutes: Number(body.reservationLeadMinutes) } : {}),
      ...(body.reservationHoldMinutes !== undefined ? { reservationHoldMinutes: Number(body.reservationHoldMinutes) } : {}),
    }));
  });

  /* ------------------ the call-in book (E23-T2) ------------------
     Not manager-gated: whoever answers the phone takes the booking. The
     actor is recorded, which is the honest trade for keeping a call to
     four seconds. */

  app.get("/v1/reservations", async (req) => {
    const { date } = req.query as { date?: string };
    return engine.reservations(date);
  });

  app.post("/v1/reservations", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.bookReservation(envelope, {
      name: String(body.name ?? ""),
      ...(typeof body.phone === "string" ? { phone: body.phone } : {}),
      partySize: Number(body.partySize),
      reservedFor: String(body.reservedFor ?? ""),
      ...(typeof body.tableName === "string" ? { tableName: body.tableName } : {}),
      ...(typeof body.note === "string" ? { note: body.note } : {}),
    }));
  });

  app.post("/v1/reservations/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const envelope = readEnvelope((req.body ?? {}) as EnvelopeBody);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.cancelReservation(envelope, id));
  });

  app.post("/v1/reservations/:id/no-show", async (req, reply) => {
    const { id } = req.params as { id: string };
    const envelope = readEnvelope((req.body ?? {}) as EnvelopeBody);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.markNoShow(envelope, id));
  });

  app.post("/v1/reservations/:id/seat", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.seatReservation(envelope, id, {
      ...(typeof body.tableName === "string" ? { tableName: body.tableName } : {}),
      // the guest is attached only when a human confirmed the match; the read
      // proposes, a person decides (D20)
      ...(typeof body.guestId === "string" ? { guestId: body.guestId } : {}),
      ...(body.confirmOverride === true ? { confirmOverride: true } : {}),
    }));
  });

  /* ------------------ the schedule (E24-T4, D28 rung 2) ------------------
     What was MEANT to happen, beside the clock records of what did.

     DEVIATION FROM THE TICKET, flagged for review. E24-T4 specifies
     `GET /v1/schedule?weekOf=...&managerPin=...`, but a manager's PIN in a
     query string lands in the server log, the browser history, and any
     referrer header the page emits. E24-T2 met the same question one ticket
     earlier and answered it in a comment on `/v1/staff/directory`: a gated
     READ is served over POST here so the PIN travels in the body. The hours
     export (E24-T3) does the same. Both gated reads below follow that
     precedent rather than re-open a decision this epic already made; the
     shape and the fields are otherwise exactly what the ticket asked for.
     `/v1/schedule/mine` stays a GET, because a deviceId is not a secret. */

  /** The manager's week: every active employee, seven days, drafts and
   *  published together, because the person building the week is the one
   *  person meant to see it mid-edit. */
  app.post("/v1/schedule/week", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await engine.schedule(body.managerPin, typeof body.weekOf === "string" ? body.weekOf : undefined);
    if (!result.ok) return reply.code(422).send({ status: "REJECTED", reason: result.reason });
    return result;
  });

  /** An employee's own week, published rows only, on nothing but the session
   *  they already signed in with. A server checking their Tuesday between
   *  tables must not have to go and find a manager. */
  app.get("/v1/schedule/mine", async (req, reply) => {
    const { deviceId, weekOf } = req.query as { deviceId?: string; weekOf?: string };
    if (!deviceId) return reply.code(400).send({ status: "BAD_REQUEST", reason: "deviceId is required" });
    const result = await engine.myShifts(deviceId, weekOf);
    if (!result.ok) return reply.code(401).send({ status: "UNAUTHORIZED", reason: result.reason });
    return result;
  });

  /** Add or edit one shift. An `id` in the body edits that row; no id writes
   *  a new one, always as a draft. */
  app.post("/v1/schedule/shift", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.upsertPlannedShift(envelope, {
      ...managerPin(body),
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      ...(typeof body.employeeId === "string" ? { employeeId: body.employeeId } : {}),
      ...(typeof body.roleForShift === "string" ? { roleForShift: body.roleForShift } : {}),
      ...(typeof body.startsAt === "string" ? { startsAt: body.startsAt } : {}),
      ...(typeof body.endsAt === "string" ? { endsAt: body.endsAt } : {}),
    }));
  });

  app.post("/v1/schedule/shift/:id/remove", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.removePlannedShift(envelope, id, managerPin(body).managerPin));
  });

  /** One act, the whole week, the menu's own discipline. */
  app.post("/v1/schedule/publish", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.publishSchedule(envelope, {
      ...managerPin(body),
      weekOf: String(body.weekOf ?? ""),
    }));
  });

  /** The pay period the export would cover, so the Settings screen can name
   *  it before anybody asks for the file. Not gated: it is two dates, and the
   *  file behind them is. */
  app.get("/v1/payroll/period", async (req) => {
    const { on } = req.query as { on?: string };
    return { period: await engine.payPeriodFor(on) };
  });

  /** Hours and declared tips for one period (E24-T3). A POST because the
   *  manager's PIN is the body, checked on every call, exactly as the staff
   *  directory read is. The response is the file itself. */
  app.post("/v1/staff/hours-export", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await engine.hoursExport(body.managerPin, typeof body.periodEnd === "string" ? body.periodEnd : undefined);
    if (!result.ok) return reply.code(422).send({ status: "REJECTED", reason: result.reason });
    return reply
      .type("text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="hours-${result.period.start}-to-${result.period.end}.csv"`)
      .send(result.csv);
  });

  app.get("/v1/staff", async () => ({ staff: await engine.staff() }));

  app.get("/v1/staff/demo-pins", async () => ({ staff: engine.demoPins() }));

  /** The gated directory read (E24-T2). A POST because the manager's PIN is
   *  the body of the request, and a PIN does not belong in a URL that lands
   *  in a log, a history list, or a referrer header. */
  app.post("/v1/staff/directory", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await engine.directory(body.managerPin);
    if (!result.ok) return reply.code(422).send({ status: "REJECTED", reason: result.reason });
    return { staff: result.staff };
  });

  /** The optional detail fields (E24-T2), forwarded only when the caller sent
   *  them as strings, so an omitted field keeps its value and an empty string
   *  clears it. Same shape as guestFields above, same reason. */
  function detailFields(body: Record<string, unknown>) {
    return {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.phone === "string" ? { phone: body.phone } : {}),
      ...(typeof body.email === "string" ? { email: body.email } : {}),
      ...(typeof body.emergencyContact === "string" ? { emergencyContact: body.emergencyContact } : {}),
      ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
    };
  }

  app.post("/v1/staff", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.addEmployee(envelope, {
      ...managerPin(body),
      name: String(body.name ?? ""),
      ...(body.role !== undefined ? { role: String(body.role) } : {}),
      // the PIN stays a string: Number("0123") would silently become 123
      ...(typeof body.pin === "string" ? { pin: body.pin } : {}),
      ...detailFields(body),
    }));
  });

  app.post("/v1/staff/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.updateEmployee(envelope, {
      ...managerPin(body), employeeId: id,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...detailFields(body),
    }));
  });

  app.post("/v1/staff/:id/pin", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.resetPin(envelope, {
      ...managerPin(body), employeeId: id,
      ...(typeof body.pin === "string" ? { pin: body.pin } : {}),
    }));
  });

  /** Promote or demote (E25-T1). Its own route because it is the one roster
   *  write that changes what a PIN may approve; `/v1/staff/:id` still refuses
   *  to touch the role no matter what a form posts at it. */
  app.post("/v1/staff/:id/role", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.setEmployeeRole(envelope, {
      ...managerPin(body), employeeId: id,
      ...(body.role !== undefined ? { role: String(body.role) } : {}),
    }));
  });

  app.post("/v1/staff/:id/deactivate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.deactivateEmployee(envelope, { ...managerPin(body), employeeId: id }));
  });

  app.post("/v1/session", async (req, reply) => {
    const body = (req.body ?? {}) as { deviceId?: unknown; pin?: unknown };
    if (typeof body.deviceId !== "string" || !body.deviceId) {
      return reply.code(400).send({ status: "BAD_REQUEST", reason: "deviceId is required" });
    }
    if (typeof body.pin !== "string" || !body.pin) {
      return reply.code(400).send({ status: "BAD_REQUEST", reason: "pin is required" });
    }
    const employee = await engine.signIn(body.deviceId, body.pin);
    if (!employee) return reply.code(401).send({ status: "UNAUTHORIZED", reason: "PIN not recognized" });
    return { employee };
  });

  app.post("/v1/session/signout", async (req, reply) => {
    const body = (req.body ?? {}) as { deviceId?: unknown };
    if (typeof body.deviceId !== "string" || !body.deviceId) {
      return reply.code(400).send({ status: "BAD_REQUEST", reason: "deviceId is required" });
    }
    engine.signOut(body.deviceId);
    return { ok: true };
  });

  /** Who is signed in here, and the matrix row that goes with them (E25-T1).
   *  The visibility comes down WITH the employee so a page never has to work
   *  out from a role string which screens it may show; there is one matrix and
   *  it lives on the server. */
  app.get("/v1/session", async (req) => {
    const { deviceId } = req.query as { deviceId?: string };
    return engine.session(deviceId);
  });

  app.get("/v1/menu", async () => engine.menu());
  app.get("/v1/menu/draft", async () => engine.menuDraft());
  app.get("/v1/floor", async () => ({ tables: await engine.floor() }));
  app.get("/v1/kds", async () => ({ tickets: await engine.kds() }));

  app.get("/v1/checks", async () => ({ checks: await engine.listChecks() }));
  app.get("/v1/checks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const check = await engine.getCheck(id);
    return check ? { check } : reply.code(404).send({ status: "NOT_FOUND" });
  });

  /** Split preview (E11): what each portion owes right now. A read, because
   *  nothing about a split is stored. `?mode=even&ways=3` or `?mode=bySeat`. */
  app.get("/v1/checks/:id/split", async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { mode?: string; ways?: string };
    const result = await engine.splitPreview(id, {
      ...(query.mode !== undefined ? { mode: query.mode } : {}),
      ...(query.ways !== undefined ? { ways: Number(query.ways) } : {}),
    });
    if (!result) return reply.code(404).send({ status: "NOT_FOUND" });
    if ("error" in result) return reply.code(400).send({ status: "BAD_REQUEST", reason: result.error });
    return result;
  });

  app.post("/v1/checks", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & { tableName?: unknown; covers?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    if (typeof body.tableName !== "string" || body.tableName.length < 1) {
      return reply.code(400).send({ status: "BAD_REQUEST", reason: "tableName is required" });
    }
    return respond(reply, await engine.openCheck(envelope, { tableName: body.tableName, covers: Number(body.covers) }));
  });

  app.post("/v1/checks/:id/items", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(
      reply,
      await engine.addItem(envelope, id, {
        itemId: String(body.itemId ?? ""),
        quantity: Number(body.quantity ?? 1),
        seatNo: Number(body.seatNo ?? 1),
        modifiers: Array.isArray(body.modifiers) ? body.modifiers : [],
      }),
    );
  });

  app.post("/v1/checks/:id/send", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & { course?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.send(envelope, id, typeof body.course === "string" ? { course: body.course } : {}));
  });


  /* --------------------- courses: hold and fire (E8-T3) ---------------------
   * A hold is check state, not kitchen state: nothing is dispatched, so these
   * are ordinary check commands, version-checked like the rest. */

  app.post("/v1/checks/:id/hold", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & { course?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.holdCourse(envelope, id, { course: String(body.course ?? "") }));
  });

  app.post("/v1/checks/:id/release", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & { course?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.releaseCourse(envelope, id, { course: String(body.course ?? "") }));
  });

  app.post("/v1/checks/:id/fire", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & { course?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.fireCourse(envelope, id, { course: String(body.course ?? "") }));
  });

  /** The check's own story (E8-T3): derived on read, nothing stored for it. */
  app.get("/v1/checks/:id/history", async (req, reply) => {
    const { id } = req.params as { id: string };
    const history = await engine.checkHistory(id);
    return history ? history : reply.code(404).send({ status: "NOT_FOUND" });
  });

  app.post("/v1/checks/:id/payments", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    const method = body.method === "cash" ? "cash" : body.method === "card" ? "card" : undefined;
    if (!method) return reply.code(400).send({ status: "BAD_REQUEST", reason: "method must be 'card' or 'cash'" });
    return respond(
      reply,
      await engine.recordPayment(envelope, id, {
        method,
        amountMinor: Number(body.amountMinor ?? 0),
        tipMinor: Number(body.tipMinor ?? 0),
        ...(typeof body.label === "string" ? { label: body.label } : {}),
        ...(body.offline === true ? { offline: true } : {}),
      }),
    );
  });

  app.post("/v1/checks/:id/items/:itemId/void", async (req, reply) => {
    const { id, itemId } = req.params as { id: string; itemId: string };
    const body = (req.body ?? {}) as EnvelopeBody & { reason?: unknown; managerPin?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.voidItem(envelope, id, {
      orderItemId: itemId,
      reason: String(body.reason ?? ""),
      ...(typeof body.managerPin === "string" ? { managerPin: body.managerPin } : {}),
    }));
  });

  app.post("/v1/checks/:id/adjustments", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.applyAdjustment(envelope, id, {
      ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
      ...(typeof body.label === "string" ? { label: body.label } : {}),
      ...(body.amountMinor !== undefined ? { amountMinor: Number(body.amountMinor) } : {}),
      ...(body.percentBp !== undefined ? { percentBp: Number(body.percentBp) } : {}),
      reason: String(body.reason ?? ""),
      ...(typeof body.managerPin === "string" ? { managerPin: body.managerPin } : {}),
    }));
  });

  app.post("/v1/checks/:id/transfer", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & { tableName?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.transferCheck(envelope, id, { tableName: String(body.tableName ?? "") }));
  });

  app.post("/v1/checks/:id/merge", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & { sourceCheckId?: unknown; managerPin?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.mergeChecks(envelope, id, {
      sourceCheckId: String(body.sourceCheckId ?? ""),
      ...(typeof body.managerPin === "string" ? { managerPin: body.managerPin } : {}),
    }));
  });

  app.post("/v1/checks/:id/close", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & { managerPin?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    // a close that owes the guest a refund needs a manager (E2-T2)
    return respond(reply, await engine.close(envelope, id, typeof body.managerPin === "string" ? { managerPin: body.managerPin } : {}));
  });

  app.post("/v1/checks/:id/reopen", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & { managerPin?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.reopenCheck(envelope, id, typeof body.managerPin === "string" ? { managerPin: body.managerPin } : {}));
  });

  app.post("/v1/shifts/clockout", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & { pin?: unknown; declaredTipsMinor?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.clockOut(envelope, {
      pin: String(body.pin ?? ""),
      ...(body.declaredTipsMinor !== undefined ? { declaredTipsMinor: Number(body.declaredTipsMinor) } : {}),
    }));
  });

  /* ------------------------------- menu ------------------------------- */

  app.post("/v1/menu/draft/item", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.menuUpsertItem(envelope, {
      ...(typeof body.itemId === "string" ? { itemId: body.itemId } : {}),
      name: String(body.name ?? ""),
      priceMinor: Number(body.priceMinor),
      course: String(body.course ?? ""),
      station: String(body.station ?? ""),
      // groupIds is the name E5-T2 gave the same field on the group commands;
      // both spellings are accepted so one vocabulary works across the editor
      ...(Array.isArray(body.modifierGroupIds) ? { modifierGroupIds: body.modifierGroupIds.map(String) }
        : Array.isArray(body.groupIds) ? { modifierGroupIds: body.groupIds.map(String) } : {}),
    }));
  });

  /* modifier groups on the draft (E5-T2): the menu's shape, not just its
     items, edited behind the same manager gate publishing already uses */

  app.post("/v1/menu/draft/group", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    const options = Array.isArray(body.options)
      ? body.options.map((raw) => {
          const o = (raw ?? {}) as Record<string, unknown>;
          return {
            ...(typeof o.id === "string" ? { id: o.id } : {}),
            name: String(o.name ?? ""),
            priceMinor: Number(o.priceMinor ?? 0),
            ...(o.isDefault === true ? { isDefault: true } : {}),
            ...(Array.isArray(o.childGroupIds) ? { childGroupIds: o.childGroupIds.map(String) } : {}),
          };
        })
      : [];
    return respond(reply, await engine.upsertDraftGroup(envelope, {
      ...managerPin(body),
      ...(typeof body.groupId === "string" ? { groupId: body.groupId } : {}),
      name: String(body.name ?? ""),
      ...(body.minSelect !== undefined ? { minSelect: Number(body.minSelect) } : {}),
      // null is meaningful here (unlimited), so it must survive the read
      ...(body.maxSelect !== undefined ? { maxSelect: body.maxSelect === null ? null : Number(body.maxSelect) } : {}),
      options,
    }));
  });

  app.post("/v1/menu/draft/group/remove", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.removeDraftGroup(envelope, {
      ...managerPin(body), groupId: String(body.groupId ?? ""),
    }));
  });

  app.post("/v1/menu/draft/assign", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.assignItemGroups(envelope, {
      ...managerPin(body), itemId: String(body.itemId ?? ""),
      // an absent array is not an empty one: only a sent array clears
      ...(Array.isArray(body.groupIds) ? { groupIds: body.groupIds.map(String) } : {}),
    }));
  });

  /** The menu import (E22-T2). The page reads the file in the browser and
   *  posts its TEXT, so the server never learns a filename or a path: what
   *  crosses the wire is the menu, not the manager's disk. */
  app.post("/v1/menu/import", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.importMenuCsv(envelope, {
      ...managerPin(body),
      ...(typeof body.csv === "string" ? { csv: body.csv } : {}),
    }));
  });

  app.post("/v1/menu/draft/remove", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & { itemId?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.menuRemoveItem(envelope, { itemId: String(body.itemId ?? "") }));
  });

  app.post("/v1/menu/draft/discard", async (req, reply) => {
    const envelope = readEnvelope((req.body ?? {}) as EnvelopeBody);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.menuDiscardDraft(envelope));
  });

  app.post("/v1/menu/publish", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & { managerPin?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.menuPublish(envelope, typeof body.managerPin === "string" ? { managerPin: body.managerPin } : {}));
  });

  app.post("/v1/menu/86", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & { itemId?: unknown; is86?: unknown; remaining?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.set86(envelope, {
      itemId: String(body.itemId ?? ""),
      ...(typeof body.is86 === "boolean" ? { is86: body.is86 } : {}),
      ...(body.remaining !== undefined ? { remaining: Number(body.remaining) } : {}),
    }));
  });

  /* ------------------------ cash + business day ------------------------ */

  app.get("/v1/day", async () => engine.dayReport());

  /* --------------------------- reports (E19) ---------------------------
   * Both are pure reads over the ledger, so no envelope and no version:
   * there is nothing to replay and nothing to conflict with.
   *
   * The paths keep their /v1/insights names on purpose (D24): the screen was
   * renamed because "Insights" is the Phase 6 intelligence layer's word, and
   * an API path is not user-facing copy worth a breaking change. */

  app.get("/v1/insights/servers", async () => engine.insightsServers());
  app.get("/v1/insights/heatmap", async () => engine.insightsHeatmap());

  /** Planned against actual for one day (E24-T4), in HOURS and never in
   *  money. Manager-gated, and therefore a POST with the PIN in the body for
   *  the reason spelled out on the schedule routes above; it keeps its
   *  /v1/insights name because that is where the ticket put it and where the
   *  Labor screen will look for it. */
  app.post("/v1/insights/labor", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await engine.labor(body.managerPin, typeof body.date === "string" ? body.date : undefined);
    if (!result.ok) return reply.code(422).send({ status: "REJECTED", reason: result.reason });
    return result;
  });

  app.post("/v1/drawer/open", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & { drawerName?: unknown; openingFloatMinor?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.openDrawer(envelope, {
      drawerName: String(body.drawerName ?? ""), openingFloatMinor: Number(body.openingFloatMinor),
    }));
  });

  app.post("/v1/drawer/event", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.drawerEvent(envelope, {
      sessionId: String(body.sessionId ?? ""), kind: String(body.kind ?? ""),
      amountMinor: Number(body.amountMinor), reason: String(body.reason ?? ""),
      ...(typeof body.managerPin === "string" ? { managerPin: body.managerPin } : {}),
    }));
  });

  app.post("/v1/drawer/close", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & { sessionId?: unknown; countedMinor?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.closeDrawer(envelope, {
      sessionId: String(body.sessionId ?? ""), countedMinor: Number(body.countedMinor),
    }));
  });

  app.post("/v1/day/close", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & { managerPin?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.closeDay(envelope, typeof body.managerPin === "string" ? { managerPin: body.managerPin } : {}));
  });

  app.post("/v1/day/reopen", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & { managerPin?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.reopenDay(envelope, typeof body.managerPin === "string" ? { managerPin: body.managerPin } : {}));
  });

  app.post("/v1/floor/move", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & { tableName?: unknown; x?: unknown; y?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.moveTable(envelope, {
      tableName: String(body.tableName ?? ""), x: Number(body.x), y: Number(body.y),
    }));
  });

  /* --------------------- floor editor (E6-T2) ---------------------
   * Structural edits to the room. managerPin is coerced the way /v1/day/close
   * coerces it: passed through only when it really is a string, so a missing
   * PIN and a numeric one both land on the same refusal. */

  app.post("/v1/floor/add", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.addTable(envelope, {
      ...managerPin(body),
      name: String(body.name ?? ""), area: String(body.area ?? ""), seats: Number(body.seats),
      ...(body.shape !== undefined ? { shape: String(body.shape) } : {}),
      x: Number(body.x), y: Number(body.y), w: Number(body.w), h: Number(body.h),
    }));
  });

  app.post("/v1/floor/update", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.updateTable(envelope, {
      ...managerPin(body),
      tableName: String(body.tableName ?? ""),
      // absent means "leave it alone", so each field is forwarded only when
      // the caller actually sent it
      ...(body.newName !== undefined ? { newName: String(body.newName) } : {}),
      ...(body.seats !== undefined ? { seats: Number(body.seats) } : {}),
      ...(body.shape !== undefined ? { shape: String(body.shape) } : {}),
    }));
  });

  app.post("/v1/floor/resize", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.resizeTable(envelope, {
      ...managerPin(body), tableName: String(body.tableName ?? ""), w: Number(body.w), h: Number(body.h),
    }));
  });

  app.post("/v1/floor/retire", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.retireTable(envelope, {
      ...managerPin(body), tableName: String(body.tableName ?? ""),
    }));
  });


  /* --------------------------- guestbook (E20) ---------------------------
   * Two reads (search, profile) and the commands behind them. The profile is
   * computed on read like every other projection here, so nothing on it can
   * drift from the checks it is made of. */

  app.get("/v1/guests", async (req) => {
    const { q } = req.query as { q?: string };
    return engine.guestSearch(q);
  });

  app.get("/v1/guests/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const profile = await engine.guestProfile(id);
    return profile ? profile : reply.code(404).send({ status: "NOT_FOUND" });
  });

  app.post("/v1/guests", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.createGuest(envelope, {
      displayName: String(body.displayName ?? ""),
      ...guestFields(body),
    }));
  });

  app.post("/v1/guests/:id/update", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & Record<string, unknown>;
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.updateGuest(envelope, id, {
      ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
      ...guestFields(body),
    }));
  });

  /** Merge is manager-gated: :id survives, absorbedId goes. */
  app.post("/v1/guests/:id/merge", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & { absorbedId?: unknown; managerPin?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.mergeGuests(envelope, id, {
      absorbedId: String(body.absorbedId ?? ""),
      ...(typeof body.managerPin === "string" ? { managerPin: body.managerPin } : {}),
    }));
  });

  /** A deletion request: identity and links go, the checks stay. */
  app.post("/v1/guests/:id/delete", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & { managerPin?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.deleteGuest(envelope, id, typeof body.managerPin === "string" ? { managerPin: body.managerPin } : {}));
  });

  app.post("/v1/checks/:id/guests", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as EnvelopeBody & { guestId?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.attachGuest(envelope, id, { guestId: String(body.guestId ?? "") }));
  });

  app.post("/v1/checks/:id/guests/:guestId/detach", async (req, reply) => {
    const { id, guestId } = req.params as { id: string; guestId: string };
    const envelope = readEnvelope((req.body ?? {}) as EnvelopeBody);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.detachGuest(envelope, id, guestId));
  });

  /* ------------------------------- KDS ------------------------------- */

  app.post("/v1/kds/toggle", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & { ticketId?: unknown; orderItemId?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.toggleItem(envelope, String(body.ticketId ?? ""), String(body.orderItemId ?? "")));
  });

  app.post("/v1/kds/serve", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & { tableName?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.serveTable(envelope, String(body.tableName ?? "")));
  });

  app.post("/v1/kds/recall", async (req, reply) => {
    const body = (req.body ?? {}) as EnvelopeBody & { ticketId?: unknown };
    const envelope = readEnvelope(body);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.recallTicket(envelope, String(body.ticketId ?? "")));
  });

  return app;
}
