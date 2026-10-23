// SEPA Direct Debit (P 09), both sides of a collection:
//
//   creditor  POST /direct-debit/collection (pain.008.001.08)
//             file-level checks fail → one pain.002, group RJCT with the documented text
//             per collection: invalid → RJCT, valid → ACCP (first pain.002, group status)
//             settlement date 11:30 CET → pain.002 ACSC + camt.054 CRDT, or RJCT with the
//             SEPA reason (AM04 from our debtor, the rails' code from another bank)
//   debtor    every collection against an account here → DIRECT_DEBIT_INCOMING_COLLECTION_NOTIFICATION
//             (pain.008, one collection); settlement → camt.054 DBIT
//             POST /direct-debit/incoming-collection (pain.007.001.09) → pain.002 ACCP / RJCT
//             (DIRECT_DEBIT_INCOMING); before the cut-off the collection is cancelled
//             (DIRECT_DEBIT_INCOMING_CANCEL_NOTIFICATION, creditor RJCT), after settlement
//             it is refunded for 8 weeks (camt.054 with RtrInf to both sides)
//
// Collections wait for their settlement date; tick() settles the due ones (main.ts calls
// it every minute, tests and /_sim/direct-debit/settle call it directly).
import type { Clock } from '../clock.js'
import { DAY_MS } from '../clock.js'
import { keyOf, type Customer, type Directory } from '../directory.js'
import { ibanChecksumOk, normalizeIban } from '../iban.js'
import { notificationMsgId, servicerRef } from '../ids.js'
import type { Inbox } from '../inbox.js'
import { InsufficientFunds, toMinor, type Ledger } from '../ledger.js'
import type { Bank } from '../payments/engine.js'
import { camt054, type Booking } from '../payments/camt054.js'
import { decimalEq, decimalSum } from '../payments/pain001.js'
import type { XsdValidator } from '../payments/xsd.js'
import type { Rails } from '../rails.js'
import { addDays } from '../statements/camt060.js'
import { dateTallinn } from '../time.js'
import type { VirtualAccounts } from '../viban/registry.js'
import { parseXml } from '../xml.js'
import {
  aggregate, ddStatusReport, incomingCollection, type Collection, type DdReport, type DdStatus,
} from './messages.js'
import {
  creditorIdOk, isoMessage, PAIN007, PAIN008, readPain007, readPain008, structuralProblem, type CollectionFile, type DdBlock, type DdTx,
} from './pain008.js'
import { EARLIEST_DAYS, REFUND_DAYS, refusalCutoff, settlementAt, settlementDate, submissionCutoff } from './target2.js'

export const DD_TYPES = {
  /** pain.002 about the creditor's collections (P 02 type list; docs/decisions.md 300). */
  outgoing: 'DIRECT_DEBIT_OUTGOING',
  /** pain.002 answering the debtor's refusal. */
  incoming: 'DIRECT_DEBIT_INCOMING',
  notification: 'DIRECT_DEBIT_INCOMING_COLLECTION_NOTIFICATION',
  cancel: 'DIRECT_DEBIT_INCOMING_CANCEL_NOTIFICATION',
} as const

/** SvcLvl/Prtry of SEPA Direct Debit CORE (P 16 code set) and the rails' settlement account key. */
export const DD_SCHEME = 'SEPADD'
export const MAX_COLLECTIONS = 1500

