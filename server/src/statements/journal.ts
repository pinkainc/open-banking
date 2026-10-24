// The transaction history behind statements: every booking that moved money on a
// customer account, as the payment engine reported it (the same record the camt.054
// notification is made from), plus simulator funding. Balances at any instant are the
// sum of the entries booked before it, so statements reconcile with the ledger.
// A store interface (decision 960): MemoryJournal here, PgJournal (pg/journal.ts) in
// Postgres, so a restarted emulator still reports the bookings made before it.
import type { Booking } from '../payments/camt054.js'

export interface JournalEntry extends Booking {
  /** Order of booking; breaks ties between entries with the same timestamp. */
  seq: number
}

export interface JournalStore {
  record(b: Booking): Promise<JournalEntry>
  /** Entries of an account booked in [from, to), oldest first (booking time, then seq). */
  entries(account: string, from: number, to: number): Promise<JournalEntry[]>
  /** Balance per currency of everything booked before the instant (signed, minor units). */
  balancesBefore(account: string, before: number): Promise<Map<string, bigint>>
  /** The sum of the accounts' debits in a currency booked in [from, to] (payment-limit usage). */
  debits(accounts: string[], currency: string, from: number, to: number): Promise<bigint>
}

export class MemoryJournal implements JournalStore {
  #byAccount = new Map<string, JournalEntry[]>()
  #seq = 0

  async record(b: Booking): Promise<JournalEntry> {
    const e: JournalEntry = { ...b, seq: ++this.#seq }
    let list = this.#byAccount.get(b.account)
    if (!list) this.#byAccount.set(b.account, (list = []))
    list.push(e)
    return e
  }

  async entries(account: string, from: number, to: number): Promise<JournalEntry[]> {
    const out = (this.#byAccount.get(account) ?? []).filter((e) => {
      const t = e.bookedAt.getTime()
      return t >= from && t < to
    })
    return out.sort((a, b) => a.bookedAt.getTime() - b.bookedAt.getTime() || a.seq - b.seq)
  }

  async balancesBefore(account: string, before: number): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>()
    for (const e of this.#byAccount.get(account) ?? []) {
      if (e.bookedAt.getTime() >= before) continue
      out.set(e.currency, (out.get(e.currency) ?? 0n) + (e.direction === 'CRDT' ? e.amount : -e.amount))
    }
    return out
  }

  async debits(accounts: string[], currency: string, from: number, to: number): Promise<bigint> {
    let sum = 0n
    for (const a of new Set(accounts)) {
      for (const e of this.#byAccount.get(a) ?? []) {
        const t = e.bookedAt.getTime()
        if (e.direction === 'DBIT' && e.currency === currency && t >= from && t <= to) sum += e.amount
      }
    }
    return sum
  }
}
