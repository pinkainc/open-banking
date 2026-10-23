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
  /** How VIBAN business errors are delivered (docs/decisions.md 200); default inbox. */
  vibanErrors?: ErrorDelivery
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
  readonly viban: VibanService

  constructor(opts: EmulatorOptions & { bank?: Partial<Bank> } = {}) {
    this.clock = opts.clock ?? systemClock
    this.ledger = opts.ledger ?? new MemoryLedger()
    this.rails = opts.rails ?? new SimulatorRails()
    this.inbox = new Inbox(this.clock)
    this.bank = { ...DEFAULT_BANK, ...opts.bank }
    const xsd = opts.xsdDir ? new XsdValidator(opts.xsdDir) : undefined
    this.viban = new VibanService(this.directory, this.inbox, this.clock, {
      schemas: opts.xsdDir ? new VibanSchemas(opts.xsdDir) : undefined, errors: opts.vibanErrors,
    })
    this.engine = new PaymentEngine(this.directory, this.ledger, this.rails, this.inbox, this.clock, this.bank, {
      strictIban: opts.strictIban, pain00103Until: opts.pain00103Until ?? '2026-11-15', xsd, virtual: this.viban.registry,
    })
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

  /** Puts money on an account without a notification (simulator set-up). */
  async fund(iban: string, amount: string, currency: string) {
    const n = normalizeIban(iban)
    if (!this.directory.ownerOf(n)) throw new Error(`no account ${n}`)
    await this.ledger.transfer({ ref: `fund-${Date.now()}-${Math.random()}`, from: FUNDING, to: n, amount: toMinor(amount), currency })
  }
}
