// Account information: statements (camt.060 → camt.053) and balances (camt.060 →
// camt.052), answered through the inbox like every Connect request, plus the automatic
// end-of-day statement the bank sends unasked to customers who have it in their contract.
import { BoundedSet, DEFAULT_BOUNDS, type Bounds } from '../bounded.js'
import type { Clock } from '../clock.js'
import { keyOf, type Customer, type CustomerKey, type Directory } from '../directory.js'
import { errorsXml } from '../errors.js'
import type { Inbox } from '../inbox.js'
import { toMinor, type Ledger } from '../ledger.js'
import type { Bank } from '../payments/engine.js'
import type { XsdValidator } from '../payments/xsd.js'
import { dateTallinn } from '../time.js'
import { camt052, type ReportBalance } from './camt052.js'
import { camt053, type StatementBlock, type StatementVersion } from './camt053.js'
import { addDays, instant, isDate, isMidnight, isTime, parseCamt060, RequestInvalid, type ReportRequest } from './camt060.js'
import type { Journal, JournalEntry } from './journal.js'

export const STATEMENT_TYPE = 'ACCOUNT_STATEMENT'
export const BALANCE_TYPE = 'ACCOUNT_BALANCE'
/** Entries per camt.053 message and per request (the documented limits). */
export const PAGE_SIZE = 10_000
export const MAX_TRANSACTIONS = 100_000

export interface Limits { daily: string; monthly: string; instant: string }
export const DEFAULT_LIMITS: Limits = { daily: '10000.00', monthly: '100000.00', instant: '15000.00' }

export interface ReportSettings {
  /** Automatic end-of-day camt.053 for every account, in this version; off when absent. */
  automaticStatement?: StatementVersion
  /** Company API payment limits in EUR (PAYMENT_LIMITS). */
  limits?: Partial<Limits>
}

export interface ReportsOptions { pageSize?: number; maxTransactions?: number }

/** The documented errStatement_* codes and texts. */
export const E = {
  noAccess: ['errStatement_NoAccess', 'No access to the account.'],
  fromRequired: ['errStatement_PeriodInvalid', 'From date is required.'],
  fromFuture: ['errStatement_PeriodInvalid', 'From date cannot be in the future.'],
  fromAfterTo: ['errStatement_PeriodInvalid', 'From date cannot be later than to date.'],
  invalid: ['errStatement_RequestInvalid', 'Request message fails xsd validation.'],
  tooMany: ['errStatement_TransactionLimitExceeded', 'The requested period contains too many transactions'],
  duplicate: ['errStatement_DuplicateRequest', 'Duplicate request.'],
  technical: ['errStatement_TechnicalError', 'Technical error'],
} as const

class StatementError extends Error {
  constructor(readonly err: readonly [string, string], readonly field?: string) { super(err[1]) }
}

const ccyOrder = (a: string, b: string) => (a === b ? 0 : a === 'EUR' ? -1 : b === 'EUR' ? 1 : a < b ? -1 : 1)
const signed = (e: JournalEntry) => (e.direction === 'CRDT' ? e.amount : -e.amount)

export interface ReportsDeps {
  /** How many camt.060 MsgIds are remembered (decision 504). */
  msgIds?: Bounds
  directory: Directory
  ledger: Ledger
  journal: Journal
  inbox: Inbox
  clock: Clock
  bank: Bank
  xsd?: XsdValidator
}

export class AccountReports {
  pageSize: number
  maxTransactions: number
  #settings = new Map<string, ReportSettings>()
  #seen: BoundedSet<string>
  #eodDone = new Set<string>()
  #eodFrom: string

  constructor(private d: ReportsDeps, opts: ReportsOptions = {}) {
    this.#seen = new BoundedSet(d.clock, d.msgIds ?? DEFAULT_BOUNDS.msgIds)
    this.pageSize = opts.pageSize ?? PAGE_SIZE
    this.maxTransactions = opts.maxTransactions ?? MAX_TRANSACTIONS
    // Automatic statements start with the day the server starts on: no backfill.
    this.#eodFrom = dateTallinn(d.clock.now())
  }

