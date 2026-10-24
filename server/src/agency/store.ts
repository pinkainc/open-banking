// Indirect scheme access (P 11, G indirect-scheme-access; decisions 800–819): the account
// manager's set-up of an agent (a service provider with an Indirect Scheme Access Service
// Agreement) and the agency accounts it synchronises with LHV. An agency account is not an
// LHV account: it is the agent's customer's account, identified by an IBAN or, in the UK,
// a sort code and account number, whose money is held on the agent's master account here.
//
// The store is the one place the rest of the server asks about agency accounts and the
// agents' set-ups (async, decision 940; MemoryAgencyStore here, PgAgencyStore in pg/agency.ts):
//   agency.get(bank, id)        one entity's account by IBAN, GB IBAN or 14-digit BBAN
//   agency.find(id)             the account in every entity (LHVEE first)
//   agency.ofAgent(agent, bank) an agent's accounts
//   agency.setup(agent)         the account manager's set-up of a customer
//   receivable(a, {instant})    whether a credit to it is accepted (ACTIVE; INST_RESTRICTED
//                               only for non-instant credits)
//   rangeFor(setup, country, id) the agreement range (and master account) covering an id
import { BoundedMap, type Bounds } from '../bounded.js'
import type { Clock } from '../clock.js'
import { keyOf, type CustomerKey } from '../directory.js'
import { normalizeIban } from '../iban.js'

export type AgencyBank = 'LHVEE' | 'LHVUK'
export type AgencyStatus = 'ACTIVE' | 'CLOSED' | 'INST_RESTRICTED'
export const AGENCY_STATUSES: AgencyStatus[] = ['ACTIVE', 'CLOSED', 'INST_RESTRICTED']
export type AccountCategory = 'PERSONAL' | 'BUSINESS'

/**
 * The bank identifiers an agreement covers, each with the master account (one of the
 * agent's own accounts here) that holds the money of the accounts in it: a GB sort code,
 * or the start of the national part of an IBAN after the check digits (`bank`, e.g. RABO
 * for NL..RABO…); neither is the whole country. `bic` is the BIC of those accounts (the
 * BankId of a VoP request), default the bank's own.
 */
export interface AgencyRange { country: string; sortCode?: string; bank?: string; master: string; bic?: string }

/** RTF deliveries (P 11 "RTF - Routing Table Files"): scheme names of decision 806. */
export const RTF_SCHEMES = ['step2.in', 'step2.di', 'rt1.in', 'rt1.di', 'sdd.in', 'sdd.di', 'tips', 't2'] as const
export type RtfScheme = (typeof RTF_SCHEMES)[number]

/**
 * What the account manager set up (decision 801): the agreement, its ranges, the CoP and
 * VoP responder services (which make Name and AccountCategory mandatory in the v2 sync),
 * the incoming CoP/VoP notifications ("enabled on request") and the RTF schemes delivered.
 */
export interface AgencySetup {
  agreement?: boolean
  ranges?: AgencyRange[]
  cop?: boolean
  vop?: boolean
  notifications?: boolean
  rtf?: RtfScheme[]
}

export interface AgencyAccount {
  bank: AgencyBank
  /** The key: a GB account's 14-digit sort code and account number, else the IBAN. */
  id: string
  country: string
  /** The IBAN, when it was synchronised with one. */
  iban?: string
  /** GB sort code (6) and account number (8), also when it came as a GB IBAN. */
  accountNo?: string
  status: AgencyStatus
  /** The holder's name (v1 Name, v2 Name): what CoP and VoP compare with. */
  name?: string
  category?: AccountCategory
  copOptOut: boolean
  agent: CustomerKey
  /** The agent's account here that holds the money (the range's master account). */
  master: string
  createdAt: Date
  updatedAt: Date
}

/** A GB IBAN: 4-letter bank code, sort code and account number. */
export const GB_IBAN = /^GB[0-9]{2}[A-Z]{4}[0-9]{14}$/
/** A GB sort code and account number. */
export const GB_ACCOUNT_NO = /^[0-9]{14}$/

/**
 * The store key of an identifier: a GB IBAN's sort code and account number, a 14-digit
 * sort code and account number as it is, any other IBAN normalised. Undefined when it is
 * neither (an `Othr/Id` that is no account number).
 */
