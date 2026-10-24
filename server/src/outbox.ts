// The outbox of the ledger (decisions 990-992): what reports a booking is written with
// the booking, so a crash between the two loses neither.
//
// - A ledger call that books (`transfer`, `commit`) takes the items that report it. The
//   ledger keeps them in its own outbox with the booking: PgLedger in the booking's
//   transaction (pg/outbox.ts), MemoryLedger with no await between, OpenLedgerLedger first
//   as an intent (its ledger shares no transaction with us), confirmed by the booking it
//   names on open-ledger (decision 992).
// - Delivery is at least once: the handler of the item's kind runs, then the item goes.
//   The caller delivers right after the booking, where it used to write the message;
//   `recover()` delivers what a crash left (at start and on a timer in main.ts). Handlers
//   are idempotent by the item's key: the journal entry and the inbox message carry it, so
//   a second delivery writes nothing (exactly once into the journal and the inbox).
// - One kind for now, `notice`: a booking's statement entry plus its camt.054, the body
//   made when the item is (the customer's camt.054 settings of that moment).
import { randomUUID } from 'node:crypto'
import type { Clock } from './clock.js'
import type { Customer, CustomerKey } from './directory.js'
import type { Ledger } from './ledger.js'
import { camt054, type Booking } from './payments/camt054.js'

type Bank = Parameters<typeof camt054>[2]

export interface OutboxItem {
  key: string
  kind: string
  /** JSON-safe. */
  payload: unknown
  /** When made, ms on the emulator's clock. */
  at: number
  /** Written before the booking, which is still to be confirmed by `ledger.booked` (open-ledger). */
  intent?: string
}

/** Where a ledger keeps the items of its bookings. */
export interface OutboxStore {
  put(items: OutboxItem[]): Promise<void>
  /** Oldest first. */
  pending(): Promise<OutboxItem[]>
  remove(keys: string[]): Promise<void>
}

export class MemoryOutbox implements OutboxStore {
  #items = new Map<string, OutboxItem>()
  /** Synchronous, for MemoryLedger to write with the booking. */
  putNow(items: OutboxItem[]) { for (const i of items) this.#items.set(i.key, structuredClone(i)) }
  async put(items: OutboxItem[]) { this.putNow(items) }
  async pending() { return [...this.#items.values()].map((i) => structuredClone(i)) }
  async remove(keys: string[]) { for (const k of keys) this.#items.delete(k) }
}

/** A booking as JSON (amount a decimal string, bookedAt ms), as the journal stores it. */
type StoredBooking = Omit<Booking, 'amount' | 'bookedAt'> & { amount: string; bookedAt: number }
export interface NoticePayload { customer: CustomerKey; booking: StoredBooking; body: string; inflight?: string }
const storeBooking = (b: Booking): StoredBooking => JSON.parse(JSON.stringify({ ...b, amount: b.amount.toString(), bookedAt: b.bookedAt.getTime() }))
export const bookingOf = (s: StoredBooking): Booking => ({ ...s, amount: BigInt(s.amount), bookedAt: new Date(s.bookedAt) })

/** An intent not confirmed by its ledger this long after it was made is dropped: the booking never happened. */
export const INTENT_GRACE_MS = 10 * 60 * 1000
/** What the timer in main.ts leaves alone: items the process that wrote them is still delivering. */
export const RECOVER_MIN_AGE_MS = 60 * 1000

type Handler = (item: OutboxItem) => Promise<void>

/** Makes, delivers and recovers the items of one emulator's ledger. */
export class Outbox {
  #handlers = new Map<string, Handler>()
  constructor(private ledger: Ledger, private clock: Clock, private bank: Bank) {}

  on(kind: string, handler: Handler) { this.#handlers.set(kind, handler) }

  /** The statement entry and camt.054 of a booking of `customer`; `inflight` a ref the limits count until then. */
  notice(customer: Customer, booking: Booking, o: { inflight?: string } = {}): OutboxItem {
    const payload: NoticePayload = { customer: { code: customer.code, country: customer.country }, booking: storeBooking(booking), body: camt054(booking, customer.camt054, this.bank), ...o }
    return { key: randomUUID(), kind: 'notice', payload, at: this.clock.now().getTime() }
  }

  /** Runs each item's handler, oldest first, then removes them. */
  async deliver(items: OutboxItem[]) {
    if (!items.length) return
    for (const i of items) {
      const h = this.#handlers.get(i.kind)
      if (!h) throw new Error(`no outbox handler for ${i.kind}`)
      await h(i)
    }
    await this.ledger.outbox.remove(items.map((i) => i.key))
  }

  /**
   * Delivers what is pending (at least `minAgeMs` old): an intent once its ledger shows the
   * booking, dropped when it does not after INTENT_GRACE_MS. Returns how many were delivered.
   */
  async recover(o: { minAgeMs?: number } = {}): Promise<number> {
    const now = this.clock.now().getTime()
    let n = 0
    for (const i of await this.ledger.outbox.pending()) {
      if (now - i.at < (o.minAgeMs ?? 0) || !this.#handlers.has(i.kind)) continue
      if (i.intent !== undefined && !(await this.ledger.booked?.(i.intent))) {
        if (now - i.at >= INTENT_GRACE_MS) await this.ledger.outbox.remove([i.key])
        continue
      }
      await this.deliver([i])
      n++
    }
    return n
  }
}
