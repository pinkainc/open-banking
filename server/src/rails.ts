// Payment schemes behind the bank. The engine hands an outgoing payment to the rails
// and books it when the rails report settlement. The simulator settles everything at
// once unless told to reject payments to a given account; real bridges (SEPA, SEPA
// Instant, UK Faster Payments: HttpRails, docs/rails-bridge-protocol.md) implement the
// same interface.
//
// Real schemes are asynchronous (decision 930): `send` may answer `accepted` (pending at
// the scheme) and the final outcome arrives later through the RailsEvents the engine
// registers with `listen`, as do credits from the scheme to accounts here.
import { keepLast } from './bounded.js'

/** FAST: UK Faster Payments (decision 840). */
export type Scheme = 'SEPA' | 'INST' | 'SWIFT' | 'TARGET2' | 'FAST'
/** Every scheme the rails send and settle. */
export const SCHEMES: readonly Scheme[] = ['SEPA', 'INST', 'SWIFT', 'TARGET2', 'FAST']

export interface OutgoingPayment {
  ref: string
  scheme: Scheme
  amount: bigint
  currency: string
  debtor: { name?: string; iban: string }
  creditor: { name?: string; iban?: string; account?: string; bic?: string }
  endToEndId?: string
  remittance?: string
}

/**
 * `unavailable`: the scheme itself could not take the payment (e.g. SEPA Instant failed
 * after being attempted); the bank may retry it on another scheme.
 */
export type RailsOutcome = { status: 'settled' } | { status: 'rejected'; reason: string } | { status: 'unavailable' }
/**
 * What `send` answers: the final outcome, or `accepted` with the outcome to follow through
 * RailsEvents.outcome, or `unknown` when the rails cannot tell whether they took it (a
 * bridge timeout): it waits as `accepted` and is reconciled (decision 1002).
 */
export type RailsAnswer = RailsOutcome | { status: 'accepted' } | { status: 'unknown' }
/** What `status` answers: as `send`, or `absent` when the rails never took ref + scheme. */
export type RailsStatus = RailsAnswer | { status: 'absent' }

/** Two outcomes are the same: status and, for a rejection, the reason. */
export const sameOutcome = (a: RailsOutcome, b: RailsOutcome) =>
  a.status === b.status && (a.status !== 'rejected' || a.reason === (b as { reason?: string }).reason)

/** A credit from the scheme to an account here (SEPA, SEPA Instant, Faster Payments …). */
export interface IncomingCredit {
  /** The scheme's (bridge's) reference: a credit is booked once per ref. */
  ref: string
  /** The account credited: IBAN, VIBAN, agency account (IBAN or sort code + account number). */
  iban: string
  amount: bigint
  currency: string
  scheme: Scheme
  debtor: { name?: string; iban?: string; bic?: string; account?: string }
  creditorName?: string
  remittance?: string
  reference?: string
  endToEndId?: string
}
/** Booked (with our AcctSvcrRef) or returned to the sender with an ISO reason code. */
export type CreditResult = { status: 'booked'; servicerRef: string } | { status: 'returned'; code: string; reason: string }

/** The payer's bank asks a credit back (camt.056, decision 1001). */
export interface CreditRecall {
  /** The credit's scheme ref, as RailsEvents.credit got it. */
  ref: string
  /** The recall's own reference (camt.056 CxlId). */
  recallRef: string
  /** The recall reason: DUPL, TECH, FRAD (returned at once) or another (needs the customer's consent). */
  code: string
}
/** Returned (pacs.004, our AcctSvcrRef of the debit) or refused (camt.029) with its reason code. */
export type RecallResult = { status: 'returned'; servicerRef: string } | { status: 'refused'; code: string }

/**
 * The scheme returned a payment of ours the rails had settled (a pacs.004 from the
 * creditor's bank, decision 1014).
 */
export interface PaymentReturn {
  /** Our payment's ref, as `send` gave it. */
  ref: string
  /** The attempt's scheme (937: a payment is ref + scheme); optional. */
  scheme?: Scheme
  /** The return's own reference (pacs.004 RtrId). */
  returnRef: string
  /** The return reason: ISO (AC04, MS03 …) or the scheme's own code (Faster Payments 00000001 …). */
  code: string
  /** What came back, at most the payment's amount (charges taken); default the payment's amount. */
  amount?: bigint
  /** The payment's currency when given. */
  currency?: string
}
/**
 * `applied` when booked back now; false for an unknown or not settled payment, another
 * scheme, a wrong amount or currency, or a repeat, which carries the first return's AcctSvcrRef.
 */
