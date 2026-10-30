// The statements journal in Postgres (decision 960): one row per booking under a
// namespace, indexed by account and booking time, so a statement or a balance reads one
// account's range, not every booking. The booking is kept whole as JSON (amount as a
// decimal string, bookedAt as ms); the columns beside it are what the queries filter and
// sum on. `seq` comes from one sequence: the booking order, as MemoryJournal's counter.
import { randomUUID } from 'node:crypto'
import type { PgDb } from './db.js'
import type { Booking } from '../payments/camt054.js'
import type { JournalEntry, JournalStore } from '../statements/journal.js'

type Stored = Omit<Booking, 'amount' | 'bookedAt'> & { amount: string; bookedAt: number }

const revive = (row: { seq: string; entry: Stored }): JournalEntry => {
  const s = row.entry
  return { ...s, amount: BigInt(s.amount), bookedAt: new Date(s.bookedAt), seq: Number(row.seq) }
}

export class PgJournal implements JournalStore {
  readonly namespace: string
  constructor(private db: PgDb, o: { namespace?: string } = {}) { this.namespace = o.namespace ?? randomUUID() }

  async record(b: Booking, key?: string): Promise<JournalEntry> {
    const stored: Stored = { ...b, amount: b.amount.toString(), bookedAt: b.bookedAt.getTime() }
    const r = await this.db.pool.query(
      `insert into journal_entries (ns, seq, account, booked_at, direction, currency, amount, entry, entry_key)
       values ($1, nextval('journal_seq'), $2, $3, $4, $5, $6, $7, $8)
       on conflict (ns, entry_key) where entry_key is not null do nothing returning seq`,
      [this.namespace, b.account, stored.bookedAt, b.direction, b.currency, stored.amount, JSON.stringify(stored), key ?? null])
    if (!r.rows.length) {
      const first = await this.db.pool.query('select seq, entry from journal_entries where ns = $1 and entry_key = $2', [this.namespace, key])
      return revive(first.rows[0])
    }
    return { ...b, seq: Number(r.rows[0].seq) }
  }

  async entries(account: string, from: number, to: number): Promise<JournalEntry[]> {
    // ±Infinity (an open range) is not a bigint: clamp to what a booking time can be.
    const r = await this.db.pool.query(
      `select seq, entry from journal_entries where ns = $1 and account = $2 and booked_at >= $3 and booked_at < $4
       order by booked_at, seq`, [this.namespace, account, clamp(from), clamp(to)])
    return r.rows.map(revive)
  }

  async balancesBefore(account: string, before: number): Promise<Map<string, bigint>> {
    const r = await this.db.pool.query(
      `select currency, sum(case when direction = 'CRDT' then amount else -amount end)::text as balance, min(seq) as first
       from journal_entries where ns = $1 and account = $2 and booked_at < $3 group by currency order by first`,
      [this.namespace, account, clamp(before)])
    return new Map(r.rows.map((x) => [x.currency as string, BigInt(x.balance)]))
  }

  async debits(accounts: string[], currency: string, from: number, to: number): Promise<bigint> {
    const r = await this.db.pool.query(
      `select coalesce(sum(amount), 0)::text as total from journal_entries
       where ns = $1 and account = any($2) and direction = 'DBIT' and currency = $3 and booked_at >= $4 and booked_at <= $5`,
      [this.namespace, accounts, currency, clamp(from), clamp(to)])
    return BigInt(r.rows[0].total)
  }

  async byRef(servicerRef: string): Promise<JournalEntry[]> {
    const r = await this.db.pool.query(`select seq, entry from journal_entries where ns = $1 and entry->>'servicerRef' = $2 order by seq`, [this.namespace, servicerRef])
    return r.rows.map(revive)
  }
}

const LIMIT = 8.64e15 // the largest Date
const clamp = (t: number) => Math.max(-LIMIT, Math.min(LIMIT, t))
