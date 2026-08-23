/**
 * RestaurantOS API server (Fastify, provisional per D16).
 * Thin HTTP skin over the Engine; no business rule lives in a route.
 */
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { readFileSync } from "node:fs";
import { Engine, type CommandOutcome } from "./engine.js";
import { landingPage } from "./landing.js";
import { MemoryStore } from "./memoryStore.js";
import type { Envelope, Store } from "./types.js";

const page = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const POS_PAGE = page("pos.html");
const KDS_PAGE = page("kds.html");
const TABLES_PAGE = page("tables.html");
const CLOSE_PAGE = page("close.html");
const INSIGHTS_PAGE = page("insights.html");
const MENU_PAGE = page("menu.html");
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

  app.get("/", async (_req, reply) => reply.type("text/html").send(LOCK_PAGE));
  app.get("/api", async (_req, reply) => reply.type("text/html").send(landingPage()));
  app.get("/pos", async (_req, reply) => reply.type("text/html").send(POS_PAGE));
  app.get("/kds", async (_req, reply) => reply.type("text/html").send(KDS_PAGE));
  app.get("/tables", async (_req, reply) => reply.type("text/html").send(TABLES_PAGE));
  app.get("/close", async (_req, reply) => reply.type("text/html").send(CLOSE_PAGE));
  app.get("/insights", async (_req, reply) => reply.type("text/html").send(INSIGHTS_PAGE));
  app.get("/menu", async (_req, reply) => reply.type("text/html").send(MENU_PAGE));
  app.get("/health/live", async () => ({ ok: true, service: "restaurantos-server", store: storeName }));

  /* -------------------------- sessions (E15) -------------------------- */

  app.get("/v1/staff", async () => ({ staff: engine.staff() }));

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

  app.get("/v1/session", async (req) => {
    const { deviceId } = req.query as { deviceId?: string };
    return { employee: deviceId ? engine.who(deviceId) : null };
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
    const envelope = readEnvelope((req.body ?? {}) as EnvelopeBody);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.close(envelope, id));
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
      ...(Array.isArray(body.modifierGroupIds) ? { modifierGroupIds: body.modifierGroupIds.map(String) } : {}),
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

  /* --------------------------- insights (E19) ---------------------------
   * Both are pure reads over the ledger, so no envelope and no version:
   * there is nothing to replay and nothing to conflict with. */

  app.get("/v1/insights/servers", async () => engine.insightsServers());
  app.get("/v1/insights/heatmap", async () => engine.insightsHeatmap());

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
