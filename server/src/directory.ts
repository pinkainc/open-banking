// Who the bank knows: customers (legal entities identified by registration code and
// country), their accounts, and which of them hold a connection certificate. A
// customer that is a service provider reaches its connected customers through its
// own certificate, selecting one with the Client-Code / Client-Country headers.
//
// Behind an async store (decision 970): MemoryDirectory below, PgDirectory (pg/directory.ts)
// in Postgres. A returned customer is a copy; changes go through update().
import type { AgencySetup } from './agency/store.js'
import type { Clock } from './clock.js'
import { normalizeIban } from './iban.js'
import { dateLondon } from './time.js'

export interface CustomerKey { code: string; country: string }
export const keyOf = (c: CustomerKey) => `${c.country}:${c.code}`

export interface Customer extends CustomerKey {
  name: string
  accounts: string[]
  /** Version of the debit/credit notifications this customer receives (default 02). */
  camt054: '02' | '08'
  /** Set when the customer is a service provider: the customers it acts for. */
  connected?: CustomerKey[]
  /**
   * Services enabled in the customer's own Connect contract (P 14 names, decision 501);
   * undefined: every service. A provider's list is also what its new customer contracts get.
   */
  services?: string[]
  /**
   * SHA-256 fingerprints of the authentication certificates on the customer's contract
   * (decision 502); undefined: any certificate with the customer's code. `[]`: none.
   */
  certificates?: string[]
  /**
   * How POST /payment is confirmed (P 08 "Payment confirmation"): DIRECT processing
   * (default) or PENDING, waiting for SCA in the internet bank (decision 521).
   */
  payments?: 'DIRECT' | 'PENDING'
  /**
   * SEPA Direct Debit set-up by the account manager (P 09, decision 527): `agreement`
   * lets the customer send collections, `debtorNotification` sends it the incoming
   * collection notifications. Both off when absent.
   */
  directDebit?: { agreement?: boolean; debtorNotification?: boolean }
}

export interface CustomerInput {
  code: string
  country: string
  name: string
  accounts?: (string | {
    iban: string; balances?: Record<string, string>; /** Master account agreement for VIBANs. */ viban?: boolean
    /** UK GET /accounts/list (decision 706): nickname, opening day (YYYY-MM-DD, default the day it is added), closed. */
    nickname?: string; opened?: string; closed?: boolean
  })[]
  camt054?: '02' | '08'
  connected?: (CustomerKey | [string, string])[]
  services?: string[]
  certificates?: string[]
  payments?: 'DIRECT' | 'PENDING'
  /** Connect payment limits in EUR (decisions 109, 524); kept by the account reports. */
  limits?: { daily?: string; monthly?: string; instant?: string }
  directDebit?: { agreement?: boolean; debtorNotification?: boolean }
  agency?: AgencySetup
}

/** UK account list details (decisions 706, 971). */
export interface AccountInfo { opened: string; nickname?: string; closed?: boolean }

/** What update() may change on a stored customer. */
export type CustomerPatch = Partial<Pick<Customer, 'name' | 'camt054' | 'connected' | 'services' | 'certificates' | 'payments' | 'directDebit'>>

export interface DirectoryStore {
  /**
   * Adds the customer with its accounts and returns it as stored. An existing key is
   * replaced (keeping its place, releasing accounts it no longer lists), or with ifAbsent
   * kept as it is (decision 972). Throws, writing nothing, on invalid input or an account
   * of another customer.
   */
  add(input: CustomerInput, o?: { ifAbsent?: boolean }): Promise<Customer>
  /** Changes a stored customer; undefined when there is none. */
  update(k: CustomerKey, patch: CustomerPatch): Promise<Customer | undefined>
  get(k: CustomerKey): Promise<Customer | undefined>
  /** Customers with this registration code (any country): how a certificate is resolved. */
  byCode(code: string): Promise<Customer[]>
  ownerOf(iban: string): Promise<Customer | undefined>
  /** Every customer, in the order they were first added. */
  all(): Promise<Customer[]>
  /** The list details of an own account. */
  account(iban: string): Promise<AccountInfo | undefined>
}

