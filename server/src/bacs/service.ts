// Bacs on the UK host (G bacs-direct-debit.md and its pages, account-reports/incoming-bacs-
// credit-notification.md; decisions 740–749). LHV is the paying bank: mandates the payer's
// customer gave a Service User arrive from the scheme (DIRECT_DEBIT_MANDATE_INITIATION) and
// are accepted or rejected with pain.012, collections arrive as notifications on day 2 and
// are debited on day 3 unless rejected with pain.002 (a rejected one is still debited and
// paid back on day 5, G use case 5), a customer cancels an active mandate with pain.011, the
// scheme cancels one (AUDDIS, DIRECT_DEBIT_MANDATE_SCHEME_CANCEL) and reverses a collection
// (pain.007, credit the next working day). Incoming Bacs credits are announced on day 2
// (BACS_INCOMING) and booked on day 3 (camt.054). The scheme side is the /_sim control plane.
// Mandates, collections and credits are kept in the emulator's keyed store (decision 977),
// so a restart mid-cycle carries on; the clock's steps run once under a claim (978).
import type { Bounds } from '../bounded.js'
import { DAY_MS, type Clock } from '../clock.js'
import { keyOf, type Customer, type CustomerKey, type DirectoryStore } from '../directory.js'
import { memoryKeyed, type KeyedFactory, type KeyedStore } from '../keyed.js'
import { normalizeIban } from '../iban.js'
import { notificationMsgId, servicerRef } from '../ids.js'
import type { InboxStore } from '../inbox.js'
import { InsufficientFunds, type Ledger } from '../ledger.js'
import { camt054, type Booking } from '../payments/camt054.js'
import type { Bank, IncomingEvent } from '../payments/engine.js'
import type { Rails } from '../rails.js'
import { addDays } from '../statements/camt060.js'
import { dateLondon } from '../time.js'
import type { VirtualAccounts } from '../viban/registry.js'
import { gbBban } from '../accounts/service.js'
import { CUTOFF, cycle, londonInstant, nextBacsDay } from './calendar.js'
import {
  BACS_TYPES, bacsIncoming, collectionConfirm, mandateConfirm, pain007, pain008, pain009, pain012Cancel, readPain002, readPain011, readPain012,
  schemeCancel, type CancelResult, type Confirmation, type Party,
} from './messages.js'

export const BACS_SCHEME = 'BACS'

/** Reason codes a customer may give (G code-reference-tables bacs-direct-debit-*). */
export const MANDATE_REJECT_CODES = new Set(['MD16', 'MD07', 'BE06', 'AC01', 'MD01', 'AM02', 'AC04', 'AG01', 'MD09', 'MD20', 'MD12', 'MD02'])
export const MANDATE_CANCEL_CODES = new Set(['MD16', 'MD07', 'BE06', 'AC04'])
export const COLLECTION_REJECT_CODES = new Set(['AG07', 'CUST', 'MD07', 'AC15', 'MD06', 'BE06', 'MD01', 'AM09', 'MD05', 'CH04', 'BE05', 'AC04'])
/** Reversal reasons (G bacs-direct-debit-reversal-reason.md), the texts shortened to AddtlInf. */
export const REVERSAL_REASONS: Record<string, string> = {
  A: 'Invalid originating sorting code and/or account number (bank originated)',
  B: 'Invalid originating sorting code and/or account number (customer originated)',
  C: 'Invalid destination sorting code, originating sorting code, and/or account number (bank originated)',
  D: 'Invalid destination sorting code, originating sorting code, and/or account number (customer originated)',
  E: 'Invalid destination sorting code', F: 'Invalid type of account, originating sorting code, and/or account number (bank originated)',
  G: 'Invalid type of account, originating sorting code, and/or account number (customer originated)',
  H: 'Invalid sorting code, account type, or originating sorting code/account number (bank originated)',
  I: 'Invalid sorting code, account type, or originating sorting code/account number (customer originated)',
  J: 'Invalid destination sorting code and type of account', K: 'Invalid type of account',
  L: 'Multiple invalid fields including destination account number and account name', M: 'Invalid destination account number and account name',
  N: 'Amendments made to contra record', O: 'Amendments made to contra record', P: 'Valid originating account, unsupported currency (customer)',
  Q: 'Automated reversal item by Bacs', R: 'Same day reversal item by Bacs', S: 'Automated recall item',
  T: 'Invalid originating account, unsupported currency (customer)', U: 'Invalid unpaid Direct Debit reference (bank originated)',
  X: "Invalid originator's service user number (bank originated)", Z: 'Invalid unpaid Direct Debit reference and other fields (bank originated)',
}
/** A collection can be reversed up to 6 days after it was debited (G "Cut-offs"; calendar days, decision 747). */
export const REVERSAL_DAYS = 6

/** What is remembered (decision 749): mandates by count only, collections and credits two months. */
export const BACS_BOUNDS = {
  mandates: { max: 10_000 },
  collections: { ttlMs: 60 * DAY_MS, max: 10_000 },
  credits: { ttlMs: 60 * DAY_MS, max: 10_000 },
} satisfies Record<string, Bounds>

