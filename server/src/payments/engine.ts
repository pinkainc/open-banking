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
//     manual review name    → funds reserved, ACSP, then PDNG "In manual review" until
//                             /_sim decides
//
// Processing is synchronous: every message exists by the time POST /payment returns.
import { BoundedSet, DEFAULT_BOUNDS, type Bounds } from '../bounded.js'
import type { Clock } from '../clock.js'
import { keyOf, type Customer, type Directory } from '../directory.js'
import { ibanChecksumOk, ibanCountry, isSepaCountry, normalizeIban } from '../iban.js'
import { servicerRef } from '../ids.js'
import type { Inbox } from '../inbox.js'
import { InsufficientFunds, toMinor, type Ledger } from '../ledger.js'
import type { Rails, Scheme } from '../rails.js'
import { parseXml, XmlSyntaxError } from '../xml.js'
import { camt054, type Booking } from './camt054.js'
import { decimalEq, decimalSum, painVersion, readPain001, structuralProblem, type Block, type PainVersion, type PaymentFile, type Tx } from './pain001.js'
import { aggregate, pain002, type StatusReport, type TxStatus } from './pain002.js'
import type { XsdValidator } from './xsd.js'
import type { VirtualAccount, VirtualAccounts } from '../viban/registry.js'

export interface Bank { bic: string; name: string }

export interface EngineOptions {
  /** How many accepted MsgIds are remembered (decision 504). */
  msgIds?: Bounds
  /** Reject creditor IBANs whose check digits are wrong (default true). */
  strictIban?: boolean
  /** pain.001.001.03 is refused from this day on (the bank's announced end of support). */
  pain00103Until?: string
  xsd?: XsdValidator
  /** Called with every booking on a customer account (the statement journal listens here). */
  onBooking?: (customer: Customer, b: Booking) => void
  /** Virtual IBANs: booked on their master account (L3). */
  virtual?: VirtualAccounts
}

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
  debtorName: 'Invalid debtor’s name.',
  creditorClosed: 'Creditor account is closed.',
  temporarilyClosed: 'Account temporarily closed.',
  requestedByCustomer: 'Requested by customer.',
  regulatory: 'Payment declined. Regulatory reasons',
  manualReview: 'In manual review',
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
  /** External payments only; `automatic` when no scheme was requested. */
  scheme?: Scheme; automatic?: boolean
}
type ParkedKind = 'SCA' | 'REVIEW'
export interface ParkedPayment {
  ref: string; kind: ParkedKind; customer: { code: string; country: string }; msgId: string
  pmtInfId?: string; instrId?: string; endToEndId?: string; amount: string; currency: string; creditor: { name?: string; iban?: string }
}

const sameName = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase()


export class PaymentEngine {
  #seenMsgIds: BoundedSet<string>
  #parked = new Map<string, { kind: ParkedKind; file: FileRef; plan: Plan; status: TxStatus }>()
  constructor(
    private directory: Directory, private ledger: Ledger, private rails: Rails, private inbox: Inbox,
    private clock: Clock, private bank: Bank, private opts: EngineOptions = {},
  ) { this.#seenMsgIds = new BoundedSet(clock, opts.msgIds ?? DEFAULT_BOUNDS.msgIds) }

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
    const groupReason = this.#fileProblem(file, customer)
    if (groupReason) return reject(groupReason, version)
    this.#seenMsgIds.add(`${keyOf(customer)}|${file.msgId}`)
    await this.#process(file, customer, requestId)
  }

  #fileProblem(f: PaymentFile, customer: Customer): string | undefined {
    if (this.#seenMsgIds.has(`${keyOf(customer)}|${f.msgId}`)) return R.duplicateMessage
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
      const owner = this.directory.ownerOf(this.#account(b.debtorIban!))
      if (!owner) return R.senderAccount(normalizeIban(b.debtorIban!))
      if (keyOf(owner) !== keyOf(customer)) return R.noRights
    }
    return undefined
  }

