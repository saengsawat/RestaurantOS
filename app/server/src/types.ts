/**
 * Shared aggregate shapes and the storage boundary.
 *
 * Store is ASYNC because the real implementation is PostgreSQL (E4).
 * MemoryStore satisfies the same contract for zero-setup dev and tests.
 * The engine never knows which one it has.
 */
import type { CheckStatus, GroupIndex, OrderItemStatus, SelectedModifier } from "@restaurantos/domain";
import type { MenuEntry } from "./menu.js";
import type { DirectoryEntry, Employee, Role, RosterEntry } from "./staff.js";

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
  /** when the line was added, and when it was voided (E8-T3, for the check's
   *  own history). Optional because a line written before E8-T3 never recorded
   *  one, and inventing a timestamp is worse than admitting the gap. */
  addedAt?: string;
  voidedAt?: string;
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
  /** when it was applied (E8-T3 history) */
  appliedAt?: string;
}

export interface PaymentRecord {
  id: string;
  label: string;
  method: "card" | "cash";
  amountMinor: number;
  tipMinor: number;
  status: "authorized" | "accepted_offline";
  takenBy?: string;
  /** when the money came in (E8-T3 history) */
  takenAt?: string;
}

export interface CheckAggregate {
  id: string;
  checkNo: number;
  tableName: string;
  covers: number;
  /** the employee who OPENED the check (E19): the attribution the server
   *  report groups on. Optional because a check written before E19 has no
   *  opener on it; every new check stamps one, falling back to the seeded
   *  default so unsigned demo flows still attribute somewhere real. */
  serverId?: string;
  serverName?: string;
  status: CheckStatus;
  version: number;
  menuSnapshotId: string;
  lines: OrderLine[];
  adjustments: AdjustmentRecord[];
  payments: PaymentRecord[];
  openedAt: string;
  closedAt?: string;
  /** the LAST reopen, if this check was ever reopened (E8-T3 history). The
   *  first close's time is overwritten by the second close, which is the
   *  honest limit of storing one closedAt. */
  reopenedAt?: string;
  /** courses the kitchen must not start yet (E8-T3). Absent means nothing is
   *  held. A hold survives on a course with no lines: it applies to whatever
   *  gets added next, which is how a table that says "hold the secondi" is
   *  meant to work. */
  heldCourses?: string[];
  /** when each hold went on and came off, so the history can tell the story.
   *  The hold STATE is heldCourses; this is only its log. */
  courseEvents?: CourseEvent[];
}

/** One hold going on or coming off a course (E8-T3). A fire is not logged here:
 *  the kitchen ticket's firedAt already records it, and one fact deserves one
 *  home. */
