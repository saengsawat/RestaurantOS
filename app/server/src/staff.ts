/**
 * Staff identity (epic E15). Demo roster for Osteria Nove; the real product
 * gets an employee admin screen, but the CONTRACT is already final:
 * PINs are stored hashed, roles gate approvals, and every privileged
 * command records WHO approved it.
 *
 * The demo PINs are printed in the UI on purpose: this is a concept demo
 * of the approval FLOW, not of PIN secrecy.
 */
import { createHash } from "node:crypto";

export interface Employee {
  id: string;
  name: string;
  role: "server" | "manager";
}

export interface StaffMember extends Employee {
  demoPin: string;
}

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

/** Verify a PIN against the roster (both stores route through this hash). */
export function staffByPinHash(hash: string): StaffMember | undefined {
  return STAFF.find((s) => pinHash(s.demoPin) === hash);
}
