// Virtual IBANs: the accounts a service provider issues to its own customers under one
// of its master accounts. A VIBAN holds no money; whatever is paid to or from it is
// booked on the master account. This module keeps their state and generates numbers.
//
// Lifecycle (P 10 "Virtual IBAN Services"):
//
//   open ──screening──▶ ACTIVE | ON_HOLD          bulk ──▶ PENDING (nameless)
//   modify (PENDING | ACTIVE | ON_HOLD) ──screening──▶ ACTIVE | ON_HOLD
//   close  (ACTIVE | PENDING | BLOCKED) ──▶ CLOSED (final)
//   bank decisions, each with a VIBAN_STATUS_NOTIFICATION:
//     ON_HOLD ──▶ ACTIVE | REJECTED,  ACTIVE ──▶ BLOCKED,  BLOCKED ──▶ ACTIVE,
//     any status but CLOSED / REJECTED ──▶ CLOSED
//
// VIBANs, the numbers given out and the master account agreements are kept in the
// emulator's keyed store (decision 984), so they survive a restart; every lookup is async.
import { systemClock } from '../clock.js'
import { keyOf, type CustomerKey } from '../directory.js'
import { makeIban, normalizeIban } from '../iban.js'
import { memoryKeyed, UNBOUNDED, type KeyedFactory, type KeyedStore } from '../keyed.js'

export type VibanStatus = 'ACTIVE' | 'PENDING' | 'ON_HOLD' | 'CLOSED' | 'REJECTED' | 'BLOCKED'

export interface Person { Name: string; BirthDate: string; BirthCountry?: string; Residency: string; DocumentNumber?: string }
export interface Company {
  Name: string; CountryOfOrigin: string; TaxResidency: string; RegistrationNumber: string
  Representative: { Name: string; BirthDate: string; Residency: string }
}
export interface Address { Country: string; StreetNo: string; CityCounty: string }
export interface VibanUser { person?: Person; company?: Company; address: Address }

export interface Viban {
  iban: string
  master: string
  /** The customer that owns the master account. */
  owner: CustomerKey
  status: VibanStatus
  clientReference?: string
  user?: VibanUser
  createdAt: Date
  activatedAt?: Date
  closedAt?: Date
}

/** What the payment engine needs to know about a VIBAN. */
export interface VirtualAccount {
  iban: string
  master: string
  status: VibanStatus
  holder?: { name: string; country: string; address: string }
}
export interface VirtualAccounts { resolve(iban: string): Promise<VirtualAccount | undefined> }

/** Status changes the bank may make on its own (each is notified). */
export const BANK_TRANSITIONS: Record<VibanStatus, VibanStatus[]> = {
  ON_HOLD: ['ACTIVE', 'REJECTED', 'CLOSED'],
  ACTIVE: ['BLOCKED', 'CLOSED'],
  BLOCKED: ['ACTIVE', 'CLOSED'],
  PENDING: ['CLOSED'],
  REJECTED: [],
  CLOSED: [],
}

export const holderName = (u?: VibanUser) => u?.person?.Name ?? u?.company?.Name

/** The Estonian national check digit (7-3-1 method) of an account number. */
export function eeCheckDigit(account: string): number {
  const w = [7, 3, 1]
  let sum = 0
  const d = [...account].reverse()
  for (let i = 0; i < d.length; i++) sum += Number(d[i]) * w[i % 3]
  return (10 - (sum % 10)) % 10
}

export interface VibanRange {
  /** EE: bank code + the first digits of every VIBAN account number (the published ones start 7777). */
  ee: string
  /** GB: the first digit of the eight-digit account number under the master's sort code. */
  gb: string
}
export const DEFAULT_RANGE: VibanRange = { ee: '7777', gb: '7' }

/** A VIBAN as the keyed store keeps it (decision 984): JSON, times in ms. */
type StoredViban = Omit<Viban, 'createdAt' | 'activatedAt' | 'closedAt'> & { createdAt: number; activatedAt?: number; closedAt?: number }

const encode = (v: Viban): StoredViban => JSON.parse(JSON.stringify({
  ...v, createdAt: v.createdAt.getTime(), activatedAt: v.activatedAt?.getTime(), closedAt: v.closedAt?.getTime(),
}))
const decode = (s: StoredViban): Viban => {
  const { createdAt, activatedAt, closedAt, ...rest } = s
  const v: Viban = { ...rest, createdAt: new Date(createdAt) }
  if (activatedAt !== undefined) v.activatedAt = new Date(activatedAt)
  if (closedAt !== undefined) v.closedAt = new Date(closedAt)
  return v
}