export interface CourseEvent {
  at: string;
  course: string;
  action: "held" | "released";
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

/** One modifier group as the DRAFT carries it (E5-T2). Structurally the
 *  domain's ModifierGroup with a mutable options array, so composing the
 *  published GroupIndex at publish time is a copy and not a translation. */
export interface DraftGroup {
  id: string;
  name: string;
  /** 0 = optional group */
  minSelect: number;
  /** null = unlimited */
  maxSelect: number | null;
  options: {
    id: string;
    name: string;
    priceMinor: number;
    isDefault?: boolean;
    /** choosing this option opens these groups (the nesting modifiers.ts walks) */
    childGroupIds?: string[];
  }[];
}

/** The in-progress menu edit (E5 v0: one draft document per location; per D29
 *  it STAYS a document, and relational draft storage waits until a real menu
 *  import demands it).
 *
 *  `groups` is optional on purpose (E5-T2): a draft written before modifier
 *  groups became editable has no such field, and it must keep behaving as it
 *  did, publishing against the active snapshot's graph rather than losing it.
 *  Per-item assignment is `MenuEntry.modifierGroupIds`, which already existed;
 *  E5-T2 gives it a command and validates it against the draft's own groups. */
export interface MenuDraft {
  basedOnVersion: number;
  items: MenuEntry[];
  groups?: DraftGroup[];
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

/* ---------------------- pay periods (E24-T3) ----------------------
   Calendar arithmetic on plain YYYY-MM-DD strings, in SERVER-LOCAL time,
   the same clock serviceDateOf buckets the business day on. The venue's
   stored timezone still does not drive day bucketing (see updateVenue);
   wiring both to it is one ticket, and doing half of it here would put a
   shift and its own service date on different calendars. */

/** A pay period as two inclusive calendar dates. The period covers
 *  `start` 00:00:00 through `end` 23:59:59.999, local. */
export interface PayPeriod {
  start: string;
  end: string;
}

const DAY_MS = 86_400_000;

/** Local midnight on a YYYY-MM-DD. Built field by field rather than parsed,
 *  because `new Date("2026-02-28")` is UTC midnight and would shift the day
 *  west of Greenwich. */
export function dateAt(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

export function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function addDays(ymdStr: string, days: number): string {
  const d = dateAt(ymdStr);
  d.setDate(d.getDate() + days);
  return ymd(d);
}

/** Whole days from a to b, DST-safe: both ends are snapped to UTC noon so a
 *  23 or 25 hour day still divides into exactly one. */
function daysBetween(a: string, b: string): number {
  const at = dateAt(a), bt = dateAt(b);
  const utc = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12);
  return Math.round((utc(bt) - utc(at)) / DAY_MS);
}

export function isValidYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // round-tripping catches the impossible ones: 2026-02-30 becomes March 2
  return ymd(dateAt(value)) === value;
}

/** The Monday of the week a date falls in (E24-T4).
 *
 *  A schedule week starts on Monday, and that is a constant rather than a
 *  venue setting on the same argument the lunch/dinner split was made one:
 *  nothing in the product needed the concept before the schedule did, and
 *  inventing a knob ahead of an operator asking for it is how a settings
 *  screen fills up with controls nobody turns. Monday because it keeps a
 *  restaurant's two busiest nights in one week instead of splitting the
 *  weekend across two, and because the demo's pay cycles already start on
 *  one. Deck F can move it later like any other answer. */
export function weekStart(date: string): string {
  // getDay() is 0 on Sunday, so Sunday belongs to the week that began six
  // days earlier rather than to the one starting tomorrow
  const back = (dateAt(date).getDay() + 6) % 7;
  return addDays(date, -back);
}

/** The seven service dates of the week beginning on `monday`. */
export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** The period the given date falls inside. */
export function periodContaining(venue: Venue, date: string): PayPeriod {
  if (venue.payPeriod === "semimonthly") {
    const d = dateAt(date);
    if (d.getDate() <= 15) {
      return { start: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), end: ymd(new Date(d.getFullYear(), d.getMonth(), 15)) };
    }
    // day 0 of next month is the last day of this one, which is how February
    // gets 28 or 29 without anybody writing down which
    return { start: ymd(new Date(d.getFullYear(), d.getMonth(), 16)), end: ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
  }
  const length = venue.payPeriod === "weekly" ? 7 : 14;
  const anchor = isValidYmd(venue.payPeriodAnchor) ? venue.payPeriodAnchor : VENUE.payPeriodAnchor;
  // floor, not truncate: a date BEFORE the anchor belongs to a cycle that
  // ran before it, and -3/14 truncating to 0 would put it in the wrong one
  const index = Math.floor(daysBetween(anchor, date) / length);
  const start = addDays(anchor, index * length);
  return { start, end: addDays(start, length - 1) };
}

/** The period before this one. */
export function periodBefore(venue: Venue, period: PayPeriod): PayPeriod {
  return periodContaining(venue, addDays(period.start, -1));
}

/** The latest period that has finished. Today's period is still being worked,
 *  so exporting it would hand a provider a half-written paycheck. */
export function lastCompletedPeriod(venue: Venue, today: string): PayPeriod {
  return periodBefore(venue, periodContaining(venue, today));
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

/** The shapes a room can be drawn with (E6-T2). "booth" was in the
 *  dining_table CHECK constraint from day one; the API never offered it. */
export const TABLE_SHAPES = ["rect", "round", "stool", "booth"] as const;
export type TableShape = (typeof TABLE_SHAPES)[number];

/** Table names are compared case-insensitively everywhere (E6-T2): "table 9"
 *  and "Table 9" are the same table to a server calling it out, so they must
 *  be the same table to the floor. Matches PG's lower(name) unique index. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** A positioned table on the floor plan (E6). Percent coordinates. */
export interface FloorTable {
  name: string;
  area: string;
  seats: number;
  shape: TableShape;
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

  /** active tables only: a retired table is history, not room (E6-T2) */
  listFloor(): Promise<FloorTable[]>;
  moveTable(name: string, pos: { x: number; y: number; w: number; h: number }): Promise<void>;
  /** Add a table, creating its area if the room has never had one. A name
   *  that matches a RETIRED table (case-insensitively) REVIVES that row
   *  rather than making a second identity, so party history stays whole. */
  addTable(table: FloorTable): Promise<void>;
  updateTable(name: string, patch: { name?: string; seats?: number; shape?: TableShape }): Promise<void>;
  /** Soft removal: the row stays so party.table_id and closed checks keep
   *  pointing at something real. `at` is the retirement instant. */
  retireTable(name: string, at: string): Promise<void>;

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

  /** PIN verification (E15): stores compare HASHES, never plaintext, and a
   *  deactivated employee matches nothing (E21-T1). */
  findEmployeeByPin(pin: string): Promise<Employee | undefined>;

  /** The venue's own identity (E21-T1). Data, not source code, so a second
   *  restaurant can exist. */
  getVenue(): Promise<Venue>;
  putVenue(venue: Venue): Promise<void>;

  /** The roster (E21-T1). Never carries a PIN or a hash: hashing happens in
   *  the engine, and what comes back out is who works here, nothing more.
   *  Since E24-T2 it also never carries the personal half: these two return
   *  the PUBLIC shape (name, role, title, active), and a phone number can
   *  only ever leave through listDirectory below. */
  listEmployees(): Promise<RosterEntry[]>;
  getEmployee(id: string): Promise<RosterEntry | undefined>;
  addEmployee(employee: DirectoryEntry, pinHash: string): Promise<void>;
  setEmployeePin(id: string, pinHash: string): Promise<void>;
  /** Deactivation is soft, always: checks.server_id still points here. */
  setEmployeeActive(id: string, active: boolean): Promise<void>;
  /** Promotion and demotion (E25-T1). Its own method rather than a field on
   *  updateEmployee: this is the one write that changes what a PIN may
   *  approve, and the engine puts an owner gate in front of it. In PG it is a
   *  REPLACEMENT of the employee_role rows, never an addition, so nobody ends
   *  up holding two permission levels at once. */
  setEmployeeRole(id: string, role: Role): Promise<void>;

  /** The whole record, personal half included (E24-T2). The ONLY way the
   *  contact fields leave a store, and the engine gates every call to it on a
   *  manager's PIN. Same order as listEmployees, so the two reads line up. */
  listDirectory(): Promise<DirectoryEntry[]>;
  /** Edit the record. An absent key keeps its value; an empty string clears
   *  the field, the way the venue's address clears. Never touches role,
   *  active, or the PIN, each of which has its own command. */
  updateEmployee(id: string, patch: Partial<Omit<DirectoryEntry, "id" | "role" | "active">>): Promise<void>;

  listShifts(): Promise<Shift[]>;
  putShift(shift: Shift): Promise<void>;

  /** The schedule (E24-T4). Plain rows: which week a shift belongs to, and
   *  how planned hours compare with worked ones, are both computed at read
   *  and stored nowhere. Removal here is a real delete, unlike an employee or
   *  a table, because a shift that was never worked has no history to keep. */
  listPlannedShifts(): Promise<PlannedShift[]>;
  getPlannedShift(id: string): Promise<PlannedShift | undefined>;
  putPlannedShift(shift: PlannedShift): Promise<void>;
  removePlannedShift(id: string): Promise<void>;

  /** guests and their check links (E20). Deleting a guest purges identity and
   *  drops the links; it never touches a check. */
  listGuests(): Promise<Guest[]>;
  getGuest(id: string): Promise<Guest | undefined>;
  putGuest(guest: Guest): Promise<void>;
  removeGuest(id: string): Promise<void>;
  /** every link, or just one check's when checkId is given */
  listCheckGuests(checkId?: string): Promise<CheckGuestLink[]>;
  putCheckGuest(link: CheckGuestLink): Promise<void>;
  removeCheckGuest(checkId: string, guestId: string): Promise<void>;
  removeGuestLinks(guestId: string): Promise<void>;

  /** The call-in book (E23-T2). Reservations are ordinary rows; everything
   *  the floor and the book SHOW about them is derived at read. */
  listReservations(): Promise<Reservation[]>;
  getReservation(id: string): Promise<Reservation | undefined>;
  putReservation(reservation: Reservation): Promise<void>;

  /** Every table name the room has EVER had, retired ones included (E23-T2).
   *  A booking taken in March for a table retired in April still has to
   *  resolve, so validating a reservation's table cannot use the active
   *  floor the way seating does. */
  listAllTableNames(): Promise<string[]>;
}

/** A promise, not a lock (D27). The floor shows it as the hour approaches and
 *  the host overrides it whenever the room says otherwise; nothing in here
 *  ever refuses a seating. */
export const RESERVATION_STATUSES = ["booked", "seated", "no_show", "cancelled"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** One entry in the call-in book (E23-T2, reservations-spec §4).
 *
 *  `name` and `phone` live here rather than only on a guest record, and the
 *  redundancy is deliberate: a booking taken over the phone is a fact about a
 *  call, and it has to be writable in four seconds without creating a person
 *  first. `guestId` fills in when a phone matches and a human confirms it. */
export interface Reservation {
  id: string;
  name: string;
  phone?: string;
  partySize: number;
  /** UTC ISO, like every other timestamp in the system */
  reservedFor: string;
  /** the table promised, if one was. Resolves against retired tables too, so
   *  a floor edit between the call and the night does not strand the booking. */
  tableName?: string;
  status: ReservationStatus;
  note?: string;
  /** set when a phone match was confirmed at seating, or attached by hand */
  guestId?: string;
  createdBy?: string;
  createdAt: string;
}

/** A guest the house remembers (E20, spec section 2). Identity only: no money,
 *  no counts, no aggregates. Everything a profile shows is a join over the
 *  ledger, so a guest record can never drift from the money. */
export interface Guest {
  id: string;
  displayName: string;
  phone?: string;
  email?: string;
  /** staff-authored free text, the only stored thing on the profile */
  notes?: string;
  /** privacy default per spec C6: opt-in is never assumed */
  marketingOptIn: boolean;
  createdBy?: string;
  createdAt: string;
}

/** One guest attached to one check (E20). A check carries zero or more guests,
 *  a guest has many checks, and the link is the whole of the write surface. */
export interface CheckGuestLink {
  checkId: string;
  guestId: string;
  attachedBy?: string;
  attachedAt: string;
}

/** One shift somebody was MEANT to work (E24-T4, team-labor-spec §3).
 *
 *  The other half of the clock. `Shift` below is what actually happened, and
 *  until now that was the only half the system held, which is why it could
 *  answer "who is here" and not "who was meant to be". Nothing in here costs
 *  anything: there is no wage rate on this row, on the employee, or anywhere
 *  else, because hours planned against hours worked is a complete and honest
 *  answer in hours, and turning it into dollars is the step that would make
 *  it payroll (spec §4, D28 rung 3). */
export interface PlannedShift {
  id: string;
  employeeId: string;
  /** What they are working AS that night: neither their job title nor their
   *  permission role, because a sous chef runs the pass on Tuesday and
   *  expedites on Saturday, and a server picks up a bar shift. Free text, and
   *  nothing in the engine ever branches on it. */
  roleForShift: string;
  /** UTC ISO, like every other timestamp here */
  startsAt: string;
  endsAt: string;
  /** The draft gate, the menu's own discipline: a manager builds next week in
   *  private, and staff see nothing until it is published once. */
  published: boolean;
  createdBy?: string;
  createdAt: string;
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

/** Who the restaurant is (E21-T1). Three fields, all editable, because
 *  "Osteria Nove" being a string literal in the source is exactly what stops
 *  a second restaurant from existing. */
/** How often the venue pays (E24-T3). Three kinds because those are the three
 *  US restaurants actually run; the provider that turns hours into money knows
 *  about the rest. */
export const PAY_PERIODS = ["weekly", "biweekly", "semimonthly"] as const;
export type PayPeriodKind = (typeof PAY_PERIODS)[number];

export interface Venue {
  name: string;
  address: string;
  timezone: string;
  /** default biweekly, the most common of the three (team-labor-spec §4) */
  payPeriod: PayPeriodKind;
  /** YYYY-MM-DD, the day a weekly or biweekly cycle starts counting from.
   *  Semimonthly ignores it: the 1st and the 16th are the anchor. */
  payPeriodAnchor: string;
  /** How long before a booking the floor starts showing it (E23-T2, spec
   *  §2). Earlier than this the badge is noise on a table that is busy
   *  serving somebody else. Default 45. */
  reservationLeadMinutes: number;
  /** How long a table is held past the booked time before the book nudges
   *  the host (E23-T2, deck E-2 default). A SOFT prompt: nothing is released
   *  automatically, because the host decides who sits where. Default 15. */
  reservationHoldMinutes: number;
}

/** The demo venue, seeded into whichever store is active. It stays the seed
 *  (an empty POS demos badly); it is no longer the only venue possible. The
 *  address is the one the receipt has always printed. */
export const VENUE: Venue = {
  name: "Osteria Nove",
  address: "9 Vicolo della Luna, New York",
  timezone: "America/New_York",
  payPeriod: "biweekly",
  // a Monday, so the demo's cycles start where a restaurant week does
  payPeriodAnchor: "2026-01-05",
  reservationLeadMinutes: 45,
  reservationHoldMinutes: 15,
};

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
