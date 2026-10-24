// Acquiring in Postgres (decision 946): merchant set-ups and the card transactions fed
// through /_sim/acq, with MemoryAcquiringStore's semantics under a namespace. References
// come from a per-namespace counter (4901, 4902, …), so a restart goes on where it was and
// two emulators on one namespace never hand out the same one. Transactions keep the
// memory bounds: an optional TTL from the injected clock and a maximum count.
import { randomUUID } from 'node:crypto'
import type { PgDb } from './db.js'
import type { Bounds } from '../bounded.js'
import type { Clock } from '../clock.js'
import type { CardTransaction, MerchantSetup } from '../acquiring/service.js'
import { ACQ_BOUNDS, type AcquiringStore } from '../acquiring/store.js'

export interface PgAcquiringOptions {
  /** Whose rows these are; default a random one (an empty store). */
  namespace?: string
  bounds?: Bounds
}

type Stored = Omit<CardTransaction, 'amount' | 'fee'> & { amount: string; fee: string }

export class PgAcquiringStore implements AcquiringStore {
  readonly namespace: string
  #bounds: Bounds
  constructor(private db: PgDb, private clock: Clock, o: PgAcquiringOptions = {}) {
    this.namespace = o.namespace ?? randomUUID()
    this.#bounds = o.bounds ?? ACQ_BOUNDS
    if (!(this.#bounds.max >= 1)) throw new Error(`bounds.max must be at least 1, not ${this.#bounds.max}`)
  }

  async merchant(key: string) {
    const r = await this.db.pool.query('select setup from acq_merchants where ns = $1 and customer = $2', [this.namespace, key])
    return r.rows[0]?.setup as MerchantSetup | undefined
  }

  async setMerchant(key: string, m: MerchantSetup | undefined) {
    if (m === undefined) await this.db.pool.query('delete from acq_merchants where ns = $1 and customer = $2', [this.namespace, key])
    else {
      await this.db.pool.query(
        'insert into acq_merchants (ns, customer, setup) values ($1, $2, $3) on conflict (ns, customer) do update set setup = excluded.setup',
        [this.namespace, key, JSON.stringify(m)])
    }
  }

  async nextRef() {
    const r = await this.db.pool.query(
      'insert into acq_counters (ns, seq) values ($1, 4901) on conflict (ns) do update set seq = acq_counters.seq + 1 returning seq', [this.namespace])
    return String(r.rows[0].seq)
  }

  async add(t: CardTransaction) {
    const now = this.clock.now().getTime()
    const stored: Stored = { ...t, amount: t.amount.toString(), fee: t.fee.toString() }
    const c = await this.db.pool.connect()
    try {
      await c.query('begin')
      await c.query(
        `insert into acq_transactions (ns, ref, account, tx, ord, until) values ($1, $2, $3, $4, nextval('acq_seq'), $5)
         on conflict (ns, ref) do update set account = excluded.account, tx = excluded.tx, ord = excluded.ord, until = excluded.until`,
        [this.namespace, t.ref, t.account, JSON.stringify(stored), this.#bounds.ttlMs === undefined ? null : now + this.#bounds.ttlMs])
      await c.query('delete from acq_transactions where ns = $1 and until is not null and until <= $2', [this.namespace, now])
      await c.query(
        'delete from acq_transactions where ns = $1 and ord in (select ord from acq_transactions where ns = $1 order by ord desc offset $2)',
        [this.namespace, this.#bounds.max])
      await c.query('commit')
    } catch (e) {
      await c.query('rollback')
      throw e
    } finally {
      c.release()
    }
  }

  async transactions(account?: string) {
    const params: unknown[] = [this.namespace, this.clock.now().getTime()]
    if (account !== undefined) params.push(account)
    const r = await this.db.pool.query(
      `select tx from acq_transactions where ns = $1 and (until is null or until > $2) ${account !== undefined ? 'and account = $3' : ''} order by ord`, params)
    return r.rows.map((x): CardTransaction => {
      const s = x.tx as Stored
      return { ...s, amount: BigInt(s.amount), fee: BigInt(s.fee) }
    })
  }
}
