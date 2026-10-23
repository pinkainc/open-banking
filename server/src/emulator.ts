// The parts of the bank wired together: directory, ledger, rails, inbox and the
// payment engine. Ledger and rails are interfaces; the defaults are in memory and the
// simulator.
import { systemClock, type Clock } from './clock.js'
import { Directory, type CustomerInput } from './directory.js'
import { Inbox } from './inbox.js'
import { MemoryLedger, toMinor, type Ledger } from './ledger.js'
import { PaymentEngine, type Bank } from './payments/engine.js'
import { XsdValidator } from './payments/xsd.js'
import { SimulatorRails, type Rails } from './rails.js'
import { normalizeIban } from './iban.js'
import { servicerRef } from './ids.js'
import { Journal } from './statements/journal.js'
import { AccountReports, type ReportsOptions } from './statements/reports.js'

export interface Seed {
  bank?: Partial<Bank>
  customers: CustomerInput[]
}

export interface EmulatorOptions {
  clock?: Clock
  ledger?: Ledger
  rails?: Rails
  /** Directory of the published XSDs; schema validation is skipped without it. */
  xsdDir?: string
  strictIban?: boolean
  pain00103Until?: string
  /** Statement page size and per-request transaction cap (tests make them small). */
  reports?: ReportsOptions
}

export const DEFAULT_BANK: Bank = { bic: 'LHVBEE22', name: 'open-banking emulator' }
/** The ledger account the simulator funds accounts from. */
export const FUNDING = '@sim:funding'

export class Emulator {
  readonly directory = new Directory()
  readonly clock: Clock
  readonly ledger: Ledger
  readonly rails: Rails
  readonly inbox: Inbox
  readonly engine: PaymentEngine
  readonly bank: Bank
  readonly journal = new Journal()
  readonly reports: AccountReports

  constructor(opts: EmulatorOptions & { bank?: Partial<Bank> } = {}) {
    this.clock = opts.clock ?? systemClock
    this.ledger = opts.ledger ?? new MemoryLedger()
    this.rails = opts.rails ?? new SimulatorRails()
    this.inbox = new Inbox(this.clock)
    this.bank = { ...DEFAULT_BANK, ...opts.bank }
    const xsd = opts.xsdDir ? new XsdValidator(opts.xsdDir) : undefined
    this.engine = new PaymentEngine(this.directory, this.ledger, this.rails, this.inbox, this.clock, this.bank, {
      strictIban: opts.strictIban, pain00103Until: opts.pain00103Until ?? '2026-11-15', xsd,
      onBooking: (_c, b) => { this.journal.record(b) },
    })
    this.reports = new AccountReports({
      directory: this.directory, ledger: this.ledger, journal: this.journal, inbox: this.inbox, clock: this.clock, bank: this.bank, xsd,
    }, opts.reports)
  }

  static async fromSeed(seed: Seed, opts: EmulatorOptions = {}): Promise<Emulator> {
    const e = new Emulator({ ...opts, bank: seed.bank })
    for (const c of seed.customers) await e.addCustomer(c)
    return e
  }

  async addCustomer(c: CustomerInput) {
    const customer = this.directory.add(c)
    for (const a of c.accounts ?? []) {
      if (typeof a === 'string' || !a.balances) continue
      for (const [ccy, amount] of Object.entries(a.balances)) await this.fund(a.iban, amount, ccy)
    }
    return customer
  }

  /**
   * Puts money on an account without a notification (simulator set-up). The statement
   * shows it as an ordinary credit, so statements reconcile with the balance.
   */
  async fund(iban: string, amount: string, currency: string) {
    const n = normalizeIban(iban)
    const owner = this.directory.ownerOf(n)
    if (!owner) throw new Error(`no account ${n}`)
    const ref = servicerRef()
    const minor = toMinor(amount)
    await this.ledger.transfer({ ref, from: FUNDING, to: n, amount: minor, currency })
    this.journal.record({
      account: n, owner: { name: owner.name, code: owner.code }, direction: 'CRDT', amount: minor, currency,
      servicerRef: ref, scheme: 'INTERNAL', bookedAt: this.clock.now(),
      counterparty: { name: this.bank.name, bic: this.bank.bic }, remittance: 'Simulator funding',
    })
  }
}
