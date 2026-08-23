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
  splitCheck,
  ticketItemTransition,
  validateModifiers,
  type Adjustment,
  type CheckLine,
  type CheckStatus,
  type ModifierError,
  type SelectedModifier,
  type SplitPortion,
} from "@restaurantos/domain";
import type { MenuEntry } from "./menu.js";
import { STAFF, type Employee } from "./staff.js";
import { randomUUID } from "node:crypto";
import { serviceDateOf, type CashEvent, type CheckAggregate, type DrawerSession, type Envelope, type KitchenTicket, type MenuSnapshot, type Store } from "./types.js";
import type { GroupIndex } from "@restaurantos/domain";

export const TAX_RATE = { num: 8_875, den: 100_000 };
export const RECALL_WINDOW_MS = 10 * 60_000;

// Manager approval is now a real identity check (E15): the PIN must hash to
// an employee who holds the manager role. See Engine.manager().

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

/** The aggregate's lines in the domain's shape. One mapping, shared by the
 *  totals and the split, so the two can never disagree about a voided line. */
function toDomainLines(check: CheckAggregate): CheckLine[] {
  return check.lines.map((l) => ({
    unitPriceMinor: l.unitPriceMinor,
    quantity: l.quantity,
    modifierPricesMinor: [l.modifierPriceMinor],
    voided: l.status === "voided",
  }));
}

function toDomainAdjustments(check: CheckAggregate): Adjustment[] {
  return check.adjustments.map((a) =>
    a.amountMinor !== undefined
      ? { kind: "amount" as const, amountMinor: a.amountMinor }
      : { kind: "percent" as const, basisPoints: a.percentBp ?? 0 },
  );
}