export function agencyKey(identifier: string): string | undefined {
  const s = normalizeIban(identifier)
  if (GB_ACCOUNT_NO.test(s)) return s
  if (GB_IBAN.test(s)) return s.slice(8)
  return /^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$/.test(s) ? s : undefined
}

/** The country of a key: GB for a sort code and account number, else the IBAN's. */
const keyCountry = (key: string) => (GB_ACCOUNT_NO.test(key) ? 'GB' : key.slice(0, 2))

/**
 * The range of an agreement that covers an account (decision 802), the most specific one
 * when several do; undefined: no master account for it (MASTER_ACCOUNT_NOT_FOUND).
 */
export function rangeFor(setup: AgencySetup | undefined, identifier: string): AgencyRange | undefined {
  if (!setup?.agreement) return undefined
  const key = agencyKey(identifier)
  if (!key) return undefined
  const country = keyCountry(key)
  const national = GB_ACCOUNT_NO.test(key) ? key : key.slice(4)
  const fits = (r: AgencyRange) => r.country === country && (r.sortCode !== undefined
    ? country === 'GB' && national.startsWith(r.sortCode)
    : r.bank === undefined || national.startsWith(r.bank))
  return (setup.ranges ?? []).filter(fits).sort((a, b) => (b.sortCode ?? b.bank ?? '').length - (a.sortCode ?? a.bank ?? '').length)[0]
}

/** Whether a credit to the account is accepted: ACTIVE, or INST_RESTRICTED for anything but SEPA Instant. */
export function receivable(a: AgencyAccount, o: { instant: boolean }): boolean {
  return a.status === 'ACTIVE' || (a.status === 'INST_RESTRICTED' && !o.instant)
}

/** Agency accounts are kept by count only: a synchronised account lives on (decision 809). */
export const AGENCY_BOUNDS: Bounds = { max: 100_000 }

/**
 * Where agency accounts and the account manager's set-ups live (decision 940): in memory
 * (MemoryAgencyStore) or in Postgres (PgAgencyStore, pg/agency.ts). Every call is async.
 */
export interface AgencyStore {
  /** One entity's account by IBAN, GB IBAN or 14-digit sort code and account number. */
  get(bank: AgencyBank, identifier: string): Promise<AgencyAccount | undefined>
  /** The account in every entity it was synchronised to, LHV EE first. */
  find(identifier: string): Promise<AgencyAccount[]>
  /** An agent's accounts (optionally of one entity), oldest write first. */
  ofAgent(agent: CustomerKey, bank?: AgencyBank): Promise<AgencyAccount[]>
  /** Every account, oldest write first (a rewrite moves an account to the end). */
  all(): Promise<AgencyAccount[]>
  count(): Promise<number>
  put(a: AgencyAccount): Promise<void>
  /** A customer's agency set-up (decision 801); undefined: none. */
  setup(agent: CustomerKey): Promise<AgencySetup | undefined>
  /**
   * Replaces a customer's set-up (undefined removes it). `ifAbsent`: only when the store
   * holds nothing for the customer yet, not even a removal (the seed on a restart, decision 941).
   */
  setSetup(agent: CustomerKey, setup: AgencySetup | undefined, o?: { ifAbsent?: boolean }): Promise<void>
  /** Every customer's set-up, by customer key (keyOf). */
  setups(): Promise<Map<string, AgencySetup>>
}

/** A customer key as the stores keep it: the country in capitals. */
export const agentKey = (c: CustomerKey) => keyOf({ code: c.code, country: c.country.toUpperCase() })

export class MemoryAgencyStore implements AgencyStore {
  #m: BoundedMap<string, AgencyAccount>
  /** null: removed (remembered so a seed on a restart does not bring it back). */
  #setups = new Map<string, AgencySetup | null>()
  constructor(clock: Clock, bounds: Bounds = AGENCY_BOUNDS) { this.#m = new BoundedMap(clock, bounds) }

  #get(bank: AgencyBank, identifier: string): AgencyAccount | undefined {
    const key = agencyKey(identifier)
    return key ? this.#m.get(`${bank}:${key}`) : undefined
  }

