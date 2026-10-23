// Processing of a payment initiation, from the posted XML to the messages it leaves
// in the inbox:
//
//   file-level checks fail  → one pain.002, group RJCT with the documented reason
//   per payment:
//     invalid / no funds    → RJCT in the first pain.002
//     internal (both accounts here) → booked at once: ACSC in the first pain.002,
//                             camt.054 DBIT to the debtor, camt.054 CRDT to the creditor
//     external              → funds reserved, ACSP in the first pain.002; then the rails
//                             answer: settled → pain.002 ACSC + camt.054 DBIT,
//                             rejected → pain.002 RJCT and the reservation released
//
// Processing is synchronous: every message exists by the time POST /payment returns.
import type { Clock } from '../clock.js'
import { keyOf, type Customer, type Directory } from '../directory.js'
import { ibanChecksumOk, ibanCountry, isSepaCountry, normalizeIban } from '../iban.js'
import { servicerRef } from '../ids.js'
import type { Inbox } from '../inbox.js'
import { InsufficientFunds, toMinor, type Ledger } from '../ledger.js'
import type { Rails, Scheme } from '../rails.js'
import { parseXml, XmlSyntaxError } from '../xml.js'
import { camt054, type Booking } from './camt054.js'
import { decimalEq, decimalSum, painVersion, readPain001, structuralProblem, type Block, type PaymentFile, type Tx } from './pain001.js'
import { aggregate, pain002, type StatusReport, type TxStatus } from './pain002.js'
import type { XsdValidator } from './xsd.js'
import type { VirtualAccount, VirtualAccounts } from '../viban/registry.js'

export interface Bank { bic: string; name: string }

export interface EngineOptions {
  /** Reject creditor IBANs whose check digits are wrong (default true). */
  strictIban?: boolean
  /** pain.001.001.03 is refused from this day on (the bank's announced end of support). */
  pain00103Until?: string
  xsd?: XsdValidator
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
}

/** Why a payment to a VIBAN that is not ACTIVE is refused: closed for good, or for now. */
export const inactiveCreditor = (v: VirtualAccount) =>
  v.status === 'CLOSED' || v.status === 'REJECTED' ? { reason: R.creditorClosed, code: 'AC04' } : { reason: R.temporarilyClosed, code: 'AC06' }

const sameName = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase()


export class PaymentEngine {
  #seenMsgIds = new Set<string>()
  constructor(
    private directory: Directory, private ledger: Ledger, private rails: Rails, private inbox: Inbox,
    private clock: Clock, private bank: Bank, private opts: EngineOptions = {},
  ) {}

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
    const first: StatusReport = { version: f.version, originalMsgId: f.msgId!, blocks: [] }
    const later: { status: TxStatus; settle: () => Promise<TxStatus | undefined> }[] = []
    const bookings: { customer: Customer; booking: Booking }[] = []

    for (const block of f.blocks) {
      const statuses: TxStatus[] = []
      for (const tx of block.txs) {
        const r = await this.#payment(block, tx, customer, bookings)
        statuses.push(r.status)
        if (r.settle) later.push({ status: r.status, settle: r.settle })
      }
      first.blocks.push({ pmtInfId: block.pmtInfId!, status: aggregate(statuses.map((s) => s.status)), txs: statuses })
    }
    first.groupStatus = aggregate(first.blocks.flatMap((b) => b.txs.map((t) => t.status)))
    this.#report(customer, requestId, first)
    for (const b of bookings) this.#notify(b.customer, b.booking)

    // The rails' answers: one more report for the payments that went outside.
    if (later.length === 0) return
    const second: StatusReport = { version: f.version, originalMsgId: f.msgId!, blocks: [] }
    const settledBookings: { customer: Customer; booking: Booking }[] = []
    for (const l of later) {
      const s = await l.settle()
      if (!s) continue
      let b = second.blocks.find((x) => x.pmtInfId === s.block.pmtInfId)
      if (!b) second.blocks.push((b = { pmtInfId: s.block.pmtInfId!, txs: [] }))
      b.txs.push(s)
      if (s.status === 'ACSC') settledBookings.push({ customer, booking: this.#debitBooking(customer, s.block, s.tx, s.servicerRef!, s.scheme!) })
    }
    this.#report(customer, requestId, second)
    for (const b of settledBookings) this.#notify(b.customer, b.booking)
  }

  /** One payment: validation, scheme selection, booking or reservation. */
  async #payment(block: Block, tx: Tx, customer: Customer, bookings: { customer: Customer; booking: Booking }[]):
    Promise<{ status: TxStatus; settle?: () => Promise<TxStatus | undefined> }> {
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
    const ref = servicerRef()
    if (creditorOwner) {
      // Internal payment: both accounts are here; booked at once.
      try {
        await this.ledger.transfer({ ref, from: debtorAccount, to: creditorAccount!, amount, currency: tx.currency! })
      } catch (e) {
        if (e instanceof InsufficientFunds) return rj(R.funds, 'INTERNAL')
        throw e
      }
      bookings.push({ customer, booking: this.#debitBooking(customer, block, tx, ref, 'INTERNAL', this.bank.bic) })
      const creditRef = servicerRef()
      bookings.push({ customer: creditorOwner, booking: {
        account: creditorAccount!, virtual: creditorV && virtualParty(creditorV), owner: { name: creditorOwner.name, code: creditorOwner.code }, direction: 'CRDT',
        amount, currency: tx.currency!, servicerRef: creditRef, scheme: 'INTERNAL', bookedAt: this.clock.now(),
        instrId: tx.instrId, endToEndId: tx.endToEndId,
        counterparty: { name: block.debtorName ?? customer.name, iban: debtorIban, bic: this.bank.bic, code: customer.code },
        remittance: tx.ustrd, reference: tx.reference,
      } })
      return { status: { block, tx, status: 'ACSC', servicerRef: ref, scheme: 'INTERNAL', creditorBic: this.bank.bic } }
    }

    if (creditorIban && this.opts.strictIban !== false && !ibanChecksumOk(creditorIban)) return rj(R.accountNumber)
    const chosen = this.#scheme(tx.scheme ?? block.scheme, tx.currency!, creditorIban)
    if ('reject' in chosen) return rj(chosen.reject)
    const scheme = chosen.scheme
    try {
      await this.ledger.reserve({ ref, account: debtorAccount, amount, currency: tx.currency! })
    } catch (e) {
      if (e instanceof InsufficientFunds) return rj(R.funds, scheme)
      throw e
    }
    const accepted: TxStatus = { block, tx, status: 'ACSP', servicerRef: ref, scheme }
    const settle = async (): Promise<TxStatus> => {
      const outcome = await this.rails.send({
        ref, scheme, amount, currency: tx.currency!,
        debtor: { name: block.debtorName ?? customer.name, iban: debtorIban },
        creditor: { name: tx.creditorName, iban: creditorIban, account: tx.creditorOther, bic: tx.creditorBic },
        endToEndId: tx.endToEndId, remittance: tx.ustrd,
      })
      if (outcome.status === 'settled') {
        await this.ledger.commit(ref, this.rails.settlementAccount(scheme))
        return { ...accepted, status: 'ACSC' }
      }
      await this.ledger.release(ref)
      return { ...accepted, status: 'RJCT', reason: outcome.reason }
    }
    return { status: accepted, settle }
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
