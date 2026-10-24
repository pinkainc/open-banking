// LHV UK account reports in JSON (G account-reports, decisions 705–713): the list of a
// customer's UK accounts, one transaction by its account servicer reference, and the
// incoming payments that are pending or rejected. Synchronous, OBIE-like PascalCase.
// Data comes from the directory, the statement journal (booked), the payment engine
// (reserved in manual review) and the incoming-payment states the engine reports.
import { BoundedMap, type Bounds } from '../bounded.js'
import { DAY_MS, type Clock } from '../clock.js'
import type { Customer, Directory } from '../directory.js'
import { JsonBodyError } from '../errors.js'
import { normalizeIban } from '../iban.js'
import { fromMinor, type Ledger } from '../ledger.js'
import type { IncomingEvent, PaymentEngine } from '../payments/engine.js'
import { isUkAccount } from '../routing.js'
import type { JournalEntry, JournalStore } from '../statements/journal.js'
import { dateLondon } from '../time.js'
import type { VibanRegistry } from '../viban/registry.js'

/** LHV Bank UK's BIC (G samples: Servicer `LHVBGB2L`, agent `LHVBGB2LXXX`). */
export const LHV_UK_BIC = 'LHVBGB2L'
/** How far back both lookups reach (G: "within the last 14 days"). */
export const LOOKBACK_DAYS = 14
/** Remembered incoming states: a day beyond the lookback, at most 10 000. */
export const DEFAULT_INCOMING: Bounds = { ttlMs: (LOOKBACK_DAYS + 1) * DAY_MS, max: 10_000 }

export const ACCESS_DENIED = 'Access denied for the account associated with this IBAN'
export const NO_TRANSACTION = 'No transaction record was found. This may happen if the account servicer reference is invalid, the payment is cancelled or older than 14 days, or it is scheduled for a future date'

const bad = (text: string) => new JsonBodyError(400, text)
const denied = () => new JsonBodyError(403, ACCESS_DENIED)

/** The 14-digit sort code and account number of a GB IBAN, else undefined. */
export const gbBban = (iban: string) => (/^GB[0-9]{2}[A-Z]{4}[0-9]{14}$/.test(iban) ? iban.slice(8) : undefined)
/** How a UK account is identified in a counterparty: sort code + account number, else the IBAN (decision 711). */
const ukIdentification = (iban: string) => gbBban(iban) ?? iban
/** A servicer reference (32 hex) as a TransactionId: the UUID form, upper case (decision 709). */
export const transactionId = (ref: string) =>
  /^[0-9A-F]{32}$/i.test(ref) ? `${ref.slice(0, 8)}-${ref.slice(8, 12)}-${ref.slice(12, 16)}-${ref.slice(16, 20)}-${ref.slice(20)}`.toUpperCase() : ref
/** An 8-character BIC with the branch code (G sample `LHVBGB2LXXX`). */
const bic11 = (bic: string) => (bic.length === 8 ? `${bic}XXX` : bic)

export interface AccountInfo { opened: string; nickname?: string; closed?: boolean }

interface IncomingEntry extends IncomingEvent { at: Date }
/** An incoming payment the simulator holds (/_sim/accounts/incoming, decision 712). */
export interface HeldIncoming {
  ref: string; iban: string; amount: bigint; currency: string; scheme: string
  debtor: { name?: string; iban?: string; bic?: string }; remittance?: string; reference?: string; endToEndId?: string
}

export interface AccountsDeps {
  directory: Directory; ledger: Ledger; journal: JournalStore; viban: VibanRegistry; clock: Clock; bank: { bic: string }
  engine: () => PaymentEngine
}

const intParam = (v: unknown, name: string, min: number, dflt?: number): number => {
  if (v === undefined || v === '') {
    if (dflt === undefined) throw bad(`${name} is required`)
    return dflt
  }
  const s = String(Array.isArray(v) ? v[0] : v)
  if (!/^-?\d+$/.test(s) || Number(s) < min) throw bad(`${name} must be an integer of at least ${min}`)
  return Number(s)
}
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const dateParam = (v: unknown, name: string, dflt: string): string => {
  if (v === undefined || v === '') return dflt
  const s = String(Array.isArray(v) ? v[0] : v)
  const m = DATE.exec(s)
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : undefined
  if (!d || d.toISOString().slice(0, 10) !== s) throw bad(`${name} must be a date in yyyy-MM-dd format`)
  return s
}
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

