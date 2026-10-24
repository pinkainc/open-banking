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
// it every minute, tests and /_sim/direct-debit/settle call it directly). They are kept in
// the emulator's keyed store (decision 975), so a restart before the settlement day still
// settles them, once (a claim per collection, decision 976).
import { DEFAULT_BOUNDS, type Bounds } from '../bounded.js'
import { memoryKeyed, UNBOUNDED, type KeyedFactory, type KeyedStore } from '../keyed.js'
import type { Clock } from '../clock.js'
import { DAY_MS } from '../clock.js'
import { keyOf, type Customer, type CustomerKey, type DirectoryStore } from '../directory.js'
import { ibanChecksumOk, normalizeIban } from '../iban.js'
import { notificationMsgId, servicerRef } from '../ids.js'
import type { InboxStore } from '../inbox.js'
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
  /** How many pain.008 / pain.007 MsgIds are remembered (decision 504). */
  msgIds?: Bounds
  directory: DirectoryStore
  ledger: Ledger
  rails: Rails
  inbox: InboxStore
  clock: Clock
  bank: Bank
  xsd?: XsdValidator
  virtual?: VirtualAccounts
  strictIban?: boolean
  onBooking?: (customer: Customer, b: Booking) => void | Promise<void>
  /** Where the pain.008 and pain.007 MsgIds are kept (decision 966); default in memory. */
  keyed?: KeyedFactory
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

/** How long a claim on a collection holds when its holder never lets go (a crash), by the clock. */
export const CLAIM_MS = 5 * 60 * 1000

export class DirectDebitService {
  #seenMsgIds: KeyedStore<true>
  #seenRefusals: KeyedStore<true>
  /** Every collection by its id, in the order they came (decision 975). */
  #collections: KeyedStore<StoredCollection>
  /** Who is settling or refunding a collection right now (decision 976). */
  #claims: KeyedStore<true>
  /** The service's operations in this process, one after the other (decision 976). */
  #queue: Promise<unknown> = Promise.resolve()
  constructor(private d: DirectDebitDeps) {
    const keyed = d.keyed ?? memoryKeyed(d.clock)
    this.#seenMsgIds = keyed('dd-msgids', d.msgIds ?? DEFAULT_BOUNDS.msgIds)
    this.#seenRefusals = keyed('dd-refusal-msgids', d.msgIds ?? DEFAULT_BOUNDS.msgIds)
    this.#collections = keyed('dd-collections', UNBOUNDED)
    this.#claims = keyed('dd-claims', { ttlMs: CLAIM_MS, max: 100_000 })
  }

  /** Every collection, oldest first; one whose customer is gone from the directory is left out. */
  async collections(): Promise<Collection[]> {
    const cache = new Map<string, Promise<Customer | undefined>>()
    const out: Collection[] = []
    for (const [, o] of await this.#collections.entries()) {
      const c = await this.#decode(o, cache)
      if (c) out.push(c)
    }
    return out
  }