  configure(c: CustomerKey, s: ReportSettings) {
    this.#settings.set(keyOf({ code: c.code, country: c.country.toUpperCase() }), { ...this.settings(c), ...s })
  }
  settings(c: CustomerKey): ReportSettings { return this.#settings.get(keyOf({ code: c.code, country: c.country.toUpperCase() })) ?? {} }

  /** POST /account-statement: the answer (pages or an error) goes to the customer's inbox. */
  statement(xml: string, customer: Customer, requestId: string) {
    return this.#handle('statement', xml, customer, requestId)
  }

  /** POST /account-balance */
  balance(xml: string, customer: Customer, requestId: string) {
    return this.#handle('balance', xml, customer, requestId)
  }

  async #handle(kind: 'statement' | 'balance', xml: string, customer: Customer, requestId: string) {
    const type = kind === 'statement' ? STATEMENT_TYPE : BALANCE_TYPE
    const add = (body: string) => this.d.inbox.add({ customer, type, requestId, body })
    try {
      const req = await this.#parse(kind, xml)
      const seenKey = `${keyOf(customer)}|${kind}`
      if (this.#seen.has(`${seenKey}|${req.msgId}`)) throw new StatementError(E.duplicate)
      const owner = this.d.directory.ownerOf(req.iban!)
      if (!owner || keyOf(owner) !== keyOf(customer)) throw new StatementError(E.noAccess)
      const bodies = kind === 'statement' ? this.#statementRequest(req, owner) : [await this.#balanceRequest(req, owner)]
      this.#seen.add(`${seenKey}|${req.msgId}`)
      for (const b of bodies) add(b)
    } catch (e) {
      const err = e instanceof StatementError ? e : new StatementError(E.technical)
      add(errorsXml([{ code: err.err[0], description: err.err[1], field: err.field }]))
    }
  }

  async #parse(kind: 'statement' | 'balance', xml: string): Promise<ReportRequest> {
    let req: ReportRequest
    try { req = parseCamt060(xml) } catch (e) {
      if (e instanceof RequestInvalid) throw new StatementError(E.invalid)
      throw e
    }
    const ns = `camt.060.001.${req.version}`
    if (this.d.xsd?.has(ns) && (await this.d.xsd.validate(xml, ns)).length) throw new StatementError(E.invalid)
    if (!req.msgId) throw new StatementError(E.invalid, 'MsgId')
    if (req.requests !== 1) throw new StatementError(E.invalid, 'RptgReq')
    const expected = kind === 'statement'
      ? (req.version === '05' ? 'camt.053.001.08' : 'camt.053.001.02')
      : (req.version === '05' ? 'camt.052.001.08' : 'camt.052.001.06')
    if (req.reqdMsgNmId !== expected) throw new StatementError(E.invalid, 'ReqdMsgNmId')
    if (!req.iban) throw new StatementError(E.invalid, 'IBAN')
    for (const [v, ok, f] of [[req.frDt, isDate, 'FrDt'], [req.toDt, isDate, 'ToDt'], [req.frTm, isTime, 'FrTm'], [req.toTm, isTime, 'ToTm']] as const) {
      if (v !== undefined && !ok(v)) throw new StatementError(E.invalid, f)
    }
    return req
  }

  // --- Statements -------------------------------------------------------------------

