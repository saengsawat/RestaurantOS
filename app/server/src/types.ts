/**
 * Shared aggregate shapes and the storage boundary.
 *
 * Store is ASYNC because the real implementation is PostgreSQL (E4).
 * MemoryStore satisfies the same contract for zero-setup dev and tests.
 * The engine never knows which one it has.
 */
import type { CheckStatus, OrderItemStatus, SelectedModifier } from "@restaurantos/domain";

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

/** One fired course on the kitchen rail (E8). */
export interface TicketItem {
  orderItemId: string;
  name: string;
  quantity: number;
  station: string;
  mods: string;
  allergy: boolean;
  done: boolean;
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
