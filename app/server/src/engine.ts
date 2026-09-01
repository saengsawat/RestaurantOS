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
import { defaultTitle, PIN_RULE, pinHash, STAFF, type DirectoryEntry, type Employee, type RosterEntry } from "./staff.js";
import { randomUUID } from "node:crypto";
import { sameName, serviceDateOf, TABLE_SHAPES, type CashEvent, type CheckAggregate, type DrawerSession, type Envelope, type FloorTable, type Guest, type KitchenTicket, type MenuSnapshot, type OrderLine, type Store, type TableShape, type Venue } from "./types.js";
import type { GroupIndex } from "@restaurantos/domain";

export const TAX_RATE = { num: 8_875, den: 100_000 };
export const RECALL_WINDOW_MS = 10 * 60_000;
/** How many hold/release events one check keeps for its history (E8-T3). The
 *  sync journal holds every operation forever; this is the readable story. */
export const COURSE_LOG_LIMIT = 200;

/** Minor units as a sentence reads them. Only the history uses this: every
 *  other number this server sends is minor units for the client to format,
 *  and the pilot's real currency handling belongs there too. */
function usd(minor: number): string {
  return "$" + (minor / 100).toFixed(2);
}

// Manager approval is now a real identity check (E15): the PIN must hash to
// an employee who holds the manager role. See Engine.manager().

export type CommandOutcome =
  | { kind: "applied"; check?: CheckView; tickets?: KitchenTicket[]; session?: DrawerSession; day?: unknown; menu?: unknown; guest?: unknown; venue?: Venue; employee?: RosterEntry; audit?: unknown; refundDueMinor?: number; note?: string }
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
    /** what the HOUSE owes the guest (E2-T2): money already taken beyond the
     *  total, which happens when a void or a discount lands on a reopened
     *  check. dueMinor stays clamped at zero, because every screen prints it
     *  as "collect this"; the obligation gets its own honest field. Computed
     *  on read like every other total, never stored. */
    refundDueMinor: number;
  };
  /** guests attached to this check (E20), joined at read time, empty when
   *  nobody is: the link lives in check_guest, never on the aggregate */
  guests: GuestChip[];
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

