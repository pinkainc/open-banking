// Processing of a payment initiation, from the posted XML to the messages it leaves
// in the inbox:
//
//   file-level checks fail  → one pain.002, group RJCT with the documented reason
//   per payment:
//     invalid / no funds    → RJCT in the first pain.002
//     pending customer      → PDNG until approved or refused in the "internet bank"
//                             (/_sim/payments/pending); approval continues as below
//     internal (both accounts here) → booked at once: ACSC in the first pain.002,
//                             camt.054 DBIT to the debtor, camt.054 CRDT to the creditor
//     external              → funds reserved, ACSP in the first pain.002; then the rails
//                             answer: settled → pain.002 ACSC + camt.054 DBIT,
//                             rejected → pain.002 RJCT and the reservation released
//                             An automatic SEPA Instant that fails at the rails: ACWC
//                             "Payment processed as European payment", then SEPA
//     manual review name    → funds reserved, ACSP, then PDNG "In manual review" until
//                             /_sim decides
//
// With rails that answer at once (the simulator) processing is synchronous: every message
// exists by the time POST /payment returns. Rails that answer `accepted` (a real scheme,
// decision 930) leave the payment ACSP with its funds reserved; the outcome arrives later
// through settle() and is reported then, the same reports and notifications as at once.
import { DEFAULT_BOUNDS, type Bounds } from '../bounded.js'
import { memoryKeyed, UNBOUNDED, type KeyedFactory, type KeyedStore } from '../keyed.js'
import type { Clock } from '../clock.js'
import { codePage, fold } from '../cp1257.js'
import { keyOf, type Customer, type DirectoryStore } from '../directory.js'
import { ibanChecksumOk, ibanCountry, isSepaCountry, normalizeIban } from '../iban.js'
import { servicerRef } from '../ids.js'
import type { InboxStore } from '../inbox.js'
import { InsufficientFunds, toMinor, type Ledger } from '../ledger.js'
import type { CreditResult, IncomingCredit, Rails, RailsOutcome, Scheme } from '../rails.js'
import { parseXml, XmlSyntaxError } from '../xml.js'
import { isUkAccount } from '../routing.js'
import { camt054, type Booking } from './camt054.js'
import { decimalEq, decimalSum, painVersion, readPain001, structuralProblem, type Block, type PainVersion, type PaymentFile, type Tx } from './pain001.js'
import { aggregate, pain002, type StatusReport, type TxStatus } from './pain002.js'
import type { XsdValidator } from './xsd.js'
import type { BankAddress } from '../statements/bank-address.js'
import type { VirtualAccount, VirtualAccounts } from '../viban/registry.js'
import { receivable, type AgencyAccount, type AgencyStore } from '../agency/store.js'
import { MemoryRailsPending, type PendingRecord, type RailsPending } from './pending.js'

export interface Bank {
  bic: string
  name: string
  /** Postal address in statements (Svcr/FinInstnId/PstlAdr); default by BIC country, null for none (decision 553). */
  address?: BankAddress | null
}

export interface EngineOptions {
  /** How many accepted MsgIds are remembered (decision 504). */
  msgIds?: Bounds
  /** Reject creditor IBANs whose check digits are wrong (default true). */
  strictIban?: boolean
  /** pain.001.001.03 is refused from this day on (the bank's announced end of support). */
  pain00103Until?: string
  xsd?: XsdValidator
  /** Called with every booking on a customer account (the statement journal listens here). */
  onBooking?: (customer: Customer, b: Booking) => void | Promise<void>
  /** Virtual IBANs: booked on their master account (L3). */
  virtual?: VirtualAccounts
  /**
   * The customer's Connect payment limits in EUR minor units: daily and monthly totals with
   * what booked debits already used, and the per-payment SEPA Instant limit (decision 524).
   */
  limits?: (c: Customer) => Promise<PaymentLimits>
  /** Incoming payments to a customer that are not (yet) booked: pending, rejected, then booked (UK /accounts, decision 711). */
  onIncoming?: (e: IncomingEvent) => void
  /** Synchronised agency accounts (indirect scheme access, decisions 830–836): paid from and to via their master account. */
  agency?: () => AgencyStore | undefined
  /** Payments waiting at the rails (decision 948); default in memory. */
  pending?: RailsPending
  /** Where duplicate sets, parked payments, in-flight limit amounts and credit results are kept (decision 963); default in memory. */
  keyed?: KeyedFactory
}

/**
 * An incoming payment's state change as the creditor sees it: `account` as addressed (a
 * VIBAN or the account), `master` the account behind it. Booked ones leave the list.
 */
export interface IncomingEvent {
  ref: string; status: 'Pending' | 'Rejected' | 'Booked'
  account: string; master: string; amount: bigint; currency: string
  debtor: { name?: string; iban?: string }
}

/** An outgoing payment whose funds are reserved and not yet booked (manual review): Pending in UK /accounts. */
export interface ReservedPayment {
  ref: string; account: string; debtorIban: string; amount: bigint; currency: string; endToEndId?: string
  creditor: { name?: string; iban?: string; account?: string; bic?: string }
}

export interface PaymentLimits { dailyFree: bigint; monthlyFree: bigint; instant: bigint }

const SCHEMES = new Set(['INST', 'SEPA', 'TARGET2', 'ALL'])