export type MandateStatus = 'PENDING' | 'ACCEPTED' | 'RETURNED' | 'ACTIVE' | 'CANCELLED'

export interface Mandate {
  /** MndtId of the pain.009, the OriginalMandateId of a scheme cancellation. */
  id: string
  /** MsgId of the pain.009 (what pain.012 OrgnlMsgInf/MsgId names). */
  msgId: string
  /** The Service User's reference (MndtReqId). */
  reference: string
  serviceUserNumber: string
  creditor: Party
  debtor: Party & { iban: string }
  customer: Customer
  status: MandateStatus
  processingDate: string
  entryDate: string
  createdAt: Date
  acceptedAt?: Date
  activatedAt?: Date
  /** Reject or cancellation reason. */
  reason?: string
  closedAt?: Date
  closedBy?: 'DEBTOR' | 'SCHEME'
  collections: number
}

export type CollectionStatus = 'RECEIVED' | 'ACCEPTED' | 'REJECTED'
export type DebitStatus = 'PENDING' | 'BOOKED' | 'UNPAID' | 'CANCELLED'

export interface BacsCollection {
  /** PmtInfId of the pain.008 and the AcctSvcrRef of the debit (G: "payment account servicer reference"). */
  id: string
  msgId: string
  endToEndId: string
  mandate: Mandate
  amount: bigint
  reference?: string
  seqTp: 'FRST' | 'RCUR'
  createdAt: Date
  processingDate: string
  entryDate: string
  /** The customer's answer: none yet, accepted, rejected (then paid back on day 5). */
  status: CollectionStatus
  reason?: string
  debit: DebitStatus
  /** Debit attempts made on the entry day (06:00, 11:30, 15:00, 18:30). */
  attempts: number
  debitedAt?: Date
  /** A credit owed back: the return of a rejected collection or a reversal. */
  refund?: { kind: 'RETURN' | 'REVERSAL'; code: string; text: string; due: number; ref: string; bookedAt?: Date }
  reversal?: { msgId: string; pmtInfId: string; code: string; at: Date }
}

export interface IncomingCredit {
  ref: string
  /** The account credited (a GB account or VIBAN) and its master account. */
  iban: string
  master: string
  customer: Customer
  amount: bigint
  beneficiary: Party
  debtor: Party
  reference: string
  numericReference?: string
  serviceUserNumber?: string
  schemeTransactionId: string
  uniqueSchemeId: string
  processingDate: string
  entryDate: string
  status: 'PENDING' | 'BOOKED' | 'RETURNED'
  bookedAt?: Date
}

export interface BacsDeps {
  directory: DirectoryStore
  ledger: Ledger
  rails: Rails
  inbox: InboxStore
  clock: Clock
  bank: Bank
  virtual: VirtualAccounts
  onBooking?: (customer: Customer, b: Booking) => void | Promise<void>
  /** Pending / rejected incoming payments for GET /accounts/{acc}/payments (decision 711). */
  onIncoming?: (e: IncomingEvent) => void
  /** Books an incoming credit (the payment engine's, so VIBANs work as for any credit). */
  credit: (p: { iban: string; amount: bigint; currency: string; scheme: string; debtor: { name?: string; iban?: string; account?: string }; reference?: string; ref: string }) => Promise<{ returned?: unknown }>
  /** Where mandates, collections and credits are kept (decision 977); default in memory. */
  keyed?: KeyedFactory
}

/** How long a claim on a collection or a credit holds when its holder never lets go (a crash), by the clock. */
export const CLAIM_MS = 5 * 60 * 1000

/** A refusal of the control plane (status, text). */
export class BacsError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const digits = (s: string, n: number) => new RegExp(`^[0-9]{${n}}$`).test(s)
const randomDigits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('')

export class BacsService {
  readonly #mandates: KeyedStore<StoredMandate>
  readonly #collections: KeyedStore<StoredCollection>
  readonly #credits: KeyedStore<StoredCredit>
  /** Who is debiting, paying back or booking an item right now (decision 978). */
  readonly #claims: KeyedStore<true>
  /** The service's operations in this process, one after the other (decision 978). */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(private d: BacsDeps, bounds: Partial<typeof BACS_BOUNDS> = {}) {
    const b = { ...BACS_BOUNDS, ...bounds }
    const keyed = d.keyed ?? memoryKeyed(d.clock)
    this.#mandates = keyed('bacs-mandates', b.mandates)
    this.#collections = keyed('bacs-collections', b.collections)
    this.#credits = keyed('bacs-credits', b.credits)
    this.#claims = keyed('bacs-claims', { ttlMs: CLAIM_MS, max: 100_000 })
  }

