// The parts of the bank wired together: directory, ledger, rails, inbox, the payment
// engine, SEPA Direct Debit, Bacs, FX, service provider contracts and the EE and UK webhooks. Ledger
// and rails are interfaces; the defaults are in memory and the simulator.
import { DEFAULT_BOUNDS, type Bounds } from './bounded.js'
import { systemClock, type Clock } from './clock.js'
import { Directory, type CustomerInput } from './directory.js'
import { Inbox } from './inbox.js'
import { RequestLog } from './requests.js'
import { MemoryLedger, toMinor, type Ledger } from './ledger.js'
import { PaymentEngine, type Bank } from './payments/engine.js'
import { XsdValidator } from './payments/xsd.js'
import { DirectDebitService } from './directdebit/service.js'
import { FxService } from './fx/service.js'
import { Contracts } from './contracts/service.js'
import { EeWebhooks, type Deliver } from './webhooks/ee.js'
import { DEFAULT_EVENT_BOUNDS, UkWebhooks, type UkDeliver } from './webhooks/uk.js'
import { SimulatorRails, type Rails } from './rails.js'
import { normalizeIban } from './iban.js'
import { servicerRef } from './ids.js'
import { Journal } from './statements/journal.js'
import { AccountReports, type ReportsOptions } from './statements/reports.js'
import { checkBankAddress, defaultBankAddress } from './statements/bank-address.js'
import { VibanSchemas } from './viban/messages.js'
import { VibanService, type ErrorDelivery } from './viban/service.js'
import { PayeeService } from './payee/service.js'
import { AccountsService, DEFAULT_INCOMING } from './accounts/service.js'
import { BACS_BOUNDS, BacsService } from './bacs/service.js'
import { Agency } from './agency/service.js'
import { Acquiring } from './acquiring/service.js'

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
  /** How UK webhooks are sent (default HTTP POST); tests record them instead. */
  ukWebhookDeliver?: UkDeliver
  /** Limits of what is remembered (decision 504); each part overrides DEFAULT_BOUNDS. */
  memory?: { tombstones?: Partial<Bounds>; msgIds?: Partial<Bounds>; processed?: Partial<Bounds>; requests?: Partial<Bounds>; incoming?: Partial<Bounds>; webhookEvents?: Partial<Bounds>; bacs?: Partial<typeof BACS_BOUNDS>; agency?: Partial<Bounds> }
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
  /** Every request answered 202, as submitted (GET /v2/requests, decision 630). */
  readonly requests: RequestLog
  readonly engine: PaymentEngine
  readonly bank: Bank
  readonly journal = new Journal()
  readonly reports: AccountReports
  readonly viban: VibanService
  readonly directDebit: DirectDebitService
  readonly fx: FxService
  readonly contracts: Contracts
  readonly webhooksEe: EeWebhooks
  /** LHV UK webhooks: per-type configurations, HMAC, retries, history and replay. */
  readonly webhooksUk: UkWebhooks
  readonly payee: PayeeService
  /** UK account reports: account list, transaction by reference, incoming pending and rejected. */
  readonly accounts: AccountsService
  /** Bacs on the UK host: incoming credits, mandates and collections (LHV as the paying bank). */
  readonly bacs: BacsService
  /** Indirect scheme access: agency accounts, their synchronisation, the CoP/VoP responder, RTFs. */
  readonly agency: Agency
  /** Card acquiring: merchant set-ups, card transactions and the merchant payment report (P 13). */
  readonly acquiring: Acquiring

  constructor(opts: EmulatorOptions & { bank?: Partial<Bank> } = {}) {
    this.clock = opts.clock ?? systemClock
    this.ledger = opts.ledger ?? new MemoryLedger()
    this.rails = opts.rails ?? new SimulatorRails()
    const tombstones = { ...DEFAULT_BOUNDS.tombstones, ...opts.memory?.tombstones }
    const msgIds = { ...DEFAULT_BOUNDS.msgIds, ...opts.memory?.msgIds }
    this.inbox = new Inbox(this.clock, undefined, tombstones, { ...DEFAULT_BOUNDS.processed, ...opts.memory?.processed })
    this.requests = new RequestLog(this.clock, { ...DEFAULT_BOUNDS.requests, ...opts.memory?.requests })
    this.webhooksEe = new EeWebhooks(this.inbox, this.clock, { deliver: opts.webhookDeliver })
    this.webhooksUk = new UkWebhooks(this.inbox, this.directory, this.clock, {
      deliver: opts.ukWebhookDeliver, events: { ...DEFAULT_EVENT_BOUNDS, ...opts.memory?.webhookEvents },
      // The entity that processed the request behind the message; notifications are LHV UK's (decision 724).
      bankOf: (m) => (m.requestId && this.requests.bankCodeOf(m.requestId)) || 'LHVUK',
    })
    this.bank = { ...DEFAULT_BANK, ...opts.bank }
    if (this.bank.address === undefined) this.bank.address = defaultBankAddress(this.bank.bic)
    else if (this.bank.address) checkBankAddress(this.bank.address)
    const xsd = opts.xsdDir ? new XsdValidator(opts.xsdDir) : undefined
    this.viban = new VibanService(this.directory, this.inbox, this.clock, {
      schemas: opts.xsdDir ? new VibanSchemas(opts.xsdDir) : undefined, errors: opts.vibanErrors,
    })
    this.accounts = new AccountsService({
      directory: this.directory, ledger: this.ledger, journal: this.journal, viban: this.viban.registry, clock: this.clock, bank: this.bank, engine: () => this.engine,
    }, { ...DEFAULT_INCOMING, ...opts.memory?.incoming })
    this.engine = new PaymentEngine(this.directory, this.ledger, this.rails, this.inbox, this.clock, this.bank, {
      strictIban: opts.strictIban, pain00103Until: opts.pain00103Until ?? '2026-11-15', xsd, virtual: this.viban.registry, msgIds,
      onBooking: (_c, b) => { this.journal.record(b) }, limits: (c) => this.reports.paymentLimits(c),
      onIncoming: (e) => this.accounts.onIncoming(e), agency: () => this.agency?.accounts,
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
    this.payee = new PayeeService({ directory: this.directory, viban: this.viban.registry, inbox: this.inbox, clock: this.clock, agency: () => this.agency?.accounts })
    this.bacs = new BacsService({
      directory: this.directory, ledger: this.ledger, rails: this.rails, inbox: this.inbox, clock: this.clock, bank: this.bank, virtual: this.viban.registry,
      onBooking: (_c, b) => { this.journal.record(b) }, onIncoming: (e) => this.accounts.onIncoming(e),
      credit: (p) => this.engine.incoming(p),
    }, opts.memory?.bacs)
    this.agency = new Agency({ directory: this.directory, inbox: this.inbox, clock: this.clock, bank: this.bank }, opts.memory?.agency)
    this.acquiring = new Acquiring({ directory: this.directory, inbox: this.inbox, clock: this.clock })
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
    if (c.limits !== undefined) {
      for (const [k, v] of Object.entries(c.limits)) {
        if (k !== 'daily' && k !== 'monthly' && k !== 'instant') throw new Error(`unknown limit ${k}`)
        toMinor(v as string)
      }
    }
    for (const a of c.accounts ?? []) {
      if (typeof a === 'string') this.accounts.register(a)
      else this.accounts.register(a.iban, { opened: a.opened, nickname: a.nickname, closed: a.closed })
    }
    const customer = this.directory.add(c)
    if (c.limits) this.reports.configure(customer, { limits: { ...c.limits } })
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
