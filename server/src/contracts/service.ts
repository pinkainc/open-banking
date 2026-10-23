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
import { randomUUID } from 'node:crypto'
import type { Clock } from '../clock.js'
import { keyOf, type Customer, type CustomerKey, type Directory } from '../directory.js'
import { dateTallinn } from '../time.js'
import { bdoc } from './bdoc.js'

export type ContractStatus = 'PENDING' | 'ACTIVE' | 'CLOSED'

/**
 * The services of a new contract: P 14 takes them "from active service provider contract
 * configuration"; this is the set of the P 14 sample (decision 413).
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

export class Contracts {
  readonly all: Contract[] = []
  readonly #startedAt: Date

  constructor(private directory: Directory, private clock: Clock) { this.#startedAt = clock.now() }

  /** ACTIVE contracts for the provider's seeded connections that have none yet. */
  #seed(provider: Customer) {
    for (const k of provider.connected ?? []) {
      if (this.all.some((c) => keyOf(c.provider) === keyOf(provider) && keyOf(c.customer) === keyOf(k) && c.status === 'ACTIVE')) continue
      this.all.push({
        id: randomUUID(), provider: { code: provider.code, country: provider.country }, customer: { code: k.code, country: k.country },
        status: 'ACTIVE', createdAt: this.#startedAt, changedAt: this.#startedAt, startDate: dateTallinn(this.#startedAt), services: [...DEFAULT_SERVICES],
      })
    }
  }

  of(provider: Customer): Contract[] {
    this.#seed(provider)
    return this.all.filter((c) => keyOf(c.provider) === keyOf(provider))
  }

  get(id: string) { return this.all.find((c) => c.id === id) }

  /** POST /contracts. Throws ContractError when the contract cannot be created. */
  create(provider: Customer, customer: CustomerKey): { contract: Contract; container: string } {
    const target = this.directory.get(customer)
    if (!target) throw new ContractError(`no customer ${keyOf(customer)}`)
    if (keyOf(target) === keyOf(provider)) throw new ContractError('a service provider cannot contract with itself')
    if (this.of(provider).some((c) => keyOf(c.customer) === keyOf(target) && c.status === 'PENDING')) {
      throw new ContractError(`customer ${keyOf(target)} already has a pending contract`)
    }
    const now = this.clock.now()
    const contract: Contract = {
      id: randomUUID(), provider: { code: provider.code, country: provider.country }, customer: { code: target.code, country: target.country },
      status: 'PENDING', createdAt: now, changedAt: now, services: [...DEFAULT_SERVICES],
    }
    this.all.push(contract)
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
  activate(id: string): Contract {
    const c = this.get(id)
    if (!c) throw new ContractError(`no contract ${id}`)
    if (c.status !== 'PENDING') throw new ContractError(`contract ${id} is ${c.status}`)
    const now = this.clock.now()
    for (const o of this.all) {
      if (o !== c && o.status === 'ACTIVE' && keyOf(o.provider) === keyOf(c.provider) && keyOf(o.customer) === keyOf(c.customer)) {
        o.status = 'CLOSED'; o.changedAt = now
      }
    }
    c.status = 'ACTIVE'; c.changedAt = now; c.startDate = dateTallinn(now)
    const provider = this.directory.get(c.provider)!
    provider.connected ??= []
    if (!provider.connected.some((k) => keyOf(k) === keyOf(c.customer))) provider.connected.push({ ...c.customer })
    return c
  }

  /** Ends a contract; without another active one the provider can no longer act for the customer. */
  close(id: string): Contract {
    const c = this.get(id)
    if (!c) throw new ContractError(`no contract ${id}`)
    if (c.status === 'CLOSED') throw new ContractError(`contract ${id} is CLOSED`)
    c.status = 'CLOSED'; c.changedAt = this.clock.now()
    const stillActive = this.all.some((o) => o.status === 'ACTIVE' && keyOf(o.provider) === keyOf(c.provider) && keyOf(o.customer) === keyOf(c.customer))
    const provider = this.directory.get(c.provider)
    if (!stillActive && provider?.connected) provider.connected = provider.connected.filter((k) => keyOf(k) !== keyOf(c.customer))
    return c
  }

  /**
   * GET /contracts: customers with their contracts, newest first. Date bounds are
   * inclusive Tallinn dates. Closed contracts appear only with a changedAt filter, and
   * then only for customers without an active contract (P 14).
   */
  list(provider: Customer, q: { createdAtMin?: string; createdAtMax?: string; changedAtMin?: string; changedAtMax?: string }) {
    const within = (d: Date, min?: string, max?: string) => {
      const day = dateTallinn(d)
      return (!min || day >= min) && (!max || day <= max)
    }
    const changedFilter = q.changedAtMin !== undefined || q.changedAtMax !== undefined
    const mine = this.of(provider)
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
      const cust = this.directory.get(contracts[0].customer)
      if (!cust) continue
      contracts.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || this.all.indexOf(b) - this.all.indexOf(a))
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
