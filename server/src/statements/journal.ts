// The transaction history behind statements: every booking that moved money on a
// customer account, as the payment engine reported it (the same record the camt.054
// notification is made from), plus simulator funding. Balances at any instant are the
// sum of the entries booked before it, so statements reconcile with the ledger.
import type { Booking } from '../payments/camt054.js'

export interface JournalEntry extends Booking {
  /** Order of booking; breaks ties between entries with the same timestamp. */
  seq: number
}

export class Journal {
  #byAccount = new Map<string, JournalEntry[]>()
  #seq = 0

  record(b: Booking): JournalEntry {
    const e: JournalEntry = { ...b, seq: ++this.#seq }
    let list = this.#byAccount.get(b.account)
    if (!list) this.#byAccount.set(b.account, (list = []))
    list.push(e)
    return e
  }

  /** Entries of an account booked in [from, to), oldest first. */
  entries(account: string, from: number, to: number): JournalEntry[] {
    const out = (this.#byAccount.get(account) ?? []).filter((e) => {
      const t = e.bookedAt.getTime()
      return t >= from && t < to
    })
    return out.sort((a, b) => a.bookedAt.getTime() - b.bookedAt.getTime() || a.seq - b.seq)
  }

  /** Balance per currency of everything booked before the instant (signed, minor units). */
  balancesBefore(account: string, before: number): Map<string, bigint> {
    const out = new Map<string, bigint>()
    for (const e of this.#byAccount.get(account) ?? []) {
      if (e.bookedAt.getTime() >= before) continue
      out.set(e.currency, (out.get(e.currency) ?? 0n) + (e.direction === 'CRDT' ? e.amount : -e.amount))
    }
    return out
  }

  /** Every entry of the given accounts (for payment-limit usage). */
  all(accounts: string[]): JournalEntry[] { return accounts.flatMap((a) => this.#byAccount.get(a) ?? []) }
}
