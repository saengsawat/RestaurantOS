/**
 * RestaurantOS API server (Fastify, provisional per D16).
 * Thin HTTP skin over the Engine; no business rule lives in a route.
 */
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { readFileSync } from "node:fs";
import { Engine, type CommandOutcome } from "./engine.js";
import { GROUPS, MENU, SNAPSHOT_ID } from "./menu.js";
import { landingPage } from "./landing.js";
import { MemoryStore } from "./memoryStore.js";
import type { Envelope, Store } from "./types.js";

const page = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const POS_PAGE = page("pos.html");
const KDS_PAGE = page("kds.html");
const TABLES_PAGE = page("tables.html");

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

  app.get("/", async (_req, reply) => reply.type("text/html").send(landingPage()));
  app.get("/pos", async (_req, reply) => reply.type("text/html").send(POS_PAGE));
  app.get("/kds", async (_req, reply) => reply.type("text/html").send(KDS_PAGE));
  app.get("/tables", async (_req, reply) => reply.type("text/html").send(TABLES_PAGE));
  app.get("/health/live", async () => ({ ok: true, service: "restaurantos-server", store: storeName }));

  app.get("/v1/menu", async () => ({ snapshotId: SNAPSHOT_ID, items: MENU, groups: GROUPS }));
  app.get("/v1/floor", async () => ({ tables: await engine.floor() }));
  app.get("/v1/kds", async () => ({ tickets: await engine.kds() }));

  app.get("/v1/checks", async () => ({ checks: await engine.listChecks() }));
  app.get("/v1/checks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const check = await engine.getCheck(id);
    return check ? { check } : reply.code(404).send({ status: "NOT_FOUND" });
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

  app.post("/v1/checks/:id/close", async (req, reply) => {
    const { id } = req.params as { id: string };
    const envelope = readEnvelope((req.body ?? {}) as EnvelopeBody);
    if ("error" in envelope) return reply.code(400).send({ status: "BAD_REQUEST", reason: envelope.error });
    return respond(reply, await engine.close(envelope, id));
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