// Reasons, worded as the documented error tables.
export const R = {
  duplicateMessage: 'Duplicate message.',
  duplicateBlock: 'Duplicate message .',
  headerCount: 'Uploading file failed. Faulty number of payments in file header.',
  headerSum: 'Uploading file failed. Faulty control sum in file header.',
  blockCount: 'Uploading file failed. Faulty number of payments in Payment Information block .',
  blockSum: 'Uploading file failed. Faulty control sum in Payment Information block .',
  senderAccount: (iban: string) => `Uploading file failed. Faulty sender account ${iban}.`,
  corrupted: (why: string) => `Corrupted payment file: ${why}`,
  noRights: 'No rights to debtor’s account.',
  funds: 'Insufficient funds available.',
  sameAccount: 'Payment to the same account.',
  currency: 'Invalid currency.',
  creditorName: 'Invalid creditor name.',
  accountNumber: 'Incorrect account number.',
  remittance: 'Description or reference number must be entered.',
  amount: 'Problem with amount. Contact bank',
  declined: 'Payment declined.',
  debtorInactive: 'Debtor’s account not active.',
  debtorAddress: 'Invalid debtor’s address.',
  debtorName: 'Invalid debtor’s name.',
  creditorClosed: 'Creditor account is closed.',
  temporarilyClosed: 'Account temporarily closed.',
  requestedByCustomer: 'Requested by customer.',
  regulatory: 'Payment declined. Regulatory reasons',
  manualReview: 'In manual review',
  europeanPayment: 'Payment processed as European payment',
  declinedTryEuropean: 'Payment declined, try European payment.',
  instantForbidden: 'Instant payment forbidden, try European payment.',
  technical: 'Technical problem. Try again',
  duplicatePayment: 'Duplicate payment.',
  dailyLimit: 'Insufficient daily limit available.',
  monthlyLimit: 'Insufficient monthly limit available.',
}

/** Why a payment to a VIBAN that is not ACTIVE is refused: closed for good, or for now. */
export const inactiveCreditor = (v: VirtualAccount) =>
  v.status === 'CLOSED' || v.status === 'REJECTED' ? { reason: R.creditorClosed, code: 'AC04' } : { reason: R.temporarilyClosed, code: 'AC06' }

