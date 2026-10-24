// Who the bank knows: customers (legal entities identified by registration code and
// country), their accounts, and which of them hold a connection certificate. A
// customer that is a service provider reaches its connected customers through its
// own certificate, selecting one with the Client-Code / Client-Country headers.
import { checkSetup, type AgencySetup } from './agency/store.js'
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
  /**
   * Indirect scheme access set-up by the account manager (P 11, decision 801): the
   * agreement, its ranges with master accounts, the CoP/VoP responder, notifications, RTF.
   */
  agency?: AgencySetup
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

export class Directory {
  #customers = new Map<string, Customer>()
  #accountOwner = new Map<string, string>()

  add(input: CustomerInput): Customer {
    if (input.payments !== undefined && input.payments !== 'DIRECT' && input.payments !== 'PENDING') throw new Error('payments must be DIRECT or PENDING')
    const dd = input.directDebit
    if (dd !== undefined && (typeof dd !== 'object' || dd === null || Object.entries(dd).some(([k, v]) => (k !== 'agreement' && k !== 'debtorNotification') || typeof v !== 'boolean'))) {
      throw new Error('directDebit takes the booleans agreement and debtorNotification')
    }
    const c: Customer = {
      code: input.code, country: input.country.toUpperCase(), name: input.name, accounts: [],
      camt054: input.camt054 ?? '02',
      ...(input.services ? { services: [...input.services] } : {}),
      ...(input.certificates ? { certificates: [...input.certificates] } : {}),
      ...(input.payments ? { payments: input.payments } : {}),
      ...(input.directDebit ? { directDebit: { ...input.directDebit } } : {}),
      connected: input.connected?.map((k) => (Array.isArray(k) ? { code: k[0], country: k[1].toUpperCase() } : { code: k.code, country: k.country.toUpperCase() })),
    }
    this.#customers.set(keyOf(c), c)
    for (const a of input.accounts ?? []) this.addAccount(c, typeof a === 'string' ? a : a.iban)
    if (input.agency !== undefined) c.agency = checkSetup(input.agency, c.accounts)
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