// Group and transaction texts of P 09 "Error Codes"; [PLACEHOLDER] is replaced by the value.
export const E = {
  duplicateMessage: 'Duplicate message.',
  duplicateBlock: (id: string) => `Duplicate Payment Information block ${id}.`,
  duplicateTx: (id: string) => `Duplicate Direct Debit Transaction block ${id}.`,
  schema: (why?: string) => `Uploading file failed. XML Schema validation error.${why ? ` ${why}` : ''}`,
  headerCount: 'Uploading file failed. Faulty number of direct debit transactions in file header.',
  headerSum: 'Uploading file failed. Faulty control sum in file header.',
  blockCount: (id: string) => `Uploading file failed. Faulty number of direct debit transactions in payment information block ${id}.`,
  blockSum: (id: string) => `Uploading file failed. Faulty control sum in payment information block ${id}.`,
  schemeName: (v: string) => `Uploading file failed. Creditor Scheme Identification ${v} not allowed.`,
  routing: (v: string) => `Uploading file failed. Routing code not allowed: ${v}`,
  creditorAccount: (iban: string) => `Uploading file failed. Faulty creditor account ${iban}.`,
  debtorName: 'Uploading file failed. The debtor name field must be filled.',
  creditorName: 'Uploading file failed. The creditor name field must be filled.',
  noRights: (iban: string) => `No rights to creditor’s account ${iban}.`,
  creditorId: (id: string) => `Invalid Creditor Identifier ${id}.`,
  date: 'Invalid Requested Collection Date. Date is not within allowed range.',
  ibanFormat: 'Invalid Creditor / Debtor IBAN format.',
  mandate: 'Invalid Mandate Identification. The Mandate Identification field must be filled.',
  // Refusals: the docs give no texts (docs/decisions.md 307).
  oneOnly: 'Only one collection can be refused per request.',
  notFound: 'Collection not found.',
  noReason: 'Refusal reason code is missing.',
  alreadyRefused: 'Collection has already been refused or refunded.',
  alreadyRejected: 'Collection has already been rejected.',
  refundPeriod: 'More than 8 weeks since settlement: request the refund by e-mail to the service provider.',
}

/** SEPA reason codes of the P 09 transaction table, with their descriptions. */
export const REASONS: Record<string, string> = {
  AC01: 'Incorrect Account Number', AC04: 'Closed Account Number', AC06: 'Blocked Account', AG01: 'Transaction Forbidden',
  AG02: 'Invalid PSP Operation Code/ transaction code/ sequence type incorrect, invalid file format.', AM02: 'Not Allowed Amount',
  AM04: 'Insufficient Funds', AM05: 'Duplication', BE05: 'Unrecognized Initiating Party', DT01: 'Invalid Date', ED05: 'Settlement Failed',
  FF01: 'Operation/transaction code incorrect, invalid file format', MD01: 'Unauthorized Transaction', MD02: 'Missing Mandatory Information Mandate',
  MD07: 'End Customer Deceased', MS02: 'Not Specified Reason Customer Generated', MS03: 'Not Specified Reason Agent Generated',
  RC01: 'PSP Identifier Incorrect', RR01: 'Missing Debtor Account or Identification', RR02: 'Missing Debtor Name or Address',
  RR03: 'Missing Creditor Name or Address', RR04: 'Regulatory Reason', SL01: 'Specific Service offered by Debtor PSP',
}

export interface DirectDebitDeps {
  directory: Directory
  ledger: Ledger
  rails: Rails
  inbox: Inbox
  clock: Clock
  bank: Bank
  xsd?: XsdValidator
  virtual?: VirtualAccounts
  strictIban?: boolean
  onBooking?: (customer: Customer, b: Booking) => void
}

/** A collection from a creditor at another bank (the /_sim trigger). */
export interface ExternalCollection {
  debtorIban: string
  amount: bigint
  currency?: string
  dueDate?: string
  creditor: { name?: string; iban?: string; bic?: string; schemeId?: string }
  debtorName?: string
  mandateId?: string
  signedOn?: string
  seqTp?: string
  pmtInfId?: string
  endToEndId?: string
  instrId?: string
  remittance?: string
  reference?: string
}

export class DirectDebitError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export class DirectDebitService {
  readonly collections: Collection[] = []
  #seenMsgIds = new Set<string>()
  #seenRefusals = new Set<string>()
  constructor(private d: DirectDebitDeps) {}

  // --- creditor: POST /direct-debit/collection ------------------------------------

  /** Handles one pain.008 body. Throws XmlSyntaxError when the body is not XML at all. */
  async collect(xml: string, customer: Customer, requestId: string): Promise<void> {
    await this.tick()
    const doc = parseXml(xml)
    const msgIdGuess = String(doc?.Document?.CstmrDrctDbtInitn?.GrpHdr?.MsgId ?? 'NOTPROVIDED')
    const reject = (reason: string) => this.#report(customer, DD_TYPES.outgoing, requestId,
      { originalMsgId: msgIdGuess, originalMsgName: PAIN008, groupStatus: 'RJCT', groupReason: reason, blocks: [] })

