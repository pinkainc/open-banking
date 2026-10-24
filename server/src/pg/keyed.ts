// KeyedStore in Postgres (decision 961): one row per (namespace, kind, key), the value as
// JSON. `ord` is the insertion order (a set moves the key to the newest), `until` the
// expiry in ms of the injected clock (null: no time to live). A write drops the expired
// and, beyond max, the oldest rows of its kind in the same transaction, as BoundedMap
// does on every set; reads ignore expired rows.
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { PgDb } from './db.js'
import type { Bounds } from '../bounded.js'
import type { Clock } from '../clock.js'
import type { KeyedFactory, KeyedStore } from '../keyed.js'

export class PgKeyed<V> implements KeyedStore<V> {
  constructor(private db: PgDb, private clock: Clock, readonly namespace: string, readonly kind: string, private bounds: Bounds) {
    if (!(bounds.max >= 1)) throw new Error(`bounds.max must be at least 1, not ${bounds.max}`)
  }

  #now() { return this.clock.now().getTime() }
  #until(now: number) { return this.bounds.ttlMs === undefined ? null : now + this.bounds.ttlMs }

  async get(key: string) {
    const r = await this.db.pool.query(
      'select value from keyed_entries where ns = $1 and kind = $2 and key = $3 and (until is null or until > $4)',
      [this.namespace, this.kind, key, this.#now()])
    return r.rows[0]?.value as V | undefined
  }

  async has(key: string) { return (await this.get(key)) !== undefined }

  async set(key: string, value: V) {
    await this.#write(async (c, now) => {
      await c.query(
        `insert into keyed_entries (ns, kind, key, value, ord, until) values ($1, $2, $3, $4, nextval('keyed_seq'), $5)
         on conflict (ns, kind, key) do update set value = excluded.value, ord = excluded.ord, until = excluded.until`,
        [this.namespace, this.kind, key, JSON.stringify(value), this.#until(now)])
      return true
    })
  }

  async add(key: string, value: V) {
    return this.#write(async (c, now) => {
      // An expired row counts as absent: replaced, as BoundedMap forgets it on read.
      const r = await c.query(
        `insert into keyed_entries (ns, kind, key, value, ord, until) values ($1, $2, $3, $4, nextval('keyed_seq'), $5)
         on conflict (ns, kind, key) do update set value = excluded.value, ord = excluded.ord, until = excluded.until
           where keyed_entries.until is not null and keyed_entries.until <= $6
         returning key`,
        [this.namespace, this.kind, key, JSON.stringify(value), this.#until(now), now])
      return r.rowCount === 1
    })
  }

  async take(key: string) {
    const r = await this.db.pool.query(
      'delete from keyed_entries where ns = $1 and kind = $2 and key = $3 returning value, until',
      [this.namespace, this.kind, key])
    const row = r.rows[0]
    if (!row || (row.until !== null && Number(row.until) <= this.#now())) return undefined
    return row.value as V
  }

  async replace(key: string, value: V, expected?: V) {
    // With expected: a compare-and-set (decision 1008); jsonb equality ignores key order.
    const r = await this.db.pool.query(
      `update keyed_entries set value = $4 where ns = $1 and kind = $2 and key = $3 and (until is null or until > $5)
         and ($6::jsonb is null or value = $6::jsonb)`,
      [this.namespace, this.kind, key, JSON.stringify(value), this.#now(), expected === undefined ? null : JSON.stringify(expected)])
    return r.rowCount === 1
  }

  async entries() {
    const r = await this.db.pool.query(
      'select key, value from keyed_entries where ns = $1 and kind = $2 and (until is null or until > $3) order by ord',
      [this.namespace, this.kind, this.#now()])
    return r.rows.map((x): [string, V] => [x.key, x.value])
  }

  async #write(f: (c: pg.PoolClient, now: number) => Promise<boolean>): Promise<boolean> {
    const now = this.#now()
    const c = await this.db.pool.connect()
    try {
      await c.query('begin')
      const done = await f(c, now)
      await c.query('delete from keyed_entries where ns = $1 and kind = $2 and until is not null and until <= $3', [this.namespace, this.kind, now])
      if (this.bounds.max < Number.MAX_SAFE_INTEGER) {
        await c.query(
          `delete from keyed_entries where ns = $1 and kind = $2 and ord in
             (select ord from keyed_entries where ns = $1 and kind = $2 order by ord desc offset $3)`,
          [this.namespace, this.kind, this.bounds.max])
      }
      await c.query('commit')
      return done
    } catch (e) {
      await c.query('rollback')
      throw e
    } finally {
      c.release()
    }
  }
}

/** Every kind of an emulator in Postgres under one namespace (default a random one: empty). */
export const pgKeyed = (db: PgDb, clock: Clock, namespace: string = randomUUID()): KeyedFactory =>
  <V>(kind: string, bounds: Bounds) => new PgKeyed<V>(db, clock, namespace, kind, bounds)
