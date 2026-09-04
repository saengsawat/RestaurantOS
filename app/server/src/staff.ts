/**
 * Staff identity (epic E15), now SEED ONLY (E21-T1), and since E25-T1 the
 * home of the permission ladder and the visibility matrix.
 *
 * STAFF was the roster: sign-in read it, approvals read it, and hiring
 * somebody meant editing this file. It is now what it should always have
 * been, the people the demo opens with. Both stores seed it once and then
 * own their own roster, so a real restaurant can hire, reset a PIN, and
 * let somebody go without a deploy.
 *
 * The contract was already final and has not moved: PINs are stored hashed,
 * roles gate approvals, and every privileged command records WHO approved it.
 *
 * The demo PINs are printed in the UI on purpose: this is a concept demo
 * of the approval FLOW, not of PIN secrecy. They are served from the seed
 * constant below (/v1/staff/demo-pins), never from the roster read, so a
 * PIN a real manager sets can never be shown by the same code path.
 */
import { createHash } from "node:crypto";

/**
 * The permission level, and the whole of it (D33).
 *
 * Four values, two shapes. `owner` and `manager` are a LADDER: an owner
 * passes every check a manager passes, because a padrona locked out of her
 * own void approvals is a bug, not a policy. `kitchen` and `server` are
 * LATERAL: neither passes the other's checks, because a line cook has no
 * business closing a check and a server has no business bumping a ticket.
 *
 * This is the permission level and nothing else. JOB TITLE is a separate
 * field on the same person (D28, E24-T2): "Chef" and "Bartender" are titles
 * on a kitchen-level person, and nothing in the engine ever branches on a
 * title. Growing this enum is the only way to grow what a PIN can do.
 */
export type Role = "owner" | "manager" | "kitchen" | "server";

export const ROLES: readonly Role[] = ["owner", "manager", "kitchen", "server"];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** The ladder, and only the ladder. `owner` is 2 and `manager` is 1 because
 *  one outranks the other; `kitchen` and `server` share 0 because neither
 *  outranks anything, including each other. Never compare two rank-0 roles
 *  with this and conclude anything: use the matrix below. */
const RANK: Record<Role, number> = { owner: 2, manager: 1, kitchen: 0, server: 0 };

/** Does this role pass a check written for `floor`? Only meaningful for the
 *  ranked half: atLeast(anything, "manager") answers the manager gates that
 *  have existed since E12, and an owner now passes every one of them. */
export function atLeast(role: Role, floor: "owner" | "manager"): boolean {
  return RANK[role] >= RANK[floor];
}

/* ---------------------------- the matrix (D33) ----------------------------
   ONE map, in one place, for the whole product. The server enforces it and
   GET /v1/session serves it, so a page renders the nav it is told to render
   and never invents a rule of its own. Nav hiding is courtesy; the route
   refusal underneath it is what actually stops anybody. */

/** The nine screens, by the name of the route family that serves each one. */
export const SCREENS = [
  "service", "tables", "kitchen", "reservations",
  "schedule", "reports", "menu", "cash", "settings",
] as const;
export type Screen = (typeof SCREENS)[number];

/** What each screen is called out loud, for the sentence a refusal prints. */
export const SCREEN_LABEL: Record<Screen, string> = {
  service: "Service", tables: "Tables", kitchen: "Kitchen",
  reservations: "Reservations", schedule: "the schedule", reports: "Reports",
  menu: "the Menu editor", cash: "the cash drawer and the day", settings: "Settings",
};

/**
 * Screens x roles.
 *
 * A manager sees everything; the owner-only ACTS below are not screens, so
 * they are not hidden from a manager, they are refused to one. Kitchen and
 * server each get the screens their job runs on plus the schedule, which for
 * both of them means their OWN week: `/v1/schedule/mine` is session-scoped,
 * and the manager's week behind `/v1/schedule/week` keeps its own PIN gate.
 *
 * Inventory joins the kitchen row when E26 builds it (D34).
 */
export const VISIBILITY: Record<Role, readonly Screen[]> = {
  owner: SCREENS,
  manager: SCREENS,
  kitchen: ["kitchen", "schedule"],
  server: ["service", "tables", "reservations", "schedule"],
};