export function toView(check: CheckAggregate): CheckView {
  const lines = toDomainLines(check);
  const adjustments = toDomainAdjustments(check);
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

/* ------------------------- split portions (E11) -------------------------
 * A split is a PAYMENT PARTITION over one check (D18), not a fork into
 * sibling checks. Nothing about a split is stored: portions are computed on
 * read, like totals and floor status, and settled by payments carrying the
 * portion's label. The money math is entirely the domain's splitCheck (E11-T1,
 * conservation-proven); this layer only labels the portions and counts what
 * has already been paid against each label.
 */

/** Ceiling on `ways`, so a crafted query string cannot ask for a million
 *  portions. Comfortably above any real party. */
export const MAX_SPLIT_WAYS = 50;

export type SplitMode = { mode: "even"; ways: number } | { mode: "bySeat" };

export interface SplitPortionView extends SplitPortion {
  label: string;
  /** which seats this portion covers (bySeat only) */
  seatNos?: number[];
  paidMinor: number;
  dueMinor: number;
}

function settle(check: CheckAggregate, label: string, portion: SplitPortion, seatNos?: readonly number[]): SplitPortionView {
  const paid = check.payments.filter((p) => p.label === label).reduce((a, p) => a + p.amountMinor, 0);
  return {
    label,
    ...(seatNos ? { seatNos: [...seatNos] } : {}),
    ...portion,
    paidMinor: paid,
    dueMinor: Math.max(0, portion.totalMinor - paid),
  };
}

/**
 * The portions of a check under one partition. Pure, and deliberately not a
 * method: recordPayment needs it for the aggregate it already holds.
 *
 * bySeat gives a portion only to seats that actually ordered something. Two
 * reasons: a dense byLines assignment cannot express a portion with no lines
 * at all (E11-T1's binding note), and a seat that ordered nothing owes
 * nothing, so printing it would just be noise on the terminal. Voided lines
 * contribute zero to any portion, so a voided line whose own seat dropped out
 * rides along on the first portion without moving a cent.
 */
export function splitPortions(check: CheckAggregate, spec: SplitMode): SplitPortionView[] {
  const lines = toDomainLines(check);
  const adjustments = toDomainAdjustments(check);

  if (spec.mode === "even") {
    const portions = splitCheck(lines, adjustments, TAX_RATE, { kind: "even", ways: spec.ways });
    return portions.map((p, i) => settle(check, `Split ${i + 1} of ${spec.ways}`, p));
  }

  const seats = [...new Set(check.lines.filter((l) => l.status !== "voided").map((l) => l.seatNo))]
    .sort((a, b) => a - b);
  if (!seats.length) return []; // nothing ordered, nothing to split
  const portionOfSeat = new Map(seats.map((s, i) => [s, i]));
  const assignment = check.lines.map((l) => portionOfSeat.get(l.seatNo) ?? 0);
  const portions = splitCheck(lines, adjustments, TAX_RATE, { kind: "byLines", assignment });
  return portions.map((p, i) => settle(check, `Seat ${seats[i]}`, p, [seats[i] as number]));
}

/** Read a partition off a query string, refusing what the domain would throw on. */
export function readSplitMode(input: { mode?: string | undefined; ways?: number | undefined }): SplitMode | { error: string } {
  if (input.mode === "bySeat") return { mode: "bySeat" };
  if (input.mode !== "even") return { error: "mode must be 'even' or 'bySeat'" };
  const { ways } = input;
  if (ways === undefined || !Number.isSafeInteger(ways) || ways < 2 || ways > MAX_SPLIT_WAYS) {
    return { error: `an even split needs ways to be a whole number from 2 to ${MAX_SPLIT_WAYS}` };
  }
  return { mode: "even", ways };
}

/**
 * The portion a payment label settles, if it names one of the check's current
 * portions. The label is the only handle: nothing about the split is stored,
 * so "Seat 2" and "Split 1 of 3" are parsed back into the partition that
 * produced them. Anything else (the default "Whole check", a bar tab, a
 * server's own note) is free text and settles nothing in particular.
 */
export function portionForLabel(check: CheckAggregate, label: string): SplitPortionView | undefined {
  if (/^Seat \d+$/.test(label)) {
    return splitPortions(check, { mode: "bySeat" }).find((p) => p.label === label);
  }
  const even = /^Split \d+ of (\d+)$/.exec(label);
  if (even) {
    const spec = readSplitMode({ mode: "even", ways: Number(even[1]) });
    if ("error" in spec) return undefined;
    return splitPortions(check, spec).find((p) => p.label === label);
  }
  return undefined;
}

/** A rail ticket as the KDS reads it: the stored ticket plus the paying status
 *  of its check, joined on read (E8-T2). "unknown" covers a ticket whose check
 *  is no longer in the store at all. */
export interface KitchenTicketView extends KitchenTicket {
  checkStatus: CheckStatus | "unknown";
}

/* ---------------------------- insights (E19) ----------------------------
 * Read-only projections over the ledger the POS already writes (D19).
 * Nothing here is stored: the rule that keeps check totals computed keeps
 * the reports computed too, so a report cannot drift from the money it
 * describes. toView is the single money source, every accumulator is
 * integer addition, and the only division is the display averages.
 */

/** The fixed course order the scorecard's bars follow, so one course reads as
 *  the same segment on every row. Mirrors MenuEntry["course"]. */
export const COURSE_ORDER = ["BEVERAGE", "ANTIPASTI", "PRIMI", "SECONDI", "DOLCI"] as const;

/** What one server did tonight. Every count and every *Minor field is an EXACT
 *  integer sum over closed checks; the three average fields are display math
 *  derived from those sums, so the SUMS are what has to conserve. */
export interface ServerMetrics {
  checks: number;
  covers: number;
  netMinor: number;
  totalMinor: number;
  tipMinor: number;
  discountMinor: number;
  declaredTipsMinor: number;
  voidCount: number;
  voidValueMinor: number;
  /** exact sum of closedAt - openedAt in ms, so avgTurnMinutes stays derived */
  turnMs: number;
  /** value per course, the category bars: voided lines contribute nothing */
  courses: Record<string, number>;
  avgCheckMinor: number;
  perCoverMinor: number;
  avgTurnMinutes: number;
}

export interface ServerRow extends ServerMetrics {
  serverId: string;
  serverName: string;
}

/** One day-of-week x hour bucket of the sales heatmap. */
export interface HeatmapCell {
  day: number; // 0 = Sunday, matching Date#getDay
  hour: number;
  netMinor: number;
  checks: number;
  covers: number;
}

/** Display-only division: the sums are the truth, this is what the scorecard
 *  prints. A zero denominator reads as zero, never NaN. */
function per(total: number, divisor: number): number {
  return divisor > 0 ? Math.round(total / divisor) : 0;
}

/** The per-server mean of every metric. Lightspeed prints an Average row so a
 *  server can be read against the shift instead of against nothing. null when
 *  nobody closed a check: the average of no rows is absent, not zero. */
function averageRow(servers: readonly ServerRow[]): ServerMetrics | null {
  const n = servers.length;
  if (!n) return null;
  const mean = (pick: (r: ServerRow) => number) => per(servers.reduce((a, r) => a + pick(r), 0), n);
  const courses: Record<string, number> = {};
  for (const key of COURSE_ORDER) {
    const total = servers.reduce((a, r) => a + (r.courses[key] ?? 0), 0);
    if (total > 0) courses[key] = per(total, n);
  }
  return {
    checks: mean((r) => r.checks),
    covers: mean((r) => r.covers),
    netMinor: mean((r) => r.netMinor),
    totalMinor: mean((r) => r.totalMinor),
    tipMinor: mean((r) => r.tipMinor),
    discountMinor: mean((r) => r.discountMinor),
    declaredTipsMinor: mean((r) => r.declaredTipsMinor),
    voidCount: mean((r) => r.voidCount),
    voidValueMinor: mean((r) => r.voidValueMinor),
    turnMs: mean((r) => r.turnMs),
    courses,
    avgCheckMinor: mean((r) => r.avgCheckMinor),
    perCoverMinor: mean((r) => r.perCoverMinor),
    avgTurnMinutes: mean((r) => r.avgTurnMinutes),
  };
}

export class Engine {
  constructor(private readonly store: Store) {}

  /* ------------------------- sessions (E15) ------------------------- */

  /** deviceId -> signed-in employee. Deliberately in-memory: a server
   *  restart signs everyone out, which is the honest behavior. */
  private sessions = new Map<string, Employee>();

  staff() {
    return STAFF.map(({ id, name, role, demoPin }) => ({ id, name, role, demoPin }));
  }

  async signIn(deviceId: string, pin: string): Promise<Employee | undefined> {
    const employee = await this.store.findEmployeeByPin(pin);
    if (!employee) return undefined;
    this.sessions.set(deviceId, employee);
    // first sign-in of the stretch clocks the employee in (E14): sign-out
    // does NOT clock out, because clock-out is where tips get declared
    const open = (await this.store.listShifts()).some((s) => s.employeeId === employee.id && !s.clockOut);
    if (!open) {
      await this.store.putShift({
        id: randomUUID(),
        employeeId: employee.id,
        employeeName: employee.name,
        clockIn: new Date().toISOString(),
      });
    }
    return employee;
  }

  /** Clock out with declared cash tips (E14). Identified by the employee's
   *  own PIN, so nobody declares someone else's tips. */
  async clockOut(envelope: Envelope, input: { pin: string; declaredTipsMinor?: number }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const employee = await this.store.findEmployeeByPin(input.pin ?? "");
    if (!employee) return this.remember(envelope, { kind: "rejected", reason: "PIN not recognized" }, "shift", "clockout");
    const shift = (await this.store.listShifts()).find((s) => s.employeeId === employee.id && !s.clockOut);
    if (!shift) return this.remember(envelope, { kind: "rejected", reason: `${employee.name} is not clocked in` }, "shift", "clockout");
    if (input.declaredTipsMinor !== undefined && (!Number.isSafeInteger(input.declaredTipsMinor) || input.declaredTipsMinor < 0)) {
      return this.remember(envelope, { kind: "rejected", reason: "declaredTipsMinor must be a non-negative integer" }, "shift", shift.id);
    }
    shift.clockOut = new Date().toISOString();
    shift.declaredTipsMinor = input.declaredTipsMinor ?? 0;
    await this.store.putShift(shift);
    return this.remember(envelope, { kind: "applied", day: { shift } }, "shift", shift.id);
  }

  signOut(deviceId: string): void {
    this.sessions.delete(deviceId);
  }

  who(deviceId: string): Employee | null {
    return this.sessions.get(deviceId) ?? null;
  }

  private actorId(envelope: Envelope): string | undefined {
    return this.sessions.get(envelope.deviceId)?.id;
  }

  /** The approval gate: the PIN must belong to an employee with the
   *  manager role. Returns the approver so commands can record WHO. */
  private async manager(pin: unknown): Promise<Employee | undefined> {
    if (typeof pin !== "string" || !pin) return undefined;
    const employee = await this.store.findEmployeeByPin(pin);
    return employee?.role === "manager" ? employee : undefined;
  }

  private managerRefusal(pin: unknown, what: string): string {
    return typeof pin === "string" && pin
      ? "PIN not recognized as a manager"
      : `${what} requires a manager's PIN`;
  }

  private async remember(envelope: Envelope, outcome: CommandOutcome, aggregateType: string, aggregateId: string): Promise<CommandOutcome> {
    await this.store.rememberOp(envelope.operationId, outcome, {
      status: outcome.kind === "applied" ? "applied" : outcome.kind === "conflict" ? "conflict" : "rejected",
      aggregateType,
      aggregateId,
      deviceId: envelope.deviceId,
      ...(this.actorId(envelope) ? { employeeId: this.actorId(envelope) } : {}),
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
    // who opened it (E19): the employee signed in on this device, or the
    // seeded default when nobody is, so an unsigned demo terminal still
    // attributes its checks to a real server instead of to nobody
    const opener = this.sessions.get(envelope.deviceId) ?? STAFF[0]!;
    const check: CheckAggregate = {
      id: randomUUID(),
      checkNo: await this.store.nextCheckNo(),
      tableName: input.tableName,
      covers: input.covers,
      serverId: opener.id,
      serverName: opener.name,
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
      const approver = await this.manager(input.managerPin);
      const r = orderItemTransition(line.status, { type: "void_item", approved: approver !== undefined });
      if (!r.ok) return { kind: "rejected", reason: approver ? r.reason : this.managerRefusal(input.managerPin, "voiding an item") };
      line.status = r.next;
      line.voidReason = input.reason.trim();
      line.voidedBy = this.actorId(envelope) ?? approver!.id;
      line.voidApprovedBy = approver!.id;

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
    return this.run(envelope, checkId, async (check) => {
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
      const approver = await this.manager(input.managerPin);
      if (!approver) {
        return { kind: "rejected", reason: this.managerRefusal(input.managerPin, "a discount") };
      }
      const kind = input.kind === "comp" ? "comp" as const : "discount" as const;
      check.adjustments.push({
        id: randomUUID(),
        kind,
        label: input.label?.trim() || (hasPercent ? `${(input.percentBp! / 100).toFixed(input.percentBp! % 100 ? 2 : 0)}% ${kind}` : kind),
        ...(hasAmount ? { amountMinor: input.amountMinor! } : {}),
        ...(hasPercent ? { percentBp: input.percentBp! } : {}),
        reason: input.reason.trim(),
        appliedBy: this.actorId(envelope) ?? approver.id,
        approvedBy: approver.id,
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
      const approver = await this.manager(input.managerPin);
      if (!approver) {
        return { kind: "rejected", reason: this.managerRefusal(input.managerPin, "merging checks") };
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

      /* A labeled payment settles a split portion (E11), so it is capped twice:
         by what that portion still owes, and by what the CHECK still owes.
         Seat 2 paying seat 3's food is a mis-tap, not a payment.

         The second cap is what stops a cross-partition overpay (E11-T4). A
         portion's paid amount only counts payments under its OWN label, so
         after "Split 1 of 3" and "Seat 1" are settled, "Seat 2" still reads as
         owing its whole share even though most of that money is already in.
         Paying it in full would put more money on the check than the check is
         worth. The POS refuses to offer that, but a second terminal or a direct
         API call would otherwise land it, so the guard belongs here.

         Unlabeled payments are deliberately untouched: cash handed over
         expecting change is normal service, and the check as a whole still
         closes on TOTAL payments covering the total. */
      const portion = input.label ? portionForLabel(check, input.label) : undefined;
      if (portion) {
        const cap = Math.min(portion.dueMinor, view.totals.dueMinor);
        if (input.amountMinor > cap + (input.tipMinor ?? 0)) {
          return {
            kind: "rejected",
            reason: view.totals.dueMinor < portion.dueMinor
              ? `${portion.label} shows ${portion.dueMinor} due but the check only owes ${view.totals.dueMinor}; payments under other portions already cover the rest`
              : `${portion.label} has ${portion.dueMinor} left to pay; ${input.amountMinor} exceeds that portion's remaining due`,
          };
        }
      }

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
        ...(this.actorId(envelope) ? { takenBy: this.actorId(envelope) } : {}),
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

  /** Reopen a closed check (manager): the mistake-remedy the state machine
   *  always allowed, now with a door. The check returns to the floor. */
  async reopenCheck(envelope: Envelope, checkId: string, input: { managerPin?: string }): Promise<CommandOutcome> {
    return this.run(envelope, checkId, async (check) => {
      const approver = await this.manager(input.managerPin);
      if (!approver) return { kind: "rejected", reason: this.managerRefusal(input.managerPin, "reopening a check") };
      const r = checkTransition(check.status, { type: "reopen", approved: true });
      if (!r.ok) return { kind: "rejected", reason: r.reason };
      check.status = r.next;
      delete check.closedAt;
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

  /**
   * The rail, with each ticket carrying the paying status of its check (E8-T2).
   *
   * A closed check does NOT clear its tickets: the two state machines are
   * separate on purpose, and auto-killing a ticket on payment would vanish
   * real work (the to-go dessert fired as the guests pay). So the kitchen sees
   * that the table settled and sweeps the rail itself, and the day close
   * refuses until it is swept.
   *
   * Joined at read time. The status is never copied onto the stored ticket,
   * which would give the same fact two homes and let them disagree.
   */
  async kds(): Promise<KitchenTicketView[]> {
    const [tickets, checks] = await Promise.all([this.activeTickets(), this.store.list()]);
    const statusOf = new Map(checks.map((c) => [c.id, c.status]));
    return tickets.map((t) => ({ ...t, checkStatus: statusOf.get(t.checkId) ?? "unknown" }));
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
    if (!(await this.manager(input.managerPin))) {
      return this.remember(envelope, { kind: "rejected", reason: this.managerRefusal(input.managerPin, "publishing the menu") }, "menu_snapshot", "publish");
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
      ...(this.actorId(envelope) ? { openedBy: this.actorId(envelope) } : {}),
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
    if (input.kind !== "pay_in" && !(await this.manager(input.managerPin))) {
      return this.remember(envelope, { kind: "rejected", reason: this.managerRefusal(input.managerPin, "cash leaving the drawer") }, "drawer_session", session.id);
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
    if (this.actorId(envelope)) session.closedBy = this.actorId(envelope);
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
    if (!(await this.manager(input.managerPin))) {
      return this.remember(envelope, { kind: "rejected", reason: this.managerRefusal(input.managerPin, "closing the day") }, "business_day", date);
    }
    const report = await this.dayReport();
    const b = report.blockers;
    if (b.openChecks.length || b.openDrawers.length || b.offlinePayments || b.openShifts.length || b.openKitchenTickets.length) {
      const parts = [
        b.openChecks.length ? `${b.openChecks.length} open check(s)` : "",
        b.openDrawers.length ? `${b.openDrawers.length} open drawer(s)` : "",
        b.offlinePayments ? `${b.offlinePayments} offline payment(s) pending upload` : "",
        b.openShifts.length ? `${b.openShifts.length} staff still clocked in` : "",
        // named, because "a ticket is open" is useless to the closing manager
        b.openKitchenTickets.length
          ? `${b.openKitchenTickets.length} kitchen ticket(s) still open (${b.openKitchenTickets.map((t) => `${t.tableName} ${t.course}`).join(", ")})`
          : "",
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
    if (!(await this.manager(input.managerPin))) {
      return this.remember(envelope, { kind: "rejected", reason: this.managerRefusal(input.managerPin, "reopening the day") }, "business_day", date);
    }
    await this.store.setDayStatus(date, "open");
    return this.remember(envelope, { kind: "applied", day: await this.dayReport() }, "business_day", date);
  }

  /** The manager's end-of-day picture: totals, drawers, and what still
   *  blocks the close. Everything is computed, nothing stored (schema rule). */
  async dayReport() {
    const date = serviceDate();
    const [status, checks, sessions, allShifts, allTickets] = await Promise.all([
      this.store.dayStatus(date),
      this.store.list(),
      this.store.listDrawerSessions(),
      this.store.listShifts(),
      this.store.listTickets(),
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
    const shifts = allShifts.filter((s) => serviceDateOf(s.clockIn) === date || !s.clockOut);
    const closedToday = checks
      .filter((c) => c.status === "closed" && serviceDateOf(c.openedAt) === date)
      .map((c) => ({ id: c.id, tableName: c.tableName, checkNo: c.checkNo, totalMinor: toView(c).totals.totalMinor, closedAt: c.closedAt }));
    return {
      serviceDate: date,
      status,
      summary: { ...summary, declaredTipsMinor: shifts.reduce((a, s) => a + (s.declaredTipsMinor ?? 0), 0) },
      drawers,
      shifts,
      closedChecks: closedToday,
      blockers: {
        openChecks: openChecks.map((c) => ({ id: c.id, tableName: c.tableName, checkNo: c.checkNo, status: c.status, dueMinor: toView(c).totals.dueMinor })),
        openDrawers: sessions.filter((s) => !s.closedAt).map((s) => s.drawerName),
        offlinePayments,
        openShifts: allShifts.filter((s) => !s.clockOut).map((s) => s.employeeName),
        // the rail sweep (E8-T2): an unbumped ticket is real work or a mistake,
        // and either way somebody has to look at it before the day is sealed
        openKitchenTickets: allTickets
          .filter((t) => t.status === "open")
          .map((t) => ({ id: t.id, tableName: t.tableName, course: t.course, firedAt: t.firedAt })),
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

  /** What would each portion owe (E11). Computed on read, never stored.
   *  undefined means no such check; { error } means the partition is not one
   *  a check can have. */
  async splitPreview(
    id: string,
    input: { mode?: string | undefined; ways?: number | undefined },
  ): Promise<{ portions: SplitPortionView[] } | { error: string } | undefined> {
    const check = await this.store.get(id);
    if (!check) return undefined;
    const spec = readSplitMode(input);
    if ("error" in spec) return spec;
    return { portions: splitPortions(check, spec) };
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

  /* --------------------------- insights (E19) --------------------------- */

  /**
   * Tonight's server scorecard: one row per employee who opened a check that
   * closed today, sorted by net sales, plus the Average row the detail card
   * ranks against. Read-only, computed here, stored nowhere.
   */
  async insightsServers() {
    const date = serviceDate();
    const [checks, allShifts] = await Promise.all([this.store.list(), this.store.listShifts()]);
    const closed = checks.filter((c) => c.status === "closed" && serviceDateOf(c.openedAt) === date);
    // the same shift window the day report uses, so declared tips here and
    // declared tips on the Close screen are one number, not two
    const shifts = allShifts.filter((s) => serviceDateOf(s.clockIn) === date || !s.clockOut);

    const rows = new Map<string, ServerRow>();
    for (const c of closed) {
      // a check written before E19 carries no opener; it lands on the same
      // seeded default an unsigned device would have stamped
      const serverId = c.serverId ?? STAFF[0]!.id;
      let row = rows.get(serverId);
      if (!row) {
        row = {
          serverId, serverName: c.serverName ?? STAFF[0]!.name,
          checks: 0, covers: 0, netMinor: 0, totalMinor: 0, tipMinor: 0, discountMinor: 0,
          declaredTipsMinor: 0, voidCount: 0, voidValueMinor: 0, turnMs: 0, courses: {},
          avgCheckMinor: 0, perCoverMinor: 0, avgTurnMinutes: 0,
        };
        rows.set(serverId, row);
      }
      const totals = toView(c).totals;
      row.checks += 1;
      row.covers += c.covers;
      row.netMinor += totals.subtotalMinor - totals.discountMinor;
      row.totalMinor += totals.totalMinor;
      row.discountMinor += totals.discountMinor;
      for (const p of c.payments) row.tipMinor += p.tipMinor;
      for (const l of c.lines) {
        // the line value the day report voids at: (unit + mods) x quantity
        const value = (l.unitPriceMinor + l.modifierPriceMinor) * l.quantity;
        if (l.status === "voided") {
          row.voidCount += 1;
          row.voidValueMinor += value;
          continue; // a voided line is void metrics only, never course value
        }
        row.courses[l.course] = (row.courses[l.course] ?? 0) + value;
      }
      if (c.closedAt) row.turnMs += Date.parse(c.closedAt) - Date.parse(c.openedAt);
    }

    for (const row of rows.values()) {
      for (const s of shifts) {
        if (s.employeeId === row.serverId) row.declaredTipsMinor += s.declaredTipsMinor ?? 0;
      }
      row.avgCheckMinor = per(row.netMinor, row.checks);
      row.perCoverMinor = per(row.netMinor, row.covers);
      row.avgTurnMinutes = per(row.turnMs, row.checks * 60_000);
    }
    const servers = [...rows.values()].sort((a, b) => b.netMinor - a.netMinor);
    const courseKeys = COURSE_ORDER.filter((key) => servers.some((s) => (s.courses[key] ?? 0) > 0));
    return { serviceDate: date, courseKeys, servers, average: averageRow(servers) };
  }

  /**
   * Busy and quiet: net sales by day-of-week x hour over EVERY closed check
   * the store holds. The memory store holds today only; PostgreSQL accumulates
   * history, which is what makes the grid worth reading.
   */
  async insightsHeatmap() {
    const closed = (await this.store.list()).filter((c) => c.status === "closed");
    const cells = new Map<string, HeatmapCell>();
    const dayTotals = [0, 0, 0, 0, 0, 0, 0];
    const dates = new Set<string>();
    let grandNetMinor = 0;
    for (const c of closed) {
      const totals = toView(c).totals;
      const net = totals.subtotalMinor - totals.discountMinor;
      // server-local day and hour, the clock serviceDateOf already reads, so a
      // late check lands on the evening it was actually served
      const at = new Date(c.openedAt);
      const day = at.getDay();
      const hour = at.getHours();
      const key = `${day}:${hour}`;
      const cell = cells.get(key) ?? { day, hour, netMinor: 0, checks: 0, covers: 0 };
      cell.netMinor += net;
      cell.checks += 1;
      cell.covers += c.covers;
      cells.set(key, cell);
      dayTotals[day] = (dayTotals[day] ?? 0) + net;
      grandNetMinor += net;
      dates.add(serviceDateOf(c.openedAt));
    }
    const cellList = [...cells.values()].sort((a, b) => a.day - b.day || a.hour - b.hour);
    return { cells: cellList, dayTotals, grandNetMinor, daysCovered: dates.size };
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
