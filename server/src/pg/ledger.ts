// The ledger in Postgres (decision 910): the same semantics as MemoryLedger, so many
// emulator processes can share the money and a restart keeps it.
//
// - Rows carry a namespace as the inbox's (decision 902): every emulator (every test) has
//   its own; two PgLedger on one namespace are one ledger.
// - Balances, holds (reservations) and postings (the append-only journal) are tables of
//   bigint minor units (pg/db.ts).
// - Locking (decision 911): only what lowers what an account has available needs to be
//   serialised, and that is reserve and transfer, both on the debited account. Each runs
//   in one transaction holding pg_advisory_xact_lock on (namespace, account), so the check
//   of available and the hold (or the debit) it allows are one step across processes.
//   Within a process at most GATE transactions per account wait on a connection, as
//   open-ledger's transaction(), so a burst on one account does not hold the whole pool.
//   A system account ('@', may go negative) is not checked and so not locked.
//   commit and release take no advisory lock: commit turns a hold into the same debit
//   (available does not change) and release only raises it; available is one statement,
//   one snapshot, so it sees a commit wholly or not at all. Balance rows are updated in a
//   fixed order (account, then currency), so two bookings between the same accounts in
//   opposite directions cannot deadlock on their row locks.
import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { Clock } from '../clock.js'
import { InsufficientFunds, isSystemAccount, type Ledger, type Posting } from '../ledger.js'
import type { PgDb } from './db.js'
import type { OutboxItem } from '../outbox.js'
import { insertOutbox, PgOutbox } from './outbox.js'

/** Transactions of one account that may hold a pool connection at once in one process. */
const GATE = 2

export interface PgLedgerOptions {
  /** Whose rows these are; default a random one (a fresh, empty ledger). */
  namespace?: string
  /** Times of postings; default the system clock (MemoryLedger uses Date.now()). */
  clock?: Clock
}

type Gate = { held: number; waiting: (() => void)[] }

export class PgLedger implements Ledger {
  readonly namespace: string
  #clock?: Clock
  #gates = new Map<string, Gate>()

  constructor(private db: PgDb, o: PgLedgerOptions = {}) {
    this.namespace = o.namespace ?? randomUUID()
    this.#clock = o.clock
    this.outbox = new PgOutbox(db, { namespace: this.namespace })
  }

  /** Items of bookings not delivered yet: written in the booking's transaction (decision 990). */
  readonly outbox: PgOutbox

  async available(account: string, currency: string) {
    return this.#available(this.db.pool, account, currency)
  }

  async balances(account: string) {
    const { rows } = await this.db.pool.query(
      `select b.currency, b.balance, b.balance - coalesce((select sum(h.amount) from ledger_holds h
         where h.ns = b.ns and h.account = b.account and h.currency = b.currency), 0) as available
       from ledger_balances b where b.ns = $1 and b.account = $2 order by b.ord`,
      [this.namespace, account],
    )
    const out: Record<string, { balance: bigint; available: bigint }> = {}
    for (const r of rows) out[r.currency] = { balance: BigInt(r.balance), available: BigInt(r.available) }
    return out
  }

