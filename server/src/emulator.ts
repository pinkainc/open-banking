// The parts of the bank wired together: directory, ledger, rails, inbox, the payment
// engine, SEPA Direct Debit, Bacs, FX, service provider contracts and the EE and UK webhooks. Ledger
// and rails are interfaces; the defaults are in memory and the simulator.
import { DEFAULT_BOUNDS, type Bounds } from './bounded.js'
import { systemClock, type Clock } from './clock.js'
import { keyOf, MemoryDirectory, type CustomerInput, type DirectoryStore } from './directory.js'
import { MemoryInbox, type InboxStore } from './inbox.js'
import { bookingOf, Outbox, type MessagePayload, type NoticePayload } from './outbox.js'
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
import { MemoryJournal, type JournalStore } from './statements/journal.js'
import { memoryKeyed, type KeyedFactory } from './keyed.js'
import { AccountReports, type ReportsOptions } from './statements/reports.js'
import { checkBankAddress, defaultBankAddress } from './statements/bank-address.js'
import { VibanSchemas } from './viban/messages.js'
import { VibanService, type ErrorDelivery } from './viban/service.js'
import { PayeeService } from './payee/service.js'
import { AccountsService, DEFAULT_INCOMING } from './accounts/service.js'
import { BACS_BOUNDS, BacsService } from './bacs/service.js'
import { Agency } from './agency/service.js'
import { checkSetup, type AgencyStore } from './agency/store.js'
import type { AcquiringStore } from './acquiring/store.js'
import type { RailsPending } from './payments/pending.js'
import { Acquiring } from './acquiring/service.js'

export interface Seed {
  bank?: Partial<Bank>
  customers: CustomerInput[]
}

export interface EmulatorOptions {
  clock?: Clock
  /** The ledger, or a factory given the emulator's clock (a PgLedger, pg/ledger.ts); default in memory. */
  ledger?: Ledger | ((clock: Clock) => Ledger)
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
  /**
   * The message box, built with the emulator's clock and bounds (decision 900); default
   * in memory. A PgInbox (pg/inbox.ts) keeps it in Postgres.
   */
  inbox?: (clock: Clock, bounds: { tombstones: Bounds; processed: Bounds }) => InboxStore
  /** Limits of what is remembered (decision 504); each part overrides DEFAULT_BOUNDS. */
  /** Agency accounts and set-ups (decision 940); default in memory. A PgAgencyStore (pg/agency.ts) keeps them in Postgres. */
  agency?: (clock: Clock, bounds: Bounds) => AgencyStore
  /** Merchant set-ups and card transactions (decision 945); default in memory, PgAcquiringStore (pg/acquiring.ts) in Postgres. */
  acquiring?: (clock: Clock, bounds: Bounds) => AcquiringStore
  /** Payments waiting at the rails for their outcome (decision 948); default in memory, PgRailsPending in Postgres. */
  railsPending?: () => RailsPending
  /** The statements journal, every booking (decision 960); default in memory, PgJournal (pg/journal.ts) in Postgres. */
  journal?: () => JournalStore
  /**
   * Remembered business state, one store per kind (decision 961): report settings, MsgId and
   * InstrId sets, parked payments, in-flight limit amounts; default in memory, pgKeyed (pg/keyed.ts) in Postgres.
   */
  keyed?: (clock: Clock) => KeyedFactory
  /** Customers and their accounts (decision 970); default in memory, PgDirectory (pg/directory.ts) in Postgres. */
  directory?: (clock: Clock) => DirectoryStore
  memory?: { tombstones?: Partial<Bounds>; msgIds?: Partial<Bounds>; processed?: Partial<Bounds>; requests?: Partial<Bounds>; incoming?: Partial<Bounds>; webhookEvents?: Partial<Bounds>; bacs?: Partial<typeof BACS_BOUNDS>; agency?: Partial<Bounds> }
}

export const DEFAULT_BANK: Bank = { bic: 'LHVBEE22', name: 'open-banking emulator' }
/** The ledger account the simulator funds accounts from. */
export const FUNDING = '@sim:funding'

