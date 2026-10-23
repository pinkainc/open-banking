// The parts of the bank wired together: directory, ledger, rails, inbox, the payment
// engine, SEPA Direct Debit, FX, service provider contracts and the EE webhooks. Ledger
// and rails are interfaces; the defaults are in memory and the simulator.
import { DEFAULT_BOUNDS, type Bounds } from './bounded.js'
import { systemClock, type Clock } from './clock.js'
import { Directory, type CustomerInput } from './directory.js'
import { Inbox } from './inbox.js'
import { MemoryLedger, toMinor, type Ledger } from './ledger.js'
import { PaymentEngine, type Bank } from './payments/engine.js'
import { XsdValidator } from './payments/xsd.js'
import { DirectDebitService } from './directdebit/service.js'
import { FxService } from './fx/service.js'
import { Contracts } from './contracts/service.js'
import { EeWebhooks, type Deliver } from './webhooks/ee.js'
import { SimulatorRails, type Rails } from './rails.js'
import { normalizeIban } from './iban.js'
import { servicerRef } from './ids.js'
import { Journal } from './statements/journal.js'
import { AccountReports, type ReportsOptions } from './statements/reports.js'
import { VibanSchemas } from './viban/messages.js'
import { VibanService, type ErrorDelivery } from './viban/service.js'

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
  /** How VIBAN business errors are delivered (docs/decisions.md 200); default inbox. */
  vibanErrors?: ErrorDelivery
  /** How EE webhook payloads are sent (default HTTP POST); tests record them instead. */
  webhookDeliver?: Deliver
  /** Limits of what is remembered (decision 504); each part overrides DEFAULT_BOUNDS. */
  memory?: { tombstones?: Partial<Bounds>; msgIds?: Partial<Bounds> }
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
  readonly viban: VibanService
  readonly directDebit: DirectDebitService
  readonly fx: FxService
  readonly contracts: Contracts
  readonly webhooksEe: EeWebhooks

  constructor(opts: EmulatorOptions & { bank?: Partial<Bank> } = {}) {
    this.clock = opts.clock ?? systemClock
    this.ledger = opts.ledger ?? new MemoryLedger()
    this.rails = opts.rails ?? new SimulatorRails()
    const tombstones = { ...DEFAULT_BOUNDS.tombstones, ...opts.memory?.tombstones }
    const msgIds = { ...DEFAULT_BOUNDS.msgIds, ...opts.memory?.msgIds }
    this.inbox = new Inbox(this.clock, undefined, tombstones)
    this.webhooksEe = new EeWebhooks(this.inbox, this.clock, { deliver: opts.webhookDeliver })
    this.bank = { ...DEFAULT_BANK, ...opts.bank }
    const xsd = opts.xsdDir ? new XsdValidator(opts.xsdDir) : undefined
    this.viban = new VibanService(this.directory, this.inbox, this.clock, {
      schemas: opts.xsdDir ? new VibanSchemas(opts.xsdDir) : undefined, errors: opts.vibanErrors,
    })
    this.engine = new PaymentEngine(this.directory, this.ledger, this.rails, this.inbox, this.clock, this.bank, {
      strictIban: opts.strictIban, pain00103Until: opts.pain00103Until ?? '2026-11-15', xsd, virtual: this.viban.registry, msgIds,
      onBooking: (_c, b) => { this.journal.record(b) },
    })
    this.directDebit = new DirectDebitService({
      directory: this.directory, ledger: this.ledger, rails: this.rails, inbox: this.inbox, clock: this.clock, bank: this.bank,
      xsd, virtual: this.viban.registry, strictIban: opts.strictIban, onBooking: (_c, b) => { this.journal.record(b) }, msgIds,
    })
    this.fx = new FxService({
      directory: this.directory, ledger: this.ledger, inbox: this.inbox, clock: this.clock, bank: this.bank,
      onBooking: (_c, b) => { this.journal.record(b) },
    })
    this.contracts = new Contracts(this.directory, this.clock)
    this.reports = new AccountReports({
      directory: this.directory, ledger: this.ledger, journal: this.journal, inbox: this.inbox, clock: this.clock, bank: this.bank, xsd, msgIds,
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
      if (typeof a === 'string') continue
      if (a.viban) this.viban.registry.agreement(a.iban)
      if (!a.balances) continue
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