    const version = isoMessage(xml)
    if (version !== PAIN008 || !doc?.Document?.CstmrDrctDbtInitn) return reject(E.schema(`${version ?? 'The document'} is not ${PAIN008}.`))
    if (this.d.xsd?.has(PAIN008)) {
      const errors = await this.d.xsd.validate(xml, PAIN008)
      if (errors.length) return reject(E.schema(errors[0]))
    }
    const file = readPain008(doc)
    const missing = structuralProblem(file)
    if (missing) return reject(E.schema(missing))
    const groupReason = this.#fileProblem(file, customer)
    if (groupReason) return reject(groupReason)
    this.#seenMsgIds.add(`${keyOf(customer)}|${file.msgId}`)

    const report: DdReport = { originalMsgId: file.msgId!, originalMsgName: PAIN008, blocks: [] }
    const accepted: Collection[] = []
    for (const b of file.blocks) {
      const txs = b.txs.map((t) => this.#collection(file, b, t, customer, requestId))
      for (const s of txs) if (s.status === 'ACCP') accepted.push(s.collection!)
      report.blocks.push({ pmtInfId: b.pmtInfId!, status: aggregate(txs.map((s) => s.status)), txs })
    }
    report.groupStatus = aggregate(report.blocks.flatMap((b) => b.txs.map((t) => t.status)))
    this.#report(customer, DD_TYPES.outgoing, requestId, report)
    for (const c of accepted) {
      this.collections.push(c)
      if (c.debtorCustomer) this.#notifyDebtor(c)
    }
  }

  #fileProblem(f: CollectionFile, customer: Customer): string | undefined {
    if (this.#seenMsgIds.has(`${keyOf(customer)}|${f.msgId}`)) return E.duplicateMessage
    const ids = f.blocks.map((b) => b.pmtInfId!)
    const dupBlock = ids.find((id, i) => ids.indexOf(id) !== i)
    if (dupBlock) return E.duplicateBlock(dupBlock)
    const e2e = f.blocks.flatMap((b) => b.txs.map((t) => t.endToEndId!))
    const dupTx = e2e.find((id, i) => e2e.indexOf(id) !== i)
    if (dupTx) return E.duplicateTx(dupTx)
    const all = f.blocks.flatMap((b) => b.txs)
    if (all.length > MAX_COLLECTIONS) return E.schema(`At most ${MAX_COLLECTIONS} collections per message.`)
    if (Number(f.nbOfTxs) !== all.length) return E.headerCount
    if (!decimalEq(f.ctrlSum!, decimalSum(all.map((t) => t.amount!)))) return E.headerSum
    for (const b of f.blocks) {
      if (b.nbOfTxs !== undefined && Number(b.nbOfTxs) !== b.txs.length) return E.blockCount(b.pmtInfId!)
      if (b.ctrlSum !== undefined && !decimalEq(b.ctrlSum, decimalSum(b.txs.map((t) => t.amount!)))) return E.blockSum(b.pmtInfId!)
    }
    for (const b of f.blocks) {
      for (const t of b.txs) {
        const scheme = t.scheme ?? b.scheme
        if (scheme !== DD_SCHEME) return E.routing(scheme ?? '')
        const name = t.creditorSchemeName ?? b.creditorSchemeName
        if (name !== undefined && name !== 'SEPA') return E.schemeName(name)
        const ci = t.creditorSchemeId ?? b.creditorSchemeId
        if (!ci || !creditorIdOk(ci)) return E.creditorId(ci ?? '')
        if (!t.debtorName?.trim()) return E.debtorName
      }
      if (!b.creditorName?.trim()) return E.creditorName
      const iban = normalizeIban(b.creditorIban!)
      const owner = this.d.directory.ownerOf(iban)
      if (!owner) return E.creditorAccount(iban)
      if (keyOf(owner) !== keyOf(customer)) return E.noRights(iban)
    }
    return undefined
  }