export class Emulator {
  readonly directory: DirectoryStore
  readonly clock: Clock
  /** The keyed store factory every service's remembered state comes from (decision 961). */
  readonly keyed: KeyedFactory
  readonly ledger: Ledger
  /** The ledger's outbox: delivers what reports a booking, also after a crash (`recover`, decision 990). */
  readonly outbox: Outbox
  readonly rails: Rails
  readonly inbox: InboxStore
  /** Every request answered 202, as submitted (GET /v2/requests, decision 630). */
  readonly requests: RequestLog
  readonly engine: PaymentEngine
  readonly bank: Bank
  readonly journal: JournalStore
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
    this.directory = opts.directory?.(this.clock) ?? new MemoryDirectory(this.clock)
    this.ledger = typeof opts.ledger === 'function' ? opts.ledger(this.clock) : opts.ledger ?? new MemoryLedger()
    this.rails = opts.rails ?? new SimulatorRails()
    this.journal = opts.journal?.() ?? new MemoryJournal()
    const keyed = this.keyed = opts.keyed?.(this.clock) ?? memoryKeyed(this.clock)
    const tombstones = { ...DEFAULT_BOUNDS.tombstones, ...opts.memory?.tombstones }
    const msgIds = { ...DEFAULT_BOUNDS.msgIds, ...opts.memory?.msgIds }
    const processed = { ...DEFAULT_BOUNDS.processed, ...opts.memory?.processed }
    this.inbox = opts.inbox ? opts.inbox(this.clock, { tombstones, processed }) : new MemoryInbox(this.clock, undefined, tombstones, processed)
    this.requests = new RequestLog(this.clock, { ...DEFAULT_BOUNDS.requests, ...opts.memory?.requests }, keyed)
    this.webhooksEe = new EeWebhooks(this.inbox, this.clock, { deliver: opts.webhookDeliver, keyed })
    this.webhooksUk = new UkWebhooks(this.inbox, this.directory, this.clock, {
      deliver: opts.ukWebhookDeliver, events: { ...DEFAULT_EVENT_BOUNDS, ...opts.memory?.webhookEvents }, keyed,
      // The entity that processed the request behind the message; notifications are LHV UK's (decision 724).
      bankOf: async (m) => (m.requestId && await this.requests.bankCodeOf(m.requestId)) || 'LHVUK',
    })
    this.bank = { ...DEFAULT_BANK, ...opts.bank }
    if (this.bank.address === undefined) this.bank.address = defaultBankAddress(this.bank.bic)
    else if (this.bank.address) checkBankAddress(this.bank.address)
    const xsd = opts.xsdDir ? new XsdValidator(opts.xsdDir) : undefined
    // What reports a booking goes with it (decisions 990, 991): the statement entry, a
    // debit out of the payment limits' in-flight amounts, the camt.054; each once by the key.
    this.outbox = new Outbox(this.ledger, this.clock, this.bank)
    this.outbox.on('notice', async (i) => {
      const n = i.payload as NoticePayload
      await this.journal.record(bookingOf(n.booking), i.key)
      if (n.inflight) await this.engine.notified(n.inflight)
      await this.inbox.add({ customer: n.customer, type: 'CREDIT_DEBIT_NOTIFICATION', body: n.body, key: i.key })
    })
    this.outbox.on('message', async (i) => { await this.inbox.add({ ...(i.payload as MessagePayload), key: i.key }) })
    this.viban = new VibanService(this.directory, this.inbox, this.clock, {
      schemas: opts.xsdDir ? new VibanSchemas(opts.xsdDir) : undefined, errors: opts.vibanErrors, keyed,
    })
    this.accounts = new AccountsService({
      directory: this.directory, ledger: this.ledger, journal: this.journal, viban: this.viban.registry, clock: this.clock, bank: this.bank, engine: () => this.engine, keyed,
    }, { ...DEFAULT_INCOMING, ...opts.memory?.incoming })
    this.engine = new PaymentEngine(this.directory, this.ledger, this.rails, this.inbox, this.clock, this.bank, {
      strictIban: opts.strictIban, pain00103Until: opts.pain00103Until ?? '2026-11-15', xsd, virtual: this.viban.registry, msgIds,
      outbox: this.outbox, limits: (c) => this.reports.paymentLimits(c),
      onIncoming: (e) => this.accounts.onIncoming(e), agency: () => this.agency?.accounts, pending: opts.railsPending?.(), keyed,
    })
    // Outcomes the rails deliver later and credits from the scheme come in here (decision 930).
    this.rails.listen({
      outcome: (ref, o) => this.engine.settle(ref, o), credit: (c) => this.engine.received(c),
      // R-transactions after settlement (decision 1000) and recalls (1001).
      collectionReturned: (ref, code) => this.directDebit.returned(ref, code), recall: (r) => this.engine.recalled(r),
    })
    this.directDebit = new DirectDebitService({
      directory: this.directory, ledger: this.ledger, rails: this.rails, inbox: this.inbox, clock: this.clock, bank: this.bank,
      xsd, virtual: this.viban.registry, strictIban: opts.strictIban, outbox: this.outbox, msgIds, keyed,
    })
    this.fx = new FxService({
      directory: this.directory, ledger: this.ledger, inbox: this.inbox, clock: this.clock, bank: this.bank,
      outbox: this.outbox, keyed,
    })
    this.contracts = new Contracts(this.directory, this.clock, keyed)
    this.payee = new PayeeService({ directory: this.directory, viban: this.viban.registry, inbox: this.inbox, clock: this.clock, agency: () => this.agency?.accounts, keyed })
    this.bacs = new BacsService({
      directory: this.directory, ledger: this.ledger, rails: this.rails, inbox: this.inbox, clock: this.clock, bank: this.bank, virtual: this.viban.registry,
      outbox: this.outbox, onIncoming: (e) => this.accounts.onIncoming(e),
      credit: (p) => this.engine.incoming(p), keyed,
    }, opts.memory?.bacs)
    this.agency = new Agency({ directory: this.directory, inbox: this.inbox, clock: this.clock, bank: this.bank }, opts.memory?.agency, opts.agency)
    this.acquiring = new Acquiring({ directory: this.directory, inbox: this.inbox, clock: this.clock }, undefined, opts.acquiring)
    this.reports = new AccountReports({
      directory: this.directory, ledger: this.ledger, journal: this.journal, inbox: this.inbox, clock: this.clock, bank: this.bank, xsd, msgIds, keyed,
    }, opts.reports)
  }

  static async fromSeed(seed: Seed, opts: EmulatorOptions = {}): Promise<Emulator> {
    const e = new Emulator({ ...opts, bank: seed.bank })
    // A persistent ledger (PgLedger) already holds the seed's money after a restart (decision 914).
    // A customer the store held before this start is kept as stored (decision 972); a key
    // the seed lists twice is replaced by its later entry, as before.
    const stored = new Set<string>()
    for (const c of seed.customers) if (await e.directory.get(c)) stored.add(keyOf({ code: c.code, country: c.country.toUpperCase() }))
    for (const c of seed.customers) await e.addCustomer(c, { fundOnce: true, keepStored: stored.has(keyOf({ code: c.code, country: c.country.toUpperCase() })) })
    // What a crash left between a booking and its report (decision 990).
    await e.outbox.recover()
    return e
  }

  /**
   * fundOnce: seed balances only for account currencies the ledger has no balance in yet.
   * keepStored: a customer already in the directory stays as stored (decision 972).
   */
  async addCustomer(c: CustomerInput, o: { fundOnce?: boolean; keepStored?: boolean } = {}) {
    if (c.limits !== undefined) {
      for (const [k, v] of Object.entries(c.limits)) {
        if (k !== 'daily' && k !== 'monthly' && k !== 'instant') throw new Error(`unknown limit ${k}`)
        toMinor(v as string)
      }
    }
    // A persistent directory keeps a stored customer as it is over the seed's (decision 972).
    const customer = await this.directory.add(c, { ifAbsent: o.keepStored })
    // The set-up lives in the agency store; a persistent one keeps what /_sim/agency changed
    // over the seed's after a restart (fundOnce, decision 941).
    if (c.agency !== undefined || !o.fundOnce) {
      const setup = c.agency !== undefined ? checkSetup(c.agency, customer.accounts) : undefined
      await this.agency.accounts.setSetup(customer, setup, { ifAbsent: o.fundOnce })
    }
    // A persistent store keeps limits /_sim/reports changed over the seed's after a restart (decision 962).
    if (c.limits) await this.reports.configure(customer, { limits: { ...c.limits } }, { ifAbsent: o.fundOnce })
    for (const a of c.accounts ?? []) {
      // A stored customer the seed lists more accounts for keeps its own (decision 972).
      if (typeof a === 'string' || !customer.accounts.includes(normalizeIban(a.iban))) continue
      // Recorded once: a stored agreement, signed or ended over /_sim, is kept after a restart (decision 984).
      if (a.viban) await this.viban.registry.agreement(a.iban, true, { ifAbsent: o.fundOnce })
      if (!a.balances) continue
      const held = o.fundOnce ? await this.ledger.balances(normalizeIban(a.iban)) : {}
      for (const [ccy, amount] of Object.entries(a.balances)) if (!held[ccy]) await this.fund(a.iban, amount, ccy)
    }
    return customer
  }

  /**
   * Puts money on an account without a notification (simulator set-up). The statement
   * shows it as an ordinary credit, so statements reconcile with the balance.
   */
  async fund(iban: string, amount: string, currency: string) {
    const n = normalizeIban(iban)
    const owner = await this.directory.ownerOf(n)
    if (!owner) throw new Error(`no account ${n}`)
    const ref = servicerRef()
    const minor = toMinor(amount)
    await this.ledger.transfer({ ref, from: FUNDING, to: n, amount: minor, currency })
    await this.journal.record({
      account: n, owner: { name: owner.name, code: owner.code }, direction: 'CRDT', amount: minor, currency,
      servicerRef: ref, scheme: 'INTERNAL', bookedAt: this.clock.now(),
      counterparty: { name: this.bank.name, bic: this.bank.bic }, remittance: 'Simulator funding',
    })
  }
}
