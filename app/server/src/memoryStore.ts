/** Zero-setup Store for dev and tests. State dies with the process. */
import { GROUPS, MENU, SNAPSHOT_ID } from "./menu.js";
import { pinHash, STAFF, type DirectoryEntry, type Employee, type Role, type RosterEntry } from "./staff.js";
import {
  FLOOR,
  sameName,
  VENUE,
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
  type PlannedShift,
  type Reservation,
  type Shift,
  type Store,
  type TableShape,
  type Venue,
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

  /* ------------------- venue and roster (E21-T1) -------------------
     The demo values are the SEED, not the definition: everything here is
     ordinary mutable state, which is the whole point of the ticket. */

  private venue: Venue = { ...VENUE };
  // pinHash rides alongside the roster entry and never leaves this class
  private employees: (DirectoryEntry & { pinHash: string })[] = STAFF.map((s) => ({
    id: s.id, name: s.name, role: s.role, active: true, pinHash: pinHash(s.demoPin),
    // the chef's title says Chef while his permission level says kitchen,
    // which is D28's two-field rule standing up in the seed itself
    ...(s.title !== undefined ? { title: s.title } : {}),
  }));

  async getVenue() { return { ...this.venue }; }
  async putVenue(venue: Venue) { this.venue = { ...venue }; }

  /** The PUBLIC projection, and the only shape listEmployees ever returns.
   *  Written as an explicit field list rather than a delete-these-keys so a
   *  field added to the record later is private by default: forgetting to add
   *  it here hides it, which is the failure direction we want (E24-T2). */
  private static roster(e: DirectoryEntry & { pinHash: string }): RosterEntry {
    return {
      id: e.id, name: e.name, role: e.role, active: e.active,
      ...(e.title !== undefined ? { title: e.title } : {}),
    };
  }

  private static directory(e: DirectoryEntry & { pinHash: string }): DirectoryEntry {
    const { pinHash: _hash, ...rest } = e;
    return { ...rest };
  }

  async listEmployees(): Promise<RosterEntry[]> { return this.employees.map(MemoryStore.roster); }
  async getEmployee(id: string) {
    const e = this.employees.find((x) => x.id === id);
    return e ? MemoryStore.roster(e) : undefined;
  }
  async listDirectory(): Promise<DirectoryEntry[]> { return this.employees.map(MemoryStore.directory); }
  async updateEmployee(id: string, patch: Partial<Omit<DirectoryEntry, "id" | "role" | "active">>) {
    const e = this.employees.find((x) => x.id === id);
    if (!e) return;
    // an absent key keeps its value; a key present but undefined CLEARS, which
    // is how the engine passes on a field the manager emptied
    for (const key of ["title", "phone", "email", "emergencyContact", "notes"] as const) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (value === undefined) delete e[key];
      else e[key] = value;
    }
    // name is the one field with no cleared state: the engine refuses a blank
    // one, because every check they ever opened prints it
    if (patch.name !== undefined) e.name = patch.name;
  }
  async addEmployee(employee: DirectoryEntry, hash: string) { this.employees.push({ ...employee, pinHash: hash }); }
  async setEmployeePin(id: string, hash: string) {
    const e = this.employees.find((x) => x.id === id);
    if (e) e.pinHash = hash;
  }
  async setEmployeeActive(id: string, active: boolean) {
    const e = this.employees.find((x) => x.id === id);
    if (e) e.active = active;
  }
  /** A REPLACEMENT, matching PG's delete-then-insert on employee_role: one
   *  person, one permission level, never two at once (E25-T1). */
  async setEmployeeRole(id: string, role: Role) {
    const e = this.employees.find((x) => x.id === id);
    if (e) e.role = role;
  }

  /** A deactivated employee's PIN opens nothing: not a session, not an
   *  approval. Their history is untouched, which is the difference between
   *  letting somebody go and erasing them. */
  async findEmployeeByPin(pin: string): Promise<Employee | undefined> {
    const hash = pinHash(pin);
    const hit = this.employees.find((e) => e.active && e.pinHash === hash);
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

  /* the call-in book (E23-T2). Ordinary rows: the badge on the floor and the
     past-due flag in the book are both computed at read, never stored here,
     because a stored status is a status that can drift from the book. */
  private reservations = new Map<string, Reservation>();
  async listReservations() { return [...this.reservations.values()]; }
  async getReservation(id: string) { return this.reservations.get(id); }
  async putReservation(reservation: Reservation) { this.reservations.set(reservation.id, { ...reservation }); }

  /** retired tables included, which is the whole point of the method: the
   *  floor array keeps a retired row so history stays whole (E6-T2) */
  async listAllTableNames() { return this.floor.map((t) => t.name); }

  /* the schedule (E24-T4). What was MEANT to happen, beside the shifts above
     that record what did. Which week a row belongs to and how it compares
     with the clock are both computed at read; nothing here stores either. */
  private plannedShifts = new Map<string, PlannedShift>();
  async listPlannedShifts() { return [...this.plannedShifts.values()]; }
  async getPlannedShift(id: string) { return this.plannedShifts.get(id); }
  async putPlannedShift(shift: PlannedShift) { this.plannedShifts.set(shift.id, { ...shift }); }
  /** A real delete: a shift nobody worked has no history worth keeping, which
   *  is what makes it different from an employee or a table. */
  async removePlannedShift(id: string) { this.plannedShifts.delete(id); }
}
