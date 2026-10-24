// The ledger's outbox in Postgres (decision 990): PgLedger writes a booking's items with
// `insertOutbox` in the booking's transaction; OpenLedgerLedger writes them as intents
// before its booking (decision 992). Rows are JSON with times in ms, oldest first by `ord`.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { PgDb } from './db.js'
import type { OutboxItem, OutboxStore } from '../outbox.js'

/** One statement for all items; an item whose key is stored already is left as stored (a rerun's deterministic key, decision 1007). */
export async function insertOutbox(q: pg.Pool | pg.PoolClient, ns: string, items: OutboxItem[]) {
  if (!items.length) return
  const values: unknown[] = []
  const rows = items.map((i, n) => {
    values.push(i.key, i.kind, JSON.stringify(i.payload), i.at, i.intent ?? null)
    const b = n * 5
    return `($1, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, nextval('outbox_seq'))`
  })
  await q.query(`insert into outbox_items (ns, key, kind, payload, at, intent, ord) values ${rows.join(', ')} on conflict (ns, key) do nothing`, [ns, ...values])
}

export class PgOutbox implements OutboxStore {
  readonly namespace: string
  constructor(private db: PgDb, o: { namespace?: string } = {}) { this.namespace = o.namespace ?? randomUUID() }

  put(items: OutboxItem[]) { return insertOutbox(this.db.pool, this.namespace, items) }

  async pending(): Promise<OutboxItem[]> {
    const { rows } = await this.db.pool.query('select key, kind, payload, at, intent from outbox_items where ns = $1 order by ord', [this.namespace])
    return rows.map((r) => ({ key: r.key, kind: r.kind, payload: r.payload, at: Number(r.at), ...(r.intent !== null ? { intent: r.intent } : {}) }))
  }

  async remove(keys: string[]) {
    if (keys.length) await this.db.pool.query('delete from outbox_items where ns = $1 and key = any($2)', [this.namespace, keys])
  }
}