  #serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(f, f)
    this.#queue = run.catch(() => undefined)
    return run
  }

  // --- creditor: POST /direct-debit/collection ------------------------------------

  /** Handles one pain.008 body. Throws XmlSyntaxError when the body is not XML at all. */
  collect(xml: string, customer: Customer, requestId: string): Promise<void> {
    return this.#serial(() => this.#collect(xml, customer, requestId))
  }

  async #collect(xml: string, customer: Customer, requestId: string): Promise<void> {
    await this.#tick()
    const doc = parseXml(xml)
    const msgIdGuess = String(doc?.Document?.CstmrDrctDbtInitn?.GrpHdr?.MsgId ?? 'NOTPROVIDED')
    const reject = (reason: string) => this.#report(customer, DD_TYPES.outgoing, requestId,
      { originalMsgId: msgIdGuess, originalMsgName: PAIN008, groupStatus: 'RJCT', groupReason: reason, blocks: [] })

    const version = isoMessage(xml)
    if (version !== PAIN008 || !doc?.Document?.CstmrDrctDbtInitn) return reject(E.schema(`${version ?? 'The document'} is not ${PAIN008}.`))
    if (this.d.xsd?.has(PAIN008)) {
      const errors = await this.d.xsd.validate(xml, PAIN008)
      if (errors.length) return reject(E.schema(schemaError(errors[0])))
    }
    const file = readPain008(doc)
    const missing = structuralProblem(file)
    if (missing) return reject(E.schema(missing))
    const groupReason = await this.#fileProblem(file, customer)
    if (groupReason) return reject(groupReason)
    await this.#seenMsgIds.set(`${keyOf(customer)}|${file.msgId}`, true)

    const report: DdReport = { originalMsgId: file.msgId!, originalMsgName: PAIN008, blocks: [] }
    const accepted: Collection[] = []
    for (const b of file.blocks) {
      const txs: DdStatus[] = []
      for (const t of b.txs) txs.push(await this.#collection(file, b, t, customer, requestId))
      for (const s of txs) if (s.status === 'ACCP') accepted.push(s.collection!)
      report.blocks.push({ pmtInfId: b.pmtInfId!, status: aggregate(txs.map((s) => s.status)), txs })
    }
    report.groupStatus = aggregate(report.blocks.flatMap((b) => b.txs.map((t) => t.status)))
    await this.#report(customer, DD_TYPES.outgoing, requestId, report)
    for (const c of accepted) await this.#add(c)
  }

  async #fileProblem(f: CollectionFile, customer: Customer): Promise<string | undefined> {
    if (await this.#seenMsgIds.has(`${keyOf(customer)}|${f.msgId}`)) return E.duplicateMessage
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
      const owner = await this.d.directory.ownerOf(iban)
      if (!owner) return E.creditorAccount(iban)
      if (keyOf(owner) !== keyOf(customer)) return E.noRights(iban)
      // Sending collections needs a Direct Debit agreement with the bank (decision 527).
      if (!owner.directDebit?.agreement) return E.noRights(iban)
    }
    return undefined
  }

  /** One collection of an accepted file: ACCP with the record, or RJCT with the reason. */
  async #collection(f: CollectionFile, b: DdBlock, t: DdTx, customer: Customer, requestId: string): Promise<DdStatus> {
    const debtorIban = normalizeIban(t.debtorIban!)
    const debtorCustomer = await this.d.directory.ownerOf(debtorIban)
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
  tick(): Promise<number> { return this.#serial(() => this.#tick()) }

  async #tick(): Promise<number> {
    const now = this.d.clock.now().getTime()
    const listed = await this.collections()
    const isDue = (c: Collection) => c.status === 'PENDING' && settlementAt(c.settlementDate) <= now
    // A refusal after the cut-off is returned once settled; one left over by a restart in between too.
    const toReturn = (c: Collection) => c.status === 'SETTLED' && !!c.returnOnSettle
    const due: Collection[] = []
    // Creditor reports of one tick: one pain.002 per original file.
    const reports = new Map<string, { customer: Customer; requestId?: string; report: DdReport }>()
    for (const x of listed.filter(isDue)) {
      let s: DdStatus | undefined
      const c = await this.#claimed(x.id, async (c) => { if (isDue(c)) s = await this.#settle(c) })
      if (!c || !s) continue
      due.push(c)
      if (!c.creditorCustomer) continue
      const k = `${keyOf(c.creditorCustomer)}|${c.msgId}|${c.requestId}`
      let r = reports.get(k)
      if (!r) reports.set(k, (r = { customer: c.creditorCustomer, requestId: c.requestId, report: { originalMsgId: c.msgId, originalMsgName: PAIN008, blocks: [] } }))
      let b = r.report.blocks.find((x) => x.pmtInfId === c.pmtInfId)
      if (!b) r.report.blocks.push((b = { pmtInfId: c.pmtInfId, txs: [] }))
      b.txs.push(s)
    }
    for (const r of reports.values()) await this.#report(r.customer, DD_TYPES.outgoing, r.requestId, r.report)
    const settled = new Set(due.map((c) => c.id))
    for (const x of [...due.filter(toReturn), ...listed.filter((c) => toReturn(c) && !settled.has(c.id))]) {
      await this.#claimed(x.id, async (c) => { if (toReturn(c)) await this.#refund(c, c.returnOnSettle!) })
    }
    return due.length
  }

  /**
   * Runs f on the stored collection while holding its claim (keyed `add`, one holder across
   * emulators on a namespace); undefined when another holds it or the collection is gone.
   */
  async #claimed(id: string, f: (c: Collection) => Promise<void>): Promise<Collection | undefined> {
    if (!(await this.#claims.add(id, true))) return undefined
    try {
      const o = await this.#collections.get(id)
      const c = o && (await this.#decode(o))
      if (c) await f(c)
      return c
    } finally {
      await this.#claims.take(id)
    }
  }

  async #settle(c: Collection): Promise<DdStatus> {
    const base = { pmtInfId: c.pmtInfId, endToEndId: c.endToEndId, instrId: c.instrId, collection: c }
    const settlement = this.d.rails.settlementAccount(DD_SCHEME)
    const fail = async (code: string): Promise<DdStatus> => {
      c.status = 'REJECTED'
      c.reason = code
      await this.#save(c)
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
    await this.#save(c)
    if (c.debtorCustomer) await this.#notify(c.debtorCustomer, this.#booking(c, 'debtor', 'DBIT', c.id))
    if (c.creditorCustomer) await this.#notify(c.creditorCustomer, this.#booking(c, 'creditor', 'CRDT', servicerRef()))
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
    await this.#save(c)
    // P 09: "TxId…" then "CD:<code>" under Rsn/Cd NARR. pain.008 has no TxId; InstrId or EndToEndId stands in.
    const returnInfo = { code: 'NARR', additional: [c.instrId ?? c.endToEndId, `CD:${code}`] }
    const family = { subFamily: 'UPDD' }
    if (c.debtorCustomer) await this.#notify(c.debtorCustomer, { ...this.#booking(c, 'debtor', 'CRDT', ref), bankTxCode: { family: 'RDDT', ...family }, returnInfo })
    if (c.creditorCustomer) await this.#notify(c.creditorCustomer, { ...this.#booking(c, 'creditor', 'DBIT', servicerRef()), bankTxCode: { family: 'IDDT', ...family }, returnInfo })
    return 'ok'
  }

  // --- debtor: POST /direct-debit/incoming-collection ------------------------------

  /** Handles one pain.007 refusal. Throws XmlSyntaxError when the body is not XML at all. */
  refuse(xml: string, customer: Customer, requestId: string): Promise<void> {
    return this.#serial(() => this.#refuse(xml, customer, requestId))
  }

  async #refuse(xml: string, customer: Customer, requestId: string): Promise<void> {
    await this.#tick()
    const doc = parseXml(xml)
    const msgId = String(doc?.Document?.CstmrPmtRvsl?.GrpHdr?.MsgId ?? 'NOTPROVIDED')
    const report = (r: Omit<DdReport, 'originalMsgId' | 'originalMsgName'>) =>
      this.#report(customer, DD_TYPES.incoming, requestId, { originalMsgId: msgId, originalMsgName: PAIN007, ...r })
    const reject = (reason: string) => report({ groupStatus: 'RJCT', groupReason: reason, blocks: [] })

    const version = isoMessage(xml)
    if (version !== PAIN007 || !doc?.Document?.CstmrPmtRvsl) return reject(E.schema(`${version ?? 'The document'} is not ${PAIN007}.`))
    if (this.d.xsd?.has(PAIN007)) {
      const errors = await this.d.xsd.validate(xml, PAIN007)
      if (errors.length) return reject(E.schema(schemaError(errors[0])))
    }
    const r = readPain007(doc)
    if (!r.msgId || !r.nbOfTxs || r.txs.length === 0 || !r.txs[0].pmtInfId || !r.txs[0].endToEndId) {
      return reject(E.schema('GrpHdr/MsgId, NbOfTxs, OrgnlPmtInfId and TxInf/OrgnlEndToEndId are required.'))
    }
    if (await this.#seenRefusals.has(`${keyOf(customer)}|${r.msgId}`)) return reject(E.duplicateMessage)
    if (Number(r.nbOfTxs) !== r.txs.length) return reject(E.headerCount)
    if (r.txs.length !== 1) return reject(E.oneOnly)
    await this.#seenRefusals.set(`${keyOf(customer)}|${r.msgId}`, true)

    const t = r.txs[0]
    const c = await this.#find(t.pmtInfId!, t.endToEndId!, (x) => !!x.debtorCustomer && keyOf(x.debtorCustomer) === keyOf(customer))
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
      await answer(tx('ACCP'))
      // After 10:30 CET on the settlement date the refusal is processed as a return.
      if (now >= refusalCutoff(c.settlementDate)) { c.returnOnSettle = t.reason; await this.#save(c); return }
      await this.#cancel(c, t.reason, requestId)
      return
    }
    // SETTLED: a refund through Connect for 8 weeks.
    if (now > c.settledAt!.getTime() + REFUND_DAYS * DAY_MS) return answer(tx('RJCT', E.refundPeriod))
    if (c.creditorCustomer && (await this.d.ledger.available(c.creditor.iban, c.currency)) < c.amount) return answer(tx('RJCT', REASONS.AM04, 'AM04'))
    await answer(tx('ACCP'))
    await this.#refund(c, t.reason)
  }

  /** Refused before settlement: nothing is booked; the debtor gets the cancel notification, the creditor RJCT. */
  async #cancel(c: Collection, code: string, requestId?: string) {
    c.status = 'REFUSED'
    c.reason = code
    await this.#save(c)
    const s: DdStatus = { pmtInfId: c.pmtInfId, endToEndId: c.endToEndId, instrId: c.instrId, status: 'RJCT', code, text: REASONS[code], collection: c }
    if (c.debtorCustomer) {
      await this.#report(c.debtorCustomer, DD_TYPES.cancel, requestId, {
        originalMsgId: c.notificationMsgId ?? c.msgId, originalMsgName: PAIN008, blocks: [{ pmtInfId: c.pmtInfId, txs: [s] }],
      })
    }
    if (c.creditorCustomer) {
      await this.#report(c.creditorCustomer, DD_TYPES.outgoing, c.requestId, { originalMsgId: c.msgId, originalMsgName: PAIN008, blocks: [{ pmtInfId: c.pmtInfId, txs: [s] }] })
    }
  }

  // --- the other bank (/_sim) -------------------------------------------------------

  /** A creditor at another bank collects from an account here. */
  incoming(x: ExternalCollection): Promise<Collection> { return this.#serial(() => this.#incoming(x)) }

  async #incoming(x: ExternalCollection): Promise<Collection> {
    await this.#tick()
    const debtorIban = normalizeIban(x.debtorIban)
    if (this.d.virtual?.resolve(debtorIban)) throw new DirectDebitError(409, 'collections from a virtual IBAN are refused (AG01)')
    const owner = await this.d.directory.ownerOf(debtorIban)
    if (!owner) throw new DirectDebitError(404, `no account ${debtorIban}`)
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
    await this.#add(c)
    return c
  }

  /**
   * An R-transaction from the debtor's bank about a collection our creditor sent out:
   * before settlement a refusal (creditor pain.002 RJCT), after it a refund (camt.054 DBIT, 13 months).
   */
  externalReturn(endToEndId: string, code: string, pmtInfId?: string): Promise<Collection> {
    return this.#serial(() => this.#externalReturn(endToEndId, code, pmtInfId))
  }

  async #externalReturn(endToEndId: string, code: string, pmtInfId?: string): Promise<Collection> {
    await this.#tick()
    const c = await this.#find(pmtInfId, endToEndId, (x) => !!x.creditorCustomer && !x.debtorCustomer)
    if (!c) throw new DirectDebitError(404, 'no collection to an external debtor with this EndToEndId')
    if (c.status === 'PENDING') { await this.#cancel(c, code); return c }
    if (c.status !== 'SETTLED') throw new DirectDebitError(409, `collection is ${c.status}`)
    if (this.d.clock.now().getTime() > c.settledAt!.getTime() + 395 * DAY_MS) throw new DirectDebitError(409, 'more than 13 months since settlement')
    if ((await this.#refund(c, code)) === 'funds') throw new DirectDebitError(409, 'the creditor account has insufficient funds')
    return c
  }

  // --- helpers ------------------------------------------------------------------------

  async #find(pmtInfId: string | undefined, endToEndId: string, mine: (c: Collection) => boolean) {
    const hits = (await this.collections()).filter((c) => mine(c) && c.endToEndId === endToEndId && (pmtInfId === undefined || c.pmtInfId === pmtInfId))
    return hits.find((c) => c.status === 'PENDING' || c.status === 'SETTLED') ?? hits[hits.length - 1]
  }

  /** A new collection: stored, then the debtor here notified (its MsgId stored with it). */
  async #add(c: Collection) {
    // Enabled per customer by the account manager (P 09, decision 527).
    if (c.debtorCustomer?.directDebit?.debtorNotification) c.notificationMsgId = notificationMsgId()
    await this.#collections.set(c.id, encodeCollection(c))
    if (c.notificationMsgId) {
      await this.d.inbox.add({ customer: c.debtorCustomer!, type: DD_TYPES.notification, body: incomingCollection(c, c.notificationMsgId, this.d.clock.now()) })
    }
  }

  async #save(c: Collection) {
    if (!(await this.#collections.replace(c.id, encodeCollection(c)))) throw new Error(`collection ${c.id} is not stored`)
  }

  /** The stored collection with its customers from the directory; undefined when one is gone. */
  async #decode(o: StoredCollection, cache = new Map<string, Promise<Customer | undefined>>()): Promise<Collection | undefined> {
    const { amount, creditorCustomer: ck, debtorCustomer: dk, settledAt, ...rest } = o
    const customer = (k: CustomerKey) => {
      let p = cache.get(keyOf(k))
      if (!p) cache.set(keyOf(k), (p = this.d.directory.get(k)))
      return p
    }
    const c: Collection = { ...rest, amount: BigInt(amount) }
    if (ck && !(c.creditorCustomer = await customer(ck))) return undefined
    if (dk && !(c.debtorCustomer = await customer(dk))) return undefined
    if (settledAt !== undefined) c.settledAt = new Date(settledAt)
    return c
  }

  /** The entry on one side's account (the side, not the direction: a refund credits the debtor). */
  #booking(c: Collection, side: 'debtor' | 'creditor', direction: 'DBIT' | 'CRDT', ref: string): Booking {
    const ownIsDebtor = side === 'debtor'
    const own = (ownIsDebtor ? c.debtorCustomer : c.creditorCustomer)!
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

  async #report(customer: Customer, type: string, requestId: string | undefined, r: DdReport) {
    await this.d.inbox.add({ customer, type, requestId, body: ddStatusReport(r, this.d.bank.bic, this.d.clock.now()) })
  }

  async #notify(customer: Customer, b: Booking) {
    await this.d.onBooking?.(customer, b)
    await this.d.inbox.add({ customer, type: 'CREDIT_DEBIT_NOTIFICATION', body: camt054(b, customer.camt054, this.d.bank) })
  }
}

/** A collection as the keyed store keeps it (decision 975): JSON, the customers by key. */
type StoredCollection = Omit<Collection, 'amount' | 'creditorCustomer' | 'debtorCustomer' | 'settledAt'> & {
  amount: string
  creditorCustomer?: CustomerKey
  debtorCustomer?: CustomerKey
  settledAt?: number
}

const customerKey = (c: Customer): CustomerKey => ({ code: c.code, country: c.country })

/** JSON-safe (undefined fields dropped), so memory hands back what Postgres would. */
const encodeCollection = (c: Collection): StoredCollection => {
  const { amount, creditorCustomer, debtorCustomer, settledAt, ...rest } = c
  return JSON.parse(JSON.stringify({
    ...rest, amount: String(amount), creditorCustomer: creditorCustomer && customerKey(creditorCustomer),
    debtorCustomer: debtorCustomer && customerKey(debtorCustomer), settledAt: settledAt?.getTime(),
  }))
}

/** An XSD error without the namespace in every element name. */
const schemaError = (e: string) => e.replace(/\{urn:iso:std:iso:20022:tech:xsd:[^}]+\}/g, '')

const fromMinorString = (n: bigint) => `${n / 100n}.${String(n % 100n).padStart(2, '0')}`
