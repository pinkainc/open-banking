// The ledger behind the facade. The interface is what the payment engine needs and no
// more, so the in-memory implementation can later be replaced by open-ledger (through
// its SDK or HTTP API) without touching the Connect-facing code. Amounts are integers
// in minor units (cents).
import { keepLast } from './bounded.js'
import { MemoryOutbox, type OutboxItem, type OutboxStore } from './outbox.js'

export class InsufficientFunds extends Error {}

/**
 * What a booking call did (decision 995). A booking has a key, a transfer's `key` (default
 * its ref) or a commit's ref: a call whose key was booked before books nothing, keeps none
 * of its items and answers `repeat` with the ref the key was booked under; the caller
 * then delivers nothing (the first call's items are in the outbox or delivered). A repeat
 * with other terms (accounts, amount, currency) is an Error, not a silent no-op.
 */
export interface Booked { ref: string; repeat: boolean }

/** The terms a booking key was booked with. */
export interface BookingTerms { ref: string; from: string; to: string; amount: bigint; currency: string }

/** Throws when a repeat of a key comes with other terms than its booking (decision 995). */
export function sameTerms(key: string, booked: BookingTerms, now: Partial<BookingTerms>): Booked {
  const differs = (['from', 'to', 'amount', 'currency'] as const).filter((k) => now[k] !== undefined && now[k] !== booked[k])
  if (differs.length) throw new Error(`booking ${key} was booked with another ${differs.join(', ')}`)
  return { ref: booked.ref, repeat: true }
}

/** Booking keys MemoryLedger remembers (decision 996): only repeats within the process, it keeps nothing across a restart. */
export const MEMORY_BOOKING_KEYS_MAX = 100_000

export interface Ledger {
  /** Balance minus reservations. */
  available(account: string, currency: string): Promise<bigint>
  balances(account: string): Promise<Record<string, { balance: bigint; available: bigint }>>
  /** Sets funds aside for a payment; throws InsufficientFunds. */
  reserve(r: { ref: string; account: string; amount: bigint; currency: string }): Promise<void>
  /**
   * Books a reservation to its destination; `outbox` the items that report it, kept with
   * the booking (decision 990). Its key is the ref: without a hold, a ref booked by an
   * earlier commit is a repeat (decision 995), else "no reservation".
   */
  commit(ref: string, to: string, outbox?: OutboxItem[]): Promise<Booked>
  release(ref: string): Promise<void>
  /** reserve + commit in one step; `outbox` as for commit; `key` (default ref) books once (decision 995). */
  transfer(t: Transfer, outbox?: OutboxItem[]): Promise<Booked>
  /** The items of bookings not delivered yet. */
  readonly outbox: OutboxStore
  /** Whether the booking an intent item names happened (only a ledger that writes intents, decision 992). */
  booked?(intent: string): Promise<boolean>
}

export interface Transfer { ref: string; from: string; to: string; amount: bigint; currency: string; /** The booking key, default ref (decision 995). */ key?: string }

/** Accounts whose name starts with '@' are the bank's own (settlement, funding) and may go negative. */
export const isSystemAccount = (a: string) => a.startsWith('@')

export interface Posting { ref: string; account: string; currency: string; amount: bigint; at: number }

/** Postings MemoryLedger keeps (decision 915): the journal is for inspection, balances do not depend on it. */
export const MEMORY_POSTINGS_MAX = 100_000

export class MemoryLedger implements Ledger {
  #balances = new Map<string, bigint>()
  #holds = new Map<string, { account: string; amount: bigint; currency: string }>()
  readonly postings: Posting[] = []
  readonly outbox = new MemoryOutbox()
  /** Booking keys, oldest first (decision 996). */
  #keys = new Map<string, BookingTerms>()

