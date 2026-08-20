/** Zero-setup Store for dev and tests. State dies with the process. */
import { GROUPS, MENU, SNAPSHOT_ID } from "./menu.js";
import { pinHash, staffByPinHash, type Employee } from "./staff.js";
import {
  FLOOR,
  type Availability,
  type CheckAggregate,
  type DrawerSession,
  type FloorTable,
  type KitchenTicket,
  type MenuDraft,
  type MenuSnapshot,
  type OpMeta,
  type Shift,
  type Store,
} from "./types.js";

export class MemoryStore implements Store {
  private checks = new Map<string, CheckAggregate>();
  private tickets = new Map<string, KitchenTicket>();
  private ops = new Map<string, unknown>();
  private checkNo = 2041;
  // per-instance copy so a layout edit never leaks into another store
  private floor: FloorTable[] = FLOOR.map((t) => ({ ...t }));

  async init(): Promise<void> {}
  async get(id: string) { return this.checks.get(id); }
  async list() { return [...this.checks.values()]; }
  async put(check: CheckAggregate) { this.checks.set(check.id, check); }
  async nextCheckNo() { return this.checkNo++; }

  async opResult(operationId: string) { return this.ops.get(operationId); }
  async rememberOp(operationId: string, result: unknown, _meta: OpMeta) { this.ops.set(operationId, result); }

  async listTickets() { return [...this.tickets.values()]; }
  async getTicket(id: string) { return this.tickets.get(id); }
  async putTicket(ticket: KitchenTicket) { this.tickets.set(ticket.id, ticket); }

  async listFloor(): Promise<FloorTable[]> { return this.floor.map((t) => ({ ...t })); }

  async moveTable(name: string, pos: { x: number; y: number; w: number; h: number }): Promise<void> {
    const t = this.floor.find((x) => x.name === name);
    if (t) Object.assign(t, pos);
  }

  private sessions = new Map<string, DrawerSession>();
  private dayStatuses = new Map<string, "open" | "closed">();

  async listDrawerSessions() { return [...this.sessions.values()]; }
  async getDrawerSession(id: string) { return this.sessions.get(id); }
  async putDrawerSession(session: DrawerSession) { this.sessions.set(session.id, session); }

  async dayStatus(serviceDate: string) { return this.dayStatuses.get(serviceDate) ?? "open"; }
  async setDayStatus(serviceDate: string, status: "open" | "closed") { this.dayStatuses.set(serviceDate, status); }

  private snapshots: MenuSnapshot[] = [
    { id: SNAPSHOT_ID, version: 1, items: MENU.map((m) => ({ ...m })), groups: GROUPS, publishedAt: new Date().toISOString() },
  ];
  private draft: MenuDraft | undefined;
  private availability = new Map<string, Availability>();

  async getActiveSnapshot() { return this.snapshots[this.snapshots.length - 1]!; }
  async putSnapshot(snapshot: MenuSnapshot) { this.snapshots.push(snapshot); }
  async getDraft() { return this.draft; }
  async putDraft(draft: MenuDraft) { this.draft = draft; }
  async clearDraft() { this.draft = undefined; }
  async listAvailability() { return [...this.availability.values()]; }
  async setAvailability(availability: Availability) { this.availability.set(availability.itemId, availability); }

  async findEmployeeByPin(pin: string): Promise<Employee | undefined> {
    const hit = staffByPinHash(pinHash(pin));
    return hit ? { id: hit.id, name: hit.name, role: hit.role } : undefined;
  }

  private shifts = new Map<string, Shift>();
  async listShifts() { return [...this.shifts.values()]; }
  async putShift(shift: Shift) { this.shifts.set(shift.id, shift); }
}
