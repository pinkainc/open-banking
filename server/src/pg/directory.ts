// The customer and account directory in Postgres (decisions 970, 973): MemoryDirectory's
// semantics under a namespace, so a restart keeps the customers /_sim added and what was
// switched on them, and emulators on one namespace share them.
//
// - A customer is one row, everything but its accounts as JSON; an account is one row with
//   its owner and list details. `ord` (dir_seq) is the order of first addition.
// - Reads are plain selects, no cache. Writes are one transaction holding an advisory lock
//   on the namespace, reading inside it what they check (the owner of an account, ifAbsent).
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { PgDb } from './db.js'
import type { Clock } from '../clock.js'
import { keyOf, patched, prepare, type AccountInfo, type Customer, type CustomerInput, type CustomerKey, type CustomerPatch, type DirectoryStore, type StoredCustomer } from '../directory.js'
import { normalizeIban } from '../iban.js'

const upper = (k: CustomerKey) => keyOf({ code: k.code, country: k.country.toUpperCase() })

export class PgDirectory implements DirectoryStore {
  readonly namespace: string
  constructor(private db: PgDb, private clock: Clock, o: { namespace?: string } = {}) { this.namespace = o.namespace ?? randomUUID() }

  /** Customers of the rows, with their accounts in order. */
  async #views(q: pg.Pool | pg.PoolClient, rows: { key: string; customer: StoredCustomer }[]): Promise<Customer[]> {
    if (!rows.length) return []
    const keys = rows.map((r) => r.key)
    const a = await q.query('select iban, owner from dir_accounts where ns = $1 and owner = any($2) order by ord', [this.namespace, keys])
    return rows.map((r) => ({ ...r.customer, accounts: a.rows.filter((x) => x.owner === r.key).map((x) => x.iban as string) }))
  }

  async #customers(q: pg.Pool | pg.PoolClient, where: string, params: unknown[]) {
    const r = await q.query(`select key, customer from dir_customers where ns = $1 ${where} order by ord`, [this.namespace, ...params])
    return this.#views(q, r.rows)
  }

  async #write<T>(f: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.db.pool.connect()
    try {
      await c.query('begin')
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [`directory:${this.namespace}`])
      const out = await f(c)
      await c.query('commit')
      return out
    } catch (e) {
      await c.query('rollback')
      throw e
    } finally {
      c.release()
    }
  }

  async add(input: CustomerInput, o: { ifAbsent?: boolean } = {}): Promise<Customer> {
    const p = prepare(input, this.clock)
    return this.#write(async (c) => {
      if (o.ifAbsent) {
        const [have] = await this.#customers(c, 'and key = $2', [p.key])
        if (have) return have
      }
      const ibans = p.accounts.map(([iban]) => iban)
      const taken = await c.query('select iban, owner from dir_accounts where ns = $1 and iban = any($2) and owner <> $3', [this.namespace, ibans, p.key])
      const first = ibans.find((i) => taken.rows.some((x) => x.iban === i))
      if (first) throw new Error(`account ${first} already belongs to ${taken.rows.find((x) => x.iban === first).owner}`)
      await c.query(
        `insert into dir_customers (ns, key, code, customer, ord) values ($1, $2, $3, $4, nextval('dir_seq'))
         on conflict (ns, key) do update set code = excluded.code, customer = excluded.customer`,
        [this.namespace, p.key, p.customer.code, JSON.stringify(p.customer)])
      await c.query('delete from dir_accounts where ns = $1 and owner = $2 and not (iban = any($3))', [this.namespace, p.key, ibans])
      for (const [iban, info] of p.accounts) {
        await c.query(
          `insert into dir_accounts (ns, iban, owner, info, ord) values ($1, $2, $3, $4, nextval('dir_seq'))
           on conflict (ns, iban) do update set info = excluded.info`,
          [this.namespace, iban, p.key, JSON.stringify(info)])
      }
      return (await this.#customers(c, 'and key = $2', [p.key]))[0]
    })
  }

  async update(k: CustomerKey, patch: CustomerPatch) {
    const key = upper(k)
    return this.#write(async (c) => {
      const r = await c.query('select customer from dir_customers where ns = $1 and key = $2', [this.namespace, key])
      if (!r.rows[0]) return undefined
      await c.query('update dir_customers set customer = $3 where ns = $1 and key = $2', [this.namespace, key, JSON.stringify(patched(r.rows[0].customer, patch))])
      return (await this.#customers(c, 'and key = $2', [key]))[0]
    })
  }

  async get(k: CustomerKey) { return (await this.#customers(this.db.pool, 'and key = $2', [upper(k)]))[0] }

  async byCode(code: string) { return this.#customers(this.db.pool, 'and code = $2', [code]) }

  async ownerOf(iban: string) {
    return (await this.#customers(this.db.pool, 'and key = (select owner from dir_accounts where ns = $1 and iban = $2)', [normalizeIban(iban)]))[0]
  }

  async all() { return this.#customers(this.db.pool, '', []) }

  async account(iban: string) {
    const r = await this.db.pool.query('select info from dir_accounts where ns = $1 and iban = $2', [this.namespace, normalizeIban(iban)])
    return r.rows[0]?.info as AccountInfo | undefined
  }
}
