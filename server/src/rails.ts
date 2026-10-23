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

export type RailsOutcome = { status: 'settled' } | { status: 'rejected'; reason: string }

export interface Rails {
  send(p: OutgoingPayment): Promise<RailsOutcome>
  /** Is SEPA Instant available to this account? Decides automatic scheme selection. */
  instantReachable(iban: string): boolean
  /** The bank's ledger account that outgoing payments of a scheme are booked against. */
  settlementAccount(scheme: Scheme | string): string
}

export class SimulatorRails implements Rails {
  readonly sent: (OutgoingPayment & { outcome: RailsOutcome })[] = []
  #rejects = new Map<string, string>()
  #noInstant = new Set<string>()

  /** Payments to this account are rejected by the "scheme" with this reason. */
  reject(account: string, reason: string) { this.#rejects.set(account.toUpperCase(), reason) }
  /** This account cannot receive SEPA Instant (automatic selection falls back to SEPA). */
  noInstant(account: string) { this.#noInstant.add(account.toUpperCase()) }
  reset() { this.#rejects.clear(); this.#noInstant.clear(); this.sent.length = 0 }

  async send(p: OutgoingPayment): Promise<RailsOutcome> {
    const target = (p.creditor.iban ?? p.creditor.account ?? '').toUpperCase()
    const reason = this.#rejects.get(target)
    const outcome: RailsOutcome = reason ? { status: 'rejected', reason } : { status: 'settled' }
    this.sent.push({ ...p, outcome })
    return outcome
  }

  instantReachable(iban: string) { return !this.#noInstant.has(iban.toUpperCase()) }

  settlementAccount(scheme: string) { return `@settlement:${scheme}` }
}