export function toView(check: CheckAggregate, guests: readonly GuestChip[] = []): CheckView {
  const lines = toDomainLines(check);
  const adjustments = toDomainAdjustments(check);
  const t = computeCheckTotals(lines, adjustments, TAX_RATE);
  const paid = check.payments.reduce((a, p) => a + p.amountMinor, 0);
  return {
    ...check,
    guests: [...guests],
    totals: {
      subtotalMinor: t.subtotalMinor,
      discountMinor: t.discountMinor,
      taxMinor: t.taxMinor,
      totalMinor: t.totalMinor,
      paidMinor: paid,
      dueMinor: Math.max(0, t.totalMinor - paid),
      refundDueMinor: Math.max(0, paid - t.totalMinor),
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

/* ---------------------------- guestbook (E20) ----------------------------
 * A guest is identity plus a link to a check, and nothing else: no stored
 * spend, no stored visit count (D19's rule, the same one the reports obey).
 * The profile is assembled in Engine.guestProfile below.
 */

/** How many results a guest search hands back, so a crafted query cannot ask
 *  for the whole book. The attach flow types until it narrows. */
export const MAX_GUEST_RESULTS = 25;
export const MAX_FAVORITES = 5;

/** A guest chip on the check header: who is sitting there, joined on read. */
export interface GuestChip {
  id: string;
  name: string;
}

/** An optional trimmed field: an empty string means absent, not "". */
function text<K extends string>(value: string | undefined, key: K): { [P in K]?: string } {
  const trimmed = (value ?? "").trim();
  return (trimmed ? { [key]: trimmed } : {}) as { [P in K]?: string };
}

/** Shape a mode result for the payload, or keep the honest null. */
function mapOrNull<T, U>(value: T | null, shape: (value: T) => U): U | null {
  return value === null ? null : shape(value);
}

/** The middle gap between visits, rounded. null below two visits, because one
 *  visit has no cadence and pretending otherwise would be a made-up number. */
function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

export class Engine {
  constructor(private readonly store: Store) {}

  /* ------------------------- sessions (E15) ------------------------- */

  /** deviceId -> signed-in employee. Deliberately in-memory: a server
   *  restart signs everyone out, which is the honest behavior. */
  private sessions = new Map<string, Employee>();

  /** The roster: who works here. Never a PIN, never a hash (E21-T1), and
   *  since E24-T2 never a phone number, an address, or an emergency contact
   *  either. This is the read every device on the floor is allowed to make,
   *  so what it carries is exactly what a service screen needs: a name, the
   *  permission role, the job title, and whether they still work here. */
  async staff(): Promise<RosterEntry[]> {
    return (await this.store.listEmployees()).map((e) => ({ ...e, title: e.title ?? defaultTitle(e.role) }));
  }

  /**
   * The people directory (E24-T2): the same roster with the personal half
   * attached, and the only door it comes out of.
   *
   * The PIN is checked on EVERY call and nothing is cached: a manager who
   * walked away from the terminal has not left the directory open behind
   * them. A wrong PIN gets the same sentence every other manager gate uses,
   * so a server who taps the row learns nothing from the wording.
   */
  async directory(pin: unknown): Promise<{ ok: true; staff: DirectoryEntry[] } | { ok: false; reason: string }> {
    if (!(await this.manager(pin))) return { ok: false, reason: this.managerRefusal(pin, "reading the staff directory") };
    const staff = await this.store.listDirectory();
    return { ok: true, staff: staff.map((e) => ({ ...e, title: e.title ?? defaultTitle(e.role) })) };
  }

  /** The three demo PINs, straight off the seed constant, for the lock screen
   *  and the POS sign-in sheet that print them on purpose. Separate from the
   *  roster read so a PIN a real manager sets can never come out of it. */
  demoPins() {
    return STAFF.map(({ id, name, role, demoPin }) => ({ id, name, role, demoPin }));
  }

  /** Who a check belongs to when nobody is signed in on the device (E19).
   *  The store roster decides, not a source-code constant: first active
   *  server, else any active employee. The seed is the last resort, for the
   *  install with an empty roster that the last-manager guard makes
   *  impossible to reach by ordinary means. */
  private async defaultOpener(): Promise<Employee> {
    const roster = await this.store.listEmployees();
    const active = roster.filter((e) => e.active);
    const pick = active.find((e) => e.role === "server") ?? active[0];
    return pick ? { id: pick.id, name: pick.name, role: pick.role } : STAFF[0]!;
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
      if (outcome.check) {
        outcome.check.version = check.version;
        outcome.check.guests = await this.guestChips(checkId);
      }
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
    const opener = this.sessions.get(envelope.deviceId) ?? await this.defaultOpener();
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
        addedAt: new Date().toISOString(),
        menuSnapshotId: snapshot.id,
      });
      if (avail?.remaining !== undefined) {
        const remaining = avail.remaining - input.quantity;
        await this.store.setAvailability({ itemId: entry.id, is86: remaining === 0, remaining });
      }
      return { kind: "applied", check: toView(check) };
    });
  }

  /**
   * Fire unsent lines: one dispatch ticket per course (E8).
   *
   * The big Send fires everything unsent EXCEPT the courses on hold (E8-T3),
   * and says which ones stayed behind. Naming an explicit course means "fire
   * this one now", hold and all, which is what the course's own Fire chip does.
   */
  async send(envelope: Envelope, checkId: string, input: { course?: string }): Promise<CommandOutcome> {
    if (input.course !== undefined) return this.fireCourse(envelope, checkId, { course: input.course });
    return this.run(envelope, checkId, async (check) => {
      const unsent = check.lines.filter((l) => l.status === "unsent");
      if (unsent.length === 0) return { kind: "rejected", reason: "nothing unsent to fire" };
      const held = new Set(check.heldCourses ?? []);
      const targets = unsent.filter((l) => !held.has(l.course));
      if (targets.length === 0) {
        // never a silent no-op: somebody pressed Send and the kitchen got
        // nothing, so say which courses are sitting on hold
        const names = [...new Set(unsent.map((l) => l.course))];
        return {
          kind: "rejected",
          reason: `everything unsent is held: ${names.join(", ")}. Fire a course from its own chip when the table is ready.`,
        };
      }
      const fired = await this.fireLines(check, targets);
      if (!fired.ok) return { kind: "rejected", reason: fired.reason };
      const waiting = new Map<string, number>();
      for (const l of unsent) {
        if (held.has(l.course)) waiting.set(l.course, (waiting.get(l.course) ?? 0) + 1);
      }
      const note = [...waiting].map(([course, n]) => `${course} held, ${n} item(s) waiting`).join("; ");
      return { kind: "applied", check: toView(check), tickets: fired.tickets, ...(note ? { note } : {}) };
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
      line.voidedAt = new Date().toISOString();
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
        appliedAt: new Date().toISOString(),
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
        takenAt: new Date().toISOString(),
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
      check.reopenedAt = new Date().toISOString();
      delete check.closedAt;
      return { kind: "applied", check: toView(check) };
    });
  }

  /**
   * Close the check out. A settled check closes with no PIN, whether it got
   * here the ordinary way or through a reopen (E2-T2: a reopened check that
   * needs no correction used to have no exit at all, which stranded the table
   * and blocked the day).
   *
   * Two edited-while-reopened cases, and neither one touches the payments
   * list, which is append-only:
   *   raised the total  -> the check still owes; the difference is collected
   *                        the ordinary way before it can close
   *   lowered the total -> the guest is overpaid, so closing BOOKS what the
   *                        house owes back (an audited refund_due, manager
   *                        approved). Moving the money is the provider's job
   *                        (E13); this records the obligation and never
   *                        quietly resets the due.
   */
  async close(envelope: Envelope, checkId: string, input: { managerPin?: string } = {}): Promise<CommandOutcome> {
    return this.run(envelope, checkId, async (check) => {
      if (check.payments.some((p) => p.status === "accepted_offline")) {
        return { kind: "rejected", reason: "offline card payments pending upload; check cannot close until they authorize" };
      }
      const totals = toView(check).totals;
      const r = checkTransition(check.status, { type: "close", coversTotal: totals.dueMinor === 0 });
      if (!r.ok) {
        // the machine knows the rule, this layer knows the number
        return { kind: "rejected", reason: totals.dueMinor > 0 ? `${r.reason} (${totals.dueMinor} still due)` : r.reason };
      }
      const refundDueMinor = totals.refundDueMinor;
      let approver: Employee | undefined;
      if (refundDueMinor > 0) {
        approver = await this.manager(input.managerPin);
        if (!approver) {
          return {
            kind: "rejected",
            reason: typeof input.managerPin === "string" && input.managerPin
              ? "PIN not recognized as a manager"
              : `this check is overpaid by ${refundDueMinor}; closing it owes the guest a refund and needs a manager's PIN`,
          };
        }
      }
      check.status = r.next;
      check.closedAt = new Date().toISOString();
      return {
        kind: "applied",
        check: toView(check),
        ...(refundDueMinor > 0
          ? {
              refundDueMinor,
              audit: {
                action: "refund_due",
                checkId: check.id,
                checkNo: check.checkNo,
                refundDueMinor,
                closedBy: this.actorId(envelope) ?? null,
                approvedBy: approver!.id,
              },
            }
          : {}),
      };
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

  /* ----------------------- floor editor (E6-T2) -----------------------
   * Drawing the room is a manager act: incumbents treat it as rare and
   * deliberate, so every structural command here is PIN-gated server-side
   * (moveTable is not: nudging a table during service is ordinary work).
   *
   * The constraint behind all of it is history. party.table_id references a
   * dining_table row and a closed check carries the name it was served under,
   * so removal is SOFT (the row survives, retired) and a rename or a retire is
   * refused while anyone is still sitting there or still cooking for them. */

  /** Size limits in percent of the room. Below 3 a table is untappable at
   *  44px; above 40 one table swallows the floor. */
  private static readonly MIN_SIDE = 3;
  private static readonly MAX_SIDE = 40;

  private static readonly ROUND1 = (v: number) => Math.round(v * 10) / 10;

  /** Everyone still attached to this table by NAME: a check that has not
   *  closed, or a kitchen card still cooking. Either one makes a rename or a
   *  retire a lie about work in progress. */
  private async tableInUse(name: string): Promise<string | undefined> {
    const [checks, tickets] = await Promise.all([this.store.list(), this.store.listTickets()]);
    const live = checks.find((c) => sameName(c.tableName, name) && c.status !== "closed" && c.status !== "voided");
    if (live) return `${name} has an open check (#${live.checkNo}); close it first`;
    const cooking = tickets.find((t) => sameName(t.tableName, name) && t.status === "open");
    if (cooking) return `${name} still has an open kitchen ticket (${cooking.course}); bump it first`;
    return undefined;
  }

  /** A name is free when no ACTIVE table answers to it. Case-insensitive,
   *  because a server calling out "table 9" means the one on the wall.
   *  `self` is the table doing the asking, so a case-only self-rename passes. */
  private nameTaken(floor: readonly FloorTable[], name: string, self?: string): boolean {
    return floor.some((t) => sameName(t.name, name) && !(self !== undefined && sameName(t.name, self)));
  }

  /** PG raises 23505 on dining_table_active_name_uq when two devices add the
   *  same name at once. The loser gets the refusal it would have got a
   *  millisecond earlier, not a 500. */
  private static isNameRace(err: unknown): boolean {
    return (err as { code?: string })?.code === "23505";
  }

  private readShape(shape: unknown): TableShape | undefined {
    return (TABLE_SHAPES as readonly string[]).includes(shape as string) ? (shape as TableShape) : undefined;
  }

  private sideError(w: number, h: number): string | undefined {
    const { MIN_SIDE, MAX_SIDE } = Engine;
    return [w, h].every((v) => Number.isFinite(v) && v >= MIN_SIDE && v <= MAX_SIDE)
      ? undefined
      : `w and h must be between ${MIN_SIDE} and ${MAX_SIDE} (percent of the room)`;
  }

  /** Draw a new table. A name that matches a RETIRED table revives that row,
   *  so a table taken out for the winter comes back with its own history. */
  async addTable(
    envelope: Envelope,
    input: { managerPin?: string; name: string; area: string; seats: number; shape?: string; x: number; y: number; w: number; h: number },
  ): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const name = (input.name ?? "").trim();
    const area = (input.area ?? "").trim();
    const refuse = (reason: string) => this.remember(envelope, { kind: "rejected", reason }, "table", name || "new");

    if (!(await this.manager(input.managerPin))) return refuse(this.managerRefusal(input.managerPin, "adding a table"));
    if (!name) return refuse("a table needs a name");
    if (!area) return refuse("a table needs an area");
    if (!Number.isSafeInteger(input.seats) || input.seats < 1) return refuse("seats must be a positive integer");
    const shape = this.readShape(input.shape ?? "rect");
    if (!shape) return refuse(`unknown shape ${String(input.shape)}; expected one of ${TABLE_SHAPES.join(", ")}`);
    const sides = this.sideError(input.w, input.h);
    if (sides) return refuse(sides);
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) return refuse("x and y must be numbers (percent of the room)");

    const floor = await this.store.listFloor();
    if (this.nameTaken(floor, name)) return refuse(`${name} is already a table on the floor`);

    const { ROUND1 } = Engine;
    const w = ROUND1(input.w), h = ROUND1(input.h);
    const table: FloorTable = {
      name, area, seats: input.seats, shape,
      x: ROUND1(Math.min(Math.max(input.x, 0), 100 - w)),
      y: ROUND1(Math.min(Math.max(input.y, 0), 100 - h)),
      w, h,
    };
    try {
      await this.store.addTable(table);
    } catch (err) {
      if (Engine.isNameRace(err)) return refuse(`${name} is already a table on the floor`);
      throw err;
    }
    return this.remember(envelope, { kind: "applied" }, "table", name);
  }

  /** Rename, re-seat, or reshape. Seats and shape are ordinary corrections and
   *  stay allowed mid-service; only the NAME is gated on the table being
   *  quiet, because the name is what a check and a kitchen card call it. */
  async updateTable(
    envelope: Envelope,
    input: { managerPin?: string; tableName: string; newName?: string; seats?: number; shape?: string },
  ): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const tableName = (input.tableName ?? "").trim();
    const refuse = (reason: string) => this.remember(envelope, { kind: "rejected", reason }, "table", tableName);

    if (!(await this.manager(input.managerPin))) return refuse(this.managerRefusal(input.managerPin, "editing a table"));
    const floor = await this.store.listFloor();
    const table = floor.find((t) => t.name === tableName);
    if (!table) return refuse(`unknown table ${tableName}`);

    const patch: { name?: string; seats?: number; shape?: TableShape } = {};
    if (input.newName !== undefined) {
      const newName = String(input.newName).trim();
      if (!newName) return refuse("a table needs a name");
      // a case-only self-rename is a correction to the sign on the wall, not
      // a collision with itself
      if (this.nameTaken(floor, newName, table.name)) return refuse(`${newName} is already a table on the floor`);
      if (newName !== table.name) {
        const busy = await this.tableInUse(table.name);
        if (busy) return refuse(`cannot rename while ${busy}`);
        patch.name = newName;
      }
    }
    if (input.seats !== undefined) {
      if (!Number.isSafeInteger(input.seats) || input.seats < 1) return refuse("seats must be a positive integer");
      patch.seats = input.seats;
    }
    if (input.shape !== undefined) {
      const shape = this.readShape(input.shape);
      if (!shape) return refuse(`unknown shape ${String(input.shape)}; expected one of ${TABLE_SHAPES.join(", ")}`);
      patch.shape = shape;
    }
    if (!Object.keys(patch).length) return refuse("nothing to change: send a newName, seats, or shape");

    try {
      await this.store.updateTable(table.name, patch);
    } catch (err) {
      if (Engine.isNameRace(err)) return refuse(`${patch.name} is already a table on the floor`);
      throw err;
    }
    return this.remember(envelope, { kind: "applied" }, "table", patch.name ?? table.name);
  }

  /** Resize in place. The position re-clamps afterwards, because a table
   *  grown at the right edge would otherwise hang off the room. */
  async resizeTable(envelope: Envelope, input: { managerPin?: string; tableName: string; w: number; h: number }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const tableName = (input.tableName ?? "").trim();
    const refuse = (reason: string) => this.remember(envelope, { kind: "rejected", reason }, "table", tableName);

    if (!(await this.manager(input.managerPin))) return refuse(this.managerRefusal(input.managerPin, "resizing a table"));
    const table = (await this.store.listFloor()).find((t) => t.name === tableName);
    if (!table) return refuse(`unknown table ${tableName}`);
    const sides = this.sideError(input.w, input.h);
    if (sides) return refuse(sides);

    const { ROUND1 } = Engine;
    const w = ROUND1(input.w), h = ROUND1(input.h);
    await this.store.moveTable(table.name, {
      x: ROUND1(Math.min(table.x, 100 - w)),
      y: ROUND1(Math.min(table.y, 100 - h)),
      w, h,
    });
    return this.remember(envelope, { kind: "applied" }, "table", table.name);
  }

  /** Take a table out of the room. SOFT: the row lives on so party history and
   *  closed checks still point at something real, and re-adding the name
   *  revives that same identity rather than forking it. */
  async retireTable(envelope: Envelope, input: { managerPin?: string; tableName: string }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const tableName = (input.tableName ?? "").trim();
    const refuse = (reason: string) => this.remember(envelope, { kind: "rejected", reason }, "table", tableName);

    if (!(await this.manager(input.managerPin))) return refuse(this.managerRefusal(input.managerPin, "retiring a table"));
    const table = (await this.store.listFloor()).find((t) => t.name === tableName);
    if (!table) return refuse(`unknown table ${tableName}`);
    const busy = await this.tableInUse(table.name);
    if (busy) return refuse(`cannot retire while ${busy}`);

    await this.store.retireTable(table.name, new Date().toISOString());
    return this.remember(envelope, { kind: "applied" }, "table", table.name);
  }

  /* --------------------- venue and roster (E21-T1) ---------------------
   * "Osteria Nove", its address, its timezone, and three PINs used to be
   * source code, which is a fine way to demo one restaurant and no way at
   * all to run a second. All of it is data now; the demo values are simply
   * the seed, because an empty POS demos badly. */

  /** Who the restaurant is. Public read: a lock screen has to print the name
   *  before anybody has signed in. */
  async venue(): Promise<Venue> {
    return this.store.getVenue();
  }

  /** Whether a string is a timezone this machine actually knows. Intl carries
   *  the IANA list, so nothing here has to be maintained by hand.
   *  supportedValuesOf is ES2023 and this project's lib is ES2022, hence the
   *  narrow cast rather than a wider lib bump. */
  private static knownTimezone(tz: string): boolean {
    const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (!zones) return true; // an older runtime cannot check; do not invent a refusal
    return zones("timeZone").includes(tz);
  }

  /**
   * Rename the restaurant, move it, or correct its timezone.
   *
   * NOTE: `serviceDateOf` buckets the business day on SERVER-LOCAL time, so
   * changing the stored timezone here does NOT change day bucketing. Wiring
   * the service date to the venue timezone is its own ticket.
   */
  async updateVenue(
    envelope: Envelope,
    input: { managerPin?: string; name?: string; address?: string; timezone?: string },
  ): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const refuse = (reason: string) => this.remember(envelope, { kind: "rejected", reason }, "venue", "venue");

    if (!(await this.manager(input.managerPin))) return refuse(this.managerRefusal(input.managerPin, "editing the venue"));
    const venue = { ...(await this.store.getVenue()) };

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) return refuse("a restaurant needs a name");
      venue.name = name;
    }
    // an address CAN be cleared: a ghost kitchen with no street frontage is
    // a real thing, and a blank line prints as a blank line
    if (input.address !== undefined) venue.address = input.address.trim();
    if (input.timezone !== undefined) {
      const tz = input.timezone.trim();
      if (!Engine.knownTimezone(tz)) return refuse(`${tz} is not a timezone this machine knows`);
      venue.timezone = tz;
    }

    await this.store.putVenue(venue);
    return this.remember(envelope, { kind: "applied", venue }, "venue", "venue");
  }

  /** The PIN must be unambiguous across ACTIVE employees: sign-in identifies
   *  a person BY their PIN, so two people sharing one would make every check
   *  and every approval a coin toss. */
  private async pinError(pin: unknown, exceptId?: string): Promise<string | undefined> {
    if (typeof pin !== "string" || !PIN_RULE.test(pin)) return "a PIN is 4 to 6 digits";
    const holder = await this.store.findEmployeeByPin(pin);
    if (holder && holder.id !== exceptId) return `that PIN already belongs to ${holder.name}`;
    return undefined;
  }

  /** The optional detail fields, trimmed, with an emptied one becoming absent
   *  rather than an empty string. Only keys the caller actually sent come
   *  back, so a half-filled form never blanks a field it did not show. */
  private static details(input: Record<string, unknown>): Partial<DirectoryEntry> {
    const out: Record<string, string | undefined> = {};
    for (const key of ["title", "phone", "email", "emergencyContact", "notes"] as const) {
      if (typeof input[key] !== "string") continue;
      const value = (input[key] as string).trim();
      out[key] = value || undefined;
    }
    return out as Partial<DirectoryEntry>;
  }

  /**
   * Hire somebody.
   *
   * `role` is the PERMISSION level and stays the two-value enum it has always
   * been: it gates sign-in, approvals, and the last-manager guard. A kitchen
   * hire who never touches the POS is role "server" with no expectation of
   * ever signing in, and their `title` says "Line cook", which is the thing
   * the room actually calls them. Widening the permission enum is a different
   * ticket, and a promotion deserves its own flow.
   */
  async addEmployee(
    envelope: Envelope,
    input: {
      managerPin?: string; name?: string; role?: string; pin?: string;
      title?: string; phone?: string; email?: string; emergencyContact?: string; notes?: string;
    },
  ): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const refuse = (reason: string) => this.remember(envelope, { kind: "rejected", reason }, "employee", "new");

    if (!(await this.manager(input.managerPin))) return refuse(this.managerRefusal(input.managerPin, "adding an employee"));
    const name = (input.name ?? "").trim();
    if (!name) return refuse("an employee needs a name");
    if (input.role !== "server" && input.role !== "manager") return refuse("role must be server or manager");
    const bad = await this.pinError(input.pin);
    if (bad) return refuse(bad);

    const employee: DirectoryEntry = {
      id: randomUUID(), name, role: input.role, active: true,
      ...Engine.details(input as Record<string, unknown>),
    };
    await this.store.addEmployee(employee, pinHash(input.pin as string));
    // the applied result is the PUBLIC shape: a hire that echoed the new
    // person's home number back over the wire would undo the gate on the
    // read, and the manager who just typed it does not need it read back
    const { phone: _phone, email: _email, emergencyContact: _ec, notes: _notes, ...roster } = employee;
    return this.remember(envelope, { kind: "applied", employee: { ...roster, title: roster.title ?? defaultTitle(roster.role) } }, "employee", employee.id);
  }

  /**
   * Edit the record: the job title, the contact details, and the name.
   *
   * NOT the role, and not `active`: a promotion changes what a PIN can
   * approve and deserves its own thought, and letting somebody go already has
   * its own command with the last-manager guard on it.
   */
  async updateEmployee(
    envelope: Envelope,
    input: {
      managerPin?: string; employeeId?: string; name?: string;
      title?: string; phone?: string; email?: string; emergencyContact?: string; notes?: string;
    },
  ): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const id = String(input.employeeId ?? "");
    const refuse = (reason: string) => this.remember(envelope, { kind: "rejected", reason }, "employee", id);

    if (!(await this.manager(input.managerPin))) return refuse(this.managerRefusal(input.managerPin, "editing an employee"));
    const employee = await this.store.getEmployee(id);
    if (!employee) return refuse(`no employee ${id}`);

    const patch: Partial<Omit<DirectoryEntry, "id" | "role" | "active">> = Engine.details(input as Record<string, unknown>);
    if (input.name !== undefined) {
      const name = input.name.trim();
      // the one field that cannot be cleared: every check they ever opened
      // shows this, and a blank check header helps nobody
      if (!name) return refuse("an employee needs a name");
      patch.name = name;
    }

    await this.store.updateEmployee(employee.id, patch);
    const updated = (await this.store.getEmployee(employee.id))!;
    return this.remember(envelope, { kind: "applied", employee: { ...updated, title: updated.title ?? defaultTitle(updated.role) } }, "employee", employee.id);
  }

  /** Change somebody's PIN. Nobody's old PIN survives this, which is the
   *  point: it is what a manager does the morning after one is overheard. */
  async resetPin(envelope: Envelope, input: { managerPin?: string; employeeId?: string; pin?: string }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const id = String(input.employeeId ?? "");
    const refuse = (reason: string) => this.remember(envelope, { kind: "rejected", reason }, "employee", id);

    if (!(await this.manager(input.managerPin))) return refuse(this.managerRefusal(input.managerPin, "resetting a PIN"));
    const employee = await this.store.getEmployee(id);
    if (!employee) return refuse(`no employee ${id}`);
    const bad = await this.pinError(input.pin, employee.id);
    if (bad) return refuse(bad);

    await this.store.setEmployeePin(employee.id, pinHash(input.pin as string));
    return this.remember(envelope, { kind: "applied", employee }, "employee", employee.id);
  }

  /** Let somebody go. SOFT, always: checks.server_id still points at them and
   *  every report they earned still names them. The last active manager
   *  cannot be deactivated, because a restaurant that cannot approve a void
   *  is a restaurant that cannot open. */
  async deactivateEmployee(envelope: Envelope, input: { managerPin?: string; employeeId?: string }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const id = String(input.employeeId ?? "");
    const refuse = (reason: string) => this.remember(envelope, { kind: "rejected", reason }, "employee", id);

    if (!(await this.manager(input.managerPin))) return refuse(this.managerRefusal(input.managerPin, "deactivating an employee"));
    const roster = await this.store.listEmployees();
    const employee = roster.find((e) => e.id === id);
    if (!employee) return refuse(`no employee ${id}`);
    if (!employee.active) return refuse(`${employee.name} is already deactivated`);
    if (employee.role === "manager" && roster.filter((e) => e.active && e.role === "manager").length === 1) {
      return refuse(`${employee.name} is the only active manager; promote someone else first`);
    }

    await this.store.setEmployeeActive(employee.id, false);
    // their session dies with the PIN: a signed-in terminal must not keep
    // working for somebody who no longer works here
    for (const [device, who] of this.sessions) if (who.id === employee.id) this.sessions.delete(device);
    return this.remember(envelope, { kind: "applied", employee: { ...employee, active: false } }, "employee", employee.id);
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
    return check ? toView(check, await this.guestChips(check.id)) : undefined;
  }

  async listChecks(): Promise<CheckView[]> {
    const [checks, links, guests] = await Promise.all([
      this.store.list(),
      this.store.listCheckGuests(),
      this.store.listGuests(),
    ]);
    const nameOf = new Map(guests.map((g) => [g.id, g.displayName]));
    return checks.map((c) =>
      toView(c, links
        .filter((l) => l.checkId === c.id)
        .flatMap((l) => {
          const name = nameOf.get(l.guestId);
          return name ? [{ id: l.guestId, name }] : [];
        })));
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
    // a check written before E19 carries no opener; it lands on the same
    // default an unsigned device would have stamped
    const fallback = await this.defaultOpener();
    for (const c of closed) {
      const serverId = c.serverId ?? fallback.id;
      let row = rows.get(serverId);
      if (!row) {
        row = {
          serverId, serverName: c.serverName ?? fallback.name,
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
    // EVERY declaration in today's window, row or no row. A row exists only
    // for someone who closed a check, but a manager sealing the day and a
    // server who only ran food declare cash tips too, and their money is
    // still the shift's money. Summing the rows would lose it, which is
    // exactly the drift this field closes: it equals the day report's
    // declaredTipsMinor unconditionally.
    const declaredTipsTotalMinor = shifts.reduce((a, s) => a + (s.declaredTipsMinor ?? 0), 0);
    return { serviceDate: date, courseKeys, servers, average: averageRow(servers), declaredTipsTotalMinor };
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

  /* ----------------------- courses: hold and fire (E8-T3) -----------------------
   * Real service is coursed: beverages go now, primi when the antipasti clear,
   * secondi when the table is ready. The engine already made one kitchen ticket
   * per course; what was missing was the control on the check, so Send fired
   * the whole order at once. These three commands are that control, and the
   * flagship mockup's Hold / Fire now chips are their spec.
   *
   * Holds are not a kitchen state: nothing is dispatched, so the KDS never
   * hears about a held course, and a held line is still an unsent line, which
   * means it still blocks payment (FR-26). Nothing about the state machines
   * changes.
   */

  /** The canonical spelling of a course, from the live menu or from this
   *  check's own lines. Keyed this way so "primi" from some client cannot
   *  create a hold that the POS, which speaks in PRIMI, can never see. */
  private async resolveCourse(check: CheckAggregate, input: string): Promise<string | undefined> {
    const wanted = (input ?? "").trim().toLowerCase();
    if (!wanted) return undefined;
    const snapshot = await this.store.getActiveSnapshot();
    const known = [
      ...snapshot.items.map((i) => i.course as string),
      ...check.lines.map((l) => l.course),
      ...(check.heldCourses ?? []),
    ];
    return known.find((c) => c.toLowerCase() === wanted);
  }

  /** A hold going on or coming off, for the history. Capped: the sync journal
   *  keeps every operation forever, this is the readable story. */
  private logCourse(check: CheckAggregate, course: string, action: "held" | "released"): void {
    const log = [...(check.courseEvents ?? []), { at: new Date().toISOString(), course, action }];
    check.courseEvents = log.slice(-COURSE_LOG_LIMIT);
  }

  /**
   * Dispatch a set of unsent lines: one ticket per course, the shape the KDS
   * reads. Shared by Send and by a single course's Fire.
   *
   * Every transition is checked BEFORE any line is mutated, because the memory
   * store hands out the live aggregate: a refusal halfway through would leave
   * half the order dispatched with nothing persisted to say so.
   */
  private async fireLines(
    check: CheckAggregate,
    targets: readonly OrderLine[],
  ): Promise<{ ok: true; tickets: KitchenTicket[] } | { ok: false; reason: string }> {
    const groups = (await this.store.getActiveSnapshot()).groups;
    for (const line of targets) {
      const r = orderItemTransition(line.status, { type: "dispatch" });
      if (!r.ok) return { ok: false, reason: r.reason };
    }
    for (const line of targets) {
      const r = orderItemTransition(line.status, { type: "dispatch" });
      if (r.ok) line.status = r.next;
    }
    const byCourse = new Map<string, OrderLine[]>();
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
    return { ok: true, tickets };
  }

  /** Hold a course back. Allowed with nothing ordered in it yet: the table
   *  says "hold the secondi" before the secondi exist. No PIN: this is service,
   *  not an approval. */
  async holdCourse(envelope: Envelope, checkId: string, input: { course: string }): Promise<CommandOutcome> {
    return this.run(envelope, checkId, async (check) => {
      if (check.status === "closed" || check.status === "voided") {
        return { kind: "rejected", reason: `cannot hold a course on a ${check.status} check` };
      }
      const course = await this.resolveCourse(check, input.course);
      if (!course) return { kind: "rejected", reason: `unknown course ${input.course}` };
      const held = check.heldCourses ?? [];
      if (!held.includes(course)) {
        check.heldCourses = [...held, course];
        this.logCourse(check, course, "held");
      }
      const waiting = check.lines.filter((l) => l.status === "unsent" && l.course === course).length;
      return {
        kind: "applied",
        check: toView(check),
        note: `${course} held${waiting ? `, ${waiting} item(s) waiting` : ""}`,
      };
    });
  }

  /** Take the hold off without firing: the next Send will include it. */
  async releaseCourse(envelope: Envelope, checkId: string, input: { course: string }): Promise<CommandOutcome> {
    return this.run(envelope, checkId, async (check) => {
      if (check.status === "closed" || check.status === "voided") {
        return { kind: "rejected", reason: `cannot release a course on a ${check.status} check` };
      }
      const course = await this.resolveCourse(check, input.course);
      if (!course) return { kind: "rejected", reason: `unknown course ${input.course}` };
      const held = check.heldCourses ?? [];
      if (held.includes(course)) {
        check.heldCourses = held.filter((c) => c !== course);
        this.logCourse(check, course, "released");
        return { kind: "applied", check: toView(check), note: `${course} released, it fires with the next Send` };
      }
      return { kind: "applied", check: toView(check), note: `${course} was not held` };
    });
  }

  /** Fire one course now: its unsent lines become one kitchen ticket and the
   *  hold comes off, because the guests are ready. */
  async fireCourse(envelope: Envelope, checkId: string, input: { course: string }): Promise<CommandOutcome> {
    return this.run(envelope, checkId, async (check) => {
      if (check.status === "closed" || check.status === "voided") {
        return { kind: "rejected", reason: `cannot fire a course on a ${check.status} check` };
      }
      const course = await this.resolveCourse(check, input.course);
      if (!course) return { kind: "rejected", reason: `unknown course ${input.course}` };
      const targets = check.lines.filter((l) => l.status === "unsent" && l.course === course);
      if (!targets.length) return { kind: "rejected", reason: `nothing unsent in ${course} to fire` };
      const fired = await this.fireLines(check, targets);
      if (!fired.ok) return { kind: "rejected", reason: fired.reason };
      // firing releases the hold, and the ticket's firedAt is the record of it,
      // so this is deliberately not logged as a release too
      check.heldCourses = (check.heldCourses ?? []).filter((c) => c !== course);
      return {
        kind: "applied",
        check: toView(check),
        tickets: fired.tickets,
        note: `${course} fired to kitchen, ${targets.length} item(s)`,
      };
    });
  }

  /**
   * The check's own story (E8-T3), assembled from what is already stored.
   * Nothing here is persisted and no timestamp is invented: a check written
   * before this ticket has fewer entries, which is the honest answer rather
   * than a plausible one. Money is spelled out because this is a sentence a
   * human reads, not a figure anything computes from.
   */
  async checkHistory(id: string) {
    const check = await this.store.get(id);
    if (!check) return undefined;
    const tickets = (await this.store.listTickets()).filter((t) => t.checkId === id);
    const entries: { at: string; kind: string; summary: string }[] = [];
    const add = (at: string | undefined, kind: string, summary: string) => {
      if (at) entries.push({ at, kind, summary });
    };

    add(check.openedAt, "opened",
      `Check #${check.checkNo} opened on ${check.tableName}, ${check.covers} cover(s)`
      + (check.serverName ? ` by ${check.serverName}` : ""));
    for (const l of check.lines) {
      add(l.addedAt, "item_added", `${l.quantity}x ${l.capturedName} added to ${l.course}, seat ${l.seatNo}`);
      if (l.status === "voided") {
        add(l.voidedAt, "voided",
          `${l.quantity}x ${l.capturedName} voided` + (l.voidReason ? `: ${l.voidReason}` : ""));
      }
    }
    for (const e of check.courseEvents ?? []) add(e.at, `course_${e.action}`, `${e.course} ${e.action}`);
    for (const t of tickets) {
      add(t.firedAt, "fired", `${t.course} fired to kitchen, ${t.items.length} item(s)`);
      add(t.servedAt, "served", `${t.course} served`);
    }
    for (const a of check.adjustments) {
      add(a.appliedAt, "adjustment", `${a.label} applied: ${a.reason}`);
    }
    for (const p of check.payments) {
      add(p.takenAt, "payment",
        `${p.label} paid ${usd(p.amountMinor)} by ${p.method}`
        + (p.tipMinor ? ` plus ${usd(p.tipMinor)} tip` : "")
        + (p.status === "accepted_offline" ? ", pending upload" : ""));
    }
    add(check.reopenedAt, "reopened", "Reopened by a manager");
    add(check.closedAt, "closed", "Check closed");

    entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return {
      checkId: check.id,
      checkNo: check.checkNo,
      tableName: check.tableName,
      status: check.status,
      heldCourses: check.heldCourses ?? [],
      entries,
    };
  }


  /* --------------------------- guestbook (E20) ---------------------------
   * The v0 rung of the D20 ladder: a guest record staff attach by hand, and a
   * profile joined out of the ledger. Nothing about a guest is aggregated and
   * stored, so merging or deleting a guest cannot move a cent: the profile is
   * the money, read through check_guest, and the checks never learn about it.
   */

  /** Who is attached to this check, for the header chips. Joined on read; the
   *  link never rides on the check aggregate itself. */
  private async guestChips(checkId: string): Promise<GuestChip[]> {
    const links = await this.store.listCheckGuests(checkId);
    const chips: GuestChip[] = [];
    for (const link of links) {
      const guest = await this.store.getGuest(link.guestId);
      if (guest) chips.push({ id: guest.id, name: guest.displayName });
    }
    return chips;
  }

  /** Quick-create from one field, because the spec's bar is five seconds on a
   *  busy Friday. No PIN: writing a name down is not a privileged act. */
  async createGuest(
    envelope: Envelope,
    input: { displayName: string; phone?: string; email?: string; notes?: string; marketingOptIn?: boolean },
  ): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const displayName = (input.displayName ?? "").trim();
    if (!displayName) {
      return this.remember(envelope, { kind: "rejected", reason: "a guest needs a name" }, "guest", "new");
    }
    const actor = this.actorId(envelope);
    const guest: Guest = {
      id: randomUUID(),
      displayName,
      ...text(input.phone, "phone"),
      ...text(input.email, "email"),
      ...text(input.notes, "notes"),
      // privacy default (spec C6): opt-in is never inferred from a phone
      // number somebody gave to hold a table
      marketingOptIn: input.marketingOptIn === true,
      ...(actor ? { createdBy: actor } : {}),
      createdAt: new Date().toISOString(),
    };
    await this.store.putGuest(guest);
    return this.remember(envelope, { kind: "applied", guest }, "guest", guest.id);
  }

  /** Edit the record. Passing an empty string clears the field, which is how
   *  a guest who asks for their phone to come off gets their wish. */
  async updateGuest(
    envelope: Envelope,
    id: string,
    input: { displayName?: string; phone?: string; email?: string; notes?: string; marketingOptIn?: boolean },
  ): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const guest = await this.store.getGuest(id);
    if (!guest) return { kind: "not_found" };
    if (input.displayName !== undefined) {
      const displayName = input.displayName.trim();
      if (!displayName) {
        return this.remember(envelope, { kind: "rejected", reason: "a guest needs a name" }, "guest", id);
      }
      guest.displayName = displayName;
    }
    for (const field of ["phone", "email", "notes"] as const) {
      const value = input[field];
      if (value === undefined) continue;
      const trimmed = value.trim();
      if (trimmed) guest[field] = trimmed;
      else delete guest[field];
    }
    if (input.marketingOptIn !== undefined) guest.marketingOptIn = input.marketingOptIn === true;
    await this.store.putGuest(guest);
    return this.remember(envelope, { kind: "applied", guest }, "guest", id);
  }

  /**
   * Attach a guest to a check. Allowed on a CLOSED check on purpose: the
   * moment a server has time to type who was at table 7 is after they leave.
   * Attaching the same guest twice is a no-op rather than an error, because a
   * double tap on a handheld is not a mistake worth a red toast.
   */
  async attachGuest(envelope: Envelope, checkId: string, input: { guestId: string }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const check = await this.store.get(checkId);
    if (!check) return { kind: "not_found" }; // not remembered: a retry may find it after sync
    const guest = await this.store.getGuest(input.guestId);
    if (!guest) {
      return this.remember(envelope, { kind: "rejected", reason: "no such guest" }, "check", checkId);
    }
    const links = await this.store.listCheckGuests(checkId);
    if (!links.some((l) => l.guestId === guest.id)) {
      const actor = this.actorId(envelope);
      await this.store.putCheckGuest({
        checkId,
        guestId: guest.id,
        ...(actor ? { attachedBy: actor } : {}),
        attachedAt: new Date().toISOString(),
      });
    }
    const view = toView(check, await this.guestChips(checkId));
    return this.remember(envelope, { kind: "applied", check: view }, "check", checkId);
  }

  /** Wrong guest, wrong table. Detaching removes the link and nothing else. */
  async detachGuest(envelope: Envelope, checkId: string, guestId: string): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const check = await this.store.get(checkId);
    if (!check) return { kind: "not_found" };
    await this.store.removeCheckGuest(checkId, guestId);
    const view = toView(check, await this.guestChips(checkId));
    return this.remember(envelope, { kind: "applied", check: view }, "check", checkId);
  }

  /**
   * Same person, two records: the reservation phone and the name a server
   * typed on a Friday. Manager-gated, because it destroys a record.
   *
   * The absorbed guest's links repoint to the survivor (skipping a check they
   * both already sit on, which would be a duplicate link), the absorbed
   * notes are APPENDED rather than dropped (somebody had a reason to type
   * them), and the record goes. No check, line, or payment is touched: the
   * survivor's history simply spans both sets of links now, which is what
   * "history is a join, not a copy" buys.
   */
  async mergeGuests(envelope: Envelope, survivorId: string, input: { absorbedId: string; managerPin?: string }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const approver = await this.manager(input.managerPin);
    if (!approver) {
      return this.remember(envelope, { kind: "rejected", reason: this.managerRefusal(input.managerPin, "merging guests") }, "guest", survivorId);
    }
    if (!input.absorbedId || input.absorbedId === survivorId) {
      return this.remember(envelope, { kind: "rejected", reason: "a merge needs two different guests" }, "guest", survivorId);
    }
    const [survivor, absorbed] = await Promise.all([this.store.getGuest(survivorId), this.store.getGuest(input.absorbedId)]);
    if (!survivor || !absorbed) return { kind: "not_found" };

    const links = await this.store.listCheckGuests();
    const survivorChecks = new Set(links.filter((l) => l.guestId === survivor.id).map((l) => l.checkId));
    let repointed = 0;
    for (const link of links.filter((l) => l.guestId === absorbed.id)) {
      if (!survivorChecks.has(link.checkId)) {
        await this.store.putCheckGuest({ ...link, guestId: survivor.id });
        survivorChecks.add(link.checkId);
        repointed += 1;
      }
      await this.store.removeCheckGuest(link.checkId, absorbed.id);
    }
    const notes = [survivor.notes, absorbed.notes].map((n) => (n ?? "").trim()).filter((n) => n.length > 0);
    if (notes.length) survivor.notes = notes.join("\n");
    // the surviving record keeps whichever contact details it has, and takes
    // the absorbed record's where it has none
    for (const field of ["phone", "email"] as const) {
      if (!survivor[field] && absorbed[field]) survivor[field] = absorbed[field];
    }
    survivor.marketingOptIn = survivor.marketingOptIn || absorbed.marketingOptIn;
    await this.store.putGuest(survivor);
    await this.store.removeGuestLinks(absorbed.id);
    await this.store.removeGuest(absorbed.id);

    return this.remember(envelope, {
      kind: "applied",
      guest: survivor,
      audit: {
        action: "merge_guests",
        survivor: { id: survivor.id, displayName: survivor.displayName },
        absorbed: { id: absorbed.id, displayName: absorbed.displayName },
        checksRepointed: repointed,
        approvedBy: approver.id,
      },
    }, "guest", survivor.id);
  }

  /**
   * A deletion request (spec C7). Manager-gated. The identity goes and the
   * links go, within the service day; the checks stay exactly as they were
   * and simply stop pointing at a person. Money history must survive a
   * deletion request, identity need not.
   */
  async deleteGuest(envelope: Envelope, id: string, input: { managerPin?: string }): Promise<CommandOutcome> {
    const replay = await this.store.opResult(envelope.operationId);
    if (replay !== undefined) return { kind: "replay", result: replay as CommandOutcome };
    const approver = await this.manager(input.managerPin);
    if (!approver) {
      return this.remember(envelope, { kind: "rejected", reason: this.managerRefusal(input.managerPin, "deleting a guest") }, "guest", id);
    }
    const guest = await this.store.getGuest(id);
    if (!guest) return { kind: "not_found" };
    const dropped = (await this.store.listCheckGuests()).filter((l) => l.guestId === id).length;
    await this.store.removeGuestLinks(id);
    await this.store.removeGuest(id);
    return this.remember(envelope, {
      kind: "applied",
      audit: {
        action: "delete_guest",
        guest: { id, displayName: guest.displayName },
        linksDropped: dropped,
        approvedBy: approver.id,
      },
    }, "guest", id);
  }

  /** The attach flow's search: substring over name and phone, case-blind. An
   *  empty query lists the newest first, because the guest a server wants is
   *  usually the one they just created. */
  async guestSearch(q?: string): Promise<{ guests: Guest[]; total: number; limit: number }> {
    const needle = (q ?? "").trim().toLowerCase();
    const all = await this.store.listGuests();
    const newestFirst = [...all].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const hits = needle
      ? newestFirst.filter((g) =>
          g.displayName.toLowerCase().includes(needle) || (g.phone ?? "").toLowerCase().includes(needle))
      : newestFirst;
    return { guests: hits.slice(0, MAX_GUEST_RESULTS), total: hits.length, limit: MAX_GUEST_RESULTS };
  }

  /**
   * The profile (spec section 4), every figure derived on read and none of it
   * stored. Closed checks only: an open table is not a visit yet and its
   * money is still moving.
   *
   * Spend is the one place this touches money. One guest on a check owns its
   * total. Several guests split it through the domain's own even allocator
   * (v0 has no guest-to-seat mapping, so seats cannot be assigned yet), which
   * is what makes the N shares of one check sum to that check to the cent no
   * matter whose profile is being read. Those visits carry sharedCheck.
   */
  async guestProfile(id: string) {
    const guest = await this.store.getGuest(id);
    if (!guest) return undefined;
    const [links, checks, floor] = await Promise.all([
      this.store.listCheckGuests(),
      this.store.list(),
      this.store.listFloor(),
    ]);
    const areaOf = new Map(floor.map((t) => [t.name, t.area]));
    const mineIds = new Set(links.filter((l) => l.guestId === id).map((l) => l.checkId));
    const mine = checks
      .filter((c) => mineIds.has(c.id) && c.status === "closed")
      .sort((a, b) => (a.openedAt < b.openedAt ? -1 : 1));

    const favorites = new Map<string, { name: string; count: number; lastAt: string }>();
    const sections = new Map<string, { area: string; visits: number; lastAt: string }>();
    const servers = new Map<string, { serverId: string; serverName: string; visits: number; lastAt: string }>();
    const visits: {
      checkId: string; checkNo: number; tableName: string; serviceDate: string; closedAt: string | null;
      shareMinor: number; sharedCheck: boolean; guestsOnCheck: number; serverName: string | null;
    }[] = [];
    const serviceDates = new Set<string>();
    const tipPercents: number[] = [];
    let totalSpendMinor = 0;

    for (const c of mine) {
      const attached = [...links.filter((l) => l.checkId === c.id)].sort((a, b) =>
        a.attachedAt === b.attachedAt ? (a.guestId < b.guestId ? -1 : 1) : (a.attachedAt < b.attachedAt ? -1 : 1));
      const totals = toView(c).totals;
      const sharedCheck = attached.length > 1;
      let shareMinor = totals.totalMinor;
      if (sharedCheck) {
        const portions = splitCheck(toDomainLines(c), toDomainAdjustments(c), TAX_RATE, { kind: "even", ways: attached.length });
        const seat = attached.findIndex((l) => l.guestId === id);
        shareMinor = portions[seat]?.totalMinor ?? 0;
      }
      totalSpendMinor += shareMinor;
      const at = c.closedAt ?? c.openedAt;
      serviceDates.add(serviceDateOf(c.openedAt));

      for (const l of c.lines) {
        if (l.status === "voided") continue; // a voided line was never eaten
        const hit = favorites.get(l.capturedName) ?? { name: l.capturedName, count: 0, lastAt: at };
        hit.count += l.quantity;
        if (at > hit.lastAt) hit.lastAt = at;
        favorites.set(l.capturedName, hit);
      }
      const area = areaOf.get(c.tableName);
      if (area) {
        const hit = sections.get(area) ?? { area, visits: 0, lastAt: at };
        hit.visits += 1;
        if (at > hit.lastAt) hit.lastAt = at;
        sections.set(area, hit);
      }
      if (c.serverId) {
        const hit = servers.get(c.serverId) ?? { serverId: c.serverId, serverName: c.serverName ?? "", visits: 0, lastAt: at };
        hit.visits += 1;
        if (at > hit.lastAt) hit.lastAt = at;
        servers.set(c.serverId, hit);
      }
      const net = totals.subtotalMinor - totals.discountMinor;
      if (net > 0) {
        const tips = c.payments.reduce((a, p) => a + p.tipMinor, 0);
        tipPercents.push((tips / net) * 100);
      }
      visits.push({
        checkId: c.id, checkNo: c.checkNo, tableName: c.tableName,
        serviceDate: serviceDateOf(c.openedAt), closedAt: c.closedAt ?? null,
        shareMinor, sharedCheck, guestsOnCheck: attached.length, serverName: c.serverName ?? null,
      });
    }

    /* mode with a recency tiebreak: two sections at three visits each resolve
       to the one they sat in last, not to whichever hashed first */
    const topBy = <T extends { visits: number; lastAt: string }>(m: Map<string, T>): T | null =>
      [...m.values()].sort((a, b) => b.visits - a.visits || (a.lastAt < b.lastAt ? 1 : -1))[0] ?? null;
    const dates = [...serviceDates].sort();
    const gaps = dates.slice(1).map((d, i) =>
      Math.round((Date.parse(d) - Date.parse(dates[i] as string)) / 86_400_000));

    return {
      guest,
      visitCount: mine.length,
      serviceDates: serviceDates.size,
      medianGapDays: median(gaps),
      lastVisitAt: visits.length ? (visits[visits.length - 1]!.closedAt ?? null) : null,
      totalSpendMinor,
      avgSpendMinor: per(totalSpendMinor, mine.length),
      tipPercentAvg: tipPercents.length
        ? Math.round((tipPercents.reduce((a, p) => a + p, 0) / tipPercents.length) * 10) / 10
        : null,
      favorites: [...favorites.values()]
        .sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1))
        .slice(0, MAX_FAVORITES),
      // lastAt is the tiebreak's business, not the payload's
      preferredSection: mapOrNull(topBy(sections), ({ area, visits }) => ({ area, visits })),
      preferredServer: mapOrNull(topBy(servers), ({ serverId, serverName, visits }) => ({ serverId, serverName, visits })),
      visits: [...visits].reverse(), // newest first, the way a profile reads
    };
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