/** A customer as stored: everything but its accounts. */
export type StoredCustomer = Omit<Customer, 'accounts'>

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Validates an input and makes what both stores write: the customer and its accounts with details. */
export function prepare(input: CustomerInput, clock: Clock): { key: string; customer: StoredCustomer; accounts: [string, AccountInfo][] } {
  if (input.payments !== undefined && input.payments !== 'DIRECT' && input.payments !== 'PENDING') throw new Error('payments must be DIRECT or PENDING')
  const dd = input.directDebit
  if (dd !== undefined && (typeof dd !== 'object' || dd === null || Object.entries(dd).some(([k, v]) => (k !== 'agreement' && k !== 'debtorNotification') || typeof v !== 'boolean'))) {
    throw new Error('directDebit takes the booleans agreement and debtorNotification')
  }
  const accounts = new Map<string, AccountInfo>()
  for (const a of input.accounts ?? []) {
    const info: { opened?: string; nickname?: string; closed?: boolean } = typeof a === 'string' ? {} : a
    if (info.opened !== undefined && (!DATE.test(info.opened) || Number.isNaN(Date.parse(info.opened)))) throw new Error(`opened must be YYYY-MM-DD, not ${info.opened}`)
    if (info.nickname !== undefined && typeof info.nickname !== 'string') throw new Error('nickname must be a string')
    if (info.closed !== undefined && typeof info.closed !== 'boolean') throw new Error('closed must be a boolean')
    accounts.set(normalizeIban(typeof a === 'string' ? a : a.iban), {
      opened: info.opened ?? dateLondon(clock.now()),
      ...(info.nickname ? { nickname: info.nickname } : {}), ...(info.closed ? { closed: true } : {}),
    })
  }
  const connected = input.connected?.map((k) => (Array.isArray(k) ? { code: k[0], country: k[1].toUpperCase() } : { code: k.code, country: k.country.toUpperCase() }))
  const customer: StoredCustomer = {
    code: input.code, country: input.country.toUpperCase(), name: input.name,
    camt054: input.camt054 ?? '02',
    ...(input.services ? { services: [...input.services] } : {}),
    ...(input.certificates ? { certificates: [...input.certificates] } : {}),
    ...(input.payments ? { payments: input.payments } : {}),
    ...(input.directDebit ? { directDebit: { ...input.directDebit } } : {}),
    ...(connected ? { connected } : {}),
  }
  return { key: keyOf(customer), customer, accounts: [...accounts] }
}

/** The patch applied, as both stores do it: an undefined field is removed. */
export function patched(c: StoredCustomer, patch: CustomerPatch): StoredCustomer {
  const out: Record<string, unknown> = { ...c }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k]
    else out[k] = JSON.parse(JSON.stringify(v))
  }
  return out as unknown as StoredCustomer
}

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const upper = (k: CustomerKey) => keyOf({ code: k.code, country: k.country.toUpperCase() })

export class MemoryDirectory implements DirectoryStore {
  #customers = new Map<string, StoredCustomer>()
  #accounts = new Map<string, { owner: string; info: AccountInfo }>()
  constructor(private clock: Clock) {}

  #view(key: string): Customer | undefined {
    const c = this.#customers.get(key)
    if (!c) return undefined
    const accounts = [...this.#accounts].filter(([, a]) => a.owner === key).map(([iban]) => iban)
    return { ...copy(c), accounts }
  }

  async add(input: CustomerInput, o: { ifAbsent?: boolean } = {}): Promise<Customer> {
    const p = prepare(input, this.clock)
    if (o.ifAbsent && this.#customers.has(p.key)) return this.#view(p.key)!
    for (const [iban] of p.accounts) {
      const owner = this.#accounts.get(iban)?.owner
      if (owner && owner !== p.key) throw new Error(`account ${iban} already belongs to ${owner}`)
    }
    this.#customers.set(p.key, p.customer)
    const listed = new Set(p.accounts.map(([iban]) => iban))
    for (const [iban, a] of this.#accounts) if (a.owner === p.key && !listed.has(iban)) this.#accounts.delete(iban)
    // A Map keeps the first place of a key: an account listed again stays where it was.
    for (const [iban, info] of p.accounts) this.#accounts.set(iban, { owner: p.key, info })
    return this.#view(p.key)!
  }

  async update(k: CustomerKey, patch: CustomerPatch) {
    const key = upper(k)
    const c = this.#customers.get(key)
    if (!c) return undefined
    this.#customers.set(key, patched(c, patch))
    return this.#view(key)
  }

  async get(k: CustomerKey) { return this.#view(upper(k)) }

  async byCode(code: string) { return [...this.#customers.keys()].filter((k) => this.#customers.get(k)!.code === code).map((k) => this.#view(k)!) }

  async ownerOf(iban: string) {
    const a = this.#accounts.get(normalizeIban(iban))
    return a ? this.#view(a.owner) : undefined
  }

  async all() { return [...this.#customers.keys()].map((k) => this.#view(k)!) }

  async account(iban: string) {
    const a = this.#accounts.get(normalizeIban(iban))
    return a ? copy(a.info) : undefined
  }
}