  /** The live mandates, collections and credits, oldest first; one whose customer is gone from the directory is left out. */
  async mandates(): Promise<Mandate[]> { return this.#all(this.#mandates, (o, k) => this.#decodeMandate(o, k)) }
  async collections(): Promise<BacsCollection[]> { return this.#all(this.#collections, (o, k) => this.#decodeCollection(o, k)) }
  async credits(): Promise<IncomingCredit[]> { return this.#all(this.#credits, (o, k) => this.#decodeCredit(o, k)) }
  async mandate(id: string) { const o = await this.#mandates.get(id); return o && this.#decodeMandate(o) }
  async collection(id: string) { const o = await this.#collections.get(id.toUpperCase()); return o && this.#decodeCollection(o) }

  #serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(f, f)
    this.#queue = run.catch(() => undefined)
    return run
  }

  /** A GB account of ours (or a VIBAN on one) as a Bacs party: sort code and account number. */
  async #own(raw: string): Promise<{ iban: string; master: string; customer: Customer; party: Party }> {
    const iban = normalizeIban(raw)
    const v = (await this.d.virtual.resolve(iban))
    const master = v?.master ?? iban
    const customer = await this.d.directory.ownerOf(master)
    if (!customer) throw new BacsError(404, `no account ${iban}`)
    const b = gbBban(iban)
    if (!b) throw new BacsError(400, `${iban} is not a UK account (GB IBAN with sort code and account number); Bacs is in GBP between UK accounts`)
    return { iban, master, customer, party: { name: v?.holder?.name ?? customer.name, sortCode: b.slice(0, 6), accountNumber: b.slice(6) } }
  }

  // --- The scheme (control plane) --------------------------------------------------------

  /** An incoming Bacs credit: BACS_INCOMING now (day 2), booked on the entry day (decision 742). */
  incoming(x: { iban: string; amount: bigint; debtor: Party; reference?: string; numericReference?: string; serviceUserNumber?: string }): Promise<IncomingCredit> { return this.#serial(() => this.#incoming(x)) }

  async #incoming(x: { iban: string; amount: bigint; debtor: Party; reference?: string; numericReference?: string; serviceUserNumber?: string }): Promise<IncomingCredit> {
    const own = await this.#own(x.iban)
    const { processing, entry } = cycle(this.d.clock.now())
    const c: IncomingCredit = {
      ref: servicerRef(), iban: own.iban, master: own.master, customer: own.customer, amount: x.amount, beneficiary: own.party, debtor: x.debtor,
      reference: x.reference ?? 'BACS CREDIT', numericReference: x.numericReference, serviceUserNumber: x.serviceUserNumber,
      schemeTransactionId: randomDigits(17), uniqueSchemeId: servicerRef().slice(0, 8), processingDate: processing, entryDate: entry, status: 'PENDING',
    }
    await this.#credits.set(c.ref, encodeCredit(c))
    // Pending in /accounts/{acc}/payments until booked; the debtor is named by sort code + account number.
    this.d.onIncoming?.({ ref: c.ref, status: 'Pending', account: c.iban, master: c.master, amount: c.amount, currency: 'GBP', debtor: { name: x.debtor.name, iban: `${x.debtor.sortCode}${x.debtor.accountNumber}` } })
    await this.d.inbox.add({
      customer: own.customer, type: BACS_TYPES.incoming, contentType: 'application/json',
      body: bacsIncoming({
        beneficiary: own.party, debtor: x.debtor, amount: x.amount, serviceUserNumber: x.serviceUserNumber, numericReference: x.numericReference,
        schemeTransactionId: c.schemeTransactionId, uniqueSchemeId: c.uniqueSchemeId, processingDate: entry, schemeProcessingDate: processing,
        reference: c.reference, servicerRef: c.ref,
      }),
    })
    return c
  }

  /** A new mandate from a Service User for an account here: pain.009 to the account owner. */
  newMandate(x: { debtorIban: string; creditor: Party; serviceUserNumber: string; reference?: string }): Promise<Mandate> { return this.#serial(() => this.#newMandate(x)) }

  async #newMandate(x: { debtorIban: string; creditor: Party; serviceUserNumber: string; reference?: string }): Promise<Mandate> {
    const own = await this.#own(x.debtorIban)
    if (own.iban !== own.master) throw new BacsError(400, 'Direct Debit mandates are held on the account itself, not on a VIBAN')
    const { processing, entry } = cycle(this.d.clock.now())
    const m: Mandate = {
      id: notificationMsgId(), msgId: notificationMsgId(), reference: x.reference ?? `DDI-${randomDigits(10)}`, serviceUserNumber: x.serviceUserNumber,
      creditor: x.creditor, debtor: { ...own.party, iban: own.iban }, customer: own.customer, status: 'PENDING',
      processingDate: processing, entryDate: entry, createdAt: this.d.clock.now(), collections: 0,
    }
    await this.#mandates.set(m.id, encodeMandate(m))
    await this.d.inbox.add({ customer: own.customer, type: BACS_TYPES.mandateInitiation, body: pain009({ ...m, mandateId: m.id }, this.d.clock.now()) })
    return m
  }

  /** The Service User cancels the mandate through AUDDIS: DIRECT_DEBIT_MANDATE_SCHEME_CANCEL. */
  schemeCancel(id: string, reason = 'Cancelled by Service User/creditor'): Promise<Mandate> { return this.#serial(() => this.#schemeCancel(id, reason)) }

  async #schemeCancel(id: string, reason: string): Promise<Mandate> {
    await this.#tick()
    const m = await this.mandate(id)
    if (!m) throw new BacsError(404, `no mandate ${id}`)
    if (m.status !== 'ACTIVE') throw new BacsError(409, `the mandate is ${m.status}; only an active mandate can be cancelled`)
    await this.#close(m, 'SCHEME', 'MD17')
    await this.d.inbox.add({
      customer: m.customer, type: BACS_TYPES.schemeCancel, contentType: 'application/json',
      body: schemeCancel({ creditor: m.creditor, debtor: m.debtor, mandateId: m.id, reference: m.reference, serviceUserNumber: m.serviceUserNumber, reason, closed: dateLondon(this.d.clock.now()) }),
    })
    return m
  }

  /** A collection under an active mandate: notification now (day 2), debit on the entry day. */
  collect(x: { mandateId: string; amount: bigint; reference?: string }): Promise<BacsCollection> { return this.#serial(() => this.#collect(x)) }

  async #collect(x: { mandateId: string; amount: bigint; reference?: string }): Promise<BacsCollection> {
    await this.#tick()
    const m = await this.mandate(x.mandateId)
    if (!m) throw new BacsError(404, `no mandate ${x.mandateId}`)
    if (m.status !== 'ACTIVE') throw new BacsError(409, `the mandate is ${m.status}; collections need an active mandate`)
    const { processing, entry } = cycle(this.d.clock.now())
    const c: BacsCollection = {
      id: servicerRef(), msgId: notificationMsgId(), endToEndId: notificationMsgId(), mandate: m, amount: x.amount, reference: x.reference,
      seqTp: m.collections === 0 ? 'FRST' : 'RCUR', createdAt: this.d.clock.now(), processingDate: processing, entryDate: entry,
      status: 'RECEIVED', debit: 'PENDING', attempts: 0,
    }
    m.collections++
    await this.#saveMandate(m)
    await this.#collections.set(c.id, encodeCollection(c))
    await this.d.inbox.add({
      customer: m.customer, type: BACS_TYPES.collection,
      body: pain008({ msgId: c.msgId, pmtInfId: c.id, endToEndId: c.endToEndId, amount: c.amount, seqTp: c.seqTp, collectionDate: entry, creditor: m.creditor, debtor: m.debtor, reference: c.reference }, this.d.clock.now()),
    })
    return c
  }

  /**
   * The scheme reverses a collection (pain.007): before the debit the two cancel out
   * (nothing is booked); after it the debtor is credited the next working day at 05:00.
   */
  reverse(id: string, code = 'R'): Promise<BacsCollection> { return this.#serial(() => this.#reverse(id, code)) }

  async #reverse(id: string, code: string): Promise<BacsCollection> {
    await this.#tick()
    const c = await this.collection(id)
    if (!c) throw new BacsError(404, `no collection ${id}`)
    const text = REVERSAL_REASONS[code]
    if (!text) throw new BacsError(400, `unknown reversal reason ${code} (A–Z of the Bacs reversal reasons)`)
    if (c.reversal) throw new BacsError(409, 'the collection is already reversed')
    if (c.debit === 'UNPAID' || c.debit === 'CANCELLED') throw new BacsError(409, `the collection was not debited (${c.debit})`)
    if (c.refund) throw new BacsError(409, 'the collection is already being paid back (rejected by the customer)')
    const today = dateLondon(this.d.clock.now())
    if (c.debit === 'BOOKED' && today > addDays(dateLondon(c.debitedAt!), REVERSAL_DAYS)) {
      throw new BacsError(409, `a reversal is possible up to ${REVERSAL_DAYS} days after the collection`)
    }
    c.reversal = { msgId: notificationMsgId(), pmtInfId: servicerRef(), code, at: this.d.clock.now() }
    if (c.debit === 'PENDING') c.debit = 'CANCELLED'
    else c.refund = { kind: 'REVERSAL', code, text, ref: servicerRef(), due: londonInstant(nextBacsDay(today), CUTOFF.refunds) }
    await this.#saveCollection(c)
    await this.d.inbox.add({
      customer: c.mandate.customer, type: BACS_TYPES.reversal,
      body: pain007({ msgId: c.reversal.msgId, originalMsgId: c.msgId, originalCreatedAt: c.createdAt, reversalPmtInfId: c.reversal.pmtInfId, pmtInfId: c.id, amount: c.amount, code, text }, this.d.clock.now()),
    })
    return c
  }

  // --- The customer's requests ------------------------------------------------------------

  #mine(customer: Customer, m: { customer: Customer }) { return keyOf(m.customer) === keyOf(customer) }

  /** POST /direct-debit/bacs-mandate-accept: pain.012 in, DIRECT_DEBIT_MANDATE_CONFIRM out. */
  mandateResponse(xml: string, customer: Customer, requestId: string): Promise<void> { return this.#serial(() => this.#mandateResponse(xml, customer, requestId)) }

  async #mandateResponse(xml: string, customer: Customer, requestId: string): Promise<void> {
    const r = readPain012(xml)
    await this.#tick()
    const byMsgId = new Map((await this.mandates()).map((m) => [m.msgId, m]))
    const seen = new Set<string>()
    const items: Confirmation[] = []
    const now = this.d.clock.now()
    for (const u of r.items) {
      const id = u.originalMsgId ?? ''
      const fail = (code: string, description: string) => items.push({ id, confirmed: false, error: { code, description } })
      const m = byMsgId.get(id)
      if (seen.has(id)) { fail('DUPLICATE_MESSAGE_ID', 'Duplicate message in file'); continue }
      seen.add(id)
      if (!m) { fail('MANDATE_FILE_NOT_FOUND', 'pain.009 message file not found'); continue }
      if (!this.#mine(customer, m)) { fail('NO_RIGHTS_TO_DEBTOR_ACCOUNT', 'User have no rights to debtor account'); continue }
      if (u.mandateId !== undefined && u.mandateId !== m.id) { fail('MANDATE_NOT_FOUND', 'Mandate not found'); continue }
      // Decision 744: rejected with a reason (RjctRsn) or Accptd false; accepted otherwise ("0" in the G acceptance sample).
      const v = u.accepted?.toLowerCase()
      if (v === undefined || !['true', 'false', '1', '0'].includes(v)) { fail('INVALID_ACCEPTANCE_DATA', 'Invalid acceptance data'); continue }
      const reject = u.reason !== undefined || v === 'false'
      if (reject && (!u.reason || !MANDATE_REJECT_CODES.has(u.reason))) { fail('INVALID_ACCEPTANCE_DATA', 'Invalid acceptance data'); continue }
      if (m.status !== 'PENDING') { fail('MANDATE_INVALID_STATUS', `Mandate is expected to be in status PENDING, but is in status ${m.status}`); continue }
      if (reject) { m.status = 'RETURNED'; m.reason = u.reason; m.closedAt = now; m.closedBy = 'DEBTOR' } else { m.status = 'ACCEPTED'; m.acceptedAt = now }
      await this.#saveMandate(m)
      items.push({ id, confirmed: true })
    }
    await this.d.inbox.add({ customer, type: BACS_TYPES.mandateConfirm, requestId, contentType: 'application/json', body: mandateConfirm(r.msgId, items) })
  }

  /** POST /direct-debit/bacs-mandate-cancel: pain.011 in, LHV's pain.012 (DIRECT_DEBIT_MANDATE_CANCEL) out. */
  mandateCancel(xml: string, customer: Customer, requestId: string): Promise<void> { return this.#serial(() => this.#mandateCancel(xml, customer, requestId)) }

  async #mandateCancel(xml: string, customer: Customer, requestId: string): Promise<void> {
    const r = readPain011(xml)
    await this.#tick()
    const seen = new Set<string>()
    const results: CancelResult[] = []
    for (const u of r.items) results.push(await (async (): Promise<CancelResult> => {
      const no = (code: string, text?: string): CancelResult => ({ mandateId: u.mandateId, accepted: false, code, text })
      if (!u.mandateId) return no('NARR', 'Mandate cancel request contains invalid data')
      if (seen.has(u.mandateId)) return no('AM05')
      seen.add(u.mandateId)
      const m = await this.mandate(u.mandateId)
      if (!m) return no('MD01')
      if (!this.#mine(customer, m)) return no('NARR', 'User has no rights to debtor account')
      if (!u.reason || !MANDATE_CANCEL_CODES.has(u.reason)) return no('NARR', 'Mandate cancel request contains invalid data')
      if (m.status !== 'ACTIVE') return no('NARR', 'Mandate cancel failed.')
      await this.#close(m, 'DEBTOR', u.reason)
      return { mandateId: m.id, accepted: true }
    })())
    await this.d.inbox.add({ customer, type: BACS_TYPES.mandateCancel, requestId, body: pain012Cancel(notificationMsgId(), r.msgId, results, this.d.clock.now()) })
  }

  /** POST /direct-debit/bacs-collection-reject: pain.002 in, DIRECT_DEBIT_COLLECTION_CONFIRMATION out. */
  collectionResponse(xml: string, customer: Customer, requestId: string): Promise<void> { return this.#serial(() => this.#collectionResponse(xml, customer, requestId)) }

  async #collectionResponse(xml: string, customer: Customer, requestId: string): Promise<void> {
    const r = readPain002(xml)
    await this.#tick()
    const now = this.d.clock.now()
    const inFile = (await this.collections()).filter((c) => c.msgId === r.originalMsgId)
    const seen = new Set<string>()
    const items: Confirmation[] = []
    for (const u of r.items) items.push(await (async (): Promise<Confirmation> => {
      const id = u.pmtInfId ?? ''
      const fail = (code: string, description: string): Confirmation => ({ id, confirmed: false, error: { code, description } })
      if (seen.has(id)) return fail('DUPLICATE_PAYMENT_ID', 'Duplicate payment in file')
      seen.add(id)
      if (!inFile.length) return fail('DIRECT_DEBIT_FILE_NOT_FOUND', 'pain.008 message file not found')
      const c = await this.collection(id)
      if (!c) return fail('DIRECT_DEBIT_NOT_FOUND', 'Direct Debit not found')
      if (c.msgId !== r.originalMsgId) return fail('DIRECT_DEBIT_FILE_INVALID', 'Payment doesn’t exist in corresponding pain.008 file')
      if (!this.#mine(customer, c.mandate)) return fail('NO_RIGHTS_TO_DEBTOR_ACCOUNT', 'User have no rights to debtor account')
      const reject = u.status === 'RJCT'
      if ((u.status !== 'ACSP' && !reject) || (reject && (!u.reason || !COLLECTION_REJECT_CODES.has(u.reason)))) {
        return fail('INVALID_REASON_CODE', 'Provided reason code is invalid')
      }
      if (c.status !== 'RECEIVED') return fail('DIRECT_DEBIT_RESPONSE_PROCESSED', 'Direct Debit response already processed')
      // After 18:30 on the entry day, or once reversed, the collection is no longer open to an answer.
      const late = now.getTime() > londonInstant(c.entryDate, CUTOFF.collectionReject)
      if (late || c.reversal) {
        return fail('DIRECT_DEBIT_INVALID_STATUS', `Direct Debit is expected to be in status RECEIVED, but is in status ${c.reversal ? 'REVERSED' : 'ACCEPTED'}`)
      }
      if (reject) {
        c.status = 'REJECTED'
        c.reason = u.reason
        // G use case 5: debited on day 3 all the same, credited on day 5 of the cycle (decision 743).
        c.refund = { kind: 'RETURN', code: u.reason!, text: 'Direct Debit returned by the debtor', ref: servicerRef(), due: londonInstant(nextBacsDay(c.entryDate, 2), CUTOFF.refunds) }
      } else c.status = 'ACCEPTED'
      await this.#saveCollection(c)
      return { id, confirmed: true }
    })())
    await this.d.inbox.add({ customer, type: BACS_TYPES.collectionConfirm, requestId, contentType: 'application/json', body: collectionConfirm(r.msgId, r.originalMsgId, items) })
  }

  async #close(m: Mandate, by: 'DEBTOR' | 'SCHEME', reason: string) {
    m.status = 'CANCELLED'
    m.closedBy = by
    m.reason = reason
    m.closedAt = this.d.clock.now()
    await this.#saveMandate(m)
  }

  // --- The clock ----------------------------------------------------------------------------

  /** Activates mandates, books credits, debits and refunds that are due. Returns how many things happened. */
  tick(): Promise<number> { return this.#serial(() => this.#tick()) }

  async #tick(): Promise<number> {
    const now = this.d.clock.now().getTime()
    let n = 0
    for (const m of await this.mandates()) {
      if (m.status !== 'PENDING' && m.status !== 'ACCEPTED') continue
      const early = londonInstant(m.entryDate, CUTOFF.mandateEarly)
      const late = londonInstant(m.entryDate, CUTOFF.mandate)
      // Accepted before 11:35: active at 11:35; otherwise at 18:35 (no answer counts as accepted, decision 744).
      const at = m.status === 'ACCEPTED' && m.acceptedAt!.getTime() <= early ? early : late
      // The same activation from two emulators writes the same state.
      if (now >= at) { m.status = 'ACTIVE'; m.activatedAt = new Date(at); await this.#saveMandate(m); n++ }
    }
    const creditDue = (c: IncomingCredit) => c.status === 'PENDING' && now >= londonInstant(c.entryDate, CUTOFF.credits)
    for (const x of (await this.credits()).filter(creditDue)) {
      n += await this.#claimed(`credit|${x.ref}`, () => this.#credits.get(x.ref), (o) => this.#decodeCredit(o), async (c) => {
        if (!creditDue(c)) return 0
        await this.#book(c)
        return 1
      })
    }
    for (const x of await this.collections()) {
      if (x.debit !== 'PENDING' && !(x.refund && !x.refund.bookedAt && x.debit === 'BOOKED')) continue
      n += await this.#claimed(`collection|${x.id}`, () => this.#collections.get(x.id), (o) => this.#decodeCollection(o), (c) => this.#due(c, now))
    }
    return n
  }

  /**
   * Runs f on the stored item while holding its claim (keyed `add`, one holder across
   * emulators on a namespace); 0 when another holds it or the item is gone.
   */
  async #claimed<S, T>(claim: string, read: () => Promise<S | undefined>, decode: (o: S) => Promise<T | undefined>, f: (x: T) => Promise<number>): Promise<number> {
    if (!(await this.#claims.add(claim, true))) return 0
    try {
      const o = await read()
      const x = o && (await decode(o))
      return x ? await f(x) : 0
    } finally {
      await this.#claims.take(claim)
    }
  }

  /** An incoming credit on its entry day: booked through the payment engine (or returned). */
  async #book(c: IncomingCredit) {
    {
      const r = await this.d.credit({
        iban: c.iban, amount: c.amount, currency: 'GBP', scheme: BACS_SCHEME, ref: c.ref, reference: c.reference,
        debtor: { name: c.debtor.name, account: `${c.debtor.sortCode}${c.debtor.accountNumber}` },
      })
      c.status = r.returned ? 'RETURNED' : 'BOOKED'
      if (!r.returned) c.bookedAt = this.d.clock.now()
      await this.#saveCredit(c)
      if (!r.returned) this.d.onIncoming?.({ ref: c.ref, status: 'Booked', account: c.iban, master: c.master, amount: c.amount, currency: 'GBP', debtor: {} })
    }
  }

  /** A collection's due debit attempts and refund; how many things happened. */
  async #due(c: BacsCollection, now: number): Promise<number> {
    let n = 0
    if (c.debit === 'PENDING') {
      while (c.debit === 'PENDING' && c.attempts < CUTOFF.debits.length && now >= londonInstant(c.entryDate, CUTOFF.debits[c.attempts])) {
        c.attempts++
        n++
        if (await this.#debit(c)) break
        if (c.attempts === CUTOFF.debits.length) c.debit = 'UNPAID'
        await this.#saveCollection(c)
      }
    }
    if (c.refund && !c.refund.bookedAt && c.debit === 'BOOKED' && now >= c.refund.due) { await this.#refund(c); n++ }
    return n
  }

  /** One debit attempt; no partial payments (G "Receiving Collections"). */
  async #debit(c: BacsCollection): Promise<boolean> {
    const m = c.mandate
    try {
      await this.d.ledger.transfer({ ref: c.id, from: m.debtor.iban, to: this.d.rails.settlementAccount(BACS_SCHEME), amount: c.amount, currency: 'GBP' })
    } catch (e) {
      if (e instanceof InsufficientFunds) return false
      throw e
    }
    c.debit = 'BOOKED'
    c.debitedAt = this.d.clock.now()
    await this.#saveCollection(c)
    await this.#notify(m.customer, this.#booking(c, 'DBIT', c.id))
    return true
  }

  async #refund(c: BacsCollection) {
    const f = c.refund!
    await this.d.ledger.transfer({ ref: f.ref, from: this.d.rails.settlementAccount(BACS_SCHEME), to: c.mandate.debtor.iban, amount: c.amount, currency: 'GBP' })
    f.bookedAt = this.d.clock.now()
    await this.#saveCollection(c)
    // A return (UPDD) or a reversal (PRDD) of the direct debit, with the reason as RtrInf.
    const b = this.#booking(c, 'CRDT', f.ref)
    await this.#notify(c.mandate.customer, { ...b, bankTxCode: { family: 'RDDT', subFamily: f.kind === 'RETURN' ? 'UPDD' : 'PRDD' }, returnInfo: { code: f.code, additional: [f.text] } })
  }

  #booking(c: BacsCollection, direction: 'DBIT' | 'CRDT', ref: string): Booking {
    const m = c.mandate
    return {
      account: m.debtor.iban, owner: { name: m.customer.name, code: m.customer.code }, direction, amount: c.amount, currency: 'GBP',
      servicerRef: ref, scheme: BACS_SCHEME, bookedAt: this.d.clock.now(),
      bankTxCode: { family: 'RDDT', subFamily: 'PMDD' },
      pmtInfId: c.id, endToEndId: c.endToEndId, mandateId: m.id,
      counterparty: { name: m.creditor.name, account: `${m.creditor.sortCode}${m.creditor.accountNumber}` },
      reference: c.reference ?? m.reference,
    }
  }

  async #notify(customer: Customer, b: Booking) {
    await this.d.onBooking?.(customer, b)
    await this.d.inbox.add({ customer, type: 'CREDIT_DEBIT_NOTIFICATION', body: camt054(b, customer.camt054, this.d.bank) })
  }

  // --- The store (decision 977) ---------------------------------------------------------------

  // A change is written in place (replace: the item keeps its place and its time to live).
  async #saveMandate(m: Mandate) { await this.#replace(this.#mandates, m.id, encodeMandate(m)) }
  async #saveCollection(c: BacsCollection) { await this.#replace(this.#collections, c.id, encodeCollection(c)) }
  async #saveCredit(c: IncomingCredit) { await this.#replace(this.#credits, c.ref, encodeCredit(c)) }
  async #replace<S>(store: KeyedStore<S>, key: string, value: S) {
    if (!(await store.replace(key, value))) throw new BacsError(409, `${key} is no longer kept`)
  }

