/**
 * Shared aggregate shapes and the storage boundary.
 *
 * Store is ASYNC because the real implementation is PostgreSQL (E4).
 * MemoryStore satisfies the same contract for zero-setup dev and tests.
 * The engine never knows which one it has.
 */
import type { CheckStatus, GroupIndex, OrderItemStatus, SelectedModifier } from "@restaurantos/domain";
import type { MenuEntry } from "./menu.js";
import type { Employee } from "./staff.js";

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
  voidReason?: string;
  voidedBy?: string;
  voidApprovedBy?: string;
  /** the snapshot this line was priced on (may be newer than the check's) */
  menuSnapshotId?: string;
}

/** A discount or comp on the check (E12). Exactly one of amount/percent,
 *  mirroring check_adjustment's amount_xor_percent constraint. */
export interface AdjustmentRecord {
  id: string;
  kind: "discount" | "comp";
  label: string;
  amountMinor?: number;
  percentBp?: number;
  reason: string;
  appliedBy?: string;
  approvedBy?: string;
}

export interface PaymentRecord {
  id: string;
  label: string;
  method: "card" | "cash";
  amountMinor: number;
  tipMinor: number;
  status: "authorized" | "accepted_offline";
  takenBy?: string;
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
  adjustments: AdjustmentRecord[];
  payments: PaymentRecord[];
  openedAt: string;
  closedAt?: string;
}

/** One fired course on the kitchen rail (E8). */
export interface TicketItem {
  orderItemId: string;
  name: string;
  quantity: number;
  station: string;
  mods: string;
  allergy: boolean;
  done: boolean;
  /** the order item was voided after firing; the cook stops, expo ignores it */
  voided?: boolean;
}

export interface KitchenTicket {
  id: string;
  checkId: string;
  tableName: string;
  course: string;
  firedAt: string;
  status: "open" | "served";
  servedAt?: string;
  items: TicketItem[];
}

/** An immutable published menu (E5). Editing tomorrow's menu never rewrites
 *  yesterday's check: order lines reference the snapshot they were priced on. */
export interface MenuSnapshot {
  id: string; // 'snap-0001', 'snap-0002', ...
  version: number;
  items: MenuEntry[];
  groups: GroupIndex;
  publishedAt: string;
}

/** The in-progress menu edit (E5 v0: one draft document per location; the
 *  relational editor tables in schema §4 replace this in E5-full). */
export interface MenuDraft {
  basedOnVersion: number;
  items: MenuEntry[];
}

/** Live 86 board (E5): hot state, deliberately OUTSIDE the snapshot, because
 *  running out of branzino mid-service must not require a menu publish. */
export interface Availability {
  itemId: string;
  is86: boolean;
  remaining?: number;
}

/** The business-day date (YYYY-MM-DD) an instant belongs to, in SERVER-LOCAL
 *  time: an 11 PM check must not land on tomorrow's day just because UTC
 *  rolled over. v0 simplification: rollover at local midnight; the real
 *  rollover hour (a 1 AM check belongs to yesterday) is pilot config. */
export function serviceDateOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** One signed movement of physical cash (E14). Append-only: a mistake is
 *  corrected by a compensating event, never an edit. */
export interface CashEvent {
  id: string;
  kind: "sale" | "pay_in" | "pay_out" | "drop";
  amountMinor: number; // signed: pay_out and drop are negative
  paymentId?: string;
  reason?: string;
  at: string;
}

/** A physical till from open count to close count (E14).
 *  expected/overShort are computed and FROZEN at close, never recomputed. */
export interface DrawerSession {
  id: string;
  drawerName: string;
  openedAt: string;
  openingFloatMinor: number;
  events: CashEvent[];
  closedAt?: string;
  countedMinor?: number;
  expectedMinor?: number;
  overShortMinor?: number;
  openedBy?: string;
  closedBy?: string;
}

/** A positioned table on the floor plan (E6). Percent coordinates. */
export interface FloorTable {
  name: string;
  area: string;
  seats: number;
  shape: "rect" | "round" | "stool";
  x: number;
  y: number;
  w: number;
  h: number;
}

export type OpStatus = "applied" | "conflict" | "rejected";

