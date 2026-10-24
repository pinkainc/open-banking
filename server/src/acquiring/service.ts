// Card acquiring for merchants (P 13, decisions 820–827): the merchant set-up of a customer
// (its ACQ user code and settlement accounts), a minimal store of card transactions fed by
// /_sim/acq, and POST /acq/merchant-report, answered in the inbox as ACQ_REPORT: a
// camt.054.001.02 of the period's card transactions, or an <Errors> document.
import { BoundedMap, type Bounds } from '../bounded.js'
import type { Clock } from '../clock.js'
import { keyOf, type Customer, type CustomerKey, type Directory } from '../directory.js'
import { errorsXml } from '../errors.js'
import type { Inbox } from '../inbox.js'
import { fromMinor, toMinor } from '../ledger.js'
import { notificationMsgId } from '../ids.js'
import { addDays, isDate } from '../statements/camt060.js'
import { dateTallinn, localTallinn } from '../time.js'
import { document, el, opt, parseXml, text, toXml } from '../xml.js'

export const ACQ_REPORT = 'ACQ_REPORT'
export const REPORT_TYPES = ['CAMT_SETTLEMENT', 'CAMT_TRANSACTION'] as const
export type ReportType = typeof REPORT_TYPES[number]
/** "Maximum period is 35 days" (P 13), counted inclusively (decision 822). */
export const MAX_PERIOD_DAYS = 35
/** Transactions are kept by count only, like agency accounts (decision 827). */
export const ACQ_BOUNDS: Bounds = { max: 100_000 }

/** The documented error codes and texts (P 13 "Error codes"). */
export const E = {
  technical: ['errMerchantReport_TechnicalError', 'Unexpected error while composing merchant report response'],
  invalid: ['errMerchantReport_InvalidInput', 'Invalid request xml, can’t read it'],
  notReady: ['errStatement_PeriodInvalid', 'Data not ready for selected period'],
  dateNull: ['errMerchantReport_NotNull', 'Maynot be null. Right format yyyy-MM-dd'],
  typeNull: ['errMerchantReport_NotNull', 'Maynot be null'],
  typeEmpty: ['errMerchantReport_NotEmpty', 'Maynot be empty'],
  wrongType: ['errMerchantReport_1', 'Wrong report type'],
  tooLong: ['errMerchantReport_2', 'Period can’t be longer than 35 days'],
  noUser: ['errMerchantReport_3', 'No such user code in ACQ'],
  noIban: ['errMerchantReport_7', 'User not authorized for this report request, no IBAN found for merchant'],
  startAfterEnd: ['errMerchantReport_9', 'Period start can’t be after end'],
} as const

class ReportError extends Error {
  constructor(readonly err: readonly [string, string], readonly field?: string) { super(err[1]) }
}

/** The account manager's acquiring set-up of a customer (decision 823). */
export interface MerchantSetup {
  /** ACQ user code; the report's notification ids start with it. */
  userCode: string
  /** Settlement accounts (IBANs of the customer) the report covers. */
  accounts: string[]
}

export interface CardTransaction {
  /** NtryRef / AcctSvcrRef: a running number, as the sample's 4904. */
  ref: string
  account: string
  currency: string
  direction: 'CRDT' | 'DBIT'
  /** Gross transaction amount (TxAmt) and the fee (Chrgs), minor units. */
  amount: bigint
  fee: bigint
  /** Day the card was used (BookgDt) and the day it was settled (ValDt; none yet when absent). */
  transactionDate: string
  settlementDate?: string
  terminal: string
  stan?: string
  pan: string
  mid: string
  location?: string
  /** Card scheme code shown as the debtor agent name (the sample's 689MC). */
  scheme: string
  orderRef?: string
  subFamily: string
}

export type CardTransactionInput = {
  account: string; amount: string; currency?: string; fee?: string; direction?: 'CRDT' | 'DBIT'
  transactionDate?: string; settlementDate?: string | null; terminal?: string; stan?: string; pan?: string
  mid?: string; location?: string; scheme?: string; orderRef?: string; subFamily?: string
}

/** PAN with positions 7–12 masked (P 13 2.134). */
export function maskPan(pan: string): string {
  const p = pan.replace(/\s+/g, '')
  if (p.length < 13) return p
  return p.slice(0, 6) + '*'.repeat(6) + p.slice(12)
}

/** Six decimals, as the sample's entry and fee amounts (decision 825). */
const six = (n: bigint) => `${fromMinor(n)}0000`

export interface AcquiringDeps { directory: Directory; inbox: Inbox; clock: Clock }

