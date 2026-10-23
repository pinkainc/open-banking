// Who the bank knows: customers (legal entities identified by registration code and
// country), their accounts, and which of them hold a connection certificate. A
// customer that is a service provider reaches its connected customers through its
// own certificate, selecting one with the Client-Code / Client-Country headers.
import { normalizeIban } from './iban.js'

export interface CustomerKey { code: string; country: string }
export const keyOf = (c: CustomerKey) => `${c.country}:${c.code}`

export interface Customer extends CustomerKey {
  name: string
  accounts: string[]
  /** Version of the debit/credit notifications this customer receives (default 02). */
  camt054: '02' | '08'
  /** Set when the customer is a service provider: the customers it acts for. */
  connected?: CustomerKey[]
}

export interface CustomerInput {
  code: string
  country: string
  name: string
  accounts?: (string | { iban: string; balances?: Record<string, string> })[]
  camt054?: '02' | '08'
  connected?: (CustomerKey | [string, string])[]
}

export class Directory {
  #customers = new Map<string, Customer>()
  #accountOwner = new Map<string, string>()

  add(input: CustomerInput): Customer {
    const c: Customer = {
      code: input.code, country: input.country.toUpperCase(), name: input.name, accounts: [],
      camt054: input.camt054 ?? '02',
      connected: input.connected?.map((k) => (Array.isArray(k) ? { code: k[0], country: k[1].toUpperCase() } : { code: k.code, country: k.country.toUpperCase() })),
    }
    this.#customers.set(keyOf(c), c)
    for (const a of input.accounts ?? []) this.addAccount(c, typeof a === 'string' ? a : a.iban)
    return c
  }

  addAccount(c: CustomerKey, iban: string) {
    const n = normalizeIban(iban)
    const owner = this.#accountOwner.get(n)
    if (owner && owner !== keyOf(c)) throw new Error(`account ${n} already belongs to ${owner}`)
    const cust = this.get(c)
    if (!cust) throw new Error(`no customer ${keyOf(c)}`)
    if (!cust.accounts.includes(n)) cust.accounts.push(n)
    this.#accountOwner.set(n, keyOf(c))
  }

  get(k: CustomerKey): Customer | undefined { return this.#customers.get(keyOf({ code: k.code, country: k.country.toUpperCase() })) }

  /** Customers with this registration code (any country): how a certificate is resolved. */
  byCode(code: string): Customer[] { return [...this.#customers.values()].filter((c) => c.code === code) }

  ownerOf(iban: string): Customer | undefined {
    const k = this.#accountOwner.get(normalizeIban(iban))
    return k ? this.#customers.get(k) : undefined
  }

  all(): Customer[] { return [...this.#customers.values()] }
}
