/** Zero-setup Store for dev and tests. State dies with the process. */
import { FLOOR, type CheckAggregate, type FloorTable, type KitchenTicket, type OpMeta, type Store } from "./types.js";

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
}