  async reserve(r: { ref: string; account: string; amount: bigint; currency: string }) {
    if (r.amount <= 0n) throw new Error('amount must be positive')
    await this.#debiting(r.account, async (c) => {
      await this.#checkFree(c, r.ref)
      await this.#checkFunds(c, r.account, r.currency, r.amount)
      await c.query('insert into ledger_holds (ns, ref, account, currency, amount) values ($1, $2, $3, $4, $5)',
        [this.namespace, r.ref, r.account, r.currency, r.amount.toString()])
    })
  }

  async commit(ref: string, to: string, outbox: OutboxItem[] = []) {
    await this.#tx(undefined, async (c) => {
      const { rows } = await c.query('delete from ledger_holds where ns = $1 and ref = $2 returning account, currency, amount', [this.namespace, ref])
      if (!rows.length) throw new Error(`no reservation ${ref}`)
      await this.#move(c, ref, rows[0].account, to, BigInt(rows[0].amount), rows[0].currency)
      await insertOutbox(c, this.namespace, outbox)
    })
  }

  async release(ref: string) {
    await this.db.pool.query('delete from ledger_holds where ns = $1 and ref = $2', [this.namespace, ref])
  }

  /** reserve + commit in one transaction: a failure leaves nothing. */
  async transfer(t: { ref: string; from: string; to: string; amount: bigint; currency: string }, outbox: OutboxItem[] = []) {
    if (t.amount <= 0n) throw new Error('amount must be positive')
    await this.#debiting(t.from, async (c) => {
      await this.#checkFree(c, t.ref)
      await this.#checkFunds(c, t.from, t.currency, t.amount)
      await this.#move(c, t.ref, t.from, t.to, t.amount, t.currency)
      await insertOutbox(c, this.namespace, outbox)
    })
  }

  /** The journal of this namespace in booking order (MemoryLedger.postings). */
  async postings(): Promise<Posting[]> {
    const { rows } = await this.db.pool.query('select ref, account, currency, amount, at from ledger_postings where ns = $1 order by id', [this.namespace])
    return rows.map((r) => ({ ref: r.ref, account: r.account, currency: r.currency, amount: BigInt(r.amount), at: Number(r.at) }))
  }

  // --- inside a transaction --------------------------------------------------------------

  async #available(q: pg.Pool | pg.PoolClient, account: string, currency: string): Promise<bigint> {
    // One statement, one snapshot: a concurrent commit is seen wholly or not at all.
    const { rows } = await q.query(
      `select coalesce((select balance from ledger_balances where ns = $1 and account = $2 and currency = $3), 0)
            - coalesce((select sum(amount) from ledger_holds where ns = $1 and account = $2 and currency = $3), 0) as available`,
      [this.namespace, account, currency],
    )
    return BigInt(rows[0].available)
  }

  async #checkFree(c: pg.PoolClient, ref: string) {
    const { rowCount } = await c.query('select 1 from ledger_holds where ns = $1 and ref = $2', [this.namespace, ref])
    if (rowCount) throw new Error(`reservation ${ref} exists`)
  }

  async #checkFunds(c: pg.PoolClient, account: string, currency: string, amount: bigint) {
    if (!isSystemAccount(account) && (await this.#available(c, account, currency)) < amount) throw new InsufficientFunds()
  }

  async #move(c: pg.PoolClient, ref: string, from: string, to: string, amount: bigint, currency: string) {
    const at = this.#clock ? this.#clock.now().getTime() : Date.now()
    const legs: [string, bigint][] = [[from, -amount], [to, amount]]
    // Row locks in a fixed order (decision 911); from === to books twice on one row.
    for (const [account, delta] of [...legs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      await c.query(
        `insert into ledger_balances (ns, account, currency, balance) values ($1, $2, $3, $4)
         on conflict (ns, account, currency) do update set balance = ledger_balances.balance + excluded.balance`,
        [this.namespace, account, currency, delta.toString()],
      )
    }
    await c.query('insert into ledger_postings (ns, ref, account, currency, amount, at) values ($1, $2, $3, $4, $5, $7), ($1, $2, $6, $4, $8, $7)',
      [this.namespace, ref, from, currency, (-amount).toString(), to, at, amount.toString()])
  }

  // --- transactions --------------------------------------------------------------------------

  /** A transaction that may lower `account`'s available: under its lock unless a system account. */
  async #debiting<T>(account: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    if (isSystemAccount(account)) return this.#tx(undefined, fn)
    let gate = this.#gates.get(account)
    if (!gate) this.#gates.set(account, (gate = { held: 0, waiting: [] }))
    if (gate.held < GATE) gate.held++
    else await new Promise<void>((r) => gate.waiting.push(r)) // the slot is handed over
    try {
      return await this.#tx(this.#lockKey(account), fn)
    } finally {
      const next = gate.waiting.shift()
      if (next) next()
      else if (--gate.held === 0) this.#gates.delete(account)
    }
  }

  /** A 64-bit advisory lock key for (namespace, account); fewer collisions than hashtext's 32 bits. */
  #lockKey(account: string): string {
    return createHash('sha256').update(`ledger\0${this.namespace}\0${account}`).digest().readBigInt64BE(0).toString()
  }

  async #tx<T>(lock: string | undefined, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.db.pool.connect()
    try {
      await c.query('begin')
      if (lock !== undefined) await c.query('select pg_advisory_xact_lock($1::bigint)', [lock])
      const out = await fn(c)
      await c.query('commit')
      return out
    } catch (e) {
      await c.query('rollback')
      throw e
    } finally {
      c.release()
    }
  }
}
