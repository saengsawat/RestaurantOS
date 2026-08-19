/**
 * Command layer over @restaurantos/domain, storage-agnostic (Store).
 *
 * Money, transitions, and modifier rules are delegated to the tested
 * domain packages; this module orchestrates and persists. Protocol per
 * domain-model.md: client operation ids (idempotent replay), optimistic
 * versions (conflict values, not lost updates).
 */
import {
  checkTransition,
  computeCheckTotals,
  kitchenTicketTransition,
  lineTotalMinor,
  orderItemTransition,
  selectionPriceMinor,
  ticketItemTransition,
  validateModifiers,
  type CheckLine,
  type ModifierError,
  type SelectedModifier,
} from "@restaurantos/domain";
import { findMenuEntry, GROUPS, SNAPSHOT_ID } from "./menu.js";
import { randomUUID } from "node:crypto";
import type { CheckAggregate, Envelope, KitchenTicket, Store } from "./types.js";

export const TAX_RATE = { num: 8_875, den: 100_000 };
export const RECALL_WINDOW_MS = 10 * 60_000;

export type CommandOutcome =
  | { kind: "applied"; check?: CheckView; tickets?: KitchenTicket[] }
  | { kind: "replay"; result: CommandOutcome }
  | { kind: "conflict"; expectedVersion: number | undefined; currentVersion: number }
  | { kind: "rejected"; reason: string; modifierErrors?: readonly ModifierError[] }
  | { kind: "not_found" };

export interface CheckView extends CheckAggregate {
  totals: {
    subtotalMinor: number;
    discountMinor: number;
    taxMinor: number;
    totalMinor: number;
    paidMinor: number;
    dueMinor: number;
  };
}

export function toView(check: CheckAggregate): CheckView {
  const lines: CheckLine[] = check.lines.map((l) => ({
    unitPriceMinor: l.unitPriceMinor,
    quantity: l.quantity,
    modifierPricesMinor: [l.modifierPriceMinor],
    voided: l.status === "voided",
  }));
  const t = computeCheckTotals(lines, [], TAX_RATE);
  const paid = check.payments.reduce((a, p) => a + p.amountMinor, 0);
  return {
    ...check,
    totals: {
      subtotalMinor: t.subtotalMinor,
      discountMinor: t.discountMinor,
      taxMinor: t.taxMinor,
      totalMinor: t.totalMinor,
      paidMinor: paid,
      dueMinor: Math.max(0, t.totalMinor - paid),
    },
  };
}

export class Engine {
  constructor(private readonly store: Store) {}

  private async remember(envelope: Envelope, outcome: CommandOutcome, aggregateType: string, aggregateId: string): Promise<CommandOutcome> {
    await this.store.rememberOp(envelope.operationId, outcome, {
      status: outcome.kind === "applied" ? "applied" : outcome.kind === "conflict" ? "conflict" : "rejected",
      aggregateType,
      aggregateId,
      deviceId: envelope.deviceId,
    });
    return outcome;
  }

