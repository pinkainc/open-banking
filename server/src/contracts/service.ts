// Service provider contracts (P 14): which customers a service provider acts for.
//
//   POST /contracts  a pending contract for a customer, answered at once with the BDOC
//                    container to sign; activation is manual at LHV (here
//                    /_sim/contracts/:id/activate), and only then may the provider act for
//                    the customer (Directory `connected`)
//   GET  /contracts  the provider's customers with their pending and active contracts
//
// The connections of the seed (`connected`) are shown as ACTIVE contracts created when the
// emulator started; they are made the first time a provider's contracts are looked at.
//
// Contracts are kept in the emulator's keyed store (decision 982), so they survive a
// restart; their changes run under a claim on the provider (decision 983).
import { randomUUID } from 'node:crypto'
import type { Clock } from '../clock.js'
import { keyOf, type Customer, type CustomerKey, type DirectoryStore } from '../directory.js'
import { memoryKeyed, UNBOUNDED, type KeyedFactory, type KeyedStore } from '../keyed.js'
import { dateTallinn } from '../time.js'
import { bdoc } from './bdoc.js'

export type ContractStatus = 'PENDING' | 'ACTIVE' | 'CLOSED'

/**
 * The services of a new contract: P 14 takes them "from active service provider contract
 * configuration", i.e. the provider's own `services` (decision 501); without one, the set
 * of the P 14 sample (decision 413).
 */
export const DEFAULT_SERVICES = ['ACCOUNT_STATEMENT', 'CREDIT_DEBIT_NOTIFICATION', 'ACCOUNT_BALANCE', 'PAYMENTS_WITHOUT_SIGNATURE', 'HEARTBEAT']
/** Services listed with the customer's IBANs. */
const PER_IBAN = new Set(['CREDIT_DEBIT_NOTIFICATION', 'AUTOMATIC_ACCOUNT_STATEMENT'])

export interface Contract {
  id: string
  provider: CustomerKey
  customer: CustomerKey
  status: ContractStatus
  createdAt: Date
  changedAt: Date
  startDate?: string
  services: string[]
}

export class ContractError extends Error {}

/** How long a claim on a provider holds when its holder never lets go (a crash), by the clock. */
export const CLAIM_MS = 30 * 1000
/** How long a change waits for a claim another emulator holds. */
const CLAIM_WAIT_MS = 5000

/** A contract as the keyed store keeps it (decision 982): JSON, times in ms. */
type StoredContract = Omit<Contract, 'createdAt' | 'changedAt'> & { createdAt: number; changedAt: number }

const encode = (c: Contract): StoredContract => JSON.parse(JSON.stringify({ ...c, createdAt: c.createdAt.getTime(), changedAt: c.changedAt.getTime() }))
const decode = (s: StoredContract): Contract => ({ ...s, createdAt: new Date(s.createdAt), changedAt: new Date(s.changedAt) })
const pair = (c: Contract) => `${keyOf(c.provider)}|${keyOf(c.customer)}`

export class Contracts {
  /** Every contract by id, in the order they were made (decision 982). */
  #contracts: KeyedStore<StoredContract>
  /** The seeded connections already made a contract (provider|customer), once per namespace. */
  #seeded: KeyedStore<true>
  /** Who is changing a provider's contracts right now (decision 983). */
  #claims: KeyedStore<true>
  #queue: Promise<unknown> = Promise.resolve()
  readonly #startedAt: Date

  constructor(private directory: DirectoryStore, private clock: Clock, keyed: KeyedFactory = memoryKeyed(clock)) {
    this.#startedAt = clock.now()
    this.#contracts = keyed('contracts', UNBOUNDED)
    this.#seeded = keyed('contract-seeds', UNBOUNDED)
    this.#claims = keyed('contract-claims', { ttlMs: CLAIM_MS, max: 100_000 })
  }