  async #process(f: PaymentFile, customer: Customer, requestId: string) {
    const file: FileRef = { customer, requestId, version: f.version, msgId: f.msgId! }
    const pending = customer.payments === 'PENDING'
    const steps: Step[] = []
    for (const block of f.blocks) {
      for (const tx of block.txs) {
        const c = this.#check(block, tx, customer)
        if ('status' in c) steps.push({ status: c.status })
        else if (pending) steps.push({ status: this.#park('SCA', file, c.plan) })
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
      this.#report(file.customer, file.requestId, r)
      for (const s of round) for (const n of s.notices ?? []) this.#notify(n.customer, n.booking)
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
  #check(block: Block, tx: Tx, customer: Customer): { status: TxStatus } | { plan: Plan } {
    const rj = (reason: string, scheme?: string): { status: TxStatus } => ({ status: { block, tx, status: 'RJCT', reason, scheme } })
    let amount: bigint
    try { amount = toMinor(tx.amount!) } catch { return rj(R.amount) }
    if (amount <= 0n) return rj(R.amount)
    if (!tx.ustrd && !tx.reference) return rj(R.remittance)
    if (!tx.creditorName) return rj(R.creditorName)
    const debtorIban = normalizeIban(block.debtorIban!)
    const creditorIban = tx.creditorIban ? normalizeIban(tx.creditorIban) : undefined
    if (creditorIban && creditorIban === debtorIban) return rj(R.sameAccount)
    // A VIBAN debtor must be ACTIVE and named as its holder; the master account pays.
    const debtorV = this.opts.virtual?.resolve(debtorIban)
    if (debtorV && debtorV.status !== 'ACTIVE') return rj(R.debtorInactive)
    if (debtorV && !sameName(block.debtorName, debtorV.holder?.name)) return rj(R.debtorName)
    const debtorAccount = debtorV?.master ?? debtorIban
    // A VIBAN creditor is credited on its master account, unless it is not ACTIVE.
    const creditorV = creditorIban ? this.opts.virtual?.resolve(creditorIban) : undefined
    if (creditorV && creditorV.status !== 'ACTIVE') return rj(inactiveCreditor(creditorV).reason, 'INTERNAL')
    const creditorAccount = creditorV?.master ?? creditorIban
    const creditorOwner = creditorAccount ? this.directory.ownerOf(creditorAccount) : undefined
    const base = { block, tx, amount, currency: tx.currency!, debtorIban, debtorAccount, creditorIban, creditorAccount, creditorV, ref: servicerRef() }
    if (creditorOwner) return { plan: { ...base, creditorOwner } }

    if (creditorIban && this.opts.strictIban !== false && !ibanChecksumOk(creditorIban)) return rj(R.accountNumber)
    const requested = tx.scheme ?? block.scheme
    const chosen = this.#scheme(requested, tx.currency!, creditorIban)
    if ('reject' in chosen) return rj(chosen.reject)
    return { plan: { ...base, scheme: chosen.scheme, automatic: requested !== 'INST' && requested !== 'SEPA' && requested !== 'TARGET2' } }
  }

  /** A checked payment goes ahead: funds, then booking (internal) or the rails (external). */
  async #execute(file: FileRef, p: Plan): Promise<Step> {
    const { block, tx } = p
    const rj = (reason: string, scheme?: string): Step => ({ status: { block, tx, status: 'RJCT', reason, scheme } })
    const scheme = p.scheme ?? 'INTERNAL'
    const review = MANUAL_REVIEW.has(normName(tx.creditorName))
    if (p.creditorOwner && !review) {
      try {
        await this.ledger.transfer({ ref: p.ref, from: p.debtorAccount, to: p.creditorAccount!, amount: p.amount, currency: p.currency })
      } catch (e) {
        if (e instanceof InsufficientFunds) return rj(R.funds, scheme)
        throw e
      }
      return this.#internalBooked(file, p)
    }
    try {
      await this.ledger.reserve({ ref: p.ref, account: p.debtorAccount, amount: p.amount, currency: p.currency })
    } catch (e) {
      if (e instanceof InsufficientFunds) return rj(R.funds, scheme)
      throw e
    }
    const accepted: TxStatus = { block, tx, status: 'ACSP', servicerRef: p.ref, scheme, ...(p.creditorOwner ? { creditorBic: this.bank.bic } : {}) }
    // Manual review (sanctions screening): accepted first, then PDNG until /_sim decides.
    if (review) return { status: accepted, next: async () => ({ status: this.#park('REVIEW', file, p, { ...accepted, status: 'PDNG', reason: R.manualReview }) }) }
    return { status: accepted, next: () => this.#rails(file, p, accepted) }
  }

  /** Booked internally: ACSC, camt.054 DBIT to the debtor and CRDT to the creditor. */
  #internalBooked(file: FileRef, p: Plan): Step {
    const { block, tx, creditorOwner, creditorV } = p
    const customer = file.customer
    const notices: Notice[] = [{ customer, booking: this.#debitBooking(customer, block, tx, p.ref, 'INTERNAL', this.bank.bic) }]
    notices.push({ customer: creditorOwner!, booking: {
      account: p.creditorAccount!, virtual: creditorV && virtualParty(creditorV), owner: { name: creditorOwner!.name, code: creditorOwner!.code }, direction: 'CRDT',
      amount: p.amount, currency: p.currency, servicerRef: servicerRef(), scheme: 'INTERNAL', bookedAt: this.clock.now(),
      instrId: tx.instrId, endToEndId: tx.endToEndId,
      counterparty: { name: block.debtorName ?? customer.name, iban: p.debtorIban, bic: this.bank.bic, code: customer.code },
      remittance: tx.ustrd, reference: tx.reference,
    } })
    return { status: { block, tx, status: 'ACSC', servicerRef: p.ref, scheme: 'INTERNAL', creditorBic: this.bank.bic }, notices }
  }

  /** The rails' answer about a reserved external payment. */
  async #rails(file: FileRef, p: Plan, accepted: TxStatus): Promise<Step> {
    const { block, tx } = p
    const scheme = p.scheme!
    const outcome = await this.rails.send({
      ref: p.ref, scheme, amount: p.amount, currency: p.currency,
      debtor: { name: block.debtorName ?? file.customer.name, iban: p.debtorIban },
      creditor: { name: tx.creditorName, iban: p.creditorIban, account: tx.creditorOther, bic: tx.creditorBic },
      endToEndId: tx.endToEndId, remittance: tx.ustrd,
    })
    if (outcome.status === 'settled') {
      await this.ledger.commit(p.ref, this.rails.settlementAccount(scheme))
      return {
        status: { ...accepted, status: 'ACSC', reason: undefined, scheme },
        notices: [{ customer: file.customer, booking: this.#debitBooking(file.customer, block, tx, p.ref, scheme) }],
      }
    }
    await this.ledger.release(p.ref)
    return { status: { ...accepted, status: 'RJCT', reason: outcome.reason, scheme } }
  }

  /** Parks a payment until /_sim decides: waiting for SCA in the internet bank, or in manual review. */
  #park(kind: ParkedKind, file: FileRef, plan: Plan, status: TxStatus = { block: plan.block, tx: plan.tx, status: 'PDNG', servicerRef: plan.ref, scheme: plan.scheme ?? 'INTERNAL' }): TxStatus {
    this.#parked.set(plan.ref, { kind, file, plan, status })
    return status
  }

  /** Payments waiting for a decision (the internet bank's pending list, manual review). */
  parked(): ParkedPayment[] {
    return [...this.#parked.entries()].map(([ref, p]) => ({
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
    const unknown = refs.filter((r) => !this.#parked.has(r))
    if (unknown.length) return unknown
    const byFile = new Map<FileRef, Step[]>()
    for (const ref of refs) {
      const p = this.#parked.get(ref)
      if (!p) continue // listed twice
      this.#parked.delete(ref)
      const steps = byFile.get(p.file) ?? []
      byFile.set(p.file, steps)
      const { block, tx } = p.plan
      if (p.kind === 'SCA') {
        steps.push(approve ? await this.#execute(p.file, p.plan) : { status: { block, tx, status: 'RJCT', reason: reason ?? R.requestedByCustomer, scheme: p.status.scheme } })
      } else if (!approve) {
        await this.ledger.release(ref)
        steps.push({ status: { ...p.status, status: 'RJCT', reason: reason ?? R.regulatory } })
      } else if (p.plan.creditorOwner) {
        await this.ledger.commit(ref, p.plan.creditorAccount!)
        steps.push(this.#internalBooked(p.file, p.plan))
      } else {
        steps.push(await this.#rails(p.file, p.plan, { ...p.status, status: 'ACSP', reason: undefined }))
      }
    }
    for (const [file, steps] of byFile) await this.#flow(file, steps, false)
    return []
  }

  /** Scheme selection as documented: requested scheme if possible, else automatic. */
  #scheme(requested: string | undefined, currency: string, creditorIban?: string): { scheme: Scheme } | { reject: string } {
    const sepa = !!creditorIban && isSepaCountry(ibanCountry(creditorIban))
    if (requested === 'INST' || requested === 'SEPA' || requested === 'TARGET2') {
      if (currency !== 'EUR') return { reject: R.currency }
      if (!sepa && requested !== 'TARGET2') return { reject: R.declined }
      if (requested === 'INST' && !this.rails.instantReachable(creditorIban!)) return { reject: 'Instant payment forbidden, try European payment.' }
      return { scheme: requested }
    }
    if (currency === 'EUR' && sepa) return { scheme: this.rails.instantReachable(creditorIban!) ? 'INST' : 'SEPA' }
    return { scheme: 'SWIFT' }
  }

  #debitBooking(customer: Customer, block: Block, tx: Tx, ref: string, scheme: string, creditorBic?: string): Booking {
    const iban = normalizeIban(block.debtorIban!)
    const v = this.opts.virtual?.resolve(iban)
    return {
      account: v?.master ?? iban, virtual: v && virtualParty(v), owner: { name: customer.name, code: customer.code }, direction: 'DBIT',
      amount: toMinor(tx.amount!), currency: tx.currency!, servicerRef: ref, scheme, bookedAt: this.clock.now(),
      pmtInfId: block.pmtInfId, instrId: tx.instrId, endToEndId: tx.endToEndId,
      counterparty: { name: tx.creditorName, iban: tx.creditorIban ? normalizeIban(tx.creditorIban) : undefined, account: tx.creditorOther, bic: creditorBic ?? tx.creditorBic },
      remittance: tx.ustrd, reference: tx.reference,
    }
  }

  /** The ledger account behind an IBAN: a VIBAN's master account, else the IBAN itself. */
  #account(iban: string) {
    const n = normalizeIban(iban)
    return this.opts.virtual?.resolve(n)?.master ?? n
  }

  #report(customer: Customer, requestId: string, r: StatusReport) {
    this.inbox.add({ customer, type: 'PAYMENT', requestId, body: pain002(r, this.bank.bic, this.clock.now()) })
  }

  #notify(customer: Customer, b: Booking) {
    this.opts.onBooking?.(customer, b)
    // Notifications carry no Message-Request-Id.
    this.inbox.add({ customer, type: 'CREDIT_DEBIT_NOTIFICATION', body: camt054(b, customer.camt054, this.bank) })
  }

  /** An incoming credit from outside (the simulator's SEPA / SEPA Instant credit). */
  async incoming(p: { iban: string; amount: bigint; currency: string; scheme: string; debtor: { name?: string; iban?: string; bic?: string }; remittance?: string; reference?: string; endToEndId?: string }) {
    const iban = normalizeIban(p.iban)
    const v = this.opts.virtual?.resolve(iban)
    // To a VIBAN that is not ACTIVE: returned to the sender, nothing booked or notified.
    if (v && v.status !== 'ACTIVE') return { returned: inactiveCreditor(v) }
    const account = v?.master ?? iban
    const owner = this.directory.ownerOf(account)
    if (!owner) throw new Error(`no account ${iban}`)
    const ref = servicerRef()
    await this.ledger.transfer({ ref, from: this.rails.settlementAccount(p.scheme), to: account, amount: p.amount, currency: p.currency })
    this.#notify(owner, {
      account, virtual: v && virtualParty(v), owner: { name: owner.name, code: owner.code }, direction: 'CRDT', amount: p.amount, currency: p.currency,
      servicerRef: ref, scheme: p.scheme, bookedAt: this.clock.now(), endToEndId: p.endToEndId,
      counterparty: { name: p.debtor.name, iban: p.debtor.iban ? normalizeIban(p.debtor.iban) : undefined, bic: p.debtor.bic },
      remittance: p.remittance, reference: p.reference,
    })
    return { servicerRef: ref }
  }
}

/** The VIBAN as the own party of a master account entry (camt.054 Dbtr / Cdtr). */
const virtualParty = (v: VirtualAccount) => ({ iban: v.iban, name: v.holder?.name, country: v.holder?.country, address: v.holder?.address })

export { XmlSyntaxError }
