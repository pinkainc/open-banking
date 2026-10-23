// Payment schemes behind the bank. The engine hands an outgoing payment to the rails
// and books it when the rails report settlement. The simulator settles everything at
// once unless told to reject payments to a given account; real bridges (SEPA, SEPA
// Instant, UK Faster Payments) will implement the same interface.
export type Scheme = 'SEPA' | 'INST' | 'SWIFT' | 'TARGET2'

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
  send(p: OutgoingPayment): Promise<RailsOutcome>
  /** Is SEPA Instant available to this account? Decides automatic scheme selection. */
  instantReachable(iban: string): boolean
  /** The bank's ledger account that outgoing payments of a scheme are booked against. */
  settlementAccount(scheme: Scheme | string): string
  /** Presents a direct debit to the debtor's bank on the settlement date. */
  collect(c: OutgoingCollection): Promise<CollectionOutcome>
}

export class SimulatorRails implements Rails {
  readonly sent: (OutgoingPayment & { outcome: RailsOutcome })[] = []
  readonly collections: (OutgoingCollection & { outcome: CollectionOutcome })[] = []
  #rejects = new Map<string, string>()
  #noInstant = new Set<string>()
  #instantFails = new Set<string>()
  #collectionRejects = new Map<string, string>()

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
  }

  async collect(c: OutgoingCollection): Promise<CollectionOutcome> {
    const code = this.#collectionRejects.get(c.debtor.iban.toUpperCase())
    const outcome: CollectionOutcome = code ? { status: 'rejected', code } : { status: 'settled' }
    this.collections.push({ ...c, outcome })
    return outcome
  }

  async send(p: OutgoingPayment): Promise<RailsOutcome> {
    const target = (p.creditor.iban ?? p.creditor.account ?? '').toUpperCase()
    const reason = this.#rejects.get(target)
    const outcome: RailsOutcome = p.scheme === 'INST' && this.#instantFails.has(target) ? { status: 'unavailable' }
      : reason ? { status: 'rejected', reason } : { status: 'settled' }
    this.sent.push({ ...p, outcome })
    return outcome
  }

  instantReachable(iban: string) { return !this.#noInstant.has(iban.toUpperCase()) }

  settlementAccount(scheme: string) { return `@settlement:${scheme}` }
}
