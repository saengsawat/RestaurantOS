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
import type { MenuEntry } from "./menu.js";
import { randomUUID } from "node:crypto";
import { serviceDateOf, type CashEvent, type CheckAggregate, type DrawerSession, type Envelope, type KitchenTicket, type MenuSnapshot, type Store } from "./types.js";
import type { GroupIndex } from "@restaurantos/domain";

export const TAX_RATE = { num: 8_875, den: 100_000 };
export const RECALL_WINDOW_MS = 10 * 60_000;

/** Until E15 wires employee PIN sessions, manager approval is any 4-digit
 *  PIN, matching the mockup's demo framing. The command still refuses
 *  without one, so the approval STEP is real even though the secret is not. */
export function managerApproved(pin: unknown): boolean {
  return typeof pin === "string" && /^\d{4}$/.test(pin);
}

export type CommandOutcome =
  | { kind: "applied"; check?: CheckView; tickets?: KitchenTicket[]; session?: DrawerSession; day?: unknown; menu?: unknown }
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
  const adjustments = check.adjustments.map((a) =>
    a.amountMinor !== undefined
      ? { kind: "amount" as const, amountMinor: a.amountMinor }
      : { kind: "percent" as const, basisPoints: a.percentBp ?? 0 },
  );
  const t = computeCheckTotals(lines, adjustments, TAX_RATE);
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
    if (await this.store.dayStatus(serviceDate()) === "closed") {
      return this.remember(envelope, { kind: "rejected", reason: "the business day is closed; reopen it from the Close screen first" }, "check", "new");
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
      menuSnapshotId: (await this.store.getActiveSnapshot()).id,
      lines: [],
      adjustments: [],
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
    return this.run(envelope, checkId, async (check) => {
      if (check.status === "closed" || check.status === "voided") {
        return { kind: "rejected", reason: `cannot add items to a ${check.status} check` };
      }
      // items price from the ACTIVE snapshot at order time (each line records
      // which one); already-ordered lines keep their captured prices forever
      const snapshot = await this.store.getActiveSnapshot();
      const entry = snapshot.items.find((m) => m.id === input.itemId);
      if (!entry) return { kind: "rejected", reason: `unknown menu item ${input.itemId}` };
      if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
        return { kind: "rejected", reason: "quantity must be a positive integer" };
      }
      if (!Number.isSafeInteger(input.seatNo) || input.seatNo < 1 || input.seatNo > check.covers) {
        return { kind: "rejected", reason: `seatNo must be between 1 and covers (${check.covers})` };
      }
      // the live 86 board outranks the snapshot (E5)
      const avail = (await this.store.listAvailability()).find((a) => a.itemId === entry.id);
      if (avail?.is86) return { kind: "rejected", reason: `${entry.name} is 86'd` };
      if (avail?.remaining !== undefined && avail.remaining < input.quantity) {
        return { kind: "rejected", reason: `only ${avail.remaining} of ${entry.name} left` };
      }
      const selections = input.modifiers ?? [];
      const validation = validateModifiers(entry, snapshot.groups, selections);
      if (!validation.valid) {
        return { kind: "rejected", reason: "modifier validation failed", modifierErrors: validation.errors };
      }
      const modifierPriceMinor = selectionPriceMinor(snapshot.groups, selections);
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
        menuSnapshotId: snapshot.id,
      });
      if (avail?.remaining !== undefined) {
        const remaining = avail.remaining - input.quantity;
        await this.store.setAvailability({ itemId: entry.id, is86: remaining === 0, remaining });
      }
      return { kind: "applied", check: toView(check) };
    });
  }

  /** Fire unsent lines: one dispatch ticket per course (E8). */
  async send(envelope: Envelope, checkId: string, input: { course?: string }): Promise<CommandOutcome> {
    return this.run(envelope, checkId, async (check) => {
      const groups = (await this.store.getActiveSnapshot()).groups;
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
            mods: describeSelections(groups, l.modifiers),
            allergy: hasAllergy(groups, l.modifiers),
            done: false,
          })),
        };
        await this.store.putTicket(ticket);
        tickets.push(ticket);
      }
      return { kind: "applied", check: toView(check), tickets };
    });
  }

  /** Void a line with reason + manager approval (E12, FR-28). If the item
   *  already fired, its ticket lines are flagged so the kitchen stops. */
  async voidItem(
    envelope: Envelope,
    checkId: string,
    input: { orderItemId: string; reason: string; managerPin?: string },
  ): Promise<CommandOutcome> {
    return this.run(envelope, checkId, async (check) => {
      if (check.status === "closed" || check.status === "voided") {
        return { kind: "rejected", reason: `cannot void items on a ${check.status} check` };
      }
      const line = check.lines.find((l) => l.id === input.orderItemId);
      if (!line) return { kind: "rejected", reason: "no such line on this check" };
      if (typeof input.reason !== "string" || input.reason.trim().length < 3) {
        return { kind: "rejected", reason: "a void must carry a reason (min 3 characters)" };
      }
      const r = orderItemTransition(line.status, { type: "void_item", approved: managerApproved(input.managerPin) });
      if (!r.ok) return { kind: "rejected", reason: r.reason };
      line.status = r.next;
      line.voidReason = input.reason.trim();

      // FR-28: the kitchen learns immediately on every open ticket
      for (const ticket of await this.store.listTickets()) {
        const item = ticket.items.find((i) => i.orderItemId === line.id);
        if (item && !item.voided) {
          item.voided = true;
          await this.store.putTicket(ticket);
        }
      }
      return { kind: "applied", check: toView(check) };
    });
  }

  /** Apply a discount or comp (E12). Exactly one of amountMinor/percentBp,
   *  reason + manager approval required, audited via check_adjustment. */
  async applyAdjustment(
    envelope: Envelope,
    checkId: string,
    input: { kind?: string; label?: string; amountMinor?: number; percentBp?: number; reason: string; managerPin?: string },
  ): Promise<CommandOutcome> {
    return this.run(envelope, checkId, (check) => {
      if (check.status !== "open" && check.status !== "reopened") {
        return { kind: "rejected", reason: `discounts apply to open checks only, this one is ${check.status}` };
      }
      const hasAmount = input.amountMinor !== undefined;
      const hasPercent = input.percentBp !== undefined;
      if (hasAmount === hasPercent) {
        return { kind: "rejected", reason: "exactly one of amountMinor or percentBp is required" };
      }
      if (hasAmount && (!Number.isSafeInteger(input.amountMinor) || input.amountMinor! < 1)) {
        return { kind: "rejected", reason: "amountMinor must be a positive integer" };
      }
      if (hasPercent && (!Number.isSafeInteger(input.percentBp) || input.percentBp! < 1 || input.percentBp! > 10_000)) {
        return { kind: "rejected", reason: "percentBp must be 1..10000 (10000 = 100%)" };
      }
      if (typeof input.reason !== "string" || input.reason.trim().length < 3) {
        return { kind: "rejected", reason: "an adjustment must carry a reason (min 3 characters)" };
      }
      if (!managerApproved(input.managerPin)) {
        return { kind: "rejected", reason: "discounts require manager approval (4-digit PIN)" };
      }
      const kind = input.kind === "comp" ? "comp" as const : "discount" as const;
      check.adjustments.push({
        id: randomUUID(),
        kind,
        label: input.label?.trim() || (hasPercent ? `${(input.percentBp! / 100).toFixed(input.percentBp! % 100 ? 2 : 0)}% ${kind}` : kind),
        ...(hasAmount ? { amountMinor: input.amountMinor! } : {}),
        ...(hasPercent ? { percentBp: input.percentBp! } : {}),
        reason: input.reason.trim(),
      });
      return { kind: "applied", check: toView(check) };
    });
  }

  /** Move a check to another table (E7). Servers do this routinely, so no
   *  manager gate; the kitchen's cards follow the party. */
  async transferCheck(envelope: Envelope, checkId: string, input: { tableName: string }): Promise<CommandOutcome> {
    return this.run(envelope, checkId, async (check) => {
      if (check.status === "closed" || check.status === "voided") {
        return { kind: "rejected", reason: `cannot transfer a ${check.status} check` };
      }
      const target = (input.tableName ?? "").trim();
      if (!target) return { kind: "rejected", reason: "tableName is required" };
      if (target === check.tableName) return { kind: "rejected", reason: `the check is already on ${target}` };
      const floor = await this.store.listFloor();
      if (floor.some((t) => t.name === target)) {
        const occupied = (await this.store.list()).some(
          (c) => c.id !== check.id && c.tableName === target && c.status !== "closed" && c.status !== "voided",
        );
        if (occupied) return { kind: "rejected", reason: `${target} already has an open check` };
      }
      // the kitchen follows the party: every card of this check re-labels
      for (const ticket of await this.store.listTickets()) {
        if (ticket.checkId !== check.id) continue;
        ticket.tableName = target;
        await this.store.putTicket(ticket);
      }
      check.tableName = target;
      return { kind: "applied", check: toView(check) };
    });
  }

  /** Merge another check into this one (E7): two parties become one table.
   *  Source seats renumber after the target's covers so "seat 2" stays a
   *  real person. Source must be unpaid (refund first); it voids with the
   *  merge as its paperwork. Manager approval required. */
  async mergeChecks(envelope: Envelope, targetId: string, input: { sourceCheckId: string; managerPin?: string }): Promise<CommandOutcome> {
    return this.run(envelope, targetId, async (target) => {
      if (target.status !== "open" && target.status !== "reopened") {
        return { kind: "rejected", reason: `can only merge into an open check, this one is ${target.status}` };
      }
      const source = await this.store.get(input.sourceCheckId);
      if (!source) return { kind: "rejected", reason: "source check not found" };
      if (source.id === target.id) return { kind: "rejected", reason: "a check cannot merge into itself" };
      if (source.status === "closed" || source.status === "voided") {
        return { kind: "rejected", reason: `cannot merge a ${source.status} check` };
      }
      if (source.payments.length) {
        return { kind: "rejected", reason: "the source check has payments; settle or refund them before merging" };
      }
      if (!managerApproved(input.managerPin)) {
        return { kind: "rejected", reason: "merging checks requires manager approval (4-digit PIN)" };
      }
      const r = checkTransition(source.status, { type: "void_check", approved: true, hasPayments: false });
      if (!r.ok) return { kind: "rejected", reason: r.reason };

      const seatOffset = target.covers;
      target.covers += source.covers;
      for (const line of source.lines) {
        line.seatNo += seatOffset;
        target.lines.push(line);
      }
      target.adjustments.push(...source.adjustments);

      // the source's fired courses now belong to the target's table
      for (const ticket of await this.store.listTickets()) {
        if (ticket.checkId !== source.id) continue;
        ticket.tableName = target.tableName;
        await this.store.putTicket(ticket);
      }
      source.lines = [];
      source.status = r.next;
      source.tableName = target.tableName; // the party moved; the old table frees
      source.version += 1;
      await this.store.put(source);
      return { kind: "applied", check: toView(target) };
    });
  }

  async recordPayment(
    envelope: Envelope,
    checkId: string,
    input: { method: "card" | "cash"; amountMinor: number; tipMinor?: number; label?: string; offline?: boolean },
  ): Promise<CommandOutcome> {
    return this.run(envelope, checkId, async (check) => {
      if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1) {
        return { kind: "rejected", reason: "amountMinor must be a positive integer" };
      }
      const view = toView(check);
      const coversTotal = view.totals.paidMinor + input.amountMinor >= view.totals.totalMinor;
      const hasUnsentLines = check.lines.some((l) => l.status === "unsent");
      const r = checkTransition(check.status, { type: "payment_recorded", coversTotal, hasUnsentLines });
      if (!r.ok) return { kind: "rejected", reason: r.reason };

      // cash needs a till: physical money must land in an open drawer (E14)
      let drawer: DrawerSession | undefined;
      if (input.method === "cash") {
        drawer = (await this.store.listDrawerSessions()).find((s) => !s.closedAt);
        if (!drawer) {
          return { kind: "rejected", reason: "no open cash drawer; open one on the Close screen before taking cash" };
        }
      }

      check.payments.push({
        id: randomUUID(),
        label: input.label ?? "Whole check",
        method: input.method,
        amountMinor: input.amountMinor,
        tipMinor: input.tipMinor ?? 0,
        status: input.method === "card" && input.offline ? "accepted_offline" : "authorized",
      });
      check.status = r.next;
      if (drawer) {
        // v0: the guest's full cash (incl. tip) goes into the till; tips are
        // reconciled at clock-out (E15). No paymentId link yet: the payment
        // row persists after this body, so the reason carries the check no.
        drawer.events.push({
          id: randomUUID(),
          kind: "sale",
          amountMinor: input.amountMinor + (input.tipMinor ?? 0),
          reason: `cash sale, check #${check.checkNo}`,
          at: new Date().toISOString(),
        });
        await this.store.putDrawerSession(drawer);
      }
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
    if (item.voided) return this.remember(envelope, { kind: "rejected", reason: "this item was voided; nothing to cook" }, "ticket", ticketId);
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
    const allItemsDone = tickets.every((t) => t.items.every((i) => i.done || i.voided));
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

  /* ------------------------------ menu (E5) ------------------------------ */

  private async draftOrStart(): Promise<{ basedOnVersion: number; items: MenuEntry[] }> {
    const existing = await this.store.getDraft();
    if (existing) return existing;
    const active = await this.store.getActiveSnapshot();
    return { basedOnVersion: active.version, items: active.items.map((m) => ({ ...m })) };
  }

  /** Add or edit an item on the DRAFT. Service never sees a draft; only
   *  publishing does (immutable snapshot rule). Groups editing is E5-full. */
  async menuUpsertItem(
    envelope: Envelope,
    input: { itemId?: string; name: string; priceMinor: number; course: string; station: string; modifierGroupIds?: string[] },
  ): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const active = await this.store.getActiveSnapshot();
    const name = (input.name ?? "").trim();
    if (name.length < 2) return this.remember(envelope, { kind: "rejected", reason: "name must be at least 2 characters" }, "menu_draft", "draft");
    if (!Number.isSafeInteger(input.priceMinor) || input.priceMinor < 0) {
      return this.remember(envelope, { kind: "rejected", reason: "priceMinor must be a non-negative integer" }, "menu_draft", "draft");
    }
    const courses = ["BEVERAGE", "ANTIPASTI", "PRIMI", "SECONDI", "DOLCI"];
    if (!courses.includes(input.course)) {
      return this.remember(envelope, { kind: "rejected", reason: `course must be one of ${courses.join(", ")}` }, "menu_draft", "draft");
    }
    const groupIds = input.modifierGroupIds ?? [];
    const unknown = groupIds.filter((g) => !active.groups[g]);
    if (unknown.length) {
      return this.remember(envelope, { kind: "rejected", reason: `unknown modifier group(s): ${unknown.join(", ")}` }, "menu_draft", "draft");
    }
    const draft = await this.draftOrStart();
    const id = input.itemId?.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const entry: MenuEntry = {
      id, name, priceMinor: input.priceMinor,
      course: input.course as MenuEntry["course"],
      station: (input.station ?? "").trim().toUpperCase() || "SAUTE",
      modifierGroupIds: groupIds,
    };
    const at = draft.items.findIndex((m) => m.id === id);
    if (at >= 0) draft.items[at] = entry; else draft.items.push(entry);
    await this.store.putDraft(draft);
    return this.remember(envelope, { kind: "applied", menu: { draft } }, "menu_draft", "draft");
  }

  async menuRemoveItem(envelope: Envelope, input: { itemId: string }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const draft = await this.draftOrStart();
    const at = draft.items.findIndex((m) => m.id === input.itemId);
    if (at < 0) return this.remember(envelope, { kind: "rejected", reason: `no item ${input.itemId} on the draft` }, "menu_draft", "draft");
    draft.items.splice(at, 1);
    await this.store.putDraft(draft);
    return this.remember(envelope, { kind: "applied", menu: { draft } }, "menu_draft", "draft");
  }

  async menuDiscardDraft(envelope: Envelope): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    if (!(await this.store.getDraft())) {
      return this.remember(envelope, { kind: "rejected", reason: "no draft to discard" }, "menu_draft", "draft");
    }
    await this.store.clearDraft();
    return this.remember(envelope, { kind: "applied", menu: { draft: null } }, "menu_draft", "draft");
  }

  /** Freeze the draft into the next immutable snapshot version. From this
   *  moment new orders price on it; nothing already ordered moves a cent. */
  async menuPublish(envelope: Envelope, input: { managerPin?: string }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const draft = await this.store.getDraft();
    if (!draft) return this.remember(envelope, { kind: "rejected", reason: "no draft to publish" }, "menu_snapshot", "publish");
    if (!draft.items.length) return this.remember(envelope, { kind: "rejected", reason: "cannot publish an empty menu" }, "menu_snapshot", "publish");
    if (!managerApproved(input.managerPin)) {
      return this.remember(envelope, { kind: "rejected", reason: "publishing the menu requires manager approval (4-digit PIN)" }, "menu_snapshot", "publish");
    }
    const active = await this.store.getActiveSnapshot();
    const snapshot: MenuSnapshot = {
      id: `snap-${String(active.version + 1).padStart(4, "0")}`,
      version: active.version + 1,
      items: draft.items,
      groups: active.groups,
      publishedAt: new Date().toISOString(),
    };
    await this.store.putSnapshot(snapshot);
    await this.store.clearDraft();
    return this.remember(envelope, {
      kind: "applied",
      menu: { snapshotId: snapshot.id, version: snapshot.version, items: snapshot.items.length },
    }, "menu_snapshot", snapshot.id);
  }

  /** The live 86 board: instant, no publish. remaining 0 auto-86s;
   *  clearing 86 clears the count unless a new one is given. */
  async set86(envelope: Envelope, input: { itemId: string; is86?: boolean; remaining?: number }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const active = await this.store.getActiveSnapshot();
    const entry = active.items.find((m) => m.id === input.itemId);
    if (!entry) return this.remember(envelope, { kind: "rejected", reason: `unknown menu item ${input.itemId}` }, "availability", input.itemId);
    if (input.remaining !== undefined && (!Number.isSafeInteger(input.remaining) || input.remaining < 0)) {
      return this.remember(envelope, { kind: "rejected", reason: "remaining must be a non-negative integer" }, "availability", input.itemId);
    }
    const availability = {
      itemId: entry.id,
      is86: input.remaining === 0 ? true : (input.is86 ?? false),
      ...(input.remaining !== undefined ? { remaining: input.remaining } : {}),
    };
    await this.store.setAvailability(availability);
    return this.remember(envelope, { kind: "applied", menu: { availability } }, "availability", input.itemId);
  }

  /* --------------------- cash + business day (E14/E16) --------------------- */

  /** Open a physical till with a counted float. One open session per drawer,
   *  mirroring idx_drawer_one_open. */
  async openDrawer(envelope: Envelope, input: { drawerName: string; openingFloatMinor: number }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const name = (input.drawerName ?? "").trim();
    if (!name) return this.remember(envelope, { kind: "rejected", reason: "drawerName is required" }, "drawer_session", "new");
    if (!Number.isSafeInteger(input.openingFloatMinor) || input.openingFloatMinor < 0) {
      return this.remember(envelope, { kind: "rejected", reason: "openingFloatMinor must be a non-negative integer" }, "drawer_session", "new");
    }
    const open = (await this.store.listDrawerSessions()).find((s) => s.drawerName === name && !s.closedAt);
    if (open) {
      return this.remember(envelope, { kind: "rejected", reason: `${name} already has an open session; close it first` }, "drawer_session", "new");
    }
    const session: DrawerSession = {
      id: randomUUID(),
      drawerName: name,
      openedAt: new Date().toISOString(),
      openingFloatMinor: input.openingFloatMinor,
      events: [],
    };
    await this.store.putDrawerSession(session);
    return this.remember(envelope, { kind: "applied", session }, "drawer_session", session.id);
  }

  /** Pay-in / pay-out / drop on an open session. Outflows need a manager. */
  async drawerEvent(
    envelope: Envelope,
    input: { sessionId: string; kind: string; amountMinor: number; reason: string; managerPin?: string },
  ): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const session = await this.store.getDrawerSession(input.sessionId);
    if (!session) return { kind: "not_found" };
    if (session.closedAt) {
      return this.remember(envelope, { kind: "rejected", reason: "session is closed; cash events are frozen" }, "drawer_session", session.id);
    }
    if (input.kind !== "pay_in" && input.kind !== "pay_out" && input.kind !== "drop") {
      return this.remember(envelope, { kind: "rejected", reason: "kind must be pay_in, pay_out, or drop" }, "drawer_session", session.id);
    }
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1) {
      return this.remember(envelope, { kind: "rejected", reason: "amountMinor must be a positive integer (the sign comes from the kind)" }, "drawer_session", session.id);
    }
    if (typeof input.reason !== "string" || input.reason.trim().length < 3) {
      return this.remember(envelope, { kind: "rejected", reason: "a cash event must carry a reason (min 3 characters)" }, "drawer_session", session.id);
    }
    if (input.kind !== "pay_in" && !managerApproved(input.managerPin)) {
      return this.remember(envelope, { kind: "rejected", reason: "cash leaving the drawer requires manager approval (4-digit PIN)" }, "drawer_session", session.id);
    }
    const event: CashEvent = {
      id: randomUUID(),
      kind: input.kind,
      amountMinor: input.kind === "pay_in" ? input.amountMinor : -input.amountMinor,
      reason: input.reason.trim(),
      at: new Date().toISOString(),
    };
    session.events.push(event);
    await this.store.putDrawerSession(session);
    return this.remember(envelope, { kind: "applied", session }, "drawer_session", session.id);
  }

  /** Close the till against a physical count. Expected and over/short are
   *  computed here and FROZEN; the schema never lets them be edited. */
  async closeDrawer(envelope: Envelope, input: { sessionId: string; countedMinor: number }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const session = await this.store.getDrawerSession(input.sessionId);
    if (!session) return { kind: "not_found" };
    if (session.closedAt) {
      return this.remember(envelope, { kind: "rejected", reason: "session is already closed" }, "drawer_session", session.id);
    }
    if (!Number.isSafeInteger(input.countedMinor) || input.countedMinor < 0) {
      return this.remember(envelope, { kind: "rejected", reason: "countedMinor must be a non-negative integer" }, "drawer_session", session.id);
    }
    const expected = session.openingFloatMinor + session.events.reduce((a, e) => a + e.amountMinor, 0);
    session.closedAt = new Date().toISOString();
    session.countedMinor = input.countedMinor;
    session.expectedMinor = expected;
    session.overShortMinor = input.countedMinor - expected;
    await this.store.putDrawerSession(session);
    return this.remember(envelope, { kind: "applied", session }, "drawer_session", session.id);
  }

  /** Close the business day (E16). Refuses while anything is still open;
   *  the response carries the frozen day summary. */
  async closeDay(envelope: Envelope, input: { managerPin?: string }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const date = serviceDate();
    if (await this.store.dayStatus(date) === "closed") {
      return this.remember(envelope, { kind: "rejected", reason: "the business day is already closed" }, "business_day", date);
    }
    if (!managerApproved(input.managerPin)) {
      return this.remember(envelope, { kind: "rejected", reason: "closing the day requires manager approval (4-digit PIN)" }, "business_day", date);
    }
    const report = await this.dayReport();
    const b = report.blockers;
    if (b.openChecks.length || b.openDrawers.length || b.offlinePayments) {
      const parts = [
        b.openChecks.length ? `${b.openChecks.length} open check(s)` : "",
        b.openDrawers.length ? `${b.openDrawers.length} open drawer(s)` : "",
        b.offlinePayments ? `${b.offlinePayments} offline payment(s) pending upload` : "",
      ].filter(Boolean).join(", ");
      return this.remember(envelope, { kind: "rejected", reason: `cannot close the day with ${parts}` }, "business_day", date);
    }
    await this.store.setDayStatus(date, "closed");
    return this.remember(envelope, { kind: "applied", day: { ...report, status: "closed" } }, "business_day", date);
  }

  /** Reopen a closed day (mistake remedy; audited like any command). */
  async reopenDay(envelope: Envelope, input: { managerPin?: string }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const date = serviceDate();
    if (await this.store.dayStatus(date) === "open") {
      return this.remember(envelope, { kind: "rejected", reason: "the business day is not closed" }, "business_day", date);
    }
    if (!managerApproved(input.managerPin)) {
      return this.remember(envelope, { kind: "rejected", reason: "reopening the day requires manager approval (4-digit PIN)" }, "business_day", date);
    }
    await this.store.setDayStatus(date, "open");
    return this.remember(envelope, { kind: "applied", day: await this.dayReport() }, "business_day", date);
  }

  /** The manager's end-of-day picture: totals, drawers, and what still
   *  blocks the close. Everything is computed, nothing stored (schema rule). */
  async dayReport() {
    const date = serviceDate();
    const [status, checks, sessions] = await Promise.all([
      this.store.dayStatus(date),
      this.store.list(),
      this.store.listDrawerSessions(),
    ]);
    const todays = checks.filter((c) => serviceDateOf(c.openedAt) === date);
    const closed = todays.filter((c) => c.status === "closed");
    const openChecks = checks.filter((c) => c.status !== "closed" && c.status !== "voided");
    const offlinePayments = checks.reduce((n, c) => n + c.payments.filter((p) => p.status === "accepted_offline").length, 0);

    const summary = { checksClosed: closed.length, covers: 0, grossMinor: 0, discountMinor: 0, taxMinor: 0, totalMinor: 0, tipsMinor: 0, paidCardMinor: 0, paidCashMinor: 0, voidCount: 0, voidValueMinor: 0 };
    for (const c of closed) {
      const v = toView(c);
      summary.covers += c.covers;
      summary.grossMinor += v.totals.subtotalMinor;
      summary.discountMinor += v.totals.discountMinor;
      summary.taxMinor += v.totals.taxMinor;
      summary.totalMinor += v.totals.totalMinor;
      for (const p of c.payments) {
        summary.tipsMinor += p.tipMinor;
        if (p.method === "cash") summary.paidCashMinor += p.amountMinor;
        else summary.paidCardMinor += p.amountMinor;
      }
    }
    for (const c of todays) {
      for (const l of c.lines) {
        if (l.status !== "voided") continue;
        summary.voidCount += 1;
        summary.voidValueMinor += (l.unitPriceMinor + l.modifierPriceMinor) * l.quantity;
      }
    }
    const drawers = sessions
      .filter((s) => serviceDateOf(s.openedAt) === date)
      .map((s) => ({
        ...s,
        expectedSoFarMinor: s.closedAt ? s.expectedMinor : s.openingFloatMinor + s.events.reduce((a, e) => a + e.amountMinor, 0),
      }));
    return {
      serviceDate: date,
      status,
      summary,
      drawers,
      blockers: {
        openChecks: openChecks.map((c) => ({ id: c.id, tableName: c.tableName, checkNo: c.checkNo, status: c.status, dueMinor: toView(c).totals.dueMinor })),
        openDrawers: sessions.filter((s) => !s.closedAt).map((s) => s.drawerName),
        offlinePayments,
      },
    };
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

  /** The active menu plus the live 86 board, in one payload for the POS. */
  async menu() {
    const [snapshot, availability] = await Promise.all([
      this.store.getActiveSnapshot(),
      this.store.listAvailability(),
    ]);
    return {
      snapshotId: snapshot.id,
      version: snapshot.version,
      items: snapshot.items,
      groups: snapshot.groups,
      availability,
    };
  }

  async menuDraft() {
    const [active, draft] = await Promise.all([this.store.getActiveSnapshot(), this.store.getDraft()]);
    return { activeVersion: active.version, activeCount: active.items.length, draft: draft ?? null };
  }

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
      // tickets match by TABLE, not check id: after a merge, courses fired
      // for the absorbed check still cook for this table
      const open = tickets.filter((k) => check && k.tableName === t.name && k.status === "open");
      const late = open.some((k) => !k.items.every((i) => i.done || i.voided) && now - Date.parse(k.firedAt) >= LATE_MS);
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

function serviceDate(): string {
  return serviceDateOf(new Date().toISOString());
}

function describeSelections(groups: GroupIndex, sels: readonly SelectedModifier[]): string {
  const names: string[] = [];
  const walk = (list: readonly SelectedModifier[]) => {
    for (const s of list) {
      const group = groups[s.groupId];
      const option = group?.options.find((o) => o.id === s.modifierId);
      if (option) names.push(option.name);
      if (s.children) walk(s.children);
    }
  };
  walk(sels);
  return names.join(", ");
}

function hasAllergy(groups: GroupIndex, sels: readonly SelectedModifier[]): boolean {
  const described = describeSelections(groups, sels);
  return described.includes("allergy") || described.includes("⚠");
}
