/**
 * Staff identity (epic E15), now SEED ONLY (E21-T1).
 *
 * STAFF was the roster: sign-in read it, approvals read it, and hiring
 * somebody meant editing this file. It is now what it should always have
 * been, the three people the demo opens with. Both stores seed it once and
 * then own their own roster, so a real restaurant can hire, reset a PIN, and
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

export interface Employee {
  id: string;
  name: string;
  role: "server" | "manager";
}

/** An employee as the roster knows them. `active` is soft: a deactivated
 *  employee cannot sign in or approve, and every check they ever opened
 *  still carries their name. */
export interface RosterEntry extends Employee {
  active: boolean;
}

export interface StaffMember extends Employee {
  demoPin: string;
}

/** A PIN a person can actually key in on a terminal: 4 to 6 digits, nothing
 *  else. Short enough to type between plates, long enough to mean something. */
export const PIN_RULE = /^[0-9]{4,6}$/;

/** Fixed uuids so the PG seed and the FK columns line up across restarts. */
export const ROLE_IDS = {
  server: "88888888-8888-4888-8888-888888888888",
  manager: "99999999-9999-4999-8999-999999999999",
} as const;

export const STAFF: readonly StaffMember[] = [
  { id: "33333333-3333-3333-3333-333333333333", name: "Gia R.", role: "server", demoPin: "2468" },
  { id: "66666666-6666-4666-8666-666666666666", name: "Marco B.", role: "manager", demoPin: "1122" },
  { id: "77777777-7777-4777-8777-777777777777", name: "Sofia T.", role: "server", demoPin: "3579" },
];

export function pinHash(pin: string): string {
  return createHash("sha256").update("ros-pin:" + pin).digest("hex");
}
