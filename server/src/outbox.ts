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
// - Kinds: `notice`, a booking's statement entry plus its camt.054, the body made when the
//   item is (the customer's camt.054 settings of that moment); `message`, an inbox message
//   made before the booking it reports (an FX confirmation, decision 999). A kind may be a
//   group (`onGroup`): its items are delivered together, so one message can report several
//   bookings (the DD status report of a file, decision 999; a payment round's pain.002, 1005).
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
  /** Synchronous, for MemoryLedger to write with the booking. A key stored already stays as stored (as in Postgres). */
  putNow(items: OutboxItem[]) { for (const i of items) if (!this.#items.has(i.key)) this.#items.set(i.key, structuredClone(i)) }
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
type GroupHandler = (items: OutboxItem[]) => Promise<void>
export interface MessagePayload { customer: CustomerKey; type: string; body: string; requestId?: string; contentType?: string }

/** Makes, delivers and recovers the items of one emulator's ledger. */
export class Outbox {
  #handlers = new Map<string, Handler>()
  #groups = new Map<string, GroupHandler>()
  #minAge = new Map<string, number>()
  constructor(private ledger: Ledger, private clock: Clock, private bank: Bank) {}

  on(kind: string, handler: Handler) { this.#handlers.set(kind, handler) }
  /**
   * A kind whose items one delivery hands over together (after the other kinds'); recover
   * hands over all pending ones together. `minAgeMs`: a recovery with an age limit (the
   * timer in main.ts) leaves the kind's items younger than this, the process that wrote
   * them still working on them (a payment round, decision 1005); one at start takes all.
   */
  onGroup(kind: string, handler: GroupHandler, o: { minAgeMs?: number } = {}) {
    this.#groups.set(kind, handler)
    if (o.minAgeMs) this.#minAge.set(kind, o.minAgeMs)
  }

  /** Any item: the payload as given (JSON-safe). */
  item(kind: string, payload: unknown): OutboxItem { return { key: randomUUID(), kind, payload, at: this.clock.now().getTime() } }

  /** An inbox message, added once by the item's key (decision 999). */
  message(m: { customer: Customer | CustomerKey; type: string; body: string; requestId?: string; contentType?: string }): OutboxItem {
    const payload: MessagePayload = JSON.parse(JSON.stringify({ ...m, customer: { code: m.customer.code, country: m.customer.country } }))
    return this.item('message', payload)
  }

  /** The statement entry and camt.054 of a booking of `customer`; `inflight` a ref the limits count until then. */
  notice(customer: Customer, booking: Booking, o: { inflight?: string } = {}): OutboxItem {
    const payload: NoticePayload = { customer: { code: customer.code, country: customer.country }, booking: storeBooking(booking), body: camt054(booking, customer.camt054, this.bank), ...o }
    return { key: randomUUID(), kind: 'notice', payload, at: this.clock.now().getTime() }
  }

  /** Runs each item's handler, oldest first, then removes them. */
  async deliver(items: OutboxItem[]) {
    if (!items.length) return
    const grouped = new Map<string, OutboxItem[]>()
    for (const i of items) {
      if (this.#groups.has(i.kind)) { grouped.set(i.kind, [...(grouped.get(i.kind) ?? []), i]); continue }
      const h = this.#handlers.get(i.kind)
      if (!h) throw new Error(`no outbox handler for ${i.kind}`)
      await h(i)
    }
    for (const [kind, g] of grouped) await this.#groups.get(kind)!(g)
    await this.ledger.outbox.remove(items.map((i) => i.key))
  }

  /**
   * Delivers what is pending (at least `minAgeMs` old): an intent once its ledger shows the
   * booking, dropped when it does not after INTENT_GRACE_MS. Returns how many were delivered.
   */
  async recover(o: { minAgeMs?: number } = {}): Promise<number> {
    const now = this.clock.now().getTime()
    let n = 0
    const grouped: OutboxItem[] = []
    for (const i of await this.ledger.outbox.pending()) {
      // minAgeMs 0 (at start) takes all, also an item another process's clock dates later (decision 998).
      if ((o.minAgeMs && now - i.at < Math.max(o.minAgeMs, this.#minAge.get(i.kind) ?? 0)) || !(this.#handlers.has(i.kind) || this.#groups.has(i.kind))) continue
      if (i.intent !== undefined && !(await this.ledger.booked?.(i.intent))) {
        if (now - i.at >= INTENT_GRACE_MS) await this.ledger.outbox.remove([i.key])
        continue
      }
      if (this.#groups.has(i.kind)) grouped.push(i)
      else await this.deliver([i])
      n++
    }
    await this.deliver(grouped)
    return n
  }
}