  async get(bank: AgencyBank, identifier: string) { return this.#get(bank, identifier) }

  async find(identifier: string) {
    return (['LHVEE', 'LHVUK'] as const).map((b) => this.#get(b, identifier)).filter((a): a is AgencyAccount => a !== undefined)
  }

  async ofAgent(agent: CustomerKey, bank?: AgencyBank) {
    const k = agentKey(agent)
    return this.#all().filter((a) => agentKey(a.agent) === k && (!bank || a.bank === bank))
  }

  #all(): AgencyAccount[] { return this.#m.entries().map(([, a]) => a) }
  async all() { return this.#all() }
  async count() { return this.#m.size }

  async put(a: AgencyAccount) { this.#m.set(`${a.bank}:${a.id}`, a) }

  async setup(agent: CustomerKey) { return this.#setups.get(agentKey(agent)) ?? undefined }

  async setSetup(agent: CustomerKey, setup: AgencySetup | undefined, o: { ifAbsent?: boolean } = {}) {
    const k = agentKey(agent)
    if (o.ifAbsent && this.#setups.has(k)) return
    this.#setups.set(k, setup ?? null)
  }

  async setups() {
    return new Map([...this.#setups].filter((e): e is [string, AgencySetup] => e[1] !== null))
  }
}

/** Checks a set-up given in the seed or to /_sim/agency (decision 801); throws with the reason. */
export function checkSetup(s: unknown, ownAccounts: string[]): AgencySetup {
  if (typeof s !== 'object' || s === null || Array.isArray(s)) throw new Error('agency must be an object')
  const o = s as Record<string, unknown>
  for (const k of Object.keys(o)) if (!['agreement', 'ranges', 'cop', 'vop', 'notifications', 'rtf'].includes(k)) throw new Error(`agency: unknown field ${k}`)
  for (const k of ['agreement', 'cop', 'vop', 'notifications']) if (o[k] !== undefined && typeof o[k] !== 'boolean') throw new Error(`agency.${k} must be a boolean`)
  const out: AgencySetup = {}
  for (const k of ['agreement', 'cop', 'vop', 'notifications'] as const) if (o[k] !== undefined) out[k] = o[k] as boolean
  if (o.ranges !== undefined) {
    if (!Array.isArray(o.ranges)) throw new Error('agency.ranges must be an array')
    out.ranges = o.ranges.map((r, i) => {
      const where = `agency.ranges[${i}]`
      if (typeof r !== 'object' || r === null) throw new Error(`${where} must be an object`)
      const x = r as Record<string, unknown>
      for (const k of Object.keys(x)) if (!['country', 'sortCode', 'bank', 'master', 'bic'].includes(k)) throw new Error(`${where}: unknown field ${k}`)
      if (typeof x.country !== 'string' || !/^[A-Z]{2}$/.test(x.country)) throw new Error(`${where}.country must be a two-letter country code`)
      if (x.sortCode !== undefined && (x.country !== 'GB' || typeof x.sortCode !== 'string' || !/^[0-9]{6}$/.test(x.sortCode))) throw new Error(`${where}.sortCode must be 6 digits, for GB only`)
      if (x.bank !== undefined && (typeof x.bank !== 'string' || !/^[A-Z0-9]{1,30}$/.test(x.bank) || x.sortCode !== undefined || x.country === 'GB')) {
        throw new Error(`${where}.bank must be the start of the national part of the IBAN (letters and digits), not for GB (use sortCode)`)
      }
      if (x.bic !== undefined && (typeof x.bic !== 'string' || !/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(x.bic))) throw new Error(`${where}.bic must be a BIC`)
      if (typeof x.master !== 'string' || !ownAccounts.includes(normalizeIban(x.master))) throw new Error(`${where}.master must be one of the customer's own accounts`)
      return {
        country: x.country, master: normalizeIban(x.master),
        ...(x.sortCode !== undefined ? { sortCode: x.sortCode as string } : {}),
        ...(x.bank !== undefined ? { bank: x.bank as string } : {}),
        ...(x.bic !== undefined ? { bic: x.bic as string } : {}),
      }
    })
  }
  if (o.rtf !== undefined) {
    if (!Array.isArray(o.rtf) || o.rtf.some((x) => !RTF_SCHEMES.includes(x as RtfScheme))) throw new Error(`agency.rtf must list schemes of ${RTF_SCHEMES.join(', ')}`)
    out.rtf = [...new Set(o.rtf as RtfScheme[])]
  }
  return out
}