export function canSee(role: Role, screen: Screen): boolean {
  return VISIBILITY[role].includes(screen);
}

/** The matrix row a page renders from, as an object rather than a list so
 *  the page reads `visibility.reports` instead of searching an array. */
export function visibilityRow(role: Role): Record<Screen, boolean> {
  return Object.fromEntries(SCREENS.map((s) => [s, canSee(role, s)])) as Record<Screen, boolean>;
}

/**
 * The owner-only ACTS (D33). Not screens: a manager opens Settings and sees
 * the venue form, and the server refuses the save. Hiding it would be a lie
 * about who runs the restaurant; refusing it is the truth about who owns it.
 */
export const OWNER_ONLY_ACTS = {
  /** the venue's identity: name, address, timezone, pay period */
  venueIdentity: "changing the venue's identity",
  /** promoting or demoting anybody who can approve */
  approverRole: "changing the role of a manager or an owner",
} as const;

export interface Employee {
  id: string;
  name: string;
  role: Role;
}

/** An employee as the roster knows them. `active` is soft: a deactivated
 *  employee cannot sign in or approve, and every check they ever opened
 *  still carries their name.
 *
 *  `title` is the E24-T2 half of the two-field rule: JOB TITLE is display
 *  vocabulary ("Sous chef", "Host"), PERMISSION LEVEL is `role`, and they are
 *  separate fields on purpose. Giving the dishwasher a nicer title must never
 *  hand them refund powers, so nothing in the engine ever branches on `title`.
 *  This shape is the PUBLIC roster: safe for any device to read. */
export interface RosterEntry extends Employee {
  active: boolean;
  title?: string;
}

/** The whole employee record, roster plus the personal half (E24-T2).
 *
 *  Everything added here is PII a manager keeps in order to run a workplace:
 *  the number you call when the line cook does not turn up, and the person to
 *  call if something happens to them on shift. It is served ONLY by the
 *  manager-PIN-gated directory read, never by `GET /v1/staff`. */
export interface DirectoryEntry extends RosterEntry {
  phone?: string;
  email?: string;
  /** one free-text line, name and number together, because that is how it is
   *  written on the sheet of paper this replaces */
  emergencyContact?: string;
  notes?: string;
}

/** What a row calls itself when nobody has typed a title yet. The permission
 *  role's own display name, which is true rather than blank, and the moment a
 *  manager types "Line cook" over it the role underneath has not moved. */
export function defaultTitle(role: Role): string {
  return { owner: "Owner", manager: "Manager", kitchen: "Kitchen", server: "Server" }[role];
}

export interface StaffMember extends Employee {
  demoPin: string;
  title?: string;
}

/** A PIN a person can actually key in on a terminal: 4 to 6 digits, nothing
 *  else. Short enough to type between plates, long enough to mean something. */
export const PIN_RULE = /^[0-9]{4,6}$/;

/** Fixed uuids so the PG seed and the FK columns line up across restarts.
 *  Migration 0012 inserts the same two new rows into an existing database, so
 *  a fresh install and an upgraded one end up with identical role ids. */
export const ROLE_IDS: Record<Role, string> = {
  owner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  manager: "99999999-9999-4999-8999-999999999999",
  kitchen: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  server: "88888888-8888-4888-8888-888888888888",
};

/** The demo's opening roster: two servers, a manager, the padrona who owns
 *  the place, and the chef whose title says Chef while his permission level
 *  says kitchen, which is D28's whole point standing up in the seed.
 *
 *  Gia stays first on purpose: the unsigned terminal opens checks in the name
 *  of the first active server it finds. */
export const STAFF: readonly StaffMember[] = [
  { id: "33333333-3333-3333-3333-333333333333", name: "Gia R.", role: "server", demoPin: "2468" },
  { id: "66666666-6666-4666-8666-666666666666", name: "Marco B.", role: "manager", demoPin: "1122" },
  { id: "77777777-7777-4777-8777-777777777777", name: "Sofia T.", role: "server", demoPin: "3579" },
  { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Elena V.", role: "owner", demoPin: "1379", title: "Padrona" },
  { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", name: "Nico F.", role: "kitchen", demoPin: "2580", title: "Chef" },
];

export function pinHash(pin: string): string {
  return createHash("sha256").update("ros-pin:" + pin).digest("hex");
}