export class AccountsService {
  #info = new Map<string, AccountInfo>()
  #incoming: BoundedMap<string, IncomingEntry>
  #held = new Map<string, HeldIncoming>()

  constructor(private deps: AccountsDeps, bounds: Bounds = DEFAULT_INCOMING) {
    this.#incoming = new BoundedMap(deps.clock, bounds)
  }

  // --- Account details ------------------------------------------------------------

  /** Records an account's list details when it is added (opening day: today, UK date, unless given). */
  register(iban: string, info: { opened?: string; nickname?: string; closed?: boolean } = {}) {
    if (info.opened !== undefined && (!DATE.test(info.opened) || Number.isNaN(Date.parse(info.opened)))) throw new Error(`opened must be YYYY-MM-DD, not ${info.opened}`)
    if (info.nickname !== undefined && typeof info.nickname !== 'string') throw new Error('nickname must be a string')
    if (info.closed !== undefined && typeof info.closed !== 'boolean') throw new Error('closed must be a boolean')
    this.#info.set(normalizeIban(iban), {
      opened: info.opened ?? dateLondon(this.deps.clock.now()),
      ...(info.nickname ? { nickname: info.nickname } : {}), ...(info.closed ? { closed: true } : {}),
    })
  }

  info(iban: string): AccountInfo | undefined { return this.#info.get(normalizeIban(iban)) }

  /** GET /accounts/list: the customer's UK current accounts (GB IBANs), VIBANs excluded. */
  async list(customer: Customer, q: Record<string, unknown>) {
    const pageNumber = intParam(q.pageNumber, 'pageNumber', 1)
    const pageSize = Math.min(intParam(q.pageSize, 'pageSize', 1, 100), 100)
    const closedParam = String(q.includeClosedAccounts ?? 'true').toLowerCase()
    if (closedParam !== 'true' && closedParam !== 'false') throw bad('includeClosedAccounts must be true or false')
    const includeClosed = closedParam === 'true'
    const accounts = customer.accounts.filter(isUkAccount).filter((a) => includeClosed || !this.info(a)?.closed)
    const page = accounts.slice((pageNumber - 1) * pageSize, pageNumber * pageSize)
    const out = []
    for (const iban of page) {
      const info = this.info(iban) ?? { opened: dateLondon(this.deps.clock.now()) }
      const ids: { SchemeName: string; Identification: string; Name: string }[] = [{ SchemeName: 'IBAN', Identification: iban, Name: customer.name }]
      const bban = gbBban(iban)
      if (bban) ids.push({ SchemeName: 'SortCodeAccountNumber', Identification: bban, Name: customer.name })
      out.push({
        Status: info.closed ? 'Deleted' : 'Enabled',
        Currency: await this.#currency(iban),
        ...(info.nickname ? { Nickname: info.nickname } : {}),
        OpeningDate: info.opened,
        Account: ids,
        Servicer: { SchemeName: 'BICFI', Identification: LHV_UK_BIC },
      })
    }
    return { Data: { Account: out }, Links: {}, Meta: {} }
  }

  /** GBP, the UK current account's currency, unless the account only ever held another one. */
  async #currency(iban: string) {
    const held = Object.keys(await this.deps.ledger.balances(iban)).sort()
    return held.length === 0 || held.includes('GBP') ? 'GBP' : held[0]
  }

  // --- One transaction by reference -------------------------------------------------

  /** GET /accounts/{accountNumber}/transactions/{accountServicerReference}. */
  async transaction(customer: Customer, accountNumber: string, reference: string) {
    const iban = normalizeIban(decodeURIComponent(accountNumber))
    // Master accounts of LHV UK only: a VIBAN, another's or an EE account is refused (decision 710).
    if (!isUkAccount(iban) || !customer.accounts.includes(iban)) throw denied()
    const ref = decodeURIComponent(reference).replace(/-/g, '').toUpperCase()
    if (!/^[0-9A-F]{32}$/.test(ref)) throw new JsonBodyError(404, NO_TRANSACTION)
    const now = this.deps.clock.now().getTime()
    const booked = (await this.deps.journal.entries(iban, now - LOOKBACK_DAYS * DAY_MS, now + 1)).filter((e) => e.servicerRef === ref)
    if (booked.length) return this.#bookedView(booked[booked.length - 1])
    const r = this.deps.engine().reserved(ref)
    if (r && r.account === iban) {
      const creditorId = r.creditor.iban ?? r.creditor.account
      return {
        ...(r.endToEndId ? { EndToEndId: r.endToEndId } : {}),
        IsVirtualAccountPayment: r.debtorIban !== iban || (!!r.creditor.iban && !!this.deps.viban.resolve(r.creditor.iban)),
        Amount: { Amount: fromMinor(r.amount), Currency: r.currency },
        CreditDebitIndicator: 'Debit',
        Status: 'Pending',
        ...(r.creditor.bic ? { CreditorAgent: { SchemeName: 'BIC', Identification: this.#agentBic(r.creditor.bic, creditorId) } } : {}),
        ...(creditorId ? { CreditorAccount: { Identification: creditorId, ...(r.creditor.name ? { Name: r.creditor.name } : {}) } } : {}),
        TransactionId: transactionId(ref),
      }
    }
    throw new JsonBodyError(404, NO_TRANSACTION)
  }

  /** LHV's own BIC for an account here: LHV UK's for a GB account, else the given one. */
  #agentBic(bic: string, account?: string) {
    const own = account && this.deps.directory.ownerOf(this.#masterOf(account))
    return bic11(own && isUkAccount(account) ? LHV_UK_BIC : bic)
  }

  #masterOf(iban: string) { return this.deps.viban.resolve(iban)?.master ?? iban }

  #bookedView(e: JournalEntry) {
    const debit = e.direction === 'DBIT'
    const id = e.counterparty.iban ?? e.counterparty.account
    const party = id ? { Identification: id, ...(e.counterparty.name ? { Name: e.counterparty.name } : {}) } : undefined
    const agent = e.counterparty.bic ? { SchemeName: 'BIC', Identification: this.#agentBic(e.counterparty.bic, id) } : undefined
    const date = dateLondon(e.bookedAt)
    return {
      ...(e.endToEndId ? { EndToEndId: e.endToEndId } : {}),
      IsVirtualAccountPayment: (!!e.virtual && !e.virtual.agency) || (!!e.counterparty.iban && !!this.deps.viban.resolve(e.counterparty.iban)),
      Amount: { Amount: fromMinor(e.amount), Currency: e.currency },
      CreditDebitIndicator: debit ? 'Debit' : 'Credit',
      Status: 'Booked',
      BookingDateTime: date,
      ValueDateTime: date,
      ...(agent ? { [debit ? 'CreditorAgent' : 'DebtorAgent']: agent } : {}),
      ...(party ? { [debit ? 'CreditorAccount' : 'DebtorAccount']: party } : {}),
      // The VIBAN the payment went through (decision 709: field name ours).
      ...(e.virtual ? { VirtualAccount: { Identification: e.virtual.iban, ...(e.virtual.name ? { Name: e.virtual.name } : {}) } } : {}),
      TransactionId: transactionId(e.servicerRef),
    }
  }

  // --- Incoming pending and rejected ----------------------------------------------------

  /** The engine's report about an incoming payment (decision 711). Booked ones leave the list. */
  onIncoming(e: IncomingEvent) {
    if (e.status === 'Booked') { this.#incoming.delete(e.ref); return }
    const before = this.#incoming.get(e.ref)
    this.#incoming.set(e.ref, { ...e, account: normalizeIban(e.account), master: normalizeIban(e.master), at: before?.at ?? this.deps.clock.now() })
  }

  /** The account a path names (IBAN or 14-digit sort code + account number), if the customer has it. */
  #resolve(customer: Customer, raw: string): { account: string; master: string } | undefined {
    const t = decodeURIComponent(raw).replace(/[\s-]+/g, '').toUpperCase()
    const own = (master: string) => customer.accounts.includes(master) && isUkAccount(master)
    if (/^[0-9]{14}$/.test(t)) {
      const master = customer.accounts.find((a) => gbBban(a) === t)
      if (master && own(master)) return { account: master, master }
      const v = this.deps.viban.all().find((x) => gbBban(x.iban) === t && own(x.master))
      return v ? { account: v.iban, master: v.master } : undefined
    }
    const iban = normalizeIban(t)
    if (own(iban)) return { account: iban, master: iban }
    const v = this.deps.viban.resolve(iban)
    return v && own(v.master) ? { account: v.iban, master: v.master } : undefined
  }

  /** GET /accounts/{accountNumber}/payments. */
  payments(customer: Customer, accountNumber: string, q: Record<string, unknown>) {
    const acc = this.#resolve(customer, accountNumber)
    if (!acc) throw denied()
    const today = dateLondon(this.deps.clock.now())
    const toDate = dateParam(q.toDate, 'toDate', today)
    const fromDate = dateParam(q.fromDate, 'fromDate', addDays(today, -LOOKBACK_DAYS))
    if (fromDate > toDate) throw bad('fromDate must not be after toDate')
    const raw = q.status === undefined ? [] : Array.isArray(q.status) ? q.status : [q.status]
    const statuses = new Set(raw.flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean))
    for (const s of statuses) if (s !== 'Pending' && s !== 'Rejected') throw bad(`status must be Pending or Rejected, not ${s}`)
    if (statuses.size === 0) { statuses.add('Pending'); statuses.add('Rejected') }
    const page = intParam(q.page, 'page', 0, 0)
    const size = intParam(q.size, 'size', 1, 20)
    if (size > 100) throw bad('size must be at most 100')
    const holder = (account: string) => this.deps.viban.resolve(account)?.holder?.name ?? customer.name
    const all = this.#incoming.entries().map(([, e]) => e)
      .filter((e) => e.master === acc.master && (acc.account === acc.master || e.account === acc.account))
      .filter((e) => statuses.has(e.status))
      .filter((e) => { const d = dateLondon(e.at); return d >= fromDate && d <= toDate })
      .sort((a, b) => a.at.getTime() - b.at.getTime())
    const Transaction = all.slice(page * size, (page + 1) * size).map((e) => ({
      AccountId: e.master,
      Amount: { Amount: fromMinor(e.amount), Currency: e.currency },
      CreditDebitIndicator: 'Credit',
      Status: e.status,
      ValueDateTime: dateLondon(e.at),
      CreditorAccount: { Identification: ukIdentification(e.account), Name: holder(e.account) },
      ...(e.debtor.iban ? { DebtorAccount: { Identification: ukIdentification(e.debtor.iban), ...(e.debtor.name ? { Name: e.debtor.name } : {}) } } : {}),
      TransactionId: transactionId(e.ref),
    }))
    return { Data: { Transaction }, Links: {}, Meta: { TotalElements: all.length, Page: page, PageSize: size } }
  }

  // --- Simulator: incoming payments held before booking (decision 712) -------------------

  /** Holds an incoming payment as Pending (no booking, no notification) until decided. */
  hold(p: HeldIncoming) {
    const v = this.deps.viban.resolve(p.iban)
    this.#held.set(p.ref, p)
    this.onIncoming({ ref: p.ref, status: 'Pending', account: p.iban, master: v?.master ?? p.iban, amount: p.amount, currency: p.currency,
      debtor: { name: p.debtor.name, iban: p.debtor.iban } })
  }

  held(): HeldIncoming[] { return [...this.#held.values()] }

  /** Books a held payment (the engine's incoming credit, same reference) or rejects it. */
  async decide(ref: string, approve: boolean) {
    const p = this.#held.get(ref)
    if (!p) return undefined
    this.#held.delete(ref)
    if (!approve) {
      const e = this.#incoming.get(ref)
      if (e) this.#incoming.set(ref, { ...e, status: 'Rejected' })
      return { ref, status: 'Rejected' as const }
    }
    this.#incoming.delete(ref)
    const r = await this.deps.engine().incoming({ ...p })
    return r.returned ? { ref, status: 'Rejected' as const, reason: r.returned.code } : { ref, status: 'Booked' as const, accountServicerReference: r.servicerRef }
  }
}