  /** One collection of an accepted file: ACCP with the record, or RJCT with the reason. */
  #collection(f: CollectionFile, b: DdBlock, t: DdTx, customer: Customer, requestId: string): DdStatus {
    const debtorIban = normalizeIban(t.debtorIban!)
    const debtorCustomer = this.d.directory.ownerOf(debtorIban)
    const c: Collection = {
      id: servicerRef(), msgId: f.msgId!, pmtInfId: b.pmtInfId!, endToEndId: t.endToEndId!, instrId: t.instrId,
      amount: toMinor(t.amount!), currency: t.currency!, dueDate: b.dueDate!, settlementDate: settlementDate(b.dueDate!),
      scheme: DD_SCHEME, localInstrument: t.localInstrument ?? b.localInstrument ?? 'CORE', seqTp: t.seqTp ?? b.seqTp,
      mandateId: t.mandateId, signedOn: t.signedOn, creditorSchemeId: t.creditorSchemeId ?? b.creditorSchemeId,
      creditor: { name: b.creditorName, iban: normalizeIban(b.creditorIban!), bic: this.d.bank.bic, country: b.creditorCountry, address: b.creditorAddress },
      debtor: { name: t.debtorName, iban: debtorIban, bic: debtorCustomer ? this.d.bank.bic : t.debtorBic },
      ustrd: t.ustrd, reference: t.reference, status: 'PENDING',
      creditorCustomer: customer, debtorCustomer, requestId,
    }
    const base = { pmtInfId: c.pmtInfId, endToEndId: c.endToEndId, instrId: c.instrId, collection: c }
    const rj = (text: string, code?: string): DdStatus => ({ ...base, status: 'RJCT', code: code ?? 'NARR', text })
    if (c.amount <= 0n) return rj(REASONS.AM02, 'AM02')
    if (!c.mandateId?.trim()) return rj(E.mandate)
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(debtorIban) || (this.d.strictIban !== false && !ibanChecksumOk(debtorIban))) return rj(E.ibanFormat)
    if (debtorIban === c.creditor.iban || this.d.virtual?.resolve(debtorIban)) return rj(REASONS.AG01, 'AG01')
    const now = this.d.clock.now()
    if (now.getTime() > submissionCutoff(c.settlementDate) || dateTallinn(now) < addDays(c.dueDate, -EARLIEST_DAYS)) return rj(E.date)
    return { ...base, status: 'ACCP' }
  }

  // --- settlement -----------------------------------------------------------------

  /** Settles every collection whose settlement time has come. Returns how many were processed. */
  async tick(): Promise<number> {
    const now = this.d.clock.now().getTime()
    const due = this.collections.filter((c) => c.status === 'PENDING' && settlementAt(c.settlementDate) <= now)
    // Creditor reports of one tick: one pain.002 per original file.
    const reports = new Map<string, { customer: Customer; requestId?: string; report: DdReport }>()
    for (const c of due) {
      const s = await this.#settle(c)
      if (!c.creditorCustomer) continue
      const k = `${keyOf(c.creditorCustomer)}|${c.msgId}|${c.requestId}`
      let r = reports.get(k)
      if (!r) reports.set(k, (r = { customer: c.creditorCustomer, requestId: c.requestId, report: { originalMsgId: c.msgId, originalMsgName: PAIN008, blocks: [] } }))
      let b = r.report.blocks.find((x) => x.pmtInfId === c.pmtInfId)
      if (!b) r.report.blocks.push((b = { pmtInfId: c.pmtInfId, txs: [] }))
      b.txs.push(s)
    }
    for (const r of reports.values()) this.#report(r.customer, DD_TYPES.outgoing, r.requestId, r.report)
    for (const c of due) if (c.status === 'SETTLED' && c.returnOnSettle) await this.#refund(c, c.returnOnSettle)
    return due.length
  }

  async #settle(c: Collection): Promise<DdStatus> {
    const base = { pmtInfId: c.pmtInfId, endToEndId: c.endToEndId, instrId: c.instrId, collection: c }
    const settlement = this.d.rails.settlementAccount(DD_SCHEME)
    const fail = (code: string): DdStatus => {
      c.status = 'REJECTED'
      c.reason = code
      return { ...base, status: 'RJCT', code, text: REASONS[code] }
    }
    if (c.debtorCustomer) {
      try {
        await this.d.ledger.transfer({ ref: c.id, from: c.debtor.iban, to: c.creditorCustomer ? c.creditor.iban : settlement, amount: c.amount, currency: c.currency })
      } catch (e) {
        if (e instanceof InsufficientFunds) return fail('AM04')
        throw e
      }
    } else {
      const outcome = await this.d.rails.collect({
        ref: c.id, amount: c.amount, currency: c.currency, creditor: { name: c.creditor.name, iban: c.creditor.iban },
        debtor: c.debtor, endToEndId: c.endToEndId, mandateId: c.mandateId, settlementDate: c.settlementDate,
      })
      if (outcome.status === 'rejected') return fail(outcome.code)
      await this.d.ledger.transfer({ ref: c.id, from: settlement, to: c.creditor.iban, amount: c.amount, currency: c.currency })
    }
    c.status = 'SETTLED'
    c.settledAt = this.d.clock.now()
    if (c.debtorCustomer) this.#notify(c.debtorCustomer, this.#booking(c, 'DBIT', c.id))
    if (c.creditorCustomer) this.#notify(c.creditorCustomer, this.#booking(c, 'CRDT', servicerRef()))
    return { ...base, status: 'ACSC' }
  }

  /** Pays a settled collection back: debtor credited, creditor debited, RtrInf on both entries. */
  async #refund(c: Collection, code: string): Promise<'ok' | 'funds'> {
    const settlement = this.d.rails.settlementAccount(DD_SCHEME)
    const from = c.creditorCustomer ? c.creditor.iban : settlement
    const to = c.debtorCustomer ? c.debtor.iban : settlement
    const ref = servicerRef()
    try {
      await this.d.ledger.transfer({ ref, from, to, amount: c.amount, currency: c.currency })
    } catch (e) {
      if (e instanceof InsufficientFunds) return 'funds'
      throw e
    }
    c.status = 'REFUNDED'
    c.reason = code
    // P 09: "TxId…" then "CD:<code>" under Rsn/Cd NARR. pain.008 has no TxId; InstrId or EndToEndId stands in.
    const returnInfo = { code: 'NARR', additional: [c.instrId ?? c.endToEndId, `CD:${code}`] }
    const family = { subFamily: 'UPDD' }
    if (c.debtorCustomer) this.#notify(c.debtorCustomer, { ...this.#booking(c, 'CRDT', ref), bankTxCode: { family: 'RDDT', ...family }, returnInfo })
    if (c.creditorCustomer) this.#notify(c.creditorCustomer, { ...this.#booking(c, 'DBIT', servicerRef()), bankTxCode: { family: 'IDDT', ...family }, returnInfo })
    return 'ok'
  }

  // --- debtor: POST /direct-debit/incoming-collection ------------------------------

  /** Handles one pain.007 refusal. Throws XmlSyntaxError when the body is not XML at all. */
  async refuse(xml: string, customer: Customer, requestId: string): Promise<void> {
    await this.tick()
    const doc = parseXml(xml)
    const msgId = String(doc?.Document?.CstmrPmtRvsl?.GrpHdr?.MsgId ?? 'NOTPROVIDED')
    const report = (r: Omit<DdReport, 'originalMsgId' | 'originalMsgName'>) =>
      this.#report(customer, DD_TYPES.incoming, requestId, { originalMsgId: msgId, originalMsgName: PAIN007, ...r })
    const reject = (reason: string) => report({ groupStatus: 'RJCT', groupReason: reason, blocks: [] })

    const version = isoMessage(xml)
    if (version !== PAIN007 || !doc?.Document?.CstmrPmtRvsl) return reject(E.schema(`${version ?? 'The document'} is not ${PAIN007}.`))
    if (this.d.xsd?.has(PAIN007)) {
      const errors = await this.d.xsd.validate(xml, PAIN007)
      if (errors.length) return reject(E.schema(errors[0]))
    }
    const r = readPain007(doc)
    if (!r.msgId || !r.nbOfTxs || r.txs.length === 0 || !r.txs[0].pmtInfId || !r.txs[0].endToEndId) {
      return reject(E.schema('GrpHdr/MsgId, NbOfTxs, OrgnlPmtInfId and TxInf/OrgnlEndToEndId are required.'))
    }
    if (this.#seenRefusals.has(`${keyOf(customer)}|${r.msgId}`)) return reject(E.duplicateMessage)
    if (Number(r.nbOfTxs) !== r.txs.length) return reject(E.headerCount)
    if (r.txs.length !== 1) return reject(E.oneOnly)
    this.#seenRefusals.add(`${keyOf(customer)}|${r.msgId}`)

    const t = r.txs[0]
    const c = this.#find(t.pmtInfId!, t.endToEndId!, (x) => !!x.debtorCustomer && keyOf(x.debtorCustomer) === keyOf(customer))
    const tx = (status: 'ACCP' | 'RJCT', text?: string, code?: string): DdStatus =>
      ({ pmtInfId: t.pmtInfId!, endToEndId: t.endToEndId, instrId: c?.instrId, status, text, code: text ? code ?? 'NARR' : undefined, collection: c })
    const answer = (s: DdStatus) => report({ blocks: [{ pmtInfId: t.pmtInfId!, txs: [s] }] })

    if (!c) return answer(tx('RJCT', E.notFound))
    if (r.ctrlSum !== undefined && !decimalEq(r.ctrlSum, decimalSum([fromMinorString(c.amount)]))) return answer(tx('RJCT', E.headerSum))
    if (!t.reason) return answer(tx('RJCT', E.noReason))
    if (c.status === 'REFUSED' || c.status === 'REFUNDED' || c.returnOnSettle) return answer(tx('RJCT', E.alreadyRefused))
    if (c.status === 'REJECTED') return answer(tx('RJCT', E.alreadyRejected))
    const now = this.d.clock.now().getTime()

    if (c.status === 'PENDING') {
      answer(tx('ACCP'))
      // After 10:30 CET on the settlement date the refusal is processed as a return.
      if (now >= refusalCutoff(c.settlementDate)) { c.returnOnSettle = t.reason; return }
      this.#cancel(c, t.reason, requestId)
      return
    }
    // SETTLED: a refund through Connect for 8 weeks.
    if (now > c.settledAt!.getTime() + REFUND_DAYS * DAY_MS) return answer(tx('RJCT', E.refundPeriod))
    if (c.creditorCustomer && (await this.d.ledger.available(c.creditor.iban, c.currency)) < c.amount) return answer(tx('RJCT', REASONS.AM04, 'AM04'))
    answer(tx('ACCP'))
    await this.#refund(c, t.reason)
  }

  /** Refused before settlement: nothing is booked; the debtor gets the cancel notification, the creditor RJCT. */
  #cancel(c: Collection, code: string, requestId?: string) {
    c.status = 'REFUSED'
    c.reason = code
    const s: DdStatus = { pmtInfId: c.pmtInfId, endToEndId: c.endToEndId, instrId: c.instrId, status: 'RJCT', code, text: REASONS[code], collection: c }
    if (c.debtorCustomer) {
      this.#report(c.debtorCustomer, DD_TYPES.cancel, requestId, {
        originalMsgId: c.notificationMsgId ?? c.msgId, originalMsgName: PAIN008, blocks: [{ pmtInfId: c.pmtInfId, txs: [s] }],
      })
    }
    if (c.creditorCustomer) {
      this.#report(c.creditorCustomer, DD_TYPES.outgoing, c.requestId, { originalMsgId: c.msgId, originalMsgName: PAIN008, blocks: [{ pmtInfId: c.pmtInfId, txs: [s] }] })
    }
  }

  // --- the other bank (/_sim) -------------------------------------------------------

  /** A creditor at another bank collects from an account here. */
  async incoming(x: ExternalCollection): Promise<Collection> {
    await this.tick()
    const debtorIban = normalizeIban(x.debtorIban)
    const owner = this.d.directory.ownerOf(debtorIban)
    if (!owner) throw new DirectDebitError(404, `no account ${debtorIban}`)
    if (this.d.virtual?.resolve(debtorIban)) throw new DirectDebitError(409, 'collections from a virtual IBAN are refused (AG01)')
    const today = dateTallinn(this.d.clock.now())
    const due = x.dueDate ?? settlementDate(addDays(today, 1))
    const c: Collection = {
      id: servicerRef(), msgId: `SIM${servicerRef().slice(0, 16)}`, pmtInfId: x.pmtInfId ?? `PMTINF${servicerRef().slice(0, 12)}`,
      endToEndId: x.endToEndId ?? `E2E${servicerRef().slice(0, 16)}`, instrId: x.instrId,
      amount: x.amount, currency: x.currency ?? 'EUR', dueDate: due, settlementDate: settlementDate(due),
      scheme: DD_SCHEME, localInstrument: 'CORE', seqTp: x.seqTp ?? 'OOFF',
      mandateId: x.mandateId ?? 'SIMMANDATE', signedOn: x.signedOn ?? addDays(today, -30), creditorSchemeId: x.creditor.schemeId ?? 'DE98ZZZ09999999999',
      creditor: { name: x.creditor.name ?? 'Simulated Creditor', iban: normalizeIban(x.creditor.iban ?? 'DE89370400440532013000'), bic: x.creditor.bic ?? 'COBADEFFXXX' },
      debtor: { name: x.debtorName ?? owner.name, iban: debtorIban, bic: this.d.bank.bic },
      ustrd: x.remittance, reference: x.reference, status: 'PENDING', debtorCustomer: owner,
    }
    this.collections.push(c)
    this.#notifyDebtor(c)
    return c
  }

  /**
   * An R-transaction from the debtor's bank about a collection our creditor sent out:
   * before settlement a refusal (creditor pain.002 RJCT), after it a refund (camt.054 DBIT, 13 months).
   */
  async externalReturn(endToEndId: string, code: string, pmtInfId?: string): Promise<Collection> {
    await this.tick()
    const c = this.#find(pmtInfId, endToEndId, (x) => !!x.creditorCustomer && !x.debtorCustomer)
    if (!c) throw new DirectDebitError(404, 'no collection to an external debtor with this EndToEndId')
    if (c.status === 'PENDING') { this.#cancel(c, code); return c }
    if (c.status !== 'SETTLED') throw new DirectDebitError(409, `collection is ${c.status}`)
    if (this.d.clock.now().getTime() > c.settledAt!.getTime() + 395 * DAY_MS) throw new DirectDebitError(409, 'more than 13 months since settlement')
    if ((await this.#refund(c, code)) === 'funds') throw new DirectDebitError(409, 'the creditor account has insufficient funds')
    return c
  }

  // --- helpers ------------------------------------------------------------------------

  #find(pmtInfId: string | undefined, endToEndId: string, mine: (c: Collection) => boolean) {
    const hits = this.collections.filter((c) => mine(c) && c.endToEndId === endToEndId && (pmtInfId === undefined || c.pmtInfId === pmtInfId))
    return hits.find((c) => c.status === 'PENDING' || c.status === 'SETTLED') ?? hits[hits.length - 1]
  }

  #notifyDebtor(c: Collection) {
    c.notificationMsgId = notificationMsgId()
    this.d.inbox.add({ customer: c.debtorCustomer!, type: DD_TYPES.notification, body: incomingCollection(c, c.notificationMsgId, this.d.clock.now()) })
  }

  #booking(c: Collection, direction: 'DBIT' | 'CRDT', ref: string): Booking {
    const own = direction === 'DBIT' ? c.debtorCustomer ?? c.creditorCustomer! : c.creditorCustomer ?? c.debtorCustomer!
    const ownIsDebtor = own === c.debtorCustomer
    const account = ownIsDebtor ? c.debtor.iban : c.creditor.iban
    const other = ownIsDebtor ? c.creditor : c.debtor
    return {
      account, owner: { name: own.name, code: own.code }, direction, amount: c.amount, currency: c.currency,
      servicerRef: ref, scheme: DD_SCHEME, bookedAt: this.d.clock.now(),
      bankTxCode: { family: ownIsDebtor ? 'RDDT' : 'IDDT', subFamily: 'ESDD' },
      pmtInfId: c.pmtInfId, instrId: c.instrId, endToEndId: c.endToEndId, mandateId: c.mandateId,
      counterparty: { name: other.name, iban: other.iban, bic: other.bic },
      remittance: c.ustrd, reference: c.reference,
    }
  }

  #report(customer: Customer, type: string, requestId: string | undefined, r: DdReport) {
    this.d.inbox.add({ customer, type, requestId, body: ddStatusReport(r, this.d.bank.bic, this.d.clock.now()) })
  }

  #notify(customer: Customer, b: Booking) {
    this.d.onBooking?.(customer, b)
    this.d.inbox.add({ customer, type: 'CREDIT_DEBIT_NOTIFICATION', body: camt054(b, customer.camt054, this.d.bank) })
  }
}

const fromMinorString = (n: bigint) => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`