/** Beneficiary names that trigger manual review (G response.md "Testing features"). */
export const MANUAL_REVIEW = new Set(['Robba Bank', 'Steela Koinz', 'Laundra Cashwell', 'Frauda Lott', 'Skimmi Cardar'].map((n) => n.toLowerCase()))
const normName = (n?: string) => (n ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

type Notice = { customer: Customer; booking: Booking }
/** One status of one payment; `next` yields its following status (a later report). */
interface Step { status: TxStatus; notices?: Notice[]; next?: () => Promise<Step | undefined> }
interface FileRef { customer: Customer; requestId: string; version: PainVersion; msgId: string }
/** A payment that passed the checks that need no money. */
interface Plan {
  block: Block; tx: Tx; amount: bigint; currency: string; ref: string
  debtorIban: string; debtorAccount: string
  creditorIban?: string; creditorAccount?: string; creditorV?: VirtualAccount; creditorOwner?: Customer
  /** The agency account credited through its master account (decision 833). */
  creditorA?: AgencyAccount
  /** The agency account paying through its agent's master account (decision 830). */
  debtorA?: AgencyAccount
  /** External payments only; `automatic` when no scheme was requested. */
  scheme?: Scheme; automatic?: boolean
  /** Duplicate-payment key, when the payment has an InstrId (decision 525). */
  instrKey?: string
}
type ParkedKind = 'SCA' | 'REVIEW'
/** A parked payment as the keyed store keeps it (JSON: encodePlan, the customer by key). */
interface ParkedRecord { kind: ParkedKind; file: PendingRecord['file']; plan: Record<string, unknown>; status: Record<string, unknown> }
interface Parked { kind: ParkedKind; file: FileRef; plan: Plan; status: TxStatus }

const fileKey = (file: FileRef): PendingRecord['file'] =>
  ({ customer: { code: file.customer.code, country: file.customer.country }, requestId: file.requestId, version: file.version, msgId: file.msgId })
const agencyToJson = (a: AgencyAccount) => ({ ...a, createdAt: a.createdAt.getTime(), updatedAt: a.updatedAt.getTime() })
const agencyFromJson = (a: any): AgencyAccount => ({ ...a, createdAt: new Date(a.createdAt), updatedAt: new Date(a.updatedAt) })
/**
 * A plan as JSON: the amount as a decimal string, the creditor customer by key, agency
 * account times in ms (the VIBAN, block and transaction are JSON already). Undefined
 * fields drop out, as JSON in Postgres would drop them.
 */
const encodePlan = (p: Plan): Record<string, unknown> => {
  const { amount, debtorA, creditorA, creditorOwner, ...plan } = p
  return JSON.parse(JSON.stringify({
    ...plan, amount: amount.toString(),
    ...(creditorOwner ? { creditorOwner: { code: creditorOwner.code, country: creditorOwner.country } } : {}),
    ...(debtorA ? { debtorA: agencyToJson(debtorA) } : {}), ...(creditorA ? { creditorA: agencyToJson(creditorA) } : {}),
  }))
}
export interface ParkedPayment {
  ref: string; kind: ParkedKind; customer: { code: string; country: string }; msgId: string
  pmtInfId?: string; instrId?: string; endToEndId?: string; amount: string; currency: string; creditor: { name?: string; iban?: string }
}

const sameName = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase()


export class PaymentEngine {
  // Kept in the keyed store (decision 963), so a restarted engine on a persistent one goes on.
  #seenMsgIds: KeyedStore<true>
  /** Payments with an InstrId that are not (yet) rejected: customer, InstrId, accounts, currency, amount (decision 525) → ref. */
  #instrIds: KeyedStore<string>
  /** EUR debits accepted but not yet in the journal, counted against the limits (amount as a decimal string). */
  #inflight: KeyedStore<{ customer: string; amount: string }>
  /** Payments waiting for SCA or in manual review, by ref. */
  #parked: KeyedStore<ParkedRecord>
  /** Payments waiting at the rails (decision 948); in memory unless the emulator gives a persistent store. */
  #pending: RailsPending
  /** Credits from the rails by their ref: the result a repeat answers (decision 932). */
  #credits: KeyedStore<CreditResult>
  /** Credits being booked in this process: a concurrent repeat waits for the same result. */
  #crediting = new Map<string, Promise<CreditResult>>()
  constructor(
    private directory: DirectoryStore, private ledger: Ledger, private rails: Rails, private inbox: InboxStore,
    private clock: Clock, private bank: Bank, private opts: EngineOptions = {},
  ) {
    const keyed = opts.keyed ?? memoryKeyed(clock)
    const msgIds = opts.msgIds ?? DEFAULT_BOUNDS.msgIds
    this.#seenMsgIds = keyed('payment-msgids', msgIds)
    this.#instrIds = keyed('payment-instrids', msgIds)
    this.#credits = keyed('payment-credits', msgIds)
    this.#inflight = keyed('payment-inflight', UNBOUNDED)
    this.#parked = keyed('payment-parked', UNBOUNDED)
    this.#pending = opts.pending ?? new MemoryRailsPending()
  }

  /** Handles one POST /payment body. Throws XmlSyntaxError when the body is not XML at all. */
  async submit(xml: string, customer: Customer, requestId: string): Promise<void> {
    const doc = parseXml(xml) // XmlSyntaxError propagates: answered with HTTP 400
    const version = painVersion(xml)
    const msgIdGuess = String(doc?.Document?.CstmrCdtTrfInitn?.GrpHdr?.MsgId ?? 'NOTPROVIDED')
    const reject = (reason: string, v = version ?? 'pain.001.001.09') =>
      this.#report(customer, requestId, { version: v, originalMsgId: msgIdGuess, groupStatus: 'RJCT', groupReason: reason, blocks: [] })

    if (!version) return reject(R.corrupted('not a pain.001.001.03 or pain.001.001.09 document'))
    if (version === 'pain.001.001.03' && this.opts.pain00103Until && this.clock.now().toISOString().slice(0, 10) >= this.opts.pain00103Until) {
      return reject(R.corrupted('pain.001.001.03 is no longer supported, use pain.001.001.09'), version)
    }
    if (this.opts.xsd?.has(version)) {
      const errors = await this.opts.xsd.validate(xml, version)
      if (errors.length) return reject(R.corrupted(errors[0]), version)
    }
    const file = readPain001(doc, version)
    const problem = structuralProblem(file)
    if (problem) return reject(R.corrupted(problem), version)
    const groupReason = await this.#fileProblem(file, customer)
    if (groupReason) return reject(groupReason, version)
    await this.#seenMsgIds.set(`${keyOf(customer)}|${file.msgId}`, true)
    await this.#process(file, customer, requestId)
  }

  async #fileProblem(f: PaymentFile, customer: Customer): Promise<string | undefined> {
    if (await this.#seenMsgIds.has(`${keyOf(customer)}|${f.msgId}`)) return R.duplicateMessage
    const ids = f.blocks.map((b) => b.pmtInfId)
    if (new Set(ids).size !== ids.length) return R.duplicateBlock
    for (const b of f.blocks) {
      const scheme = [b.scheme, ...b.txs.map((t) => t.scheme)].find((s) => s !== undefined && !SCHEMES.has(s))
      if (scheme !== undefined) return R.corrupted(`invalid payment scheme ${scheme}`)
    }
    const all = f.blocks.flatMap((b) => b.txs)
    if (Number(f.nbOfTxs) !== all.length) return R.headerCount
    if (f.ctrlSum !== undefined && !decimalEq(f.ctrlSum, decimalSum(all.map((t) => t.amount!)))) return R.headerSum
    for (const b of f.blocks) {
      if (b.nbOfTxs !== undefined && Number(b.nbOfTxs) !== b.txs.length) return R.blockCount
      if (b.ctrlSum !== undefined && !decimalEq(b.ctrlSum, decimalSum(b.txs.map((t) => t.amount!)))) return R.blockSum
    }
    for (const b of f.blocks) {
      const owner = b.debtorOther ? undefined : await this.directory.ownerOf(this.#account(b.debtorIban!))
      if (owner) {
        if (keyOf(owner) !== keyOf(customer)) return R.noRights
        continue
      }
      // An agency account pays through its agent's master account (decision 830).
      const agency = await this.#agency(b.debtorIban!)
      if (!agency.length) return R.senderAccount(normalizeIban(b.debtorIban!))
      if (!agency.some((a) => keyOf(a.agent) === keyOf(customer))) return R.noRights
    }
    return undefined
  }

  async #process(f: PaymentFile, customer: Customer, requestId: string) {
    const file: FileRef = { customer, requestId, version: f.version, msgId: f.msgId! }
    const pending = customer.payments === 'PENDING'
    const steps: Step[] = []
    for (const block of f.blocks) {
      for (const tx of block.txs) {
        const c = await this.#check(block, tx, customer)
        if ('status' in c) steps.push({ status: c.status })
        else if (pending) steps.push({ status: await this.#park('SCA', file, c.plan) })
        else steps.push(await this.#execute(file, c.plan))
      }
    }
    await this.#flow(file, steps, true)
  }

  /**
   * Reports rounds of steps: one pain.002 per round (group and block statuses only in the
   * first report about a file), then the round's camt.054s, then the steps that follow.
   */
  async #flow(file: FileRef, steps: Step[], first: boolean) {
    let round = steps
    while (round.length) {
      const r: StatusReport = { version: file.version, originalMsgId: file.msgId, blocks: [] }
      for (const s of round) {
        let b = r.blocks.find((x) => x.pmtInfId === s.status.block.pmtInfId)
        if (!b) r.blocks.push((b = { pmtInfId: s.status.block.pmtInfId!, txs: [] }))
        b.txs.push(s.status)
      }
      if (first) {
        for (const b of r.blocks) b.status = aggregate(b.txs.map((t) => t.status))
        r.groupStatus = aggregate(r.blocks.flatMap((b) => b.txs.map((t) => t.status)))
      }
      await this.#report(file.customer, file.requestId, r)
      for (const s of round) for (const n of s.notices ?? []) await this.#notify(n.customer, n.booking)
      const next: Step[] = []
      for (const s of round) {
        const n = s.next && (await s.next())
        if (n) next.push(n)
      }
      round = next
      first = false
    }
  }

  /** The checks that need no money: a rejection, or what to execute. */
  async #check(rawBlock: Block, rawTx: Tx, customer: Customer): Promise<{ status: TxStatus } | { plan: Plan }> {
    // Free text as the core keeps it, for the receiver bank's country (decision 526): what
    // the reports echo, the notifications book and the rails receive.
    const country = await this.#receiverCountry(rawTx)
    const block: Block = { ...rawBlock, debtorName: fold(rawBlock.debtorName, country) }
    const tx: Tx = { ...rawTx, creditorName: fold(rawTx.creditorName, country), ustrd: fold(rawTx.ustrd, country), reference: fold(rawTx.reference, country) }
    const rj = (reason: string, scheme?: string): { status: TxStatus } => ({ status: { block, tx, status: 'RJCT', reason, scheme } })
    let amount: bigint
    try { amount = toMinor(tx.amount!) } catch { return rj(R.amount) }
    if (amount <= 0n) return rj(R.amount)
    if (!tx.ustrd && !tx.reference) return rj(R.remittance)
    if (!tx.creditorName) return rj(R.creditorName)
    const debtorIban = normalizeIban(block.debtorIban!)
    const creditorIban = tx.creditorIban ? normalizeIban(tx.creditorIban) : undefined
    if (creditorIban && creditorIban === debtorIban) return rj(R.sameAccount)
    // The same InstrId alone is no duplicate (PAYMENT_MULTI repeats one in a file); the
    // same payment again is (decision 525).
    const instrKey = tx.instrId
      ? [keyOf(customer), tx.instrId, debtorIban, creditorIban ?? tx.creditorOther ?? '', tx.currency, amount].join('|') : undefined
    if (instrKey && (await this.#instrIds.has(instrKey))) return rj(R.duplicatePayment)
    // A VIBAN debtor must be ACTIVE and named as its holder; the master account pays.
    const debtorV = block.debtorOther ? undefined : this.opts.virtual?.resolve(debtorIban)
    if (debtorV && debtorV.status !== 'ACTIVE') return rj(R.debtorInactive)
    if (debtorV && !sameName(rawBlock.debtorName, debtorV.holder?.name)) return rj(R.debtorName)
    // An agency debtor: named and addressed in the payment (LHV keeps neither), not CLOSED (decisions 830, 831).
    const debtorA = debtorV ? undefined : await this.#agencyDebtor(block, customer)
    if (debtorA) {
      // The status report names the agent's BIC as the debtor agent, as the request (G use case 7, decision 842).
      if (rawBlock.debtorAgentBic) block.debtorAgentShown = rawBlock.debtorAgentBic
      if (!rawBlock.debtorName?.trim()) return rj(R.debtorName)
      if (!block.debtorAddress?.country) return rj(R.debtorAddress)
      if (debtorA.status === 'CLOSED') return rj(R.debtorInactive)
    }
    const debtorAccount = debtorV?.master ?? debtorA?.master ?? debtorIban
    // A VIBAN creditor is credited on its master account, unless it is not ACTIVE.
    const creditorV = creditorIban ? this.opts.virtual?.resolve(creditorIban) : undefined
    if (creditorV && creditorV.status !== 'ACTIVE') {
      this.opts.onIncoming?.({ ref: servicerRef(), status: 'Rejected', account: creditorIban!, master: creditorV.master, amount, currency: tx.currency!,
        debtor: { name: block.debtorName ?? customer.name, iban: debtorIban } })
      return rj(inactiveCreditor(creditorV).reason, 'INTERNAL')
    }
    // An agency account here is credited on its master account unless CLOSED (decision 833).
    const creditorId = creditorIban ?? (tx.creditorOther ? normalizeIban(tx.creditorOther) : undefined)
    const creditorA = !creditorV && creditorId && !(creditorIban && await this.directory.ownerOf(creditorIban)) ? (await this.#agency(creditorId))[0] : undefined
    if (creditorA && !receivable(creditorA, { instant: false })) {
      this.opts.onIncoming?.({ ref: servicerRef(), status: 'Rejected', account: creditorId!, master: creditorA.master, amount, currency: tx.currency!,
        debtor: { name: block.debtorName ?? customer.name, iban: debtorIban } })
      return rj(R.creditorClosed, 'INTERNAL')
    }
    if (creditorA && creditorA.master === debtorAccount && debtorA) return rj(R.sameAccount)
    const creditorAccount = creditorV?.master ?? creditorA?.master ?? creditorIban
    const creditorOwner = creditorAccount ? await this.directory.ownerOf(creditorAccount) : undefined
    const base = { block, tx, amount, currency: tx.currency!, debtorIban, debtorAccount, creditorIban, creditorAccount, creditorV, creditorA, debtorA, ref: servicerRef(), instrKey }
    const planned = async (plan: Plan) => {
      if (instrKey) await this.#instrIds.set(instrKey, plan.ref)
      return { plan }
    }
    if (creditorOwner) return planned({ ...base, creditorOwner })

    if (creditorIban && this.opts.strictIban !== false && !ibanChecksumOk(creditorIban)) return rj(R.accountNumber)
    const requested = tx.scheme ?? block.scheme
    const instantLimit = (await this.opts.limits?.(customer))?.instant
    // An INST_RESTRICTED agency debtor sends no SEPA Instant (decision 834).
    const instantOk = (instantLimit === undefined || amount <= instantLimit) && debtorA?.status !== 'INST_RESTRICTED'
    const chosen = await this.#scheme(requested, tx.currency!, creditorIban, instantOk, creditorId)
    if ('reject' in chosen) return rj(chosen.reject)
    return planned({ ...base, scheme: chosen.scheme, automatic: requested !== 'INST' && requested !== 'SEPA' && requested !== 'TARGET2' })
  }

  /** A checked payment goes ahead: funds, then booking (internal) or the rails (external). */
  async #execute(file: FileRef, p: Plan): Promise<Step> {
    const { block, tx } = p
    const rj = async (reason: string, scheme?: string): Promise<Step> => {
      await this.#forget(p)
      return { status: { block, tx, status: 'RJCT', reason, scheme } }
    }
    const scheme = p.scheme ?? 'INTERNAL'
    // Funds first, then the Connect limits (EUR payments only, decision 524).
    if ((await this.ledger.available(p.debtorAccount, p.currency)) < p.amount) return rj(R.funds, scheme)
    if (p.currency === 'EUR' && this.opts.limits) {
      const l = await this.opts.limits(file.customer)
      const inflight = await this.#inflightOf(file.customer)
      if (p.amount > l.dailyFree - inflight) return rj(R.dailyLimit, scheme)
      if (p.amount > l.monthlyFree - inflight) return rj(R.monthlyLimit, scheme)
    }
    const review = MANUAL_REVIEW.has(normName(tx.creditorName))
    if (p.creditorOwner && !review) {
      try {
        await this.ledger.transfer({ ref: p.ref, from: p.debtorAccount, to: p.creditorAccount!, amount: p.amount, currency: p.currency })
      } catch (e) {
        if (e instanceof InsufficientFunds) return rj(R.funds, scheme)
        throw e
      }
      await this.#hold(file.customer, p)
      return this.#internalBooked(file, p)
    }
    try {
      await this.ledger.reserve({ ref: p.ref, account: p.debtorAccount, amount: p.amount, currency: p.currency })
    } catch (e) {
      if (e instanceof InsufficientFunds) return rj(R.funds, scheme)
      throw e
    }
    await this.#hold(file.customer, p)
    const accepted: TxStatus = { block, tx, status: 'ACSP', servicerRef: p.ref, scheme, ...(p.creditorOwner ? { creditorBic: this.bank.bic } : {}) }
    // Manual review (sanctions screening): accepted first, then PDNG until /_sim decides.
    if (review) {
      return { status: accepted, next: async () => {
        this.#incomingOf(file, p, 'Pending')
        return { status: await this.#park('REVIEW', file, p, { ...accepted, status: 'PDNG', reason: R.manualReview }) }
      } }
    }
    return { status: accepted, next: () => this.#rails(file, p, accepted) }
  }

  /** Booked internally: ACSC, camt.054 DBIT to the debtor and CRDT to the creditor. */
  #internalBooked(file: FileRef, p: Plan): Step {
    const { block, tx, creditorOwner, creditorV } = p
    const customer = file.customer
    const notices: Notice[] = [{ customer, booking: this.#debitBooking(customer, p, 'INTERNAL', this.bank.bic) }]
    notices.push({ customer: creditorOwner!, booking: {
      account: p.creditorAccount!, virtual: creditorV ? virtualParty(creditorV) : p.creditorA && agencyParty(p.creditorA, p.creditorIban ?? tx.creditorOther!, tx.creditorName),
      owner: { name: creditorOwner!.name, code: creditorOwner!.code }, direction: 'CRDT',
      amount: p.amount, currency: p.currency, servicerRef: servicerRef(), scheme: 'INTERNAL', bookedAt: this.clock.now(),
      instrId: tx.instrId, endToEndId: tx.endToEndId, ultimateDebtor: tx.ultimateDebtor ?? block.ultimateDebtor, ultimateCreditor: tx.ultimateCreditor,
      counterparty: { name: block.debtorName ?? customer.name, ...(block.debtorOther ? { account: p.debtorIban } : { iban: p.debtorIban }), bic: this.bank.bic, code: customer.code },
      remittance: tx.ustrd, reference: tx.reference,
    } })
    return { status: { block, tx, status: 'ACSC', servicerRef: p.ref, scheme: 'INTERNAL', creditorBic: this.bank.bic }, notices }
  }

  /**
   * Sends a reserved external payment to the rails. An immediate outcome is the step that
   * follows; `accepted` leaves it waiting for settle() (nothing more is reported now).
   */
  async #rails(file: FileRef, p: Plan, accepted: TxStatus): Promise<Step | undefined> {
    const { block, tx } = p
    // Registered before sending: a bridge may call back before its answer arrives.
    await this.#pending.put(this.#encode(file, p, accepted))
    const answer = await this.rails.send({
      ref: p.ref, scheme: p.scheme!, amount: p.amount, currency: p.currency,
      debtor: { name: block.debtorName ?? file.customer.name, iban: p.debtorIban },
      creditor: { name: tx.creditorName, iban: p.creditorIban, account: tx.creditorOther, bic: tx.creditorBic },
      endToEndId: tx.endToEndId, remittance: tx.ustrd,
    })
    if (answer.status === 'accepted') return undefined
    // Settled through the events while the answer was on its way: already reported (and a
    // SEPA fallback of it waits under the same ref with another scheme).
    if (!(await this.#pending.take(p.ref, p.scheme))) return undefined
    return this.#outcome(file, p, accepted, answer)
  }

  /**
   * The final outcome of a payment the rails answered `accepted` (RailsEvents.outcome):
   * booked and reported as an immediate outcome would have been. False for a ref that is
   * not waiting at the rails (unknown, or already final): a repeat changes nothing.
   */
  async settle(ref: string, outcome: RailsOutcome): Promise<boolean> {
    const r = await this.#pending.take(ref)
    const w = r && await this.#decode(r)
    if (!w) return false
    await this.#flow(w.file, [await this.#outcome(w.file, w.plan, w.accepted, outcome)], false)
    return true
  }

  /** Payments sent to the rails without a final outcome yet (refs). */
  atRails(): Promise<string[]> { return this.#pending.refs() }

  /** A waiting payment as JSON (encodePlan). */
  #encode(file: FileRef, p: Plan, accepted: TxStatus): PendingRecord {
    return { ref: p.ref, scheme: p.scheme!, file: fileKey(file), plan: encodePlan(p), accepted: { ...accepted } }
  }

  /** Undefined when the customer is gone from the directory (nothing to report to). */
  async #decode(r: PendingRecord): Promise<{ file: FileRef; plan: Plan; accepted: TxStatus } | undefined> {
    const customer = await this.directory.get(r.file.customer)
    const plan = await this.#decodePlan(r.plan)
    if (!customer || !plan) return undefined
    return { file: { ...r.file, customer, version: r.file.version as PainVersion }, plan, accepted: r.accepted as unknown as TxStatus }
  }

  /** The plan encodePlan made, with the creditor customer from the directory; undefined when it is gone. */
  async #decodePlan(o: Record<string, unknown>): Promise<Plan | undefined> {
    const { amount, debtorA, creditorA, creditorOwner, ...plan } = o as any
    const owner = creditorOwner ? await this.directory.get(creditorOwner) : undefined
    if (creditorOwner && !owner) return undefined
    return { ...plan, amount: BigInt(amount), creditorOwner: owner, debtorA: debtorA && agencyFromJson(debtorA), creditorA: creditorA && agencyFromJson(creditorA) }
  }

  /** The rails' outcome of a reserved external payment: booked, rejected, or on to SEPA. */
  async #outcome(file: FileRef, p: Plan, accepted: TxStatus, outcome: RailsOutcome): Promise<Step> {
    const { block, tx } = p
    const scheme = p.scheme!
    if (outcome.status === 'settled') {
      await this.ledger.commit(p.ref, this.rails.settlementAccount(scheme))
      return {
        status: { ...accepted, status: 'ACSC', reason: undefined, scheme },
        notices: [{ customer: file.customer, booking: this.#debitBooking(file.customer, p, scheme) }],
      }
    }
    // SEPA Instant attempted and failed: an automatic choice goes on as SEPA (ACWC first).
    if (outcome.status === 'unavailable' && scheme === 'INST' && p.automatic) {
      const sepa: Plan = { ...p, scheme: 'SEPA' }
      const changed: TxStatus = { ...accepted, status: 'ACWC', reason: R.europeanPayment, scheme: 'SEPA' }
      return { status: changed, next: () => this.#rails(file, sepa, { ...changed, status: 'ACSP', reason: undefined }) }
    }
    await this.#release(p)
    const reason = outcome.status === 'rejected' ? outcome.reason : scheme === 'INST' ? R.declinedTryEuropean : R.technical
    return { status: { ...accepted, status: 'RJCT', reason, scheme } }
  }

  /** A rejected payment no longer blocks its InstrId. */
  async #forget(p: Plan) {
    if (p.instrKey && (await this.#instrIds.get(p.instrKey)) === p.ref) await this.#instrIds.take(p.instrKey)
  }

  /** Counts an accepted EUR debit against the limits until its camt.054 is booked in the journal. */
  async #hold(customer: Customer, p: Plan) {
    if (p.currency === 'EUR') await this.#inflight.set(p.ref, { customer: keyOf(customer), amount: p.amount.toString() })
  }

  async #release(p: Plan) {
    await this.ledger.release(p.ref)
    await this.#inflight.take(p.ref)
    await this.#forget(p)
  }

  async #inflightOf(customer: Customer) {
    let sum = 0n
    for (const [, h] of await this.#inflight.entries()) if (h.customer === keyOf(customer)) sum += BigInt(h.amount)
    return sum
  }

  /** Parks a payment until /_sim decides: waiting for SCA in the internet bank, or in manual review. */
  async #park(kind: ParkedKind, file: FileRef, plan: Plan, status: TxStatus = { block: plan.block, tx: plan.tx, status: 'PDNG', servicerRef: plan.ref, scheme: plan.scheme ?? 'INTERNAL' }): Promise<TxStatus> {
    await this.#parked.set(plan.ref, { kind, file: fileKey(file), plan: encodePlan(plan), status: { ...status } as unknown as Record<string, unknown> })
    return status
  }

  /** A parked payment as the engine works with it; undefined when its customers are gone from the directory. */
  async #unpark(r: ParkedRecord): Promise<Parked | undefined> {
    const customer = await this.directory.get(r.file.customer)
    const plan = await this.#decodePlan(r.plan)
    if (!customer || !plan) return undefined
    return { kind: r.kind, file: { ...r.file, customer, version: r.file.version as PainVersion }, plan, status: r.status as unknown as TxStatus }
  }

  /** An internal payment as its creditor sees it (decision 711); nothing for an external creditor. */
  #incomingOf(file: FileRef, p: Plan, status: IncomingEvent['status']) {
    if (!p.creditorOwner) return
    this.opts.onIncoming?.({ ref: p.ref, status, account: p.creditorIban ?? normalizeIban(p.tx.creditorOther ?? ''), master: p.creditorAccount!, amount: p.amount, currency: p.currency,
      debtor: { name: p.block.debtorName ?? file.customer.name, iban: p.debtorIban } })
  }

  /** A payment in manual review: funds reserved, not booked (GET /accounts/{acc}/transactions/{ref}, decision 710). */
  async reserved(ref: string): Promise<ReservedPayment | undefined> {
    const r = await this.#parked.get(ref)
    const p = r && r.kind === 'REVIEW' ? await this.#unpark(r) : undefined
    if (!p) return undefined
    const { plan } = p
    return {
      ref, account: plan.debtorAccount, debtorIban: plan.debtorIban, amount: plan.amount, currency: plan.currency, endToEndId: plan.tx.endToEndId,
      creditor: { name: plan.tx.creditorName, iban: plan.creditorIban, account: plan.tx.creditorOther, bic: plan.creditorOwner ? this.bank.bic : plan.tx.creditorBic },
    }
  }

  /** Payments waiting for a decision (the internet bank's pending list, manual review). */
  async parked(): Promise<ParkedPayment[]> {
    const all: (readonly [string, Parked | undefined])[] = []
    for (const [ref, r] of await this.#parked.entries()) all.push([ref, await this.#unpark(r)] as const)
    return all.filter((x): x is [string, Parked] => x[1] !== undefined).map(([ref, p]) => ({
      ref, kind: p.kind, customer: { code: p.file.customer.code, country: p.file.customer.country }, msgId: p.file.msgId,
      pmtInfId: p.plan.block.pmtInfId, instrId: p.plan.tx.instrId, endToEndId: p.plan.tx.endToEndId,
      amount: p.plan.tx.amount!, currency: p.plan.currency, creditor: { name: p.plan.tx.creditorName, iban: p.plan.creditorIban },
    }))
  }

  /**
   * Decides parked payments. SCA: approval executes the payment as if it had just been
   * sent (funds, booking or rails); refusal is RJCT "Requested by customer.". Manual
   * review: approval continues to settlement (ACSC or the rails' RJCT); refusal releases
   * the funds, RJCT "Payment declined. Regulatory reasons" unless a reason is given.
   * One report per original file. Returns the refs that were not parked.
   */
  async decide(refs: string[], approve: boolean, reason?: string): Promise<string[]> {
    const unknown: string[] = []
    for (const r of refs) if (!(await this.#parked.has(r))) unknown.push(r)
    if (unknown.length) return unknown
    // One report per original file: grouped by its key (a parked payment comes back from the store as a new object).
    const byFile = new Map<string, { file: FileRef; steps: Step[] }>()
    for (const ref of refs) {
      const r = await this.#parked.take(ref) // at most once: listed twice, or decided by another process
      const p = r && await this.#unpark(r)
      if (!p) continue
      const fk = `${keyOf(p.file.customer)}|${p.file.requestId}|${p.file.msgId}`
      const group = byFile.get(fk) ?? { file: p.file, steps: [] }
      byFile.set(fk, group)
      const steps = group.steps
      const { block, tx } = p.plan
      if (p.kind === 'SCA') {
        if (!approve) await this.#forget(p.plan)
        steps.push(approve ? await this.#execute(p.file, p.plan) : { status: { block, tx, status: 'RJCT', reason: reason ?? R.requestedByCustomer, scheme: p.status.scheme } })
      } else if (!approve) {
        await this.#release(p.plan)
        this.#incomingOf(p.file, p.plan, 'Rejected')
        steps.push({ status: { ...p.status, status: 'RJCT', reason: reason ?? R.regulatory } })
      } else if (p.plan.creditorOwner) {
        await this.ledger.commit(ref, p.plan.creditorAccount!)
        this.#incomingOf(p.file, p.plan, 'Booked')
        steps.push(this.#internalBooked(p.file, p.plan))
      } else {
        const s = await this.#rails(p.file, p.plan, { ...p.status, status: 'ACSP', reason: undefined })
        if (s) steps.push(s)
      }
    }
    for (const { file, steps } of byFile.values()) await this.#flow(file, steps, false)
    return []
  }

  /** Scheme selection as documented: requested scheme if possible, else automatic. */
  async #scheme(requested: string | undefined, currency: string, creditorIban: string | undefined, withinInstantLimit: boolean, creditorId?: string): Promise<{ scheme: Scheme } | { reject: string }> {
    const sepa = !!creditorIban && isSepaCountry(ibanCountry(creditorIban))
    // GBP to a UK account (GB IBAN or sort code + account number) goes by Faster Payments when no scheme is asked for (decision 840).
    const ukCreditor = !!creditorId && (/^GB[0-9]{2}[A-Z]{4}[0-9]{14}$/.test(creditorId) || /^[0-9]{14}$/.test(creditorId))
    if (currency === 'GBP' && ukCreditor && (requested === undefined || requested === 'ALL')) return { scheme: 'FAST' }
    if (requested === 'INST' || requested === 'SEPA' || requested === 'TARGET2') {
      if (currency !== 'EUR') return { reject: R.currency }
      if (!sepa && requested !== 'TARGET2') return { reject: R.declined }
      if (requested === 'INST' && (!withinInstantLimit || !(await this.rails.instantReachable(creditorIban!)))) return { reject: R.instantForbidden }
      return { scheme: requested }
    }
    if (currency === 'EUR' && sepa) return { scheme: withinInstantLimit && (await this.rails.instantReachable(creditorIban!)) ? 'INST' : 'SEPA' }
    return { scheme: 'SWIFT' }
  }

  /** The debit of a planned payment; an agency debtor as found when it was checked. */
  #debitBooking(customer: Customer, p: Plan, scheme: string, creditorBic?: string): Booking {
    const { block, tx, ref } = p
    const iban = normalizeIban(block.debtorIban!)
    const v = block.debtorOther ? undefined : this.opts.virtual?.resolve(iban)
    const a = v ? undefined : p.debtorA
    const party = v ? virtualParty(v) : a ? {
      ...(block.debtorOther ? { account: iban } : { iban }), name: block.debtorName, country: block.debtorAddress?.country, address: block.debtorAddress?.town, agency: true,
    } : undefined
    return {
      account: v?.master ?? a?.master ?? iban, virtual: party, owner: { name: customer.name, code: customer.code }, direction: 'DBIT',
      amount: toMinor(tx.amount!), currency: tx.currency!, servicerRef: ref, scheme, bookedAt: this.clock.now(),
      pmtInfId: block.pmtInfId, instrId: tx.instrId, endToEndId: tx.endToEndId,
      counterparty: { name: tx.creditorName, iban: tx.creditorIban ? normalizeIban(tx.creditorIban) : undefined, account: tx.creditorOther, bic: creditorBic ?? tx.creditorBic },
      remittance: tx.ustrd, reference: tx.reference,
      ultimateDebtor: tx.ultimateDebtor ?? block.ultimateDebtor, ultimateCreditor: tx.ultimateCreditor,
    }
  }

  /** The receiver bank's country: LHV's own for an account here, else the BIC's, else the IBAN's. */
  async #receiverCountry(tx: Tx): Promise<string | undefined> {
    const iban = tx.creditorIban ? normalizeIban(tx.creditorIban) : undefined
    if (iban && await this.directory.ownerOf(this.#account(iban))) return this.bank.bic.slice(4, 6).toUpperCase()
    if (tx.creditorBic && tx.creditorBic.length >= 6) return tx.creditorBic.slice(4, 6).toUpperCase()
    return iban ? ibanCountry(iban) : undefined
  }

  /** The ledger account behind an IBAN: a VIBAN's master account, else the IBAN itself. */
  #account(iban: string) {
    const n = normalizeIban(iban)
    return this.opts.virtual?.resolve(n)?.master ?? n
  }

  /** The synchronised agency accounts with this identifier (IBAN, GB IBAN or sort code + account number), LHV EE first. */
  async #agency(id: string): Promise<AgencyAccount[]> {
    return (await this.opts.agency?.()?.find(id)) ?? []
  }

  /** The agency account a block pays from, when the customer is its agent and it is no account of the customer's own. */
  async #agencyDebtor(block: Block, customer: Customer): Promise<AgencyAccount | undefined> {
    const id = normalizeIban(block.debtorIban!)
    if (!block.debtorOther && await this.directory.ownerOf(id)) return undefined
    return (await this.#agency(id)).find((a) => keyOf(a.agent) === keyOf(customer))
  }

  async #report(customer: Customer, requestId: string, r: StatusReport) {
    // LHV UK answers for a file whose debtor accounts are all held in the UK (decision 843).
    const blocks = r.blocks.map((b) => b.txs[0]?.block).filter((b): b is Block => !!b)
    const accounts = await Promise.all(blocks.map((b) => this.#ledgerAccount(b, customer)))
    const uk = accounts.length > 0 && accounts.every((a) => isUkAccount(a))
    await this.inbox.add({ customer, type: 'PAYMENT', requestId, body: pain002(r, this.bank.bic, this.clock.now(), { uk }) })
  }

  /** The ledger account a block pays from: a VIBAN's or an agency account's master account, else the account. */
  async #ledgerAccount(b: Block, customer: Customer): Promise<string> {
    const id = normalizeIban(b.debtorIban ?? '')
    if (!b.debtorOther) {
      const v = this.opts.virtual?.resolve(id)
      if (v) return v.master
      if (await this.directory.ownerOf(id)) return id
    }
    return (await this.#agencyDebtor(b, customer))?.master ?? id
  }

  async #notify(customer: Customer, b: Booking) {
    // In the journal first, then out of the in-flight amounts: never counted by neither.
    await this.opts.onBooking?.(customer, b)
    if (b.direction === 'DBIT') await this.#inflight.take(b.servicerRef)
    // Notifications carry no Message-Request-Id.
    await this.inbox.add({ customer, type: 'CREDIT_DEBIT_NOTIFICATION', body: camt054(b, customer.camt054, this.bank) })
  }

  /**
   * A credit from the rails (RailsEvents.credit): booked once per ref, a repeat answers
   * the first result; an account not here is returned AC01 (decision 932).
   */
  received(c: IncomingCredit): Promise<CreditResult> {
    const busy = this.#crediting.get(c.ref)
    if (busy) return busy
    const r = (async () => {
      const seen = await this.#credits.get(c.ref)
      if (seen) return seen
      const result = await this.#receive(c)
      await this.#credits.set(c.ref, result)
      return result
    })()
    this.#crediting.set(c.ref, r)
    // A failure (not a return) may be retried with the same ref: nothing is remembered.
    const done = () => { if (this.#crediting.get(c.ref) === r) this.#crediting.delete(c.ref) }
    r.then(done, done)
    return r
  }

  async #receive(c: IncomingCredit): Promise<CreditResult> {
    const iban = normalizeIban(c.iban)
    if (!this.opts.virtual?.resolve(iban) && !await this.directory.ownerOf(iban) && !(await this.#agency(iban)).length) {
      return { status: 'returned', code: 'AC01', reason: R.accountNumber }
    }
    const r = await this.incoming({
      iban, amount: c.amount, currency: c.currency, scheme: c.scheme, debtor: c.debtor, remittance: c.remittance,
      reference: c.reference, endToEndId: c.endToEndId, creditorName: c.creditorName,
    })
    return r.returned ? { status: 'returned', code: r.returned.code, reason: r.returned.reason } : { status: 'booked', servicerRef: r.servicerRef! }
  }

  /** An incoming credit from outside (the simulator's SEPA / SEPA Instant credit). */
  async incoming(p: { iban: string; amount: bigint; currency: string; scheme: string; debtor: { name?: string; iban?: string; bic?: string; /** A non-IBAN account (Bacs: sort code + account number). */ account?: string }; remittance?: string; reference?: string; endToEndId?: string; /** Reuse a reference (a held payment, decision 712). */ ref?: string; /** The creditor's name as the payment gives it. */ creditorName?: string
    /** The sender's references, shown in Refs as the G use case 7 sample (decision 847). */ pmtInfId?: string; instrId?: string }) {
    const iban = normalizeIban(p.iban)
    const v = this.opts.virtual?.resolve(iban)
    // To a VIBAN that is not ACTIVE: returned to the sender, nothing booked or notified.
    if (v && v.status !== 'ACTIVE') {
      this.opts.onIncoming?.({ ref: p.ref ?? servicerRef(), status: 'Rejected', account: iban, master: v.master, amount: p.amount, currency: p.currency,
        debtor: { name: p.debtor.name, iban: p.debtor.iban ? normalizeIban(p.debtor.iban) : undefined } })
      return { returned: inactiveCreditor(v) }
    }
    // To an agency account: on its master account, refused when CLOSED, and when INST_RESTRICTED for SEPA Instant (decision 835).
    const a = !v && !await this.directory.ownerOf(iban) ? (await this.#agency(iban))[0] : undefined
    if (a && !receivable(a, { instant: p.scheme === 'INST' })) {
      this.opts.onIncoming?.({ ref: p.ref ?? servicerRef(), status: 'Rejected', account: iban, master: a.master, amount: p.amount, currency: p.currency,
        debtor: { name: p.debtor.name, iban: p.debtor.iban ? normalizeIban(p.debtor.iban) : undefined } })
      return { returned: a.status === 'CLOSED' ? { reason: R.creditorClosed, code: 'AC04' } : { reason: R.instantForbidden, code: 'AG01' } }
    }
    const account = v?.master ?? a?.master ?? iban
    const owner = await this.directory.ownerOf(account)
    if (!owner) throw new Error(`no account ${iban}`)
    const ref = p.ref ?? servicerRef()
    await this.ledger.transfer({ ref, from: this.rails.settlementAccount(p.scheme), to: account, amount: p.amount, currency: p.currency })
    await this.#notify(owner, {
      account, virtual: v ? virtualParty(v) : a && agencyParty(a, iban, p.creditorName), owner: { name: owner.name, code: owner.code }, direction: 'CRDT', amount: p.amount, currency: p.currency,
      servicerRef: ref, scheme: p.scheme, bookedAt: this.clock.now(), endToEndId: p.endToEndId, pmtInfId: p.pmtInfId, instrId: p.instrId,
      counterparty: { name: codePage(p.debtor.name), iban: p.debtor.iban ? normalizeIban(p.debtor.iban) : undefined, account: p.debtor.account, bic: p.debtor.bic },
      remittance: codePage(p.remittance), reference: codePage(p.reference),
    })
    return { servicerRef: ref }
  }
}

/** The VIBAN as the own party of a master account entry (camt.054 Dbtr / Cdtr). */
const virtualParty = (v: VirtualAccount) => ({ iban: v.iban, name: v.holder?.name, country: v.holder?.country, address: v.holder?.address })
/** An agency account as the own party of a master account entry: as addressed (IBAN or Othr/Id), the synchronised name first (decision 832). */
const agencyParty = (a: AgencyAccount, id: string, name?: string) => {
  const n = normalizeIban(id)
  return { ...(/^[A-Z]{2}[0-9]{2}/.test(n) ? { iban: n } : { account: n }), name: a.name ?? name, agency: true }
}

export { XmlSyntaxError }
