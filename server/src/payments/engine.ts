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
import { createHash, randomUUID } from 'node:crypto'
import { DEFAULT_BOUNDS, type Bounds } from '../bounded.js'
import { memoryKeyed, UNBOUNDED, type KeyedFactory, type KeyedStore } from '../keyed.js'
import type { Clock } from '../clock.js'
import { codePage, fold } from '../cp1257.js'
import { keyOf, type Customer, type CustomerKey, type DirectoryStore } from '../directory.js'
import type { JournalStore } from '../statements/journal.js'
import { ibanChecksumOk, ibanCountry, isSepaCountry, normalizeIban } from '../iban.js'
import { servicerRef } from '../ids.js'
import type { InboxStore } from '../inbox.js'
import { InsufficientFunds, toMinor, type Ledger } from '../ledger.js'
import { SCHEMES as RAILS_SCHEMES, sameOutcome, type CreditRecall, type CreditResult, type IncomingCredit, type PaymentReturn, type PaymentReturnResult, type Rails, type RailsOutcome, type RecallResult, type Scheme } from '../rails.js'
import { parseXml, XmlSyntaxError } from '../xml.js'
import { isUkAccount } from '../routing.js'
import type { Booking } from './camt054.js'
import type { Outbox, OutboxItem } from '../outbox.js'
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
  /**
   * Where a booking's statement entry and camt.054 go with the booking (decision 990): the
   * emulator's outbox, whose notice handler writes the journal and the inbox.
   */
  outbox: Outbox
  /** Virtual IBANs: booked on their master account (L3). */
  virtual?: VirtualAccounts
  /**
   * The customer's Connect payment limits in EUR minor units: daily and monthly totals with
   * what booked debits already used, and the per-payment SEPA Instant limit (decision 524).
   */
  limits?: (c: Customer) => Promise<PaymentLimits>
  /** Incoming payments to a customer that are not (yet) booked: pending, rejected, then booked (UK /accounts, decision 711). */
  onIncoming?: (e: IncomingEvent) => void | Promise<void>
  /** Synchronised agency accounts (indirect scheme access, decisions 830–836): paid from and to via their master account. */
  agency?: () => AgencyStore | undefined
  /** Payments waiting at the rails (decision 948); default in memory. */
  pending?: RailsPending
  /** Where duplicate sets, parked payments, in-flight limit amounts and credit results are kept (decision 963); default in memory. */
  keyed?: KeyedFactory
  /** The statements journal: a settled payment's debit entry, for a return without its record (decision 1020). */
  journal?: Pick<JournalStore, 'byRef'>
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

/**
 * One status of one payment; `then`: the plan whose following step (#nextOf: the rails,
 * manual review) yields its status in a later report, planned with this round's entries
 * (decision 1018). `reported`: its pain.002 went with its booking's first call
 * (decision 999), the round leaves it out. `i`: its place in the round; `entry`: its entry
 * in the round's report, kept with its booking (decision 1005).
 */
interface Step { status: TxStatus; notices?: OutboxItem[]; then?: Plan; reported?: boolean; i?: number; entry?: OutboxItem }
/**
 * Makes a payment's entry in its round's report, to be kept with the booking that settles it;
 * `then` the plan of its step in the round after (SEPA after ACWC), kept with the entry when
 * the entry is kept before the round's own put (decision 1019).
 */
type EntryOf = ((status: TxStatus) => OutboxItem) & { then: (p: Plan, s: TxStatus) => OutboxItem }
/** A round of a file's status reports: one pain.002, group and block statuses in the first. */
interface Round { id: string; file: FileRef; first: boolean }
/**
 * The id of the round after a round (decision 1019): derived, so a step's plan in it can be
 * kept with the step's entry before the round's own put, and a resumed round plans the same.
 */
const afterOf = (id: string) => {
  const h = createHash('sha256').update(`${id}/next`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}
/** The outbox kind of a round's pain.002 (decision 1005): a group per round. */
const ROUND_KIND = 'pain002'
/** A settled external payment kept for a return (decision 1014): an item of its settlement's commit. */
const SETTLED_KIND = 'payment-settled'
/** The timer's recovery leaves a round this long to the process running it (decision 1005). */
export const ROUND_RECOVER_MIN_AGE_MS = 10 * 60 * 1000
type StoredFile = PendingRecord['file']
/** A payment's entry in its round's report; no status when the round reports nothing for it now. */
interface RoundEntry { type: 'entry'; round: string; file: StoredFile; first: boolean; i: number; status?: Record<string, unknown> }
/**
 * A transaction of a round planned before anything books (decision 1005): a status from the
 * checks, a checked plan to execute (or park for SCA), a parked payment decided (1006), or
 * the step that follows a status of the previous round (1018: #nextOf of the plan and status).
 */
type PlannedTx = { i: number; status: Record<string, unknown> } | { i: number; plan: Record<string, unknown>; park?: boolean } | { i: number; ref: string; parked: ParkedRecord }
  | { i: number; next: { plan: Record<string, unknown>; status: Record<string, unknown> } }
/**
 * A received file kept in its first round's group before its MsgId is marked (decision 1017):
 * the body as sent and a reference per transaction, so a crash before the round is planned
 * checks the same file again under the same references.
 */
interface RoundFile { type: 'file'; round: string; file: StoredFile; first: true; xml: string; refs: string[] }
interface RoundPlan { type: 'plan'; round: string; file: StoredFile; first: boolean; txs: PlannedTx[]; decision?: { approve: boolean; reason?: string } }
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v))
/**
 * A round's plan from its items: the plan #flow put, and the plans of single steps kept with
 * their entries of the round before (decision 1019), their transactions together, once each.
 */
