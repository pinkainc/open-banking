// Agency accounts and the account manager's set-ups in Postgres (decision 943): the
// semantics of MemoryAgencyStore under a namespace, so a restart keeps what the agents
// synchronised and what /_sim/agency set up, and emulators on one namespace share it.
//
// - An account is one row per entity and key (agencyKey), the whole account as JSON with
//   its times as milliseconds; a rewrite takes a new `ord`, so lists come in the order of
//   the last write, as BoundedMap's.
// - Bounds as in memory: an optional TTL (`until` from the injected clock) and a maximum
//   count, the oldest dropped first when a new account goes over it.
// - Every call is one statement except put() of a new account, which then trims the oldest
//   over the maximum in the same transaction.
import { randomUUID } from 'node:crypto'
import type { PgDb } from './db.js'
import type { Bounds } from '../bounded.js'
import type { Clock } from '../clock.js'
import type { CustomerKey } from '../directory.js'
import { AGENCY_BOUNDS, agencyKey, agentKey, type AgencyAccount, type AgencyBank, type AgencySetup, type AgencyStore } from '../agency/store.js'

export interface PgAgencyOptions {
  /** Whose rows these are; default a random one (an empty store). */
  namespace?: string
  bounds?: Bounds
}

type Stored = Omit<AgencyAccount, 'createdAt' | 'updatedAt'> & { createdAt: number; updatedAt: number }
const toRow = (a: AgencyAccount): Stored => ({ ...a, createdAt: a.createdAt.getTime(), updatedAt: a.updatedAt.getTime() })
const fromRow = (s: Stored): AgencyAccount => ({ ...s, createdAt: new Date(s.createdAt), updatedAt: new Date(s.updatedAt) })

export class PgAgencyStore implements AgencyStore {
  readonly namespace: string
  #bounds: Bounds
  constructor(private db: PgDb, private clock: Clock, o: PgAgencyOptions = {}) {
    this.namespace = o.namespace ?? randomUUID()
    this.#bounds = o.bounds ?? AGENCY_BOUNDS
    if (!(this.#bounds.max >= 1)) throw new Error(`bounds.max must be at least 1, not ${this.#bounds.max}`)
  }

  #now() { return this.clock.now().getTime() }

  async #accounts(where: string, params: unknown[]): Promise<AgencyAccount[]> {
    const r = await this.db.pool.query(
      `select account from agency_accounts where ns = $1 and (until is null or until > $2) ${where} order by ord`,
      [this.namespace, this.#now(), ...params])
    return r.rows.map((x) => fromRow(x.account))
  }

  async get(bank: AgencyBank, identifier: string) {
    const key = agencyKey(identifier)
    return key ? (await this.#accounts('and bank = $3 and id = $4', [bank, key]))[0] : undefined
  }

  async find(identifier: string) {
    const key = agencyKey(identifier)
    if (!key) return []
    // LHV EE first, as MemoryAgencyStore.
    return (await this.#accounts('and id = $3', [key])).sort((a, b) => (a.bank < b.bank ? -1 : a.bank > b.bank ? 1 : 0))
  }

  ofAgent(agent: CustomerKey, bank?: AgencyBank) {
    return bank ? this.#accounts('and agent = $3 and bank = $4', [agentKey(agent), bank]) : this.#accounts('and agent = $3', [agentKey(agent)])
  }

  all() { return this.#accounts('', []) }

  async count() {
    const r = await this.db.pool.query('select count(*)::int as n from agency_accounts where ns = $1 and (until is null or until > $2)', [this.namespace, this.#now()])
    return r.rows[0].n as number
  }

  async put(a: AgencyAccount) {
    const now = this.#now()
    const until = this.#bounds.ttlMs === undefined ? null : now + this.#bounds.ttlMs
    const c = await this.db.pool.connect()
    try {
      await c.query('begin')
      const r = await c.query(
        `insert into agency_accounts (ns, bank, id, agent, account, ord, until) values ($1, $2, $3, $4, $5, nextval('agency_seq'), $6)
         on conflict (ns, bank, id) do update set agent = excluded.agent, account = excluded.account, ord = excluded.ord, until = excluded.until
         returning (xmax = 0) as inserted`,
        [this.namespace, a.bank, a.id, agentKey(a.agent), JSON.stringify(toRow(a)), until])
      if (r.rows[0].inserted) {
        // Expired rows go first, then the oldest over the maximum (BoundedMap's #dropFront).
        await c.query('delete from agency_accounts where ns = $1 and until is not null and until <= $2', [this.namespace, now])
        await c.query(
          `delete from agency_accounts where ns = $1 and ord in (
             select ord from agency_accounts where ns = $1 order by ord desc offset $2)`, [this.namespace, this.#bounds.max])
      }
      await c.query('commit')
    } catch (e) {
      await c.query('rollback')
      throw e
    } finally {
      c.release()
    }
  }

  async setup(agent: CustomerKey) {
    const r = await this.db.pool.query('select setup from agency_setups where ns = $1 and agent = $2', [this.namespace, agentKey(agent)])
    return (r.rows[0]?.setup ?? undefined) as AgencySetup | undefined
  }

  async setSetup(agent: CustomerKey, setup: AgencySetup | undefined, o: { ifAbsent?: boolean } = {}) {
    await this.db.pool.query(
      `insert into agency_setups (ns, agent, setup, ord) values ($1, $2, $3, nextval('agency_seq'))
       on conflict (ns, agent) do ${o.ifAbsent ? 'nothing' : 'update set setup = excluded.setup'}`,
      [this.namespace, agentKey(agent), setup === undefined ? null : JSON.stringify(setup)])
  }

  async setups() {
    const r = await this.db.pool.query('select agent, setup from agency_setups where ns = $1 and setup is not null order by ord', [this.namespace])
    return new Map<string, AgencySetup>(r.rows.map((x) => [x.agent, x.setup]))
  }
}