export class Acquiring {
  #merchants = new Map<string, MerchantSetup>()
  #tx: BoundedMap<string, CardTransaction>
  #seq = 4900
  constructor(private d: AcquiringDeps, bounds: Bounds = ACQ_BOUNDS) { this.#tx = new BoundedMap(d.clock, bounds) }

  merchant(c: CustomerKey): MerchantSetup | undefined { return this.#merchants.get(keyOf({ code: c.code, country: c.country.toUpperCase() })) }

  /** Sets (or with undefined removes) a customer's acquiring set-up; accounts default to all its accounts. */
  setMerchant(c: Customer, s: { userCode?: unknown; accounts?: unknown } | undefined): MerchantSetup | undefined {
    const k = keyOf(c)
    if (s === undefined) { this.#merchants.delete(k); return undefined }
    if (s.userCode !== undefined && (typeof s.userCode !== 'string' || !/^[A-Za-z0-9]{1,20}$/.test(s.userCode))) throw new Error('userCode must be 1–20 letters or digits')
    let accounts = c.accounts
    if (s.accounts !== undefined) {
      if (!Array.isArray(s.accounts) || s.accounts.some((a) => typeof a !== 'string')) throw new Error('accounts must be a list of IBANs')
      accounts = (s.accounts as string[]).map((a) => a.replace(/\s+/g, '').toUpperCase())
      const foreign = accounts.find((a) => !c.accounts.includes(a))
      if (foreign) throw new Error(`${foreign} is not an account of ${k}`)
    }
    const m: MerchantSetup = { userCode: (s.userCode as string | undefined) ?? c.code, accounts: [...accounts] }
    this.#merchants.set(k, m)
    return m
  }

  /** A card transaction on a merchant's settlement account (the simulator's card scheme). */
  addTransaction(i: CardTransactionInput): CardTransaction {
    const account = String(i.account ?? '').replace(/\s+/g, '').toUpperCase()
    const owner = this.d.directory.ownerOf(account)
    if (!owner) throw new Error(`no account ${account}`)
    const m = this.merchant(owner)
    if (!m) throw new Error(`${keyOf(owner)} has no acquiring set-up`)
    if (!m.accounts.includes(account)) throw new Error(`${account} is not a settlement account of the merchant`)
    const amount = toMinor(String(i.amount))
    const fee = i.fee === undefined ? 0n : toMinor(String(i.fee))
    if (amount < 0n || fee < 0n) throw new Error('amount and fee must not be negative')
    const direction = i.direction ?? 'CRDT'
    if (direction !== 'CRDT' && direction !== 'DBIT') throw new Error('direction must be CRDT or DBIT')
    const currency = i.currency ?? 'EUR'
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be three capital letters')
    const transactionDate = i.transactionDate ?? dateTallinn(this.d.clock.now())
    if (!isDate(transactionDate)) throw new Error('transactionDate must be YYYY-MM-DD')
    // Settled the next day unless given; null: not settled yet (decision 824).
    const settlementDate = i.settlementDate === null ? undefined : i.settlementDate ?? addDays(transactionDate, 1)
    if (settlementDate !== undefined && (!isDate(settlementDate) || settlementDate < transactionDate)) {
      throw new Error('settlementDate must be YYYY-MM-DD, not before transactionDate')
    }
    const pan = i.pan ?? '5326100000003339'
    if (!/^[0-9*]{12,19}$/.test(pan.replace(/\s+/g, ''))) throw new Error('pan must be 12–19 digits')
    const t: CardTransaction = {
      ref: String(++this.#seq), account, currency, direction, amount, fee, transactionDate, settlementDate,
      terminal: i.terminal ?? '87654321 001', stan: i.stan, pan: maskPan(pan), mid: i.mid ?? '1234567',
      location: i.location, scheme: i.scheme ?? '689MC', orderRef: i.orderRef,
      subFamily: i.subFamily ?? (direction === 'CRDT' ? 'POSP' : 'DAJT'),
    }
    this.#tx.set(t.ref, t)
    return t
  }

  transactions(account?: string): CardTransaction[] {
    const all = this.#tx.entries().map(([, t]) => t)
    return account ? all.filter((t) => t.account === account.replace(/\s+/g, '').toUpperCase()) : all
  }

  /** POST /acq/merchant-report: the report or an error goes to the customer's inbox. */
  report(xml: string, customer: Customer, requestId: string) {
    const add = (body: string) => this.d.inbox.add({ customer, type: ACQ_REPORT, requestId, body })
    try {
      add(this.#report(xml, customer))
    } catch (e) {
      const err = e instanceof ReportError ? e : new ReportError(E.technical)
      add(errorsXml([{ code: err.err[0], description: err.err[1], field: err.field }]))
    }
  }

  #report(xml: string, customer: Customer): string {
    let doc: any
    try { doc = parseXml(xml) } catch { throw new ReportError(E.invalid) }
    const r = doc?.MerchantReportRequest
    if (!r || typeof r !== 'object') throw new ReportError(E.invalid)
    if (r.Type === undefined) throw new ReportError(E.typeNull, 'Type')
    const type = (text(r.Type) ?? '').trim()
    if (!type) throw new ReportError(E.typeEmpty, 'Type')
    if (!REPORT_TYPES.includes(type as ReportType)) throw new ReportError(E.wrongType, 'Type')
    const start = text(r.PeriodStart)?.trim()
    const end = text(r.PeriodEnd)?.trim()
    if (!isDate(start)) throw new ReportError(E.dateNull, 'PeriodStart')
    if (!isDate(end)) throw new ReportError(E.dateNull, 'PeriodEnd')
    if (start > end) throw new ReportError(E.startAfterEnd)
    if (addDays(start, MAX_PERIOD_DAYS - 1) < end) throw new ReportError(E.tooLong)
    const m = this.merchant(customer)
    if (!m) throw new ReportError(E.noUser)
    if (m.accounts.length === 0) throw new ReportError(E.noIban)
    if (end > dateTallinn(this.d.clock.now())) throw new ReportError(E.notReady)
    return this.#camt054(type as ReportType, start, end, m, customer)
  }

  #camt054(type: ReportType, start: string, end: string, m: MerchantSetup, customer: Customer): string {
    const now = localTallinn(this.d.clock.now())
    const inPeriod = (d: string | undefined) => d !== undefined && d >= start && d <= end
    const txs = this.transactions()
      .filter((t) => m.accounts.includes(t.account))
      .filter((t) => (type === 'CAMT_SETTLEMENT' ? inPeriod(t.settlementDate) : inPeriod(t.transactionDate)))
    // One block per account and currency; an account without transactions gets an empty EUR block (decision 826).
    const blocks: { account: string; currency: string; txs: CardTransaction[] }[] = []
    for (const account of m.accounts) {
      const own = txs.filter((t) => t.account === account)
      const ccys = [...new Set(own.map((t) => t.currency))].sort((a, b) => (a === 'EUR' ? -1 : b === 'EUR' ? 1 : a < b ? -1 : 1))
      if (!ccys.length) ccys.push('EUR')
      for (const currency of ccys) blocks.push({ account, currency, txs: own.filter((t) => t.currency === currency).sort((a, b) => Number(a.ref) - Number(b.ref)) })
    }
    const compact = (d: string) => d.replaceAll('-', '')
    const sum = (list: CardTransaction[]) => fromMinor(list.reduce((s, t) => s + t.amount, 0n))
    const net = (t: CardTransaction) => (t.direction === 'CRDT' ? t.amount - t.fee : t.amount + t.fee)
    const name = customer.name.slice(0, 140)
    const entry = (t: CardTransaction) => {
      const n = net(t)
      const ind = n === 0n ? 'CRDT' : t.direction
      const acct = el('Id', el('IBAN', t.account))
      return el('Ntry',
        el('NtryRef', t.ref),
        el('Amt', { Ccy: t.currency }, six(n < 0n ? -n : n)),
        el('CdtDbtInd', ind),
        el('Sts', 'BOOK'),
        el('BookgDt', el('Dt', t.transactionDate)),
        t.settlementDate ? el('ValDt', el('Dt', t.settlementDate)) : null,
        el('AcctSvcrRef', t.ref),
        el('BkTxCd',
          el('Domn', el('Cd', 'PMNT'), el('Fmly', el('Cd', 'MCDR'), el('SubFmlyCd', t.subFamily))),
          el('Prtry', el('Cd', t.terminal))),
        el('NtryDtls', el('TxDtls',
          el('Refs', opt('AcctSvcrRef', t.orderRef), opt('ChqNb', t.stan), el('Prtry', el('Tp', t.pan), el('Ref', t.mid))),
          el('AmtDtls', el('TxAmt', el('Amt', { Ccy: t.currency }, fromMinor(t.amount)))),
          t.fee !== 0n ? el('Chrgs', el('Amt', { Ccy: t.currency }, six(t.fee))) : null,
          el('RltdPties',
            el('Dbtr', el('Nm', name)), el('DbtrAcct', acct),
            el('Cdtr', el('Nm', name)), el('CdtrAcct', acct)),
          el('RltdAgts', el('DbtrAgt', el('FinInstnId', el('Nm', t.scheme)))),
          t.location ? el('RmtInf', el('Ustrd', t.location.slice(0, 140))) : null,
        )),
      )
    }
    const body = el('BkToCstmrDbtCdtNtfctn',
      el('GrpHdr', el('MsgId', notificationMsgId()), el('CreDtTm', now)),
      blocks.map((b, i) => {
        const cr = b.txs.filter((t) => net(t) === 0n || t.direction === 'CRDT')
        const dr = b.txs.filter((t) => !cr.includes(t))
        return el('Ntfctn',
          el('Id', `${m.userCode}${i}${compact(start)}${compact(end)}${b.currency}`.slice(0, 35)),
          el('CreDtTm', now),
          el('FrToDt', el('FrDtTm', `${start}T00:00:00.000`), el('ToDtTm', `${end}T00:00:00.000`)),
          el('Acct', el('Id', el('IBAN', b.account)), el('Ccy', b.currency)),
          el('TxsSummry',
            el('TtlCdtNtries', el('NbOfNtries', String(cr.length)), el('Sum', sum(cr))),
            el('TtlDbtNtries', el('NbOfNtries', String(dr.length)), el('Sum', sum(dr)))),
          b.txs.map(entry),
        )
      }),
    )
    return toXml(document('camt.054.001.02', body))
  }
}