  #statementRequest(req: ReportRequest, owner: Customer): string[] {
    const now = this.d.clock.now().getTime()
    if (!req.frDt) throw new StatementError(E.fromRequired)
    const datetime = req.prtry === 'DATETIME'
    const toDt = req.toDt ?? dateTallinn(new Date(now))
    const from = datetime && req.frTm ? instant(req.frDt, req.frTm) : instant(req.frDt)
    let to = datetime && req.toTm ? instant(toDt, req.toTm) : instant(addDays(toDt, 1))
    if (from > now) throw new StatementError(E.fromFuture)
    if (from >= to) throw new StatementError(E.fromAfterTo)
    // A period reaching into the future ends now (inclusive end = the current millisecond).
    to = Math.min(to, now + 1)
    const entries = this.d.journal.entries(req.iban!, from, to)
    if (entries.length > this.maxTransactions) throw new StatementError(E.tooMany)
    return this.statementPages({ version: req.version === '05' ? '08' : '02', iban: req.iban!, owner, from, to, entries })
  }

  /** The camt.053 messages (one per page) of an account for [from, to). */
  statementPages(s: { version: StatementVersion; iban: string; owner: Customer; from: number; to: number; entries?: JournalEntry[] }): string[] {
    const created = this.d.clock.now()
    const entries = s.entries ?? this.d.journal.entries(s.iban, s.from, s.to)
    const fullDays = isMidnight(s.from) && isMidnight(s.to)
    const opening = this.d.journal.balancesBefore(s.iban, s.from)
    const history = new Set([...this.d.journal.balancesBefore(s.iban, s.to).keys()])
    const withEntries = new Set(entries.map((e) => e.currency))
    // v08 reports every currency with history; v02 mid-day reports only currencies with entries.
    let currencies = [...(s.version === '08' || fullDays ? history : withEntries)].sort(ccyOrder)
    if (currencies.length === 0) currencies = ['EUR']

    const ordered = currencies.flatMap((c) => entries.filter((e) => e.currency === c))
    const pages: JournalEntry[][] = []
    for (let i = 0; i < ordered.length; i += this.pageSize) pages.push(ordered.slice(i, i + this.pageSize))
    if (pages.length === 0) pages.push([])

    const running = new Map(currencies.map((c) => [c, opening.get(c) ?? 0n]))
    const first = new Map<string, JournalEntry>()
    const last = new Map<string, JournalEntry>()
    for (const e of ordered) { if (!first.has(e.currency)) first.set(e.currency, e); last.set(e.currency, e) }
    const prevPageLast = new Map<string, JournalEntry>()

    return pages.map((page, i) => {
      const isLast = i === pages.length - 1
      const blocks: StatementBlock[] = []
      for (const c of currencies) {
        const own = page.filter((e) => e.currency === c)
        if (own.length === 0 && !(isLast && !withEntries.has(c))) continue
        const open = running.get(c)!
        let close = open
        for (const e of own) close += signed(e)
        running.set(c, close)
        const startsHere = own.length === 0 || own[0] === first.get(c)
        const endsHere = own.length === 0 || own[own.length - 1] === last.get(c)
        blocks.push({
          currency: c,
          opening: { amount: open, intm: startsHere ? undefined : prevPageLast.get(c)!.bookedAt },
          closing: { amount: close, intm: endsHere ? undefined : own[own.length - 1].bookedAt },
          entries: own,
        })
        if (own.length) prevPageLast.set(c, own[own.length - 1])
      }
      return camt053({
        version: s.version, created, page: pages.length > 1 ? { number: i + 1, last: isLast } : undefined,
        from: s.from, to: s.to, fullDays, iban: s.iban, owner: { name: s.owner.name, code: s.owner.code }, bank: this.d.bank, blocks,
      })
    })
  }

  // --- Balances ---------------------------------------------------------------------

  async #balanceRequest(req: ReportRequest, owner: Customer): Promise<string> {
    const now = this.d.clock.now()
    const today = dateTallinn(now)
    const version = req.version === '05' ? '08' : '06'
    if (version === '08' && req.prtry === 'END_OF_DAY_BALANCE') {
      if (!req.frDt) throw new StatementError(E.fromRequired)
      if (req.frDt >= today) throw new StatementError(E.fromFuture)
      const end = instant(addDays(req.frDt, 1))
      const bal = this.d.journal.balancesBefore(req.iban!, end)
      const currencies = [...bal.keys()].sort(ccyOrder)
      return camt052({
        version, created: now, at: new Date(end - 1), date: req.frDt, iban: req.iban!,
        blocks: (currencies.length ? currencies : ['EUR']).map((c) => ({ currency: c, balances: [{ code: 'CLBD', amount: bal.get(c) ?? 0n }] })),
      })
    }
    return this.#intraday(version, req.iban!, owner, req.prtry === 'PAYMENT_LIMITS', now, today)
  }

  async #intraday(version: '08' | '06', iban: string, owner: Customer, limits: boolean, now: Date, today: string): Promise<string> {
    // Balances are real-time: booked (ITBD) and available after reservations (ITAV).
    const live = new Map(Object.entries(await this.d.ledger.balances(iban)))
    if (live.size === 0 || (limits && !live.has('EUR'))) live.set('EUR', live.get('EUR') ?? { balance: 0n, available: 0n })
    const currencies = [...live.keys()].sort(ccyOrder)
    const blocks = currencies.map((c) => {
      const b = live.get(c)!
      const balances: ReportBalance[] = [{ code: 'ITBD', amount: b.balance }, { code: 'ITAV', amount: b.available }]
      if (limits && c === 'EUR') balances.push(...this.#limits(owner, now, today))
      return { currency: c, balances }
    })
    return camt052({ version, created: now, at: now, date: today, iban, blocks })
  }

  /**
   * The customer's Connect payment limits now: totals, what today's / this month's EUR
   * debits (Tallinn calendar) leave free, and the per-payment instant limit. The payment
   * engine enforces these (decision 524).
   */
  paymentLimits(owner: Customer, now = this.d.clock.now()) {
    const today = dateTallinn(now)
    const l = { ...DEFAULT_LIMITS, ...this.settings(owner).limits }
    let day = 0n, month = 0n
    for (const e of this.d.journal.all(owner.accounts)) {
      if (e.direction !== 'DBIT' || e.currency !== 'EUR') continue
      const d = dateTallinn(e.bookedAt)
      if (d.slice(0, 7) === today.slice(0, 7) && e.bookedAt <= now) month += e.amount
      if (d === today && e.bookedAt <= now) day += e.amount
    }
    const free = (total: bigint, used: bigint) => (total > used ? total - used : 0n)
    const monthly = toMinor(l.monthly), daily = toMinor(l.daily)
    return { monthly, daily, monthlyFree: free(monthly, month), dailyFree: free(daily, day), instant: toMinor(l.instant) }
  }

  #limits(owner: Customer, now: Date, _today: string): ReportBalance[] {
    const { monthly, daily, monthlyFree, dailyFree, instant } = this.paymentLimits(owner, now)
    return [
      { prtry: 'PAYMENT_LIMIT_MONTHLY_TOTAL', amount: monthly },
      { prtry: 'PAYMENT_LIMIT_MONTHLY_FREE', amount: monthlyFree },
      { prtry: 'PAYMENT_LIMIT_DAILY_TOTAL', amount: daily },
      { prtry: 'PAYMENT_LIMIT_DAILY_FREE', amount: dailyFree },
      { prtry: 'PAYMENT_LIMIT_INSTANT', amount: instant },
    ]
  }

  // --- Automatic end-of-day statement -------------------------------------------------

  /**
   * Sends the statement of a finished day (Tallinn time) for every account of every
   * customer with automatic statements. Returns the number of messages; a day is sent once.
   */
  endOfDay(date: string): number {
    if (this.#eodDone.has(date)) return 0
    this.#eodDone.add(date)
    let n = 0
    for (const c of this.d.directory.all()) {
      const version = this.settings(c).automaticStatement
      if (!version) continue
      for (const iban of c.accounts) {
        for (const body of this.statementPages({ version, iban, owner: c, from: instant(date), to: instant(addDays(date, 1)) })) {
          this.d.inbox.add({ customer: c, type: STATEMENT_TYPE, body })
          n++
        }
      }
    }
    return n
  }

  /** Runs the end-of-day statements of every day finished since the last call (clock-driven). */
  tick(): number {
    const yesterday = addDays(dateTallinn(this.d.clock.now()), -1)
    let n = 0
    for (let d = this.#eodFrom; d <= yesterday; d = addDays(d, 1)) n += this.endOfDay(d)
    if (this.#eodFrom <= yesterday) this.#eodFrom = addDays(yesterday, 1)
    return n
  }
}
