/**
 * Check engine: the command layer that ties the domain packages together.
 *
 * Everything financial or transitional is delegated to @restaurantos/domain
 * (E1 money, E2 state machines, E3 modifier validation); this module only
 * orchestrates and stores. The protocol is the one from domain-model.md:
 * every mutation carries a client operation id (idempotency) and an
 * expected version (optimistic concurrency).
 *
 * Storage today is an in-process Store implementation; the PostgreSQL
 * repository (E4) implements the same interface against schema.sql.
 */
import {
  checkTransition,
  computeCheckTotals,
  lineTotalMinor,
  orderItemTransition,
  selectionPriceMinor,
  validateModifiers,
  type CheckLine,
  type CheckStatus,
  type ModifierError,
  type OrderItemStatus,
  type SelectedModifier,
} from "@restaurantos/domain";
import { findMenuEntry, GROUPS, SNAPSHOT_ID } from "./menu.js";
import { randomUUID } from "node:crypto";

/** demo NYC-style rate; location config in the real build */
export const TAX_RATE = { num: 8_875, den: 100_000 };

export interface Envelope {
  operationId: string;
  deviceId: string;
  expectedVersion?: number;
}

export interface OrderLine {
  id: string;
  itemId: string;
  capturedName: string;
  unitPriceMinor: number;
  quantity: number;
  seatNo: number;
  course: string;
  station: string;
  modifiers: readonly SelectedModifier[];
  modifierPriceMinor: number;
  status: OrderItemStatus;
}

export interface PaymentRecord {
  id: string;
  label: string;
  method: "card" | "cash";
  amountMinor: number;
  tipMinor: number;
  status: "authorized" | "accepted_offline";
}

export interface CheckAggregate {
  id: string;
  checkNo: number;
  tableName: string;
  covers: number;
  status: CheckStatus;
  version: number;
  menuSnapshotId: string;
  lines: OrderLine[];
  payments: PaymentRecord[];
  openedAt: string;
  closedAt?: string;
}

export type CommandOutcome =
  | { kind: "applied"; check: CheckView }
  | { kind: "replay"; result: CommandOutcome }
  | { kind: "conflict"; expectedVersion: number | undefined; currentVersion: number }
  | { kind: "rejected"; reason: string; modifierErrors?: readonly ModifierError[] }
  | { kind: "not_found" };

export interface CheckView extends Omit<CheckAggregate, "lines"> {
  lines: OrderLine[];
  totals: {
    subtotalMinor: number;
    discountMinor: number;
    taxMinor: number;
    totalMinor: number;
    paidMinor: number;
    dueMinor: number;
  };
}

interface StoredOp {
  outcome: CommandOutcome;
}

/** Storage boundary: MemoryStore now, PgStore (E4) next, same interface. */
export interface Store {
  get(id: string): CheckAggregate | undefined;
  list(): CheckAggregate[];
  put(check: CheckAggregate): void;
  opResult(operationId: string): StoredOp | undefined;
  rememberOp(operationId: string, op: StoredOp): void;
  nextCheckNo(): number;
}

export class MemoryStore implements Store {
  private checks = new Map<string, CheckAggregate>();
  private ops = new Map<string, StoredOp>();
  private checkNo = 2041;

  get(id: string) { return this.checks.get(id); }
  list() { return [...this.checks.values()]; }
  put(check: CheckAggregate) { this.checks.set(check.id, check); }
  opResult(operationId: string) { return this.ops.get(operationId); }
  rememberOp(operationId: string, op: StoredOp) { this.ops.set(operationId, op); }
  nextCheckNo() { return this.checkNo++; }
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

  /** Idempotency + optimistic concurrency wrapper shared by every command. */
  private run(
    envelope: Envelope,
    checkId: string | undefined,
    body: (check: CheckAggregate | undefined) => CommandOutcome,
  ): CommandOutcome {
    const replay = this.store.opResult(envelope.operationId);
    if (replay) return { kind: "replay", result: replay.outcome };

    const check = checkId === undefined ? undefined : this.store.get(checkId);
    if (checkId !== undefined && !check) {
      return { kind: "not_found" }; // not remembered: a later retry may find it after sync
    }
    if (check && envelope.expectedVersion !== undefined && envelope.expectedVersion !== check.version) {
      const outcome: CommandOutcome = {
        kind: "conflict",
        expectedVersion: envelope.expectedVersion,
        currentVersion: check.version,
      };
      this.store.rememberOp(envelope.operationId, { outcome });
      return outcome;
    }

    const outcome = body(check);
    if (outcome.kind === "applied" && check) {
      check.version += 1;
      outcome.check.version = check.version;
      this.store.put(check);
    }
    this.store.rememberOp(envelope.operationId, { outcome });
    return outcome;
  }

  openCheck(envelope: Envelope, input: { tableName: string; covers: number }): CommandOutcome {
    const replay = this.store.opResult(envelope.operationId);
    if (replay) return { kind: "replay", result: replay.outcome };

    if (!Number.isSafeInteger(input.covers) || input.covers < 1) {
      const outcome: CommandOutcome = { kind: "rejected", reason: "covers must be a positive integer" };
      this.store.rememberOp(envelope.operationId, { outcome });
      return outcome;
    }
    const check: CheckAggregate = {
      id: randomUUID(),
      checkNo: this.store.nextCheckNo(),
      tableName: input.tableName,
      covers: input.covers,
      status: "open",
      version: 0,
      menuSnapshotId: SNAPSHOT_ID,
      lines: [],
      payments: [],
      openedAt: new Date().toISOString(),
    };
    this.store.put(check);
    const outcome: CommandOutcome = { kind: "applied", check: toView(check) };
    this.store.rememberOp(envelope.operationId, { outcome });
    return outcome;
  }

  addItem(
    envelope: Envelope,
    checkId: string,
    input: { itemId: string; quantity: number; seatNo: number; modifiers?: readonly SelectedModifier[] },
  ): CommandOutcome {
    return this.run(envelope, checkId, (check) => {
      if (!check) return { kind: "not_found" };
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
      lineTotalMinor(entry.priceMinor, input.quantity, [modifierPriceMinor]); // overflow guard

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

  /** Fire unsent lines to the kitchen; optionally a single course. */
  send(envelope: Envelope, checkId: string, input: { course?: string }): CommandOutcome {
    return this.run(envelope, checkId, (check) => {
      if (!check) return { kind: "not_found" };
      const targets = check.lines.filter(
        (l) => l.status === "unsent" && (input.course === undefined || l.course === input.course),
      );
      if (targets.length === 0) return { kind: "rejected", reason: "nothing unsent to fire" };
      for (const line of targets) {
        const r = orderItemTransition(line.status, { type: "dispatch" });
        if (!r.ok) return { kind: "rejected", reason: r.reason };
        line.status = r.next;
      }
      return { kind: "applied", check: toView(check) };
    });
  }

  recordPayment(
    envelope: Envelope,
    checkId: string,
    input: { method: "card" | "cash"; amountMinor: number; tipMinor?: number; label?: string; offline?: boolean },
  ): CommandOutcome {
    return this.run(envelope, checkId, (check) => {
      if (!check) return { kind: "not_found" };
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

  close(envelope: Envelope, checkId: string): CommandOutcome {
    return this.run(envelope, checkId, (check) => {
      if (!check) return { kind: "not_found" };
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

  getCheck(id: string): CheckView | undefined {
    const check = this.store.get(id);
    return check ? toView(check) : undefined;
  }

  listChecks(): CheckView[] {
    return this.store.list().map(toView);
  }
}