export class VibanRegistry implements VirtualAccounts {
  /** Every VIBAN by its IBAN, in the order they were made. */
  #vibans: KeyedStore<StoredViban>
  /** The numbers given out (one emulator of a namespace gets each). */
  #numbers: KeyedStore<true>
  /** The master account agreements: true signed, false ended (kept, so the seed does not sign it again). */
  #agreements: KeyedStore<boolean>
  #serial = 0

  constructor(
    private range: VibanRange = DEFAULT_RANGE, private taken: (iban: string) => Promise<boolean> = async () => false,
    keyed: KeyedFactory = memoryKeyed(systemClock),
  ) {
    this.#vibans = keyed('vibans', UNBOUNDED)
    this.#numbers = keyed('viban-numbers', UNBOUNDED)
    this.#agreements = keyed('viban-agreements', UNBOUNDED)
  }

  /**
   * Signs (or ends) the master account agreement of an account. ifAbsent: only when the
   * account never had one recorded (the seed after a restart, decision 984).
   */
  async agreement(iban: string, active = true, o: { ifAbsent?: boolean } = {}) {
    const n = normalizeIban(iban)
    if (o.ifAbsent) await this.#agreements.add(n, active)
    else await this.#agreements.set(n, active)
  }
  async hasAgreement(iban: string) { return (await this.#agreements.get(normalizeIban(iban))) === true }

  /** The VIBAN (a copy: change it with setStatus or save). */
  async get(iban: string): Promise<Viban | undefined> {
    const s = await this.#vibans.get(normalizeIban(iban))
    return s && decode(s)
  }
  async all(): Promise<Viban[]> { return (await this.#vibans.entries()).map(([, s]) => decode(s)) }

  async byClientReference(owner: CustomerKey, ref: string): Promise<Viban | undefined> {
    const k = keyOf(owner)
    return (await this.all()).find((v) => keyOf(v.owner) === k && v.clientReference === ref)
  }

  /** A new number in the bank's VIBAN range, in the master account's country format; taken for good. */
  async generate(master: string): Promise<string> {
    const m = normalizeIban(master)
    for (;;) {
      const serial = ++this.#serial
      let iban: string
      if (m.startsWith('EE')) {
        // EE: 2-digit bank code + 14-digit account number whose last digit is the 7-3-1 check.
        const account = (this.range.ee.slice(2) + String(serial).padStart(13 - (this.range.ee.length - 2), '0'))
        iban = makeIban('EE', this.range.ee.slice(0, 2) + account + eeCheckDigit(account))
      } else if (m.startsWith('GB')) {
        // GB: bank code + the master's sort code + an eight-digit account number.
        iban = makeIban('GB', m.slice(4, 8) + m.slice(8, 14) + this.range.gb + String(serial).padStart(8 - this.range.gb.length, '0'))
      } else {
        throw new Error(`no VIBAN format for ${m.slice(0, 2)} master accounts`)
      }
      // A restarted emulator's counter walks past the numbers given out before, once.
      if (!(await this.taken(iban)) && (await this.#numbers.add(iban, true))) return iban
    }
  }

  async add(v: Viban): Promise<Viban> {
    await this.#vibans.set(v.iban, encode(v))
    return v
  }

  /** Stores a changed VIBAN. */
  async save(v: Viban) { await this.#vibans.replace(v.iban, encode(v)) }

  /** Moves a VIBAN to a status, stamping the activation and closing dates, and stores it. */
  async setStatus(v: Viban, status: VibanStatus, at: Date) {
    v.status = status
    if (status === 'ACTIVE' && !v.activatedAt) v.activatedAt = at
    if (status === 'CLOSED') v.closedAt = at
    await this.save(v)
  }

  async resolve(iban: string): Promise<VirtualAccount | undefined> {
    const v = await this.get(iban)
    if (!v) return undefined
    const name = holderName(v.user)
    return {
      iban: v.iban, master: v.master, status: v.status,
      holder: name && v.user ? { name, country: v.user.address.Country, address: v.user.address.StreetNo } : undefined,
    }
  }
}