  async #all<S, T>(store: KeyedStore<S>, decode: (o: S, customers: Customers) => Promise<T | undefined>): Promise<T[]> {
    const customers: Customers = new Map()
    const out: T[] = []
    for (const [, o] of await store.entries()) {
      const x = await decode(o, customers)
      if (x) out.push(x)
    }
    return out
  }

  #customer(k: CustomerKey, customers: Customers) {
    let p = customers.get(keyOf(k))
    if (!p) customers.set(keyOf(k), (p = this.d.directory.get(k)))
    return p
  }

  async #decodeMandate(o: StoredMandate, customers: Customers = new Map()): Promise<Mandate | undefined> {
    const customer = await this.#customer(o.customer, customers)
    if (!customer) return undefined
    const { createdAt, acceptedAt, activatedAt, closedAt, ...rest } = o
    return { ...rest, customer, createdAt: new Date(createdAt), ...dates({ acceptedAt, activatedAt, closedAt }) }
  }

  async #decodeCollection(o: StoredCollection, customers: Customers = new Map()): Promise<BacsCollection | undefined> {
    const mandate = await this.#decodeMandate(o.mandate, customers)
    if (!mandate) return undefined
    const { refund, reversal, createdAt, debitedAt, ...rest } = o
    return {
      ...rest, mandate, amount: BigInt(o.amount), createdAt: new Date(createdAt), ...dates({ debitedAt }),
      ...(refund ? { refund: (({ bookedAt, ...f }) => ({ ...f, ...dates({ bookedAt }) }))(refund) } : {}),
      ...(reversal ? { reversal: { ...reversal, at: new Date(reversal.at) } } : {}),
    }
  }

  async #decodeCredit(o: StoredCredit, customers: Customers = new Map()): Promise<IncomingCredit | undefined> {
    const customer = await this.#customer(o.customer, customers)
    if (!customer) return undefined
    const { bookedAt, ...rest } = o
    return { ...rest, customer, amount: BigInt(o.amount), ...dates({ bookedAt }) }
  }
}

