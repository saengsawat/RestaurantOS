/** Zero-setup Store for dev and tests. State dies with the process. */
import { GROUPS, MENU, SNAPSHOT_ID } from "./menu.js";
import { pinHash, staffByPinHash, type Employee } from "./staff.js";
import {
  FLOOR,
  sameName,
  type Availability,
  type CheckAggregate,
  type DrawerSession,
  type FloorTable,
  type KitchenTicket,
  type MenuDraft,
  type CheckGuestLink,
  type Guest,
  type MenuSnapshot,
  type OpMeta,
  type Shift,
  type Store,
  type TableShape,
} from "./types.js";

export class MemoryStore implements Store {
  private checks = new Map<string, CheckAggregate>();
  private tickets = new Map<string, KitchenTicket>();
  private ops = new Map<string, unknown>();
  private checkNo = 2041;
  // per-instance copy so a layout edit never leaks into another store.
  // retiredAt mirrors dining_table.retired_at: a retired table keeps its
  // place in the array so a re-add revives the same identity (E6-T2).
  private floor: (FloorTable & { retiredAt?: string })[] = FLOOR.map((t) => ({ ...t }));
  // first-seen area order, the memory twin of dining_area.sort
  private areas: string[] = [...new Set(FLOOR.map((t) => t.area)), "Altro"];

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

  /** Active tables, grouped by area in first-seen order (the memory twin of
   *  PG's dining_area.sort). Within an area the order is insertion order, so
   *  the seeded room comes back exactly as FLOOR spells it. */
  async listFloor(): Promise<FloorTable[]> {
    const rank = (a: string) => {
      const i = this.areas.indexOf(a);
      return i === -1 ? this.areas.length : i;
    };
    return this.floor
      .filter((t) => !t.retiredAt)
      .map(({ retiredAt: _retiredAt, ...t }) => ({ ...t }))
      .sort((a, b) => rank(a.area) - rank(b.area));
  }

  async moveTable(name: string, pos: { x: number; y: number; w: number; h: number }): Promise<void> {
    const t = this.floor.find((x) => x.name === name && !x.retiredAt);
    if (t) Object.assign(t, pos);
  }

  async addTable(table: FloorTable): Promise<void> {
    if (!this.areas.includes(table.area)) this.areas.push(table.area);
    // a retired row with this name IS this table: revive it rather than
    // starting a second identity the old parties do not point at
    const revived = this.floor.find((t) => t.retiredAt && sameName(t.name, table.name));
    if (revived) {
      Object.assign(revived, table);
      delete revived.retiredAt;
      return;
    }
    this.floor.push({ ...table });
  }

  async updateTable(name: string, patch: { name?: string; seats?: number; shape?: TableShape }): Promise<void> {
    const t = this.floor.find((x) => x.name === name && !x.retiredAt);
    if (!t) return;
    if (patch.name !== undefined) t.name = patch.name;
    if (patch.seats !== undefined) t.seats = patch.seats;
    if (patch.shape !== undefined) t.shape = patch.shape;
  }

  async retireTable(name: string, at: string): Promise<void> {
    const t = this.floor.find((x) => x.name === name && !x.retiredAt);
    if (t) t.retiredAt = at;
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

  /* guests (E20). Keyed by id; links keyed by "checkId:guestId" so attaching
     twice is the same row, which is what makes attach idempotent. */
  private guests = new Map<string, Guest>();
  private guestLinks = new Map<string, CheckGuestLink>();

  async listGuests() { return [...this.guests.values()]; }
  async getGuest(id: string) { return this.guests.get(id); }
  async putGuest(guest: Guest) { this.guests.set(guest.id, guest); }
  async removeGuest(id: string) { this.guests.delete(id); }

  async listCheckGuests(checkId?: string) {
    const all = [...this.guestLinks.values()];
    return checkId === undefined ? all : all.filter((l) => l.checkId === checkId);
  }
  async putCheckGuest(link: CheckGuestLink) { this.guestLinks.set(link.checkId + ":" + link.guestId, link); }
  async removeCheckGuest(checkId: string, guestId: string) { this.guestLinks.delete(checkId + ":" + guestId); }
  async removeGuestLinks(guestId: string) {
    for (const [key, link] of this.guestLinks) if (link.guestId === guestId) this.guestLinks.delete(key);
  }
}