export interface PaymentReturnResult { applied: boolean; servicerRef?: string }

/** The event cannot be applied now but must be later (e.g. the funds are not there yet): the bridge retries it. */
export class RailsRetryLater extends Error {}

/** Where the rails deliver what happens later; the engine registers it (Rails.listen). */
export interface RailsEvents {
  /**
   * The final outcome of a payment `send` answered `accepted`. False: unknown ref, already
   * final, another outcome stored first (decision 1003) or another scheme's attempt (ignored).
   */
  outcome(ref: string, outcome: RailsOutcome, scheme?: Scheme): Promise<boolean>
  /** A credit from the scheme; the same ref again answers the first result. */
  credit(c: IncomingCredit): Promise<CreditResult>
  /**
   * A collection the rails settled was returned or refunded by the debtor's bank (an
   * R-transaction after settlement, decision 1000). True when booked back; false for an
   * unknown or not settled collection, or a repeat. Throws RailsRetryLater when it must wait.
   */
  collectionReturned(ref: string, code: string): Promise<boolean>
  /** A recall of a credit received (camt.056, decision 1001); a repeat answers the first result. */
  recall(r: CreditRecall): Promise<RecallResult>
  /** A payment of ours the rails settled came back (pacs.004, decision 1014); a repeat books nothing. */
  paymentReturned(r: PaymentReturn): Promise<PaymentReturnResult>
}

/** A SEPA Direct Debit our creditor sends to a debtor at another bank (L4). */
export interface OutgoingCollection {
  ref: string
  amount: bigint
  currency: string
  creditor: { name?: string; iban: string }
  debtor: { name?: string; iban: string; bic?: string }
  endToEndId: string
  mandateId?: string
  settlementDate: string
}

/** The debtor's bank: settled, or an R-transaction before settlement with a SEPA reason code. */
export type CollectionOutcome = { status: 'settled' } | { status: 'rejected'; code: string }

export interface Rails {
  send(p: OutgoingPayment): Promise<RailsAnswer>
  /** What the rails know of ref + scheme (reconciliation, decision 1002); optional for test doubles. */
  status?(ref: string, scheme: Scheme): Promise<RailsStatus>
  /** Registers the engine's sink for later outcomes and incoming credits (one sink; a second replaces it). */
  listen(events: RailsEvents): void
  /** Is SEPA Instant available to this account? Decides automatic scheme selection. */
  instantReachable(iban: string): Promise<boolean>
  /** The bank's ledger account that outgoing payments of a scheme are booked against. */
  settlementAccount(scheme: Scheme | string): string
  /**
   * Presents a direct debit to the debtor's bank on the settlement date and answers at
   * presentation (decision 933); R-transactions after settlement come later through
   * RailsEvents.collectionReturned (decision 1000).
   */
  collect(c: OutgoingCollection): Promise<CollectionOutcome>
}

/** What SimulatorRails keeps of what it sent and collected (/_sim/rails/…, decision 915). */
export const RAILS_LOG_MAX = 10_000

export class SimulatorRails implements Rails {
  readonly sent: (OutgoingPayment & { outcome: RailsOutcome })[] = []
  readonly collections: (OutgoingCollection & { outcome: CollectionOutcome })[] = []
  #rejects = new Map<string, string>()
  #noInstant = new Set<string>()
  #instantFails = new Set<string>()
  #collectionRejects = new Map<string, string>()
  #events?: RailsEvents
  #deferred = false
  #timeouts = false
  /** Deferred mode: payments answered `accepted` whose outcome is not delivered yet (ref → outcome). */
  readonly held = new Map<string, RailsOutcome>()
  #heldScheme = new Map<string, Scheme>()