// What the keyed store keeps (decision 977): JSON, amounts as decimal strings, times in ms,
// customers by key. A collection keeps a copy of its mandate (only the mandate's fixed fields
// are read through it, as through the object it held before), so it is still debited when
// the mandate is no longer remembered.

type Customers = Map<string, Promise<Customer | undefined>>

interface StoredMandate extends Omit<Mandate, 'customer' | 'createdAt' | 'acceptedAt' | 'activatedAt' | 'closedAt'> {
  customer: CustomerKey; createdAt: number; acceptedAt?: number; activatedAt?: number; closedAt?: number
}
interface StoredCollection extends Omit<BacsCollection, 'mandate' | 'amount' | 'createdAt' | 'debitedAt' | 'refund' | 'reversal'> {
  mandate: StoredMandate; amount: string; createdAt: number; debitedAt?: number
  refund?: Omit<NonNullable<BacsCollection['refund']>, 'bookedAt'> & { bookedAt?: number }
  reversal?: Omit<NonNullable<BacsCollection['reversal']>, 'at'> & { at: number }
}
interface StoredCredit extends Omit<IncomingCredit, 'customer' | 'amount' | 'bookedAt'> { customer: CustomerKey; amount: string; bookedAt?: number }

const ms = (d?: Date) => d?.getTime()
/** Undefined fields dropped, so memory hands back what Postgres would. */
const json = <T>(o: unknown): T => JSON.parse(JSON.stringify(o))
const customerKey = (c: Customer): CustomerKey => ({ code: c.code, country: c.country })
/** The named ms fields as Dates; an absent one stays absent. */
const dates = <K extends string>(o: Partial<Record<K, number>>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [k, new Date(v as number)])) as Partial<Record<K, Date>>

const encodeMandate = (m: Mandate): StoredMandate => json({
  ...m, customer: customerKey(m.customer), createdAt: ms(m.createdAt), acceptedAt: ms(m.acceptedAt), activatedAt: ms(m.activatedAt), closedAt: ms(m.closedAt),
})
const encodeCollection = (c: BacsCollection): StoredCollection => json({
  ...c, mandate: encodeMandate(c.mandate), amount: String(c.amount), createdAt: ms(c.createdAt), debitedAt: ms(c.debitedAt),
  refund: c.refund && { ...c.refund, bookedAt: ms(c.refund.bookedAt) }, reversal: c.reversal && { ...c.reversal, at: ms(c.reversal.at) },
})
const encodeCredit = (c: IncomingCredit): StoredCredit => json({ ...c, customer: customerKey(c.customer), amount: String(c.amount), bookedAt: ms(c.bookedAt) })

export const isSortCode = (s: string) => digits(s, 6)
export const isAccountNumber = (s: string) => digits(s, 8)
export const isServiceUserNumber = (s: string) => digits(s, 6)