  #k = (a: string, c: string) => `${a}|${c}`
  #bal(a: string, c: string) { return this.#balances.get(this.#k(a, c)) ?? 0n }
  #held(a: string, c: string) {
    let s = 0n
    for (const h of this.#holds.values()) if (h.account === a && h.currency === c) s += h.amount
    return s
  }

  async available(account: string, currency: string) { return this.#avail(account, currency) }
  #avail(a: string, c: string) { return this.#bal(a, c) - this.#held(a, c) }

  async balances(account: string) {
    const out: Record<string, { balance: bigint; available: bigint }> = {}
    for (const key of this.#balances.keys()) {
      const [a, c] = key.split('|')
      if (a === account) out[c] = { balance: this.#bal(a, c), available: this.#bal(a, c) - this.#held(a, c) }
    }
    return out
  }

  async reserve(r: { ref: string; account: string; amount: bigint; currency: string }) { this.#reserve(r) }
  #reserve(r: { ref: string; account: string; amount: bigint; currency: string }) {
    if (r.amount <= 0n) throw new Error('amount must be positive')
    if (this.#holds.has(r.ref)) throw new Error(`reservation ${r.ref} exists`)
    // Checked and held with no await between (decision 913): concurrent reserves once all
    // read the same available and together overdrew it.
    if (!isSystemAccount(r.account) && this.#avail(r.account, r.currency) < r.amount) throw new InsufficientFunds()
    this.#holds.set(r.ref, { account: r.account, amount: r.amount, currency: r.currency })
  }

  async commit(ref: string, to: string, outbox: OutboxItem[] = []): Promise<Booked> {
    const h = this.#holds.get(ref)
    if (!h) {
      const b = this.#keys.get(ref)
      if (b) return sameTerms(ref, b, { to })
      throw new Error(`no reservation ${ref}`)
    }
    this.#commit(ref, to, ref)
    this.outbox.putNow(outbox) // with the booking, no await between
    return { ref, repeat: false }
  }
  #commit(ref: string, to: string, key: string) {
    const h = this.#holds.get(ref)!
    this.#holds.delete(ref)
    this.#move(ref, h.account, to, h.amount, h.currency)
    this.#keys.delete(key) // a re-reserved ref booked again: the newest terms, last in order
    this.#keys.set(key, { ref, from: h.account, to, amount: h.amount, currency: h.currency })
    if (this.#keys.size > MEMORY_BOOKING_KEYS_MAX) this.#keys.delete(this.#keys.keys().next().value!)
  }

  async release(ref: string) { this.#holds.delete(ref) }

  async transfer(t: Transfer, outbox: OutboxItem[] = []): Promise<Booked> {
    const key = t.key ?? t.ref
    if (t.amount <= 0n) throw new Error('amount must be positive')
    const b = this.#keys.get(key)
    if (b) return sameTerms(key, b, t)
    // reserve + commit with no await between, so nothing sees or takes the hold in between.
    this.#reserve({ ref: t.ref, account: t.from, amount: t.amount, currency: t.currency })
    this.#commit(t.ref, t.to, key)
    this.outbox.putNow(outbox)
    return { ref: t.ref, repeat: false }
  }

  #move(ref: string, from: string, to: string, amount: bigint, currency: string) {
    const at = Date.now()
    this.#balances.set(this.#k(from, currency), this.#bal(from, currency) - amount)
    this.#balances.set(this.#k(to, currency), this.#bal(to, currency) + amount)
    this.postings.push({ ref, account: from, currency, amount: -amount, at }, { ref, account: to, currency, amount, at })
    keepLast(this.postings, MEMORY_POSTINGS_MAX)
  }
}

/** "12.30" → 1230n. Throws on more than two decimals or a malformed number. */
export function toMinor(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim())
  if (!m) throw new Error(`not an amount with at most two decimals: ${s}`)
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'))
}

/** 1230n → "12.30" */
export function fromMinor(n: bigint): string {
  const neg = n < 0n
  const a = neg ? -n : n
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`
}
