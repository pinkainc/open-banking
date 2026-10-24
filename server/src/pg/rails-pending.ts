// Payments waiting at the rails in Postgres (decision 948): one row per ref under a
// namespace, taken with one `delete … returning`, so an outcome settles a payment once even
// with two emulators on the namespace, and a restarted one still finds it.
import { randomUUID } from 'node:crypto'
import type { PgDb } from './db.js'
import type { PendingRecord, RailsPending } from '../payments/pending.js'
import type { Scheme } from '../rails.js'

export class PgRailsPending implements RailsPending {
  readonly namespace: string
  constructor(private db: PgDb, o: { namespace?: string } = {}) { this.namespace = o.namespace ?? randomUUID() }

  async put(r: PendingRecord) {
    await this.db.pool.query(
      `insert into rails_pending (ns, ref, scheme, record, ord) values ($1, $2, $3, $4, nextval('rails_pending_seq'))
       on conflict (ns, ref) do update set scheme = excluded.scheme, record = excluded.record, ord = excluded.ord`,
      [this.namespace, r.ref, r.scheme, JSON.stringify(r)])
  }

  async take(ref: string, scheme?: Scheme) {
    const r = await this.db.pool.query(
      `delete from rails_pending where ns = $1 and ref = $2 ${scheme !== undefined ? 'and scheme = $3' : ''} returning record`,
      scheme !== undefined ? [this.namespace, ref, scheme] : [this.namespace, ref])
    return r.rows[0]?.record as PendingRecord | undefined
  }

  async refs() {
    const r = await this.db.pool.query('select ref from rails_pending where ns = $1 order by ord', [this.namespace])
    return r.rows.map((x) => x.ref as string)
  }
}