function planOf(items: OutboxItem[]): RoundPlan | undefined {
  const plans = items.map((c) => c.payload as RoundPlan | RoundEntry).filter((c): c is RoundPlan => c.type === 'plan')
  if (plans.length < 2) return plans[0]
  const txs = new Map<number, PlannedTx>()
  for (const p of plans) for (const t of p.txs) if (!txs.has(t.i)) txs.set(t.i, t)
  return { ...plans[0], txs: [...txs.values()].sort((a, b) => a.i - b.i) }
}
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
/** A file's MsgId as marked, per customer. */
const msgIdKey = (file: FileRef) => `${keyOf(file.customer)}|${file.msgId}`
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
  // The value is the first round of the file that claimed the MsgId (decision 1017; `true` before).
  #seenMsgIds: KeyedStore<string | true>
  /** Payments with an InstrId that are not (yet) rejected: customer, InstrId, accounts, currency, amount (decision 525) → ref. */
  #instrIds: KeyedStore<string>
  /** EUR debits accepted but not yet in the journal, counted against the limits (amount as a decimal string). */
  #inflight: KeyedStore<{ customer: string; amount: string }>
  /** Payments waiting for SCA or in manual review, by ref. */
  #parked: KeyedStore<ParkedRecord>
  /** Payments waiting at the rails (decision 948); in memory unless the emulator gives a persistent store. */
  #pending: RailsPending
  /** Credits from the rails by their ref: the result a repeat answers (decision 932), what was booked and a recall's answer (1001). */
  #credits: KeyedStore<CreditRecord>
  /** Credits being booked in this process: a concurrent repeat waits for the same result. */
  #crediting = new Map<string, Promise<CreditResult>>()
  /** Parked payments claimed by a decision's round (decision 1006): the round's id, so a resumed round knows its own. */
  #decided: KeyedStore<string>
  /** External payments the rails settled, by ref: what a return books back (decision 1014). */
  #settled: KeyedStore<SettledRecord>
  constructor(
    private directory: DirectoryStore, private ledger: Ledger, private rails: Rails, private inbox: InboxStore,
    private clock: Clock, private bank: Bank, private opts: EngineOptions,
  ) {
    const keyed = opts.keyed ?? memoryKeyed(clock)
    const msgIds = opts.msgIds ?? DEFAULT_BOUNDS.msgIds
    this.#seenMsgIds = keyed('payment-msgids', msgIds)
    this.#instrIds = keyed('payment-instrids', msgIds)
    this.#credits = keyed('payment-credits', msgIds)
    this.#inflight = keyed('payment-inflight', UNBOUNDED)
    this.#parked = keyed('payment-parked', UNBOUNDED)
    this.#pending = opts.pending ?? new MemoryRailsPending()
    this.#decided = keyed('payment-decided', msgIds)
    this.#settled = keyed('payment-settled', msgIds)
    // Kept with the settlement's booking; `add` leaves a record a return has already changed.
    opts.outbox.on(SETTLED_KIND, async (i) => { const r = i.payload as SettledRecord; await this.#settled.add(r.ref, r) })
    // A round's pain.002 (decision 1005): delivered by the round, or after a crash resumed and delivered by recover.
    opts.outbox.onGroup(ROUND_KIND, (items) => this.#roundReports(items), { minAgeMs: ROUND_RECOVER_MIN_AGE_MS })
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
    // Kept before the MsgId is marked (decision 1017): a crash before the round is planned
    // resumes the file from the outbox; the mark claims the MsgId once (`add`), so of two
    // submissions of one MsgId at once, or a resubmission and a resumed file, one goes on.
    const round: Round = { id: randomUUID(), file: { customer, requestId, version, msgId: file.msgId! }, first: true }
    const kept: RoundFile = { type: 'file', round: round.id, file: fileKey(round.file), first: true, xml, refs: file.blocks.flatMap((b) => b.txs.map(() => servicerRef())) }
    const item = this.opts.outbox.item(ROUND_KIND, json(kept))
    await this.ledger.outbox.put([item])
    if (!(await this.#seenMsgIds.add(msgIdKey(round.file), round.id))) {
      await this.ledger.outbox.remove([item.key])
      return reject(R.duplicateMessage, version)
    }
    await this.#process(file, round, kept.refs, item)
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
      const owner = b.debtorOther ? undefined : await this.directory.ownerOf(await this.#account(b.debtorIban!))
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

  /** Checks a file's transactions under their kept references, plans the first round and runs it (decisions 1005, 1017). */
  async #process(f: PaymentFile, round: Round, refs: string[], kept: OutboxItem) {
    const customer = round.file.customer
    const pending = customer.payments === 'PENDING'
    // Checked, then planned in the outbox before anything books (decision 1005): a crash
    // after any booking resumes the round from the plan and reports it once.
    const txs: PlannedTx[] = []
    const plans: (Plan | undefined)[] = []
    for (const block of f.blocks) {
      for (const tx of block.txs) {
        const i = txs.length
        const c = await this.#check(block, tx, customer, refs[i])
        plans.push('plan' in c ? c.plan : undefined)
        txs.push('status' in c ? { i, status: json(c.status) as unknown as Record<string, unknown> } : { i, plan: encodePlan(c.plan), ...(pending ? { park: true } : {}) })
      }
    }
    const plan = this.#planItem(round, txs)
    await this.ledger.outbox.put([plan])
    const steps: Step[] = []
    for (const t of txs) {
      const s = await this.#runPlanned(round, t, { live: plans[t.i] })
      if (s) steps.push(s)
    }
    await this.#flow(steps, round, [kept, plan])
  }

  /**
   * A kept file whose round has no plan (decision 1017): a crash during its checks, or before
   * its MsgId was marked. Checked again and run when the MsgId is this round's (or still
   * free, then claimed); another submission's claim drops it, delivered with nothing to report.
   */
  async #resumeFile(round: Round, item: OutboxItem) {
    const kept = item.payload as RoundFile
    const key = msgIdKey(round.file)
    if (!(await this.#seenMsgIds.add(key, round.id)) && (await this.#seenMsgIds.get(key)) !== round.id) return
    const f = readPain001(parseXml(kept.xml), round.file.version)
    await this.#process(f, round, kept.refs, item)
  }

  #planItem(round: Round, txs: PlannedTx[], decision?: RoundPlan['decision']): OutboxItem {
    const payload: RoundPlan = { type: 'plan', round: round.id, file: fileKey(round.file), first: round.first, txs, ...(decision ? { decision } : {}) }
    return this.opts.outbox.item(ROUND_KIND, json(payload))
  }

  /**
   * The plan of one payment's step in the round after `round` (decision 1019), kept with its
   * entry of `round` when that entry is kept early (#answered, settle): keyed by the round
   * after and the payment's place, so #flow carries (and a resumed round finds) the same item.
   */
  #thenItem(round: Round, i: number, p: Plan, s: TxStatus): OutboxItem {
    const after = afterOf(round.id)
    const payload: RoundPlan = { type: 'plan', round: after, file: fileKey(round.file), first: false, txs: [{ i, next: { plan: encodePlan(p), status: json(s) as unknown as Record<string, unknown> } }] }
    return { ...this.opts.outbox.item(ROUND_KIND, json(payload)), key: `${after}/then/${i}` }
  }

  #entry(round: Round, i: number, status?: TxStatus): OutboxItem {
    const payload: RoundEntry = { type: 'entry', round: round.id, file: fileKey(round.file), first: round.first, i, ...(status ? { status: json(status) as unknown as Record<string, unknown> } : {}) }
    return this.opts.outbox.item(ROUND_KIND, json(payload))
  }

  #entryOf(round: Round, i: number): EntryOf {
    return Object.assign((status: TxStatus) => this.#entry(round, i, status), { then: (p: Plan, s: TxStatus) => this.#thenItem(round, i, p, s) })
  }

  /**
   * Runs one planned transaction of a round; `live` the plan as checked (not read back),
   * `resume` after a crash, when a reservation of a transaction without an entry was not
   * reported and is made again (decision 1005).
   */
  async #runPlanned(round: Round, t: PlannedTx, o: { live?: Plan; decision?: RoundPlan['decision']; resume?: boolean } = {}): Promise<Step | undefined> {
    const file = round.file
    const entryOf = this.#entryOf(round, t.i)
    const at = (s: Step | undefined): Step | undefined => s && { ...s, i: t.i }
    if ('status' in t) return at({ status: t.status as unknown as TxStatus })
    if ('plan' in t) {
      const plan = o.live ?? (await this.#decodePlan(t.plan))
      if (!plan) return undefined
      if (t.park) return at({ status: await this.#park('SCA', file, plan) })
      if (o.resume) await this.ledger.release(plan.ref)
      return at(await this.#execute(file, plan, entryOf))
    }
    if ('next' in t) {
      // The step after a status reported in the previous round, run after a crash (decision
      // 1018): that report told ACSP, so the reservation is kept (not released as above); a
      // payment the rails have is not sent again, one already parked is not parked again.
      const plan = await this.#decodePlan(t.next.plan)
      const go = plan && this.#nextOf(file, plan, t.next.status as unknown as TxStatus)
      if (!plan || !go) return undefined
      const sepa = (t.next.status as unknown as TxStatus).status === 'ACWC'
      const waiting = await this.#resumeRails(plan.ref, entryOf, sepa ? 'SEPA' : undefined)
      if (waiting !== false) return at(waiting)
      if ((await this.#settled.has(plan.ref)) || (await this.#decided.has(plan.ref))) return undefined
      const parked = await this.#parked.get(plan.ref)
      if (parked) return at({ status: parked.status as unknown as TxStatus })
      return at(await go(entryOf))
    }
    // A parked payment decided (decision 1006): claimed by this round once, also when the
    // round is resumed after a crash (the claim names it); another round's claim skips it.
    if (!(await this.#decided.add(t.ref, round.id)) && (await this.#decided.get(t.ref)) !== round.id) return undefined
    await this.#parked.take(t.ref)
    const p = await this.#unpark(t.parked)
    if (!p) return undefined
    const { approve, reason } = o.decision!
    const { block, tx } = p.plan
    if (p.kind === 'SCA') {
      if (!approve) {
        await this.#forget(p.plan)
        return at({ status: { block, tx, status: 'RJCT', reason: reason ?? R.requestedByCustomer, scheme: p.status.scheme } })
      }
      if (o.resume) await this.ledger.release(p.plan.ref)
      return at(await this.#execute(p.file, p.plan, entryOf))
    }
    if (!approve) {
      await this.#release(p.plan)
      await this.#incomingOf(p.file, p.plan, 'Rejected')
      return at({ status: { ...p.status, status: 'RJCT', reason: reason ?? R.regulatory } })
    }
    if (p.plan.creditorOwner) {
      const booked = await this.#internalBooked(p.file, p.plan)
      const entry = entryOf(booked.status)
      if ((await this.ledger.commit(t.ref, p.plan.creditorAccount!, [...booked.notices!, entry])).repeat) booked.notices = []
      else booked.entry = entry
      await this.#incomingOf(p.file, p.plan, 'Booked')
      return at(booked)
    }
    // Sent before the crash: waiting at the rails, settled from there (decision 1018).
    if (o.resume) {
      const waiting = await this.#resumeRails(t.ref, entryOf)
      if (waiting !== false) return at(waiting)
    }
    return at(await this.#rails(p.file, p.plan, { ...p.status, status: 'ACSP', reason: undefined }, entryOf))
  }

  /**
   * Reports rounds of steps: one pain.002 per round (group and block statuses only in the
   * first report about a file), then the round's camt.054s, then the steps that follow.
   * The pain.002 goes through the outbox (decision 1005): each step's entry, kept with its
   * booking or written now, and `carried` (the round's plan, entries a crash left) are
   * delivered together; the group's handler (#roundReports) adds the report, once by the round.
   */
  async #flow(steps: Step[], round: Round, carried: OutboxItem[] = []) {
    for (;;) {
      const plan = planOf(carried)
      const have = new Set(carried.map((c) => c.payload as RoundPlan | RoundEntry).flatMap((c) => (c.type === 'entry' ? [c.i] : [])))
      const entries = [...carried]
      const put: OutboxItem[] = []
      const fresh = (i: number, status?: TxStatus) => { const e = this.#entry(round, i, status); put.push(e); entries.push(e) }
      for (const s of steps) {
        if (s.entry) entries.push(s.entry)
        else if (!have.has(s.i!)) fresh(s.i!, s.reported ? undefined : s.status)
      }
      // A planned transaction without a step reports nothing now; its empty entry completes the round.
      for (const t of plan?.txs ?? []) if (!have.has(t.i) && !steps.some((s) => s.i === t.i)) fresh(t.i)
      // The next round is planned with this round's entries (decision 1018): a crash after this
      // report resumes the steps that follow (the rails, manual review) from the plan, once.
      // A step whose entry was kept before this put (#answered, settle) kept its plan in the
      // round after with it (decision 1019): carried, not planned again.
      const next: Round = { id: afterOf(round.id), file: round.file, first: false }
      const then = steps.filter((s) => s.then && this.#nextOf(round.file, s.then, s.status))
      const early = (s: Step) => !!s.entry || have.has(s.i!)
      const own = then.filter((s) => !early(s))
      const nextPlan = own.length
        ? this.#planItem(next, own.map((s) => ({ i: s.i!, next: { plan: encodePlan(s.then!), status: json(s.status) as unknown as Record<string, unknown> } })))
        : undefined
      const nextPlans = [...(nextPlan ? [nextPlan] : []), ...then.filter(early).map((s) => this.#thenItem(round, s.i!, s.then!, s.status))]
      // Put again with the rest (an existing key is kept): a kept entry never lacks its plan.
      await this.ledger.outbox.put([...put, ...nextPlans])
      await this.opts.outbox.deliver(entries)
      for (const s of steps) await this.opts.outbox.deliver(s.notices ?? [])
      const following: Step[] = []
      for (const s of then) {
        const n = await this.#nextOf(round.file, s.then!, s.status)!(this.#entryOf(next, s.i!))
        if (n) following.push({ ...n, i: s.i })
      }
      // Every step waits (at the rails): nothing to report, the plan goes.
      if (!following.length) {
        if (nextPlans.length) await this.ledger.outbox.remove(nextPlans.map((p) => p.key))
        return
      }
      steps = following
      round = next
      carried = nextPlans
    }
  }

  /**
   * The outbox group of rounds' entries: one pain.002 per round, its message keyed by the
   * round (a recovery racing the round adds one). A planned round with a transaction
   * without an entry was cut by a crash: it is resumed first (decision 1005).
   */
  async #roundReports(items: OutboxItem[]) {
    const rounds = new Map<string, OutboxItem[]>()
    for (const i of items) {
      const id = (i.payload as RoundEntry).round
      rounds.set(id, [...(rounds.get(id) ?? []), i])
    }
    for (const [id, group] of rounds) {
      const planItems = group.filter((i) => (i.payload as RoundPlan).type === 'plan')
      const plan = planOf(planItems)
      // One entry per transaction; of two (a resumed booking found booked), one with a status.
      const entries = new Map<number, OutboxItem>()
      for (const i of group) {
        const e = i.payload as RoundEntry
        if (e.type === 'entry' && (!entries.has(e.i) || e.status)) entries.set(e.i, i)
      }
      const head = group[0].payload as RoundEntry
      const file = await this.#fileOf(head.file)
      if (!file) continue // the customer is gone: nothing to report to
      const round: Round = { id, file, first: head.first }
      const kept = group.find((i) => (i.payload as RoundFile).type === 'file')
      if (!plan && kept) {
        await this.#resumeFile(round, kept)
        continue
      }
      if (plan) await this.#takeReported(plan, entries)
      if (plan && plan.txs.some((t) => !entries.has(t.i))) {
        await this.#resume(round, plan, [...planItems, ...(kept ? [kept] : [])], entries)
        continue
      }
      const r: StatusReport = { version: file.version, originalMsgId: file.msgId, blocks: [] }
      for (const e of [...entries.values()].map((i) => i.payload as RoundEntry).sort((a, b) => a.i - b.i)) {
        if (!e.status) continue
        const st = e.status as unknown as TxStatus
        let b = r.blocks.find((x) => x.pmtInfId === st.block.pmtInfId)
        if (!b) r.blocks.push((b = { pmtInfId: st.block.pmtInfId!, txs: [] }))
        b.txs.push(st)
      }
      if (round.first) {
        for (const b of r.blocks) b.status = aggregate(b.txs.map((t) => t.status))
        r.groupStatus = aggregate(r.blocks.flatMap((b) => b.txs.map((t) => t.status)))
      }
      if (r.blocks.length) await this.inbox.add({ ...(await this.#reportMessage(file.customer, file.requestId, r)), key: id })
    }
  }

  /**
   * A round a crash cut (decision 1005): the transactions with an entry keep it (booked, or
   * decided before the crash; their next steps did not run, the round was not reported),
   * the others run again, then the round goes on as it would have.
   */
  async #resume(round: Round, plan: RoundPlan, carried: OutboxItem[], entries: Map<number, OutboxItem>) {
    const steps: Step[] = []
    for (const t of plan.txs) {
      const e = entries.get(t.i)?.payload as RoundEntry | undefined
      if (!e) {
        const s = await this.#runPlanned(round, t, { decision: plan.decision, resume: true })
        if (s) steps.push(s)
        continue
      }
      if (!e.status) continue
      const status = e.status as unknown as TxStatus
      const p = 'plan' in t ? await this.#decodePlan(t.plan) : 'parked' in t ? (await this.#unpark(t.parked))?.plan : 'next' in t ? await this.#decodePlan(t.next.plan) : undefined
      steps.push({ status, i: t.i, ...(p ? { then: p } : {}) })
    }
    await this.#flow(steps, round, [...carried, ...entries.values()])
  }

  /**
   * A rails outcome of a round cut by a crash whose entry was kept before its record was
   * taken (decision 1018): the record, still waiting with its outcome, is taken now (the
   * entry reports it; reconcile would report it again).
   */
  async #takeReported(plan: RoundPlan, entries: Map<number, OutboxItem>) {
    for (const t of plan.txs) {
      const ref = 'next' in t ? String(t.next.plan.ref) : 'parked' in t ? t.ref : undefined
      if (!ref || !(entries.get(t.i)?.payload as RoundEntry | undefined)?.status) continue
      // Only the attempt this round reported (decision 1019): after ACWC the SEPA leg's record
      // (sent by the round after, resumed first) is not this round's.
      const scheme = 'next' in t ? (t.next.status.status === 'ACWC' ? 'SEPA' : t.next.plan.scheme) : 'parked' in t ? t.parked.plan.scheme : undefined
      const r = await this.#pending.get(ref)
      if (r?.outcome && (scheme === undefined || r.scheme === scheme)) await this.#pending.take(ref, r.scheme)
    }
  }

  /**
   * A payment of a resumed round that a crash left at the rails (decisions 1006, 1018):
   * `false` when nothing waits under its ref. One whose outcome was stored goes on from it
   * as #rails would have (its entry in this round); one without waits for the outcome
   * (the bridge's callback, reconcile). `scheme` the attempt to resume (SEPA after ACWC): a
   * record of another is the attempt before, whose outcome the round before reports (its
   * entry was kept with this plan, decision 1019): taken, and `false`.
   */
  async #resumeRails(ref: string, entryOf: EntryOf, scheme?: Scheme): Promise<Step | undefined | false> {
    const r = await this.#pending.get(ref)
    if (!r) return false
    if (scheme && r.scheme !== scheme) {
      await this.#pending.take(ref, r.scheme)
      return false
    }
    const w = r.outcome && (await this.#decode(r))
    return w ? this.#answered(w.file, w.plan, w.accepted, r.outcome!, entryOf) : undefined
  }

  /** What follows a status in a later round: the rails for an accepted external payment (SEPA after ACWC), manual review's PDNG. */
  #nextOf(file: FileRef, p: Plan, s: TxStatus): ((entry: EntryOf) => Promise<Step | undefined>) | undefined {
    if (s.status === 'ACWC') {
      const sepa: Plan = { ...p, scheme: 'SEPA' }
      return (e) => this.#rails(file, sepa, { ...s, status: 'ACSP', reason: undefined }, e)
    }
    if (s.status !== 'ACSP') return undefined
    if (MANUAL_REVIEW.has(normName(p.tx.creditorName))) {
      return async () => {
        await this.#incomingOf(file, p, 'Pending')
        return { status: await this.#park('REVIEW', file, p, { ...s, status: 'PDNG', reason: R.manualReview }) }
      }
    }
    return (e) => this.#rails(file, p, s, e)
  }

  async #fileOf(f: StoredFile): Promise<FileRef | undefined> {
    const customer = await this.directory.get(f.customer)
    return customer && { ...f, customer, version: f.version as PainVersion }
  }

  /**
   * The checks that need no money: a rejection, or what to execute. `ref` the transaction's
   * reference kept with its file (decision 1017), the same when the checks run again.
   */
  async #check(rawBlock: Block, rawTx: Tx, customer: Customer, ref: string): Promise<{ status: TxStatus } | { plan: Plan }> {
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
    // Its own key from checks a crash cut (decision 1017) is no duplicate.
    const heldBy = instrKey && (await this.#instrIds.get(instrKey))
    if (heldBy && heldBy !== ref) return rj(R.duplicatePayment)
    // A VIBAN debtor must be ACTIVE and named as its holder; the master account pays.
    const debtorV = block.debtorOther ? undefined : (await this.opts.virtual?.resolve(debtorIban))
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
    const creditorV = creditorIban ? (await this.opts.virtual?.resolve(creditorIban)) : undefined
    if (creditorV && creditorV.status !== 'ACTIVE') {
      await this.opts.onIncoming?.({ ref, status: 'Rejected', account: creditorIban!, master: creditorV.master, amount, currency: tx.currency!,
        debtor: { name: block.debtorName ?? customer.name, iban: debtorIban } })
      return rj(inactiveCreditor(creditorV).reason, 'INTERNAL')
    }
    // An agency account here is credited on its master account unless CLOSED (decision 833).
    const creditorId = creditorIban ?? (tx.creditorOther ? normalizeIban(tx.creditorOther) : undefined)
    const creditorA = !creditorV && creditorId && !(creditorIban && await this.directory.ownerOf(creditorIban)) ? (await this.#agency(creditorId))[0] : undefined
    if (creditorA && !receivable(creditorA, { instant: false })) {
      await this.opts.onIncoming?.({ ref, status: 'Rejected', account: creditorId!, master: creditorA.master, amount, currency: tx.currency!,
        debtor: { name: block.debtorName ?? customer.name, iban: debtorIban } })
      return rj(R.creditorClosed, 'INTERNAL')
    }
    if (creditorA && creditorA.master === debtorAccount && debtorA) return rj(R.sameAccount)
    const creditorAccount = creditorV?.master ?? creditorA?.master ?? creditorIban
    const creditorOwner = creditorAccount ? await this.directory.ownerOf(creditorAccount) : undefined
    const base = { block, tx, amount, currency: tx.currency!, debtorIban, debtorAccount, creditorIban, creditorAccount, creditorV, creditorA, debtorA, ref, instrKey }
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
  async #execute(file: FileRef, p: Plan, entryOf?: EntryOf): Promise<Step> {
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
      const booked = await this.#internalBooked(file, p)
      // Its entry in the round's report goes with the booking (decision 1005).
      const entry = entryOf?.(booked.status)
      try {
        // A repeat of the ref (decision 995) delivers nothing again.
        if ((await this.ledger.transfer({ ref: p.ref, from: p.debtorAccount, to: p.creditorAccount!, amount: p.amount, currency: p.currency }, [...booked.notices!, ...(entry ? [entry] : [])])).repeat) booked.notices = []
        else booked.entry = entry
      } catch (e) {
        if (e instanceof InsufficientFunds) return rj(R.funds, scheme)
        throw e
      }
      await this.#hold(file.customer, p)
      return booked
    }
    try {
      await this.ledger.reserve({ ref: p.ref, account: p.debtorAccount, amount: p.amount, currency: p.currency })
    } catch (e) {
      if (e instanceof InsufficientFunds) return rj(R.funds, scheme)
      throw e
    }
    await this.#hold(file.customer, p)
    const accepted: TxStatus = { block, tx, status: 'ACSP', servicerRef: p.ref, scheme, ...(p.creditorOwner ? { creditorBic: this.bank.bic } : {}) }
    // Manual review (sanctions screening): accepted first, then PDNG until /_sim decides; else the rails.
    return { status: accepted, then: p }
  }

  /** Booked internally: ACSC, camt.054 DBIT to the debtor and CRDT to the creditor (made before the booking, which carries them). */
  async #internalBooked(file: FileRef, p: Plan): Promise<Step> {
    const { block, tx, creditorOwner, creditorV } = p
    const customer = file.customer
    const notices = [this.#notice(customer, await this.#debitBooking(customer, p, 'INTERNAL', this.bank.bic))]
    notices.push(this.#notice(creditorOwner!, {
      account: p.creditorAccount!, virtual: creditorV ? virtualParty(creditorV) : p.creditorA && agencyParty(p.creditorA, p.creditorIban ?? tx.creditorOther!, tx.creditorName),
      owner: { name: creditorOwner!.name, code: creditorOwner!.code }, direction: 'CRDT',
      amount: p.amount, currency: p.currency, servicerRef: servicerRef(), scheme: 'INTERNAL', bookedAt: this.clock.now(),
      instrId: tx.instrId, endToEndId: tx.endToEndId, ultimateDebtor: tx.ultimateDebtor ?? block.ultimateDebtor, ultimateCreditor: tx.ultimateCreditor,
      counterparty: { name: block.debtorName ?? customer.name, ...(block.debtorOther ? { account: p.debtorIban } : { iban: p.debtorIban }), bic: this.bank.bic, code: customer.code },
      remittance: tx.ustrd, reference: tx.reference,
    }))
    return { status: { block, tx, status: 'ACSC', servicerRef: p.ref, scheme: 'INTERNAL', creditorBic: this.bank.bic }, notices }
  }

  /**
   * Sends a reserved external payment to the rails. An immediate outcome is the step that
   * follows; `accepted` leaves it waiting for settle() (nothing more is reported now).
   */
  async #rails(file: FileRef, p: Plan, accepted: TxStatus, entryOf: EntryOf): Promise<Step | undefined> {
    const { block, tx } = p
    // Registered before sending: a bridge may call back before its answer arrives.
    await this.#pending.put(this.#encode(file, p, accepted))
    const answer = await this.rails.send({
      ref: p.ref, scheme: p.scheme!, amount: p.amount, currency: p.currency,
      debtor: { name: block.debtorName ?? file.customer.name, iban: p.debtorIban },
      creditor: { name: tx.creditorName, iban: p.creditorIban, account: tx.creditorOther, bic: tx.creditorBic },
      endToEndId: tx.endToEndId, remittance: tx.ustrd,
    })
    // `unknown` (a bridge timeout) waits as `accepted` and is reconciled (decision 1002).
    if (answer.status === 'accepted' || answer.status === 'unknown') return undefined
    return this.#answered(file, p, accepted, answer, entryOf)
  }

  /**
   * An immediate outcome of the rails (or one stored before a crash, decision 1018). Its
   * record is taken last, after what reports it is kept: a crash before leaves the payment
   * waiting with the outcome stored, and the resumed round (or reconcile) goes on from it.
   * Settled: booked with its entry (the commit's key is the ref, decision 995), then taken.
   * Otherwise the funds are released (RJCT) and its entry kept, then the record taken; of
   * two takers (an outcome from the events at once), the one that takes it reports.
   */
  async #answered(file: FileRef, p: Plan, accepted: TxStatus, answer: RailsOutcome, entryOf: EntryOf): Promise<Step | undefined> {
    // The first stored outcome wins (decision 1003): a callback with another one that came
    // first goes on, this answer is dropped. No record: settled through the events while the
    // answer was on its way, already reported (a SEPA fallback waits with another scheme).
    const d = await this.#pending.decide(p.ref, answer, p.scheme!)
    if (!d) return undefined
    if (d.outcome && !sameOutcome(d.outcome, answer)) {
      console.warn(`rails: payment ${p.ref} (${p.scheme}) answered ${JSON.stringify(answer)} after ${JSON.stringify(d.outcome)} was stored; ignored`)
      return undefined
    }
    if (answer.status === 'settled') {
      // A repeat (the events booked it at once) is `reported`; either way the record goes.
      const step = await this.#outcome(file, p, accepted, answer, { entryOf })
      await this.#pending.take(p.ref, p.scheme)
      return step
    }
    const step = await this.#outcome(file, p, accepted, answer)
    const entry = entryOf(step.status)
    // ACWC: the SEPA round's plan is kept with the entry (decision 1019), so a crash after the
    // take sends SEPA from it; #flow carries it.
    const kept = [entry, ...(step.then ? [entryOf.then(step.then, step.status)] : [])]
    await this.ledger.outbox.put(kept)
    if (!(await this.#pending.take(p.ref, p.scheme))) {
      await this.ledger.outbox.remove(kept.map((k) => k.key))
      return undefined
    }
    return { ...step, entry }
  }

  /**
   * The final outcome of a payment the rails answered `accepted` (RailsEvents.outcome):
   * booked and reported as an immediate outcome would have been. False for a ref that is
   * not waiting at the rails (unknown, or already final): a repeat changes nothing.
   */
  async settle(ref: string, outcome: RailsOutcome, scheme?: Scheme): Promise<boolean> {
    // Booked before the record goes (decision 998): a crash in between leaves the payment
    // waiting, and the outcome again (a bridge retrying) commits nothing twice (the ref is
    // the commit's key). Settled: the pain.002 is one of the commit's items (decision 999),
    // delivered by whoever booked it (or recovered), never by a repeat. Otherwise, of two
    // outcomes at once, the one that takes the record reports.
    // The first outcome stored wins (decision 1003); an outcome for another attempt (scheme) is not this one's.
    const waiting = await this.#pending.get(ref)
    if (!waiting || (scheme !== undefined && waiting.scheme !== scheme)) return false
    const r = await this.#pending.decide(ref, outcome, waiting.scheme)
    if (!r) return false
    if (r.outcome && !sameOutcome(r.outcome, outcome)) {
      console.warn(`rails: payment ${ref} (${r.scheme}) got ${JSON.stringify(outcome)} after ${JSON.stringify(r.outcome)} was stored; ignored`)
      return false
    }
    const w = await this.#decode(r)
    if (!w) { await this.#pending.take(ref, r.scheme); return false }
    if (outcome.status === 'settled') {
      const booked = await this.#outcome(w.file, w.plan, w.accepted, outcome, { report: true })
      await this.opts.outbox.deliver(booked.notices ?? [])
      return !!(await this.#pending.take(ref, r.scheme))
    }
    // Rejected or ACWC (decision 1019): its round is planned, its entry and (ACWC) the SEPA
    // round's plan kept before the record is taken, as for an immediate outcome (1018). A crash
    // before the put leaves the outcome stored (reconcile settles it again, the release a
    // no-op); after it, recovery reports the round (#takeReported takes a record still
    // waiting) and resumes SEPA.
    const step = await this.#outcome(w.file, w.plan, w.accepted, outcome)
    const round: Round = { id: randomUUID(), file: w.file, first: false }
    const entryOf = this.#entryOf(round, 0)
    const plan = this.#planItem(round, [{ i: 0, next: { plan: encodePlan(w.plan), status: json(w.accepted) as unknown as Record<string, unknown> } }])
    const entry = entryOf(step.status)
    const kept = [plan, entry, ...(step.then ? [entryOf.then(step.then, step.status)] : [])]
    await this.ledger.outbox.put(kept)
    if (!(await this.#pending.take(ref, r.scheme))) {
      await this.ledger.outbox.remove(kept.map((k) => k.key))
      await this.opts.outbox.deliver(step.notices ?? [])
      return false
    }
    await this.#flow([{ ...step, i: 0, entry }], round, [plan])
    return true
  }

  /** Payments sent to the rails without a final outcome yet (refs). */
  atRails(): Promise<string[]> { return this.#pending.refs() }

  /**
   * Reconciliation (decision 1002): every payment waiting longer than minAgeMs is settled
   * from its stored outcome (a crash after it was decided), else from what the rails tell
   * (`status`): a final answer through settle, `absent` as unavailable (never taken);
   * accepted and unknown wait. How many it settled.
   */
  async reconcile(o: { minAgeMs?: number } = {}): Promise<number> {
    const minAge = o.minAgeMs ?? 60_000
    const now = this.clock.now().getTime()
    let n = 0
    for (const ref of await this.#pending.refs()) {
      const r = await this.#pending.get(ref)
      if (!r) continue
      let outcome: RailsOutcome | undefined = r.outcome
      if (!outcome) {
        if (!this.rails.status || (r.sentAt !== undefined && now - r.sentAt < minAge)) continue
        const a = await this.rails.status(ref, r.scheme)
        outcome = a.status === 'absent' ? { status: 'unavailable' } : a.status === 'accepted' || a.status === 'unknown' ? undefined : a
      }
      if (outcome && (await this.settle(ref, outcome, r.scheme))) n++
    }
    return n
  }

  /** A waiting payment as JSON (encodePlan). */
  #encode(file: FileRef, p: Plan, accepted: TxStatus): PendingRecord {
    return { ref: p.ref, scheme: p.scheme!, file: fileKey(file), plan: encodePlan(p), accepted: { ...accepted }, sentAt: this.clock.now().getTime() }
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
  async #outcome(file: FileRef, p: Plan, accepted: TxStatus, outcome: RailsOutcome, o: { report?: boolean; entryOf?: EntryOf } = {}): Promise<Step> {
    const { block, tx } = p
    const scheme = p.scheme!
    if (outcome.status === 'settled') {
      const debit = await this.#debitBooking(file.customer, p, scheme)
      const notices = [this.#notice(file.customer, debit), this.opts.outbox.item(SETTLED_KIND, settledRecord(file.customer, file.msgId, debit))]
      // `report`: its pain.002 goes with the commit too, before the camt.054 (decision 999).
      const status: TxStatus = { ...accepted, status: 'ACSC', reason: undefined, scheme }
      if (o.report) notices.unshift(this.opts.outbox.message(await this.#reportMessage(file.customer, file.requestId, { version: file.version, originalMsgId: file.msgId, blocks: [{ pmtInfId: block.pmtInfId!, txs: [status] }] })))
      // `entryOf`: its entry in the round's report goes with the commit (decision 1005).
      const entry = o.entryOf?.(status)
      const b = await this.ledger.commit(p.ref, this.rails.settlementAccount(scheme), [...notices, ...(entry ? [entry] : [])])
      // A repeat: booked by an outcome from the rails' events at the same time, which reported it.
      return b.repeat ? { status, notices: [], reported: true } : { status, notices, entry }
    }
    // SEPA Instant attempted and failed: an automatic choice goes on as SEPA (ACWC first).
    if (outcome.status === 'unavailable' && scheme === 'INST' && p.automatic) {
      const changed: TxStatus = { ...accepted, status: 'ACWC', reason: R.europeanPayment, scheme: 'SEPA' }
      return { status: changed, then: p }
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
  async #incomingOf(file: FileRef, p: Plan, status: IncomingEvent['status']) {
    if (!p.creditorOwner) return
    await this.opts.onIncoming?.({ ref: p.ref, status, account: p.creditorIban ?? normalizeIban(p.tx.creditorOther ?? ''), master: p.creditorAccount!, amount: p.amount, currency: p.currency,
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
    // One report per original file: a round per file (a parked payment comes back from the
    // store as a new object, grouped by its key), planned in the outbox before any payment
    // is claimed (decision 1006); each payment is claimed by its round in #runPlanned.
    const byFile = new Map<string, { file: StoredFile; txs: PlannedTx[] }>()
    for (const ref of new Set(refs)) {
      const r = await this.#parked.get(ref)
      if (!r) continue
      const fk = `${keyOf(r.file.customer)}|${r.file.requestId}|${r.file.msgId}`
      const g = byFile.get(fk) ?? { file: r.file, txs: [] }
      byFile.set(fk, g)
      g.txs.push({ i: g.txs.length, ref, parked: r })
    }
    const decision = { approve, ...(reason !== undefined ? { reason } : {}) }
    const rounds: { round: Round; txs: PlannedTx[]; plan: OutboxItem }[] = []
    for (const g of byFile.values()) {
      // A customer gone from the directory: nothing to decide for or report to (as #unpark).
      const file = await this.#fileOf(g.file)
      if (!file) { for (const t of g.txs) await this.#parked.take((t as { ref: string }).ref); continue }
      const round: Round = { id: randomUUID(), file, first: false }
      rounds.push({ round, txs: g.txs, plan: this.#planItem(round, g.txs, decision) })
    }
    await this.ledger.outbox.put(rounds.map((r) => r.plan))
    const runs: { round: Round; steps: Step[]; plan: OutboxItem }[] = []
    for (const { round, txs, plan } of rounds) {
      const steps: Step[] = []
      for (const t of txs) {
        const s = await this.#runPlanned(round, t, { decision })
        if (s) steps.push(s)
      }
      runs.push({ round, steps, plan })
    }
    for (const { round, steps, plan } of runs) await this.#flow(steps, round, [plan])
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
  async #debitBooking(customer: Customer, p: Plan, scheme: string, creditorBic?: string): Promise<Booking> {
    const { block, tx, ref } = p
    const iban = normalizeIban(block.debtorIban!)
    const v = block.debtorOther ? undefined : (await this.opts.virtual?.resolve(iban))
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
    if (iban && await this.directory.ownerOf(await this.#account(iban))) return this.bank.bic.slice(4, 6).toUpperCase()
    if (tx.creditorBic && tx.creditorBic.length >= 6) return tx.creditorBic.slice(4, 6).toUpperCase()
    return iban ? ibanCountry(iban) : undefined
  }

  /** The ledger account behind an IBAN: a VIBAN's master account, else the IBAN itself. */
  async #account(iban: string) {
    const n = normalizeIban(iban)
    return (await this.opts.virtual?.resolve(n))?.master ?? n
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
    await this.inbox.add(await this.#reportMessage(customer, requestId, r))
  }

  async #reportMessage(customer: Customer, requestId: string, r: StatusReport) {
    // LHV UK answers for a file whose debtor accounts are all held in the UK (decision 843).
    const blocks = r.blocks.map((b) => b.txs[0]?.block).filter((b): b is Block => !!b)
    const accounts = await Promise.all(blocks.map((b) => this.#ledgerAccount(b, customer)))
    const uk = accounts.length > 0 && accounts.every((a) => isUkAccount(a))
    return { customer, type: 'PAYMENT', requestId, body: pain002(r, this.bank.bic, this.clock.now(), { uk }) }
  }

  /** The ledger account a block pays from: a VIBAN's or an agency account's master account, else the account. */
  async #ledgerAccount(b: Block, customer: Customer): Promise<string> {
    const id = normalizeIban(b.debtorIban ?? '')
    if (!b.debtorOther) {
      const v = (await this.opts.virtual?.resolve(id))
      if (v) return v.master
      if (await this.directory.ownerOf(id)) return id
    }
    return (await this.#agencyDebtor(b, customer))?.master ?? id
  }

  /**
   * A booking's outbox item: its statement entry, then (a debit) out of the in-flight
   * amounts, never counted by neither, then the camt.054 (no Message-Request-Id).
   */
  #notice(customer: Customer, b: Booking): OutboxItem {
    return this.opts.outbox.notice(customer, b, b.direction === 'DBIT' ? { inflight: b.servicerRef } : {})
  }

  /** A debit's camt.054 is out (the outbox notice handler): no longer counted against the limits. */
  async notified(ref: string) { await this.#inflight.take(ref) }

  /**
   * A credit from the rails (RailsEvents.credit): booked once per ref, a repeat answers
   * the first result; an account not here is returned AC01 (decision 932).
   */
  received(c: IncomingCredit): Promise<CreditResult> {
    const busy = this.#crediting.get(c.ref)
    if (busy) return busy
    const r = (async () => {
      const seen = await this.#credits.get(c.ref)
      if (seen) return creditResult(seen)
      const result = await this.#receive(c)
      await this.#credits.set(c.ref, result)
      return creditResult(result)
    })()
    this.#crediting.set(c.ref, r)
    // A failure (not a return) may be retried with the same ref: nothing is remembered.
    const done = () => { if (this.#crediting.get(c.ref) === r) this.#crediting.delete(c.ref) }
    r.then(done, done)
    return r
  }

  async #receive(c: IncomingCredit): Promise<CreditRecord> {
    const iban = normalizeIban(c.iban)
    if (!(await this.opts.virtual?.resolve(iban)) && !await this.directory.ownerOf(iban) && !(await this.#agency(iban)).length) {
      return { status: 'returned', code: 'AC01', reason: R.accountNumber }
    }
    // Keyed by the scheme's ref: a crash after the booking and before #credits remembers it
    // books nothing twice when the credit comes again (decision 995).
    const r = await this.incoming({
      key: `credit:${c.ref}`, iban, amount: c.amount, currency: c.currency, scheme: c.scheme, debtor: c.debtor, remittance: c.remittance,
      reference: c.reference, endToEndId: c.endToEndId, creditorName: c.creditorName,
    })
    if (r.returned) return { status: 'returned', code: r.returned.code, reason: r.returned.reason }
    return {
      status: 'booked', servicerRef: r.servicerRef!,
      booked: {
        account: r.account!, amount: String(c.amount), currency: c.currency, scheme: c.scheme, debtor: c.debtor, endToEndId: c.endToEndId,
        ...(r.party ? { party: JSON.parse(JSON.stringify(r.party)) } : {}),
      },
    }
  }

  /**
   * A recall of a credit from the rails (camt.056, decision 1001): DUPL, TECH and FRAD are
   * returned at once when the funds are there (the account debited, camt.054 DBIT with
   * RtrInf); others need the customer's consent, which Connect cannot ask (NOAS). A repeat
   * answers the first result; a credit is returned once (key `recall:<ref>`).
   */
  async recalled(r: CreditRecall): Promise<RecallResult> {
    const seen = await this.#credits.get(r.ref)
    if (!seen) return { status: 'refused', code: 'NOOR' }
    if (seen.recall) return seen.recall
    if (seen.status === 'returned') return { status: 'refused', code: 'ARDT' }
    const b = seen.booked
    const owner = b && await this.directory.ownerOf(b.account)
    if (!b || !owner) return { status: 'refused', code: 'NOOR' }
    let answer: RecallResult
    if (!AUTOMATIC_RECALLS.has(r.code)) answer = { status: 'refused', code: 'NOAS' }
    else {
      const ref = servicerRef()
      const amount = BigInt(b.amount)
      const notices = [this.#notice(owner, {
        account: b.account, virtual: b.party, owner: { name: owner.name, code: owner.code }, direction: 'DBIT', amount, currency: b.currency,
        servicerRef: ref, scheme: b.scheme, bookedAt: this.clock.now(), endToEndId: b.endToEndId,
        counterparty: { name: codePage(b.debtor.name), iban: b.debtor.iban ? normalizeIban(b.debtor.iban) : undefined, account: b.debtor.account, bic: b.debtor.bic },
        bankTxCode: { family: 'RCDT', subFamily: 'RRTN' }, returnInfo: { code: r.code, additional: [r.recallRef, seen.servicerRef] },
      })]
      try {
        const t = await this.ledger.transfer({ ref, key: `recall:${r.ref}`, from: b.account, to: this.rails.settlementAccount(b.scheme), amount, currency: b.currency }, notices)
        if (!t.repeat) await this.opts.outbox.deliver(notices)
        answer = { status: 'returned', servicerRef: t.ref }
      } catch (e) {
        if (!(e instanceof InsufficientFunds)) throw e
        // Not remembered: the funds may come, and the recall again.
        return { status: 'refused', code: 'AM04' }
      }
    }
    await this.#credits.replace(r.ref, { ...seen, recall: answer })
    return answer
  }

  /**
   * A payment of ours the rails settled came back (a pacs.004, RailsEvents.paymentReturned,
   * decision 1014): the amount booked back from the scheme's settlement account to the
   * account debited (a VIBAN's or agency account's master, with that party), key
   * `return:<ref>`, camt.054 CRDT with RvslInd true and RtrInf (NARR, the return code,
   * `ORIG:<ref>`) as LHV's return sample. Once per payment: a repeat (or a second return)
   * books nothing and answers `applied: false` with the first return's AcctSvcrRef.
   * False also for a ref the rails did not settle (unknown, waiting, rejected), another
   * scheme, another currency, or an amount above the payment's.
   */
  async returned(r: PaymentReturn): Promise<PaymentReturnResult> {
    const seen = (await this.#settled.get(r.ref)) ?? (await this.#settledBefore(r.ref))
    if (!seen || (r.scheme !== undefined && r.scheme !== seen.scheme)) return { applied: false }
    if (seen.returned) return { applied: false, servicerRef: seen.returned.servicerRef }
    const amount = r.amount ?? BigInt(seen.amount)
    if (amount <= 0n || amount > BigInt(seen.amount) || (r.currency !== undefined && r.currency !== seen.currency)) {
      console.warn(`rails: return ${r.returnRef} of payment ${r.ref} (${r.amount ?? ''} ${r.currency ?? ''}) does not fit ${seen.amount} ${seen.currency}; ignored`)
      return { applied: false }
    }
    const customer = await this.directory.get(seen.customer)
    if (!customer) return { applied: false }
    const ref = servicerRef()
    const notices = [this.#notice(customer, {
      account: seen.account, virtual: seen.party, owner: { name: customer.name, code: customer.code }, direction: 'CRDT', amount, currency: seen.currency,
      servicerRef: ref, scheme: seen.scheme, bookedAt: this.clock.now(), pmtInfId: seen.pmtInfId, instrId: seen.instrId, endToEndId: seen.endToEndId,
      counterparty: seen.counterparty, reversal: true, returnInfo: { code: 'NARR', additional: [r.code, `ORIG:${r.ref}`] },
    })]
    const t = await this.ledger.transfer({ ref, key: `return:${r.ref}`, from: this.rails.settlementAccount(seen.scheme), to: seen.account, amount, currency: seen.currency }, notices)
    if (!t.repeat) await this.opts.outbox.deliver(notices)
    // Of two returns at once one stores its answer; the other answers the stored one.
    const returned = { returnRef: r.returnRef, code: r.code, amount: amount.toString(), servicerRef: t.ref }
    if (await this.#settled.replace(r.ref, { ...seen, returned }, seen)) return { applied: true, servicerRef: t.ref }
    const now = await this.#settled.get(r.ref)
    return { applied: false, servicerRef: now?.returned?.servicerRef ?? t.ref }
  }

  /**
   * The record of a payment settled with no `payment-settled` record (before decision 1014,
   * or forgotten past the bound), derived from its debit's journal entry (decision 1020):
   * the camt.054 DBIT the settlement's commit wrote, the booking whole (account, VIBAN or
   * agency party, amount, currency, scheme, PmtInfId, InstrId, EndToEndId, creditor). Only
   * a payment the rails settled: a debit of a scheme the rails settle with no bank
   * transaction code or return information (a recall's debit, a direct debit, Bacs and FX
   * all have one; an internal payment is INTERNAL). The customer is the account's owner;
   * the MsgId is not in the entry and stays absent. `add`ed, so of two at once (also in
   * two emulators) one record is kept and both go on with it, the return then once by its
   * compare-and-set as for a record kept at settlement.
   */
  async #settledBefore(ref: string): Promise<SettledRecord | undefined> {
    const d = (await this.opts.journal?.byRef(ref))?.find((e) => e.direction === 'DBIT' && (RAILS_SCHEMES as readonly string[]).includes(e.scheme) && !e.bankTxCode && !e.returnInfo && !e.reversal && !e.mandateId)
    const customer = d && await this.directory.ownerOf(d.account)
    if (!d || !customer) return undefined
    const record = settledRecord(customer, undefined, d)
    return (await this.#settled.add(ref, record)) ? record : this.#settled.get(ref)
  }

  /** An incoming credit from outside (the simulator's SEPA / SEPA Instant credit). */
  async incoming(p: { iban: string; amount: bigint; currency: string; scheme: string; debtor: { name?: string; iban?: string; bic?: string; /** A non-IBAN account (Bacs: sort code + account number). */ account?: string }; remittance?: string; reference?: string; endToEndId?: string; /** Reuse a reference (a held payment, decision 712). */ ref?: string; /** The booking key, default the ref (decision 995). */ key?: string; /** The creditor's name as the payment gives it. */ creditorName?: string
    /** The sender's references, shown in Refs as the G use case 7 sample (decision 847). */ pmtInfId?: string; instrId?: string }) {
    const iban = normalizeIban(p.iban)
    const v = (await this.opts.virtual?.resolve(iban))
    // To a VIBAN that is not ACTIVE: returned to the sender, nothing booked or notified.
    if (v && v.status !== 'ACTIVE') {
      await this.opts.onIncoming?.({ ref: p.ref ?? servicerRef(), status: 'Rejected', account: iban, master: v.master, amount: p.amount, currency: p.currency,
        debtor: { name: p.debtor.name, iban: p.debtor.iban ? normalizeIban(p.debtor.iban) : undefined } })
      return { returned: inactiveCreditor(v) }
    }
    // To an agency account: on its master account, refused when CLOSED, and when INST_RESTRICTED for SEPA Instant (decision 835).
    const a = !v && !await this.directory.ownerOf(iban) ? (await this.#agency(iban))[0] : undefined
    if (a && !receivable(a, { instant: p.scheme === 'INST' })) {
      await this.opts.onIncoming?.({ ref: p.ref ?? servicerRef(), status: 'Rejected', account: iban, master: a.master, amount: p.amount, currency: p.currency,
        debtor: { name: p.debtor.name, iban: p.debtor.iban ? normalizeIban(p.debtor.iban) : undefined } })
      return { returned: a.status === 'CLOSED' ? { reason: R.creditorClosed, code: 'AC04' } : { reason: R.instantForbidden, code: 'AG01' } }
    }
    const account = v?.master ?? a?.master ?? iban
    const owner = await this.directory.ownerOf(account)
    if (!owner) throw new Error(`no account ${iban}`)
    const ref = p.ref ?? servicerRef()
    const party = v ? virtualParty(v) : a && agencyParty(a, iban, p.creditorName)
    const notices = [this.#notice(owner, {
      account, virtual: party, owner: { name: owner.name, code: owner.code }, direction: 'CRDT', amount: p.amount, currency: p.currency,
      servicerRef: ref, scheme: p.scheme, bookedAt: this.clock.now(), endToEndId: p.endToEndId, pmtInfId: p.pmtInfId, instrId: p.instrId,
      counterparty: { name: codePage(p.debtor.name), iban: p.debtor.iban ? normalizeIban(p.debtor.iban) : undefined, account: p.debtor.account, bic: p.debtor.bic },
      remittance: codePage(p.remittance), reference: codePage(p.reference),
    })]
    const b = await this.ledger.transfer({ ref, key: p.key, from: this.rails.settlementAccount(p.scheme), to: account, amount: p.amount, currency: p.currency }, notices)
    if (!b.repeat) await this.opts.outbox.deliver(notices)
    return { servicerRef: b.ref, account, party }
  }
}

/**
 * What a return of a settled external payment needs (decision 1014), from its debit's
 * booking; JSON, the amount a decimal string of minor units. `returned` once it came back.
 * No `msgId` when derived from the journal (decision 1020): the entry does not carry it.
 */
type SettledRecord = {
  ref: string; customer: { code: string; country: string }; account: string; party?: Booking['virtual']
  amount: string; currency: string; scheme: Scheme; msgId?: string; pmtInfId?: string; instrId?: string; endToEndId?: string
  counterparty: Booking['counterparty']
  returned?: { returnRef: string; code: string; amount: string; servicerRef: string }
}
const settledRecord = (customer: CustomerKey, msgId: string | undefined, d: Booking): SettledRecord => JSON.parse(JSON.stringify({
  ref: d.servicerRef, customer: { code: customer.code, country: customer.country }, account: d.account, party: d.virtual,
  amount: d.amount.toString(), currency: d.currency, scheme: d.scheme, msgId,
  pmtInfId: d.pmtInfId, instrId: d.instrId, endToEndId: d.endToEndId, counterparty: d.counterparty,
}))

/** Recall reasons the bank returns without asking the customer (decision 1001). */
const AUTOMATIC_RECALLS = new Set(['DUPL', 'TECH', 'FRAD'])

/** What the credits' store keeps of a credit from the rails (JSON: the amount a decimal string of minor units). */
type CreditRecord = CreditResult & {
  booked?: {
    account: string; amount: string; currency: string; scheme: Scheme; debtor: IncomingCredit['debtor']; endToEndId?: string
    /** The VIBAN or agency account the credit's camt.054 named (account its master), for the recall's debit (decision 1015). */
    party?: Booking['virtual']
  }
  recall?: RecallResult
}
/** The answer to the scheme: the result without what is kept for a recall. */
const creditResult = (r: CreditRecord): CreditResult =>
  r.status === 'booked' ? { status: 'booked', servicerRef: r.servicerRef } : { status: 'returned', code: r.code, reason: r.reason }

/** The VIBAN as the own party of a master account entry (camt.054 Dbtr / Cdtr). */
const virtualParty = (v: VirtualAccount) => ({ iban: v.iban, name: v.holder?.name, country: v.holder?.country, address: v.holder?.address })
/** An agency account as the own party of a master account entry: as addressed (IBAN or Othr/Id), the synchronised name first (decision 832). */
const agencyParty = (a: AgencyAccount, id: string, name?: string) => {
  const n = normalizeIban(id)
  return { ...(/^[A-Z]{2}[0-9]{2}/.test(n) ? { iban: n } : { account: n }), name: a.name ?? name, agency: true }
}

export { XmlSyntaxError }
