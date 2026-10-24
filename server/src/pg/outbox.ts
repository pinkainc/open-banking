// The ledger's outbox in Postgres (decision 990): PgLedger writes a booking's items with
// `insertOutbox` in the booking's transaction; OpenLedgerLedger writes them as intents
// before its booking (decision 992). Rows are JSON with times in ms, oldest first by `ord`.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { PgDb } from './db.js'
import type { OutboxItem, OutboxStore } from '../outbox.js'

export async function insertOutbox(q: pg.Pool | pg.PoolClient, ns: string, items: OutboxItem[]) {
  for (const i of items) {
    await q.query(`insert into outbox_items (ns, key, kind, payload, at, intent, ord) values ($1, $2, $3, $4, $5, $6, nextval('outbox_seq'))`,
      [ns, i.key, i.kind, JSON.stringify(i.payload), i.at, i.intent ?? null])
  }
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