  private async run(
    envelope: Envelope,
    checkId: string,
    body: (check: CheckAggregate) => Promise<CommandOutcome> | CommandOutcome,
  ): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };

    const check = await this.store.get(checkId);
    if (!check) return { kind: "not_found" }; // not remembered: a retry may find it after sync

    if (envelope.expectedVersion !== undefined && envelope.expectedVersion !== check.version) {
      return this.remember(envelope, {
        kind: "conflict",
        expectedVersion: envelope.expectedVersion,
        currentVersion: check.version,
      }, "check", checkId);
    }

    const outcome = await body(check);
    if (outcome.kind === "applied") {
      check.version += 1;
      if (outcome.check) outcome.check.version = check.version;
      await this.store.put(check);
    }
    return this.remember(envelope, outcome, "check", checkId);
  }

  async openCheck(envelope: Envelope, input: { tableName: string; covers: number }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };

    if (!Number.isSafeInteger(input.covers) || input.covers < 1) {
      return this.remember(envelope, { kind: "rejected", reason: "covers must be a positive integer" }, "check", "new");
    }
    const floor = await this.store.listFloor();
    const floorTable = floor.find((t) => t.name === input.tableName);
    if (floorTable) {
      const open = (await this.store.list()).some(
        (c) => c.tableName === input.tableName && c.status !== "closed" && c.status !== "voided",
      );
      if (open) {
        return this.remember(envelope, { kind: "rejected", reason: `${input.tableName} already has an open check` }, "check", "new");
      }
    }
    const check: CheckAggregate = {
      id: randomUUID(),
      checkNo: await this.store.nextCheckNo(),
      tableName: input.tableName,
      covers: input.covers,
      status: "open",
      version: 0,
      menuSnapshotId: SNAPSHOT_ID,
      lines: [],
      payments: [],
      openedAt: new Date().toISOString(),
    };
    await this.store.put(check);
    const outcome: CommandOutcome = { kind: "applied", check: toView(check) };
    return this.remember(envelope, outcome, "check", check.id);
  }

  async addItem(
    envelope: Envelope,
    checkId: string,
    input: { itemId: string; quantity: number; seatNo: number; modifiers?: readonly SelectedModifier[] },
  ): Promise<CommandOutcome> {
    return this.run(envelope, checkId, (check) => {
      if (check.status === "closed" || check.status === "voided") {
        return { kind: "rejected", reason: `cannot add items to a ${check.status} check` };
      }
      const entry = findMenuEntry(input.itemId);
      if (!entry) return { kind: "rejected", reason: `unknown menu item ${input.itemId}` };
      if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
        return { kind: "rejected", reason: "quantity must be a positive integer" };
      }
      if (!Number.isSafeInteger(input.seatNo) || input.seatNo < 1 || input.seatNo > check.covers) {
        return { kind: "rejected", reason: `seatNo must be between 1 and covers (${check.covers})` };
      }
      const selections = input.modifiers ?? [];
      const validation = validateModifiers(entry, GROUPS, selections);
      if (!validation.valid) {
        return { kind: "rejected", reason: "modifier validation failed", modifierErrors: validation.errors };
      }
      const modifierPriceMinor = selectionPriceMinor(GROUPS, selections);
      lineTotalMinor(entry.priceMinor, input.quantity, [modifierPriceMinor]);

      check.lines.push({
        id: randomUUID(),
        itemId: entry.id,
        capturedName: entry.name,
        unitPriceMinor: entry.priceMinor,
        quantity: input.quantity,
        seatNo: input.seatNo,
        course: entry.course,
        station: entry.station,
        modifiers: selections,
        modifierPriceMinor,
        status: "unsent",
      });
      return { kind: "applied", check: toView(check) };
    });
  }

  /** Fire unsent lines: one dispatch ticket per course (E8). */
  async send(envelope: Envelope, checkId: string, input: { course?: string }): Promise<CommandOutcome> {
    return this.run(envelope, checkId, async (check) => {
      const targets = check.lines.filter(
        (l) => l.status === "unsent" && (input.course === undefined || l.course === input.course),
      );
      if (targets.length === 0) return { kind: "rejected", reason: "nothing unsent to fire" };

      for (const line of targets) {
        const r = orderItemTransition(line.status, { type: "dispatch" });
        if (!r.ok) return { kind: "rejected", reason: r.reason };
        line.status = r.next;
      }
      const byCourse = new Map<string, typeof targets>();
      for (const line of targets) {
        const list = byCourse.get(line.course) ?? [];
        list.push(line);
        byCourse.set(line.course, list);
      }
      const tickets: KitchenTicket[] = [];
      for (const [course, lines] of byCourse) {
        const ticket: KitchenTicket = {
          id: randomUUID(),
          checkId: check.id,
          tableName: check.tableName,
          course,
          firedAt: new Date().toISOString(),
          status: "open",
          items: lines.map((l) => ({
            orderItemId: l.id,
            name: l.capturedName,
            quantity: l.quantity,
            station: l.station,
            mods: describeSelections(l.modifiers),
            allergy: hasAllergy(l.modifiers),
            done: false,
          })),
        };
        await this.store.putTicket(ticket);
        tickets.push(ticket);
      }
      return { kind: "applied", check: toView(check), tickets };
    });
  }

  async recordPayment(
    envelope: Envelope,
    checkId: string,
    input: { method: "card" | "cash"; amountMinor: number; tipMinor?: number; label?: string; offline?: boolean },
  ): Promise<CommandOutcome> {
    return this.run(envelope, checkId, (check) => {
      if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1) {
        return { kind: "rejected", reason: "amountMinor must be a positive integer" };
      }
      const view = toView(check);
      const coversTotal = view.totals.paidMinor + input.amountMinor >= view.totals.totalMinor;
      const hasUnsentLines = check.lines.some((l) => l.status === "unsent");
      const r = checkTransition(check.status, { type: "payment_recorded", coversTotal, hasUnsentLines });
      if (!r.ok) return { kind: "rejected", reason: r.reason };

      check.payments.push({
        id: randomUUID(),
        label: input.label ?? "Whole check",
        method: input.method,
        amountMinor: input.amountMinor,
        tipMinor: input.tipMinor ?? 0,
        status: input.method === "card" && input.offline ? "accepted_offline" : "authorized",
      });
      check.status = r.next;
      return { kind: "applied", check: toView(check) };
    });
  }

  async close(envelope: Envelope, checkId: string): Promise<CommandOutcome> {
    return this.run(envelope, checkId, (check) => {
      if (check.payments.some((p) => p.status === "accepted_offline")) {
        return { kind: "rejected", reason: "offline card payments pending upload; check cannot close until they authorize" };
      }
      const r = checkTransition(check.status, { type: "close" });
      if (!r.ok) return { kind: "rejected", reason: r.reason };
      check.status = r.next;
      check.closedAt = new Date().toISOString();
      return { kind: "applied", check: toView(check) };
    });
  }

  /* ------------------------------ KDS (E8) ------------------------------ */

  private async activeTickets(): Promise<KitchenTicket[]> {
    const all = await this.store.listTickets();
    const now = Date.now();
    return all.filter(
      (t) => t.status !== "served" || (t.servedAt !== undefined && now - Date.parse(t.servedAt) < RECALL_WINDOW_MS),
    );
  }

  async kds(): Promise<KitchenTicket[]> {
    return this.activeTickets();
  }

  async toggleItem(envelope: Envelope, ticketId: string, orderItemId: string): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const ticket = await this.store.getTicket(ticketId);
    if (!ticket) return { kind: "not_found" };
    const item = ticket.items.find((i) => i.orderItemId === orderItemId);
    if (!item) return { kind: "not_found" };
    const r = ticketItemTransition(item.done ? "done" : "pending", { type: "toggle_done", ticketStatus: ticket.status });
    if (!r.ok) return this.remember(envelope, { kind: "rejected", reason: r.reason }, "ticket", ticketId);
    item.done = r.next === "done";
    await this.store.putTicket(ticket);
    return this.remember(envelope, { kind: "applied", tickets: [ticket] }, "ticket", ticketId);
  }

  /** Serve releases the whole table (expo action): every open ticket of it. */
  async serveTable(envelope: Envelope, tableName: string): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const tickets = (await this.activeTickets()).filter((t) => t.tableName === tableName && t.status === "open");
    if (!tickets.length) return this.remember(envelope, { kind: "rejected", reason: "no open tickets for " + tableName }, "table", tableName);
    const allItemsDone = tickets.every((t) => t.items.every((i) => i.done));
    for (const ticket of tickets) {
      const r = kitchenTicketTransition(ticket.status, { type: "serve", allItemsDone, fromExpoView: true });
      if (!r.ok) return this.remember(envelope, { kind: "rejected", reason: r.reason }, "table", tableName);
    }
    const servedAt = new Date().toISOString();
    for (const ticket of tickets) {
      ticket.status = "served";
      ticket.servedAt = servedAt;
      await this.store.putTicket(ticket);
    }
    return this.remember(envelope, { kind: "applied", tickets }, "table", tableName);
  }

  async recallTicket(envelope: Envelope, ticketId: string): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const ticket = await this.store.getTicket(ticketId);
    if (!ticket) return { kind: "not_found" };
    const within = ticket.servedAt !== undefined && Date.now() - Date.parse(ticket.servedAt) < RECALL_WINDOW_MS;
    const r = kitchenTicketTransition(ticket.status, { type: "recall", withinRecallWindow: within });
    if (!r.ok) return this.remember(envelope, { kind: "rejected", reason: r.reason }, "ticket", ticketId);
    ticket.status = "open";
    delete ticket.servedAt;
    await this.store.putTicket(ticket);
    return this.remember(envelope, { kind: "applied", tickets: [ticket] }, "ticket", ticketId);
  }

  /** Relocate a table on the floor plan (E6 layout editor). Move only,
   *  size stays; coordinates clamp to the room so a drag past the edge
   *  cannot strand a table off-canvas. */
  async moveTable(envelope: Envelope, input: { tableName: string; x: number; y: number }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
      return this.remember(envelope, { kind: "rejected", reason: "x and y must be numbers (percent of the room)" }, "table", input.tableName);
    }
    const table = (await this.store.listFloor()).find((t) => t.name === input.tableName);
    if (!table) {
      return this.remember(envelope, { kind: "rejected", reason: `unknown table ${input.tableName}` }, "table", input.tableName);
    }
    const round1 = (v: number) => Math.round(v * 10) / 10;
    const x = round1(Math.min(Math.max(input.x, 0), 100 - table.w));
    const y = round1(Math.min(Math.max(input.y, 0), 100 - table.h));
    await this.store.moveTable(input.tableName, { x, y, w: table.w, h: table.h });
    return this.remember(envelope, { kind: "applied" }, "table", input.tableName);
  }

  /* ------------------------------ reads ------------------------------ */

  async getCheck(id: string): Promise<CheckView | undefined> {
    const check = await this.store.get(id);
    return check ? toView(check) : undefined;
  }

  async listChecks(): Promise<CheckView[]> {
    return (await this.store.list()).map(toView);
  }

  /** Floor with live status derived from checks and tickets (E6). */
  async floor() {
    const [tables, checks, tickets] = await Promise.all([
      this.store.listFloor(),
      this.store.list(),
      this.activeTickets(),
    ]);
    const LATE_MS = 12 * 60_000;
    const now = Date.now();
    return tables.map((t) => {
      const check = checks.find((c) => c.tableName === t.name && c.status !== "closed" && c.status !== "voided");
      const open = tickets.filter((k) => check && k.checkId === check.id && k.status === "open");
      const late = open.some((k) => !k.items.every((i) => i.done) && now - Date.parse(k.firedAt) >= LATE_MS);
      const view = check ? toView(check) : undefined;
      return {
        ...t,
        check: view
          ? {
              id: view.id, checkNo: view.checkNo, covers: view.covers, status: view.status,
              dueMinor: view.totals.dueMinor, openedAt: view.openedAt,
              unsent: view.lines.filter((l) => l.status === "unsent").length,
            }
          : null,
        kitchenLate: late,
      };
    });
  }
}

function describeSelections(sels: readonly SelectedModifier[]): string {
  const names: string[] = [];
  const walk = (list: readonly SelectedModifier[]) => {
    for (const s of list) {
      const group = GROUPS[s.groupId];
      const option = group?.options.find((o) => o.id === s.modifierId);
      if (option) names.push(option.name);
      if (s.children) walk(s.children);
    }
  };
  walk(sels);
  return names.join(", ");
}

function hasAllergy(sels: readonly SelectedModifier[]): boolean {
  return describeSelections(sels).includes("allergy") || describeSelections(sels).includes("⚠");
}