  /** Every contract, oldest first (copies: change them through the methods). */
  async all(): Promise<Contract[]> { return (await this.#contracts.entries()).map(([, s]) => decode(s)) }

  /** ACTIVE contracts for the provider's seeded connections that have none yet. */
  async #seed(provider: Customer, all: Contract[]) {
    for (const k of provider.connected ?? []) {
      if (all.some((c) => keyOf(c.provider) === keyOf(provider) && keyOf(c.customer) === keyOf(k) && c.status === 'ACTIVE')) continue
      const c: Contract = {
        id: randomUUID(), provider: { code: provider.code, country: provider.country }, customer: { code: k.code, country: k.country },
        status: 'ACTIVE', createdAt: this.#startedAt, changedAt: this.#startedAt, startDate: dateTallinn(this.#startedAt), services: [...DEFAULT_SERVICES],
      }
      // One emulator of a namespace makes it, once (a restart does not make another).
      if (!(await this.#seeded.add(pair(c), true))) continue
      await this.#contracts.set(c.id, encode(c))
      all.push(c)
    }
  }

  async of(provider: Customer): Promise<Contract[]> {
    const all = await this.all()
    await this.#seed(provider, all)
    return all.filter((c) => keyOf(c.provider) === keyOf(provider))
  }

  async get(id: string) {
    const s = await this.#contracts.get(id)
    return s && decode(s)
  }

  /** Services of the provider's ACTIVE contract with the customer; none without one. */
  async servicesFor(provider: Customer, customer: CustomerKey): Promise<string[]> {
    const active = (await this.of(provider)).find((c) => c.status === 'ACTIVE' && keyOf(c.customer) === keyOf(customer))
    return active ? active.services : []
  }

  /**
   * Runs f holding the provider's claim (one change of its contracts and `connected` at a
   * time across emulators on a namespace), after the ones before it in this process.
   */
  #changing<T>(provider: CustomerKey, f: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(async () => {
      const key = keyOf(provider)
      for (const until = Date.now() + CLAIM_WAIT_MS; !(await this.#claims.add(key, true));) {
        if (Date.now() > until) throw new Error(`the contracts of ${key} are being changed elsewhere`)
        await new Promise((r) => setTimeout(r, 10))
      }
      try { return await f() } finally { await this.#claims.take(key) }
    })
    this.#queue = run.catch(() => undefined)
    return run
  }

  /** POST /contracts. Throws ContractError when the contract cannot be created. */
  create(provider: Customer, customer: CustomerKey): Promise<{ contract: Contract; container: string }> {
    return this.#changing(provider, () => this.#create(provider, customer))
  }

  async #create(provider: Customer, customer: CustomerKey): Promise<{ contract: Contract; container: string }> {
    const target = await this.directory.get(customer)
    if (!target) throw new ContractError(`no customer ${keyOf(customer)}`)
    if (keyOf(target) === keyOf(provider)) throw new ContractError('a service provider cannot contract with itself')
    if ((await this.of(provider)).some((c) => keyOf(c.customer) === keyOf(target) && c.status === 'PENDING')) {
      throw new ContractError(`customer ${keyOf(target)} already has a pending contract`)
    }
    const now = this.clock.now()
    const contract: Contract = {
      id: randomUUID(), provider: { code: provider.code, country: provider.country }, customer: { code: target.code, country: target.country },
      status: 'PENDING', createdAt: now, changedAt: now, services: [...(provider.services ?? DEFAULT_SERVICES)],
    }
    await this.#contracts.set(contract.id, encode(contract))
    const text = [
      `Connect service contract ${contract.id}`,
      `Service provider: ${provider.name} (${provider.code}, ${provider.country})`,
      `Customer: ${target.name} (${target.code}, ${target.country})`,
      `Services: ${contract.services.join(', ')}`,
      `Created: ${now.toISOString()}`,
      '',
    ].join('\n')
    return { contract, container: bdoc(`contract-${contract.id}.txt`, text) }
  }

  /** LHV Client Services activate a pending contract; an earlier active one is closed. */
  activate(id: string): Promise<Contract> { return this.#onContract(id, (c) => this.#activate(c)) }

  /** f on the contract, read again holding its provider's claim. */
  async #onContract(id: string, f: (c: Contract) => Promise<Contract>): Promise<Contract> {
    const c = await this.get(id)
    if (!c) throw new ContractError(`no contract ${id}`)
    return this.#changing(c.provider, async () => f((await this.get(id))!))
  }

  async #activate(c: Contract): Promise<Contract> {
    const id = c.id
    if (c.status !== 'PENDING') throw new ContractError(`contract ${id} is ${c.status}`)
    const now = this.clock.now()
    for (const o of await this.all()) {
      if (o.id !== c.id && o.status === 'ACTIVE' && pair(o) === pair(c)) {
        o.status = 'CLOSED'; o.changedAt = now
        await this.#contracts.replace(o.id, encode(o))
      }
    }
    c.status = 'ACTIVE'; c.changedAt = now; c.startDate = dateTallinn(now)
    await this.#contracts.replace(c.id, encode(c))
    const provider = (await this.directory.get(c.provider))!
    const connected = provider.connected ?? []
    if (!connected.some((k) => keyOf(k) === keyOf(c.customer))) await this.directory.update(provider, { connected: [...connected, { ...c.customer }] })
    return c
  }