export interface OpMeta {
  status: OpStatus;
  aggregateType: string;
  aggregateId: string;
  deviceId: string;
  /** the signed-in employee on the device, when there is one (E15) */
  employeeId?: string;
}

export interface Store {
  init(): Promise<void>;
  get(id: string): Promise<CheckAggregate | undefined>;
  list(): Promise<CheckAggregate[]>;
  put(check: CheckAggregate): Promise<void>;
  nextCheckNo(): Promise<number>;

  opResult(operationId: string): Promise<unknown | undefined>;
  rememberOp(operationId: string, result: unknown, meta: OpMeta): Promise<void>;

  listTickets(): Promise<KitchenTicket[]>;
  getTicket(id: string): Promise<KitchenTicket | undefined>;
  putTicket(ticket: KitchenTicket): Promise<void>;

  listFloor(): Promise<FloorTable[]>;
  moveTable(name: string, pos: { x: number; y: number; w: number; h: number }): Promise<void>;

  listDrawerSessions(): Promise<DrawerSession[]>;
  getDrawerSession(id: string): Promise<DrawerSession | undefined>;
  putDrawerSession(session: DrawerSession): Promise<void>;

  /** business_day status for a service date (YYYY-MM-DD); "open" if no row yet */
  dayStatus(serviceDate: string): Promise<"open" | "closed">;
  setDayStatus(serviceDate: string, status: "open" | "closed"): Promise<void>;

  /** the active menu is always the highest published version */
  getActiveSnapshot(): Promise<MenuSnapshot>;
  putSnapshot(snapshot: MenuSnapshot): Promise<void>;
  getDraft(): Promise<MenuDraft | undefined>;
  putDraft(draft: MenuDraft): Promise<void>;
  clearDraft(): Promise<void>;
  listAvailability(): Promise<Availability[]>;
  setAvailability(availability: Availability): Promise<void>;

  /** PIN verification (E15): stores compare HASHES, never plaintext */
  findEmployeeByPin(pin: string): Promise<Employee | undefined>;

  listShifts(): Promise<Shift[]>;
  putShift(shift: Shift): Promise<void>;
}

/** One employee working one stretch (E14/E15). Sign-in auto-clocks-in;
 *  clock-out is explicit because that is where tips get declared. */
export interface Shift {
  id: string;
  employeeId: string;
  employeeName: string;
  clockIn: string;
  clockOut?: string;
  declaredTipsMinor?: number;
}

/** Osteria Nove's room, seeded into whichever store is active. */
export const FLOOR: readonly FloorTable[] = [
  { name: "Table 2", area: "Sala", seats: 2, shape: "round", x: 5, y: 8, w: 12, h: 22 },
  { name: "Table 3", area: "Sala", seats: 4, shape: "rect", x: 22, y: 8, w: 16, h: 26 },
  { name: "Table 5", area: "Sala", seats: 4, shape: "rect", x: 44, y: 8, w: 16, h: 26 },
  { name: "Table 7", area: "Sala", seats: 6, shape: "rect", x: 66, y: 8, w: 28, h: 30 },
  { name: "Table 9", area: "Sala", seats: 2, shape: "round", x: 5, y: 42, w: 12, h: 22 },
  { name: "Table 12", area: "Sala", seats: 4, shape: "rect", x: 22, y: 44, w: 16, h: 26 },
  { name: "Table 14", area: "Sala", seats: 4, shape: "rect", x: 44, y: 44, w: 16, h: 26 },
  { name: "Terrazza 21", area: "Terrazza", seats: 4, shape: "rect", x: 8, y: 12, w: 20, h: 34 },
  { name: "Terrazza 22", area: "Terrazza", seats: 2, shape: "round", x: 42, y: 14, w: 13, h: 28 },
  { name: "Terrazza 23", area: "Terrazza", seats: 6, shape: "rect", x: 66, y: 10, w: 28, h: 40 },
  { name: "Bar 1", area: "Bar", seats: 1, shape: "stool", x: 12, y: 44, w: 9, h: 20 },
  { name: "Bar 2", area: "Bar", seats: 1, shape: "stool", x: 30, y: 44, w: 9, h: 20 },
  { name: "Bar 3", area: "Bar", seats: 1, shape: "stool", x: 48, y: 44, w: 9, h: 20 },
];
