// Payments the rails answered `accepted` and whose outcome is still to come (decision 948),
// as plain JSON records so a persistent store (PgRailsPending, pg/rails-pending.ts) lets a
// restarted engine settle them. The engine writes a record before `send` and takes it once:
// on the immediate answer, or on the outcome the bridge delivers later.
import type { CustomerKey } from '../directory.js'
import type { RailsOutcome, Scheme } from '../rails.js'

export interface PendingRecord {
  ref: string
  scheme: Scheme
  file: { customer: CustomerKey; requestId: string; version: string; msgId: string }
  /** The engine's plan: amount as a decimal string of minor units, agency times in ms. */
  plan: Record<string, unknown>
  /** The status the payment was accepted with (ACSP, or ACWC on the SEPA fallback). */
  accepted: Record<string, unknown>
  /** When it was sent (ms, the engine's clock): reconciliation waits a while (decision 1002). */
  sentAt?: number
  /** The outcome stored first (decision 1003): another one for this attempt is refused. */
  outcome?: RailsOutcome
}

export interface RailsPending {
  put(r: PendingRecord): Promise<void>
  /** The payment waiting under ref, left waiting. */
  get(ref: string): Promise<PendingRecord | undefined>
  /** Removes and returns the payment waiting under ref (of that scheme, when given); at most once. */
  take(ref: string, scheme?: Scheme): Promise<PendingRecord | undefined>
  /** The refs waiting, oldest first. */
  refs(): Promise<string[]>
  /**
   * Stores the outcome on the record of ref (of that scheme) unless it has one; the record
   * with the outcome stored first, undefined when none waits (decision 1003).
   */
  decide(ref: string, outcome: RailsOutcome, scheme: Scheme): Promise<PendingRecord | undefined>
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
  async decide(ref: string, outcome: RailsOutcome, scheme: Scheme) {
    const r = this.#m.get(ref)
    if (!r || r.scheme !== scheme) return undefined
    if (!r.outcome) this.#m.set(ref, { ...r, outcome })
    return this.#m.get(ref)
  }
}