  /** Ends a contract; without another active one the provider can no longer act for the customer. */
  close(id: string): Promise<Contract> { return this.#onContract(id, (c) => this.#close(c)) }

  async #close(c: Contract): Promise<Contract> {
    if (c.status === 'CLOSED') throw new ContractError(`contract ${c.id} is CLOSED`)
    c.status = 'CLOSED'; c.changedAt = this.clock.now()
    await this.#contracts.replace(c.id, encode(c))
    const stillActive = (await this.all()).some((o) => o.status === 'ACTIVE' && pair(o) === pair(c))
    const provider = await this.directory.get(c.provider)
    if (!stillActive && provider?.connected) await this.directory.update(provider, { connected: provider.connected.filter((k) => keyOf(k) !== keyOf(c.customer)) })
    return c
  }

  /**
   * GET /contracts: customers with their contracts, newest first. Date bounds are
   * inclusive Tallinn dates. Closed contracts appear only with a changedAt filter, and
   * then only for customers without an active contract (P 14).
   */
  async list(provider: Customer, q: { createdAtMin?: string; createdAtMax?: string; changedAtMin?: string; changedAtMax?: string }) {
    const within = (d: Date, min?: string, max?: string) => {
      const day = dateTallinn(d)
      return (!min || day >= min) && (!max || day <= max)
    }
    const changedFilter = q.changedAtMin !== undefined || q.changedAtMax !== undefined
    const mine = await this.of(provider)
    const order = new Map(mine.map((c, i) => [c.id, i]))
    const byCustomer = new Map<string, Contract[]>()
    for (const c of mine) {
      if (!within(c.createdAt, q.createdAtMin, q.createdAtMax) || !within(c.changedAt, q.changedAtMin, q.changedAtMax)) continue
      if (c.status === 'CLOSED') {
        if (!changedFilter) continue
        if (mine.some((o) => o.status === 'ACTIVE' && keyOf(o.customer) === keyOf(c.customer))) continue
      }
      const k = keyOf(c.customer)
      byCustomer.set(k, [...(byCustomer.get(k) ?? []), c])
    }
    const customers = []
    for (const [, contracts] of [...byCustomer].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const cust = await this.directory.get(contracts[0].customer)
      if (!cust) continue
      contracts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || order.get(b.id)! - order.get(a.id)!)
      customers.push({
        companyCode: cust.code, companyCodeIssuer: cust.country, name: cust.name,
        contracts: contracts.map((c) => ({
          id: c.id, status: c.status, ...(c.startDate && c.status !== 'PENDING' ? { startDate: c.startDate } : {}),
          services: c.services.map((name) => (PER_IBAN.has(name) && cust.accounts.length ? { name, ibans: [...cust.accounts] } : { name })),
        })),
      })
    }
    return { customers }
  }
}