  listen(events: RailsEvents) { this.#events = events }
  /**
   * Deferred mode (decision 931): `send` answers `accepted` and keeps the outcome until
   * `deliver`, as a real scheme that settles later. Off by default (immediate outcomes).
   */
  defer(on = true) { this.#deferred = on }
  get deferred() { return this.#deferred }
  /**
   * Timeouts (decision 1002): `send` takes the payment (decides or holds its outcome) and
   * answers `unknown`, as a bridge whose answer was lost; `status` then tells the outcome.
   */
  timeouts(on = true) { this.#timeouts = on }
  get timingOut() { return this.#timeouts }
  async status(ref: string, scheme: Scheme): Promise<RailsStatus> {
    if (this.held.has(ref) && this.#heldScheme.get(ref) === scheme) return { status: 'accepted' }
    const sent = this.#lastSent(ref, scheme)
    return sent ? sent.outcome : { status: 'absent' }
  }
  /**
   * Delivers held outcomes through the engine's events: one ref (optionally with another
   * outcome, e.g. a reject after accept) or all of them, oldest first. Returns how many were applied.
   */
  async deliver(ref?: string, outcome?: RailsOutcome): Promise<number> {
    if (!this.#events) throw new Error('no RailsEvents registered')
    const refs = ref === undefined ? [...this.held.keys()] : this.held.has(ref) ? [ref] : []
    let n = 0
    for (const r of refs) {
      const o = outcome ?? this.held.get(r)!
      const scheme = this.#heldScheme.get(r)
      this.held.delete(r)
      this.#heldScheme.delete(r)
      // What `status` tells from now on.
      const sent = this.#lastSent(r, scheme)
      if (sent) sent.outcome = o
      if (await this.#events.outcome(r, o)) n++
    }
    return n
  }
  #lastSent(ref: string, scheme: Scheme | undefined) {
    for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].ref === ref && this.sent[i].scheme === scheme) return this.sent[i]
    return undefined
  }
  /** A credit from the "scheme", through the same events as a bridge's. */
  async credit(c: IncomingCredit): Promise<CreditResult> {
    if (!this.#events) throw new Error('no RailsEvents registered')
    return this.#events.credit(c)
  }
  /** The debtor's bank returns or refunds a collection after settlement (decision 1000). */
  async returnCollection(ref: string, code: string): Promise<boolean> {
    if (!this.#events) throw new Error('no RailsEvents registered')
    return this.#events.collectionReturned(ref, code)
  }
  /** The payer's bank recalls a credit (decision 1001). */
  async recall(r: CreditRecall): Promise<RecallResult> {
    if (!this.#events) throw new Error('no RailsEvents registered')
    return this.#events.recall(r)
  }

  /** The creditor's bank returns a payment the rails settled (decision 1014). */
  async returnPayment(r: PaymentReturn): Promise<PaymentReturnResult> {
    if (!this.#events) throw new Error('no RailsEvents registered')
    return this.#events.paymentReturned(r)
  }

  /** Payments to this account are rejected by the "scheme" with this reason. */
  reject(account: string, reason: string) { this.#rejects.set(account.toUpperCase(), reason) }
  /** This account cannot receive SEPA Instant (automatic selection falls back to SEPA). */
  noInstant(account: string) { this.#noInstant.add(account.toUpperCase()) }
  /** SEPA Instant to this account is attempted and fails (the bank falls back to SEPA, ACWC). */
  instantFails(account: string) { this.#instantFails.add(account.toUpperCase()) }
  /** Direct debits from this (external) debtor account are rejected with this SEPA code. */
  rejectCollections(debtorIban: string, code: string) { this.#collectionRejects.set(debtorIban.toUpperCase(), code) }
  reset() {
    this.#rejects.clear(); this.#noInstant.clear(); this.#instantFails.clear(); this.#collectionRejects.clear()
    this.sent.length = 0; this.collections.length = 0
    this.held.clear(); this.#heldScheme.clear(); this.#deferred = false; this.#timeouts = false
  }

  async collect(c: OutgoingCollection): Promise<CollectionOutcome> {
    const code = this.#collectionRejects.get(c.debtor.iban.toUpperCase())
    const outcome: CollectionOutcome = code ? { status: 'rejected', code } : { status: 'settled' }
    this.collections.push({ ...c, outcome })
    keepLast(this.collections, RAILS_LOG_MAX)
    return outcome
  }

  async send(p: OutgoingPayment): Promise<RailsAnswer> {
    const target = (p.creditor.iban ?? p.creditor.account ?? '').toUpperCase()
    const reason = this.#rejects.get(target)
    const outcome: RailsOutcome = p.scheme === 'INST' && this.#instantFails.has(target) ? { status: 'unavailable' }
      : reason ? { status: 'rejected', reason } : { status: 'settled' }
    this.sent.push({ ...p, outcome })
    keepLast(this.sent, RAILS_LOG_MAX)
    if (this.#deferred) {
      this.held.set(p.ref, outcome)
      this.#heldScheme.set(p.ref, p.scheme)
      return { status: this.#timeouts ? 'unknown' : 'accepted' }
    }
    return this.#timeouts ? { status: 'unknown' } : outcome
  }

  async instantReachable(iban: string) { return !this.#noInstant.has(iban.toUpperCase()) }

  settlementAccount(scheme: string) { return `@settlement:${scheme}` }
}
