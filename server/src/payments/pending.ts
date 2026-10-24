// Payments the rails answered `accepted` and whose outcome is still to come (decision 948),
// as plain JSON records so a persistent store (PgRailsPending, pg/rails-pending.ts) lets a
// restarted engine settle them. The engine writes a record before `send` and takes it once:
// on the immediate answer, or on the outcome the bridge delivers later.
import type { CustomerKey } from '../directory.js'
import type { Scheme } from '../rails.js'

export interface PendingRecord {
  ref: string
  scheme: Scheme
  file: { customer: CustomerKey; requestId: string; version: string; msgId: string }
  /** The engine's plan: amount as a decimal string of minor units, agency times in ms. */
  plan: Record<string, unknown>
  /** The status the payment was accepted with (ACSP, or ACWC on the SEPA fallback). */
  accepted: Record<string, unknown>
}

export interface RailsPending {
  put(r: PendingRecord): Promise<void>
  /** The payment waiting under ref, left waiting. */
  get(ref: string): Promise<PendingRecord | undefined>
  /** Removes and returns the payment waiting under ref (of that scheme, when given); at most once. */
  take(ref: string, scheme?: Scheme): Promise<PendingRecord | undefined>
  /** The refs waiting, oldest first. */
  refs(): Promise<string[]>
}

export class MemoryRailsPending implements RailsPending {
  #m = new Map<string, PendingRecord>()
  async put(r: PendingRecord) { this.#m.set(r.ref, r) }
  async get(ref: string) { return this.#m.get(ref) }
  async take(ref: string, scheme?: Scheme) {
    const r = this.#m.get(ref)
    if (!r || (scheme !== undefined && r.scheme !== scheme)) return undefined
    this.#m.delete(ref)
    return r
  }
  async refs() { return [...this.#m.keys()] }
}
