// The ledger behind the facade. The interface is what the payment engine needs and no
// more, so the in-memory implementation can later be replaced by open-ledger (through
// its SDK or HTTP API) without touching the Connect-facing code. Amounts are integers
// in minor units (cents).
export class InsufficientFunds extends Error {}

export interface Ledger {
  /** Balance minus reservations. */
  available(account: string, currency: string): Promise<bigint>
  balances(account: string): Promise<Record<string, { balance: bigint; available: bigint }>>
  /** Sets funds aside for a payment; throws InsufficientFunds. */
  reserve(r: { ref: string; account: string; amount: bigint; currency: string }): Promise<void>
  /** Books a reservation to its destination. */
  commit(ref: string, to: string): Promise<void>
  release(ref: string): Promise<void>
  /** reserve + commit in one step. */
  transfer(t: { ref: string; from: string; to: string; amount: bigint; currency: string }): Promise<void>
}

/** Accounts whose name starts with '@' are the bank's own (settlement, funding) and may go negative. */
export const isSystemAccount = (a: string) => a.startsWith('@')

export interface Posting { ref: string; account: string; currency: string; amount: bigint; at: number }

export class MemoryLedger implements Ledger {
  #balances = new Map<string, bigint>()
  #holds = new Map<string, { account: string; amount: bigint; currency: string }>()
  readonly postings: Posting[] = []

  #k = (a: string, c: string) => `${a}|${c}`
  #bal(a: string, c: string) { return this.#balances.get(this.#k(a, c)) ?? 0n }
  #held(a: string, c: string) {
    let s = 0n
    for (const h of this.#holds.values()) if (h.account === a && h.currency === c) s += h.amount
    return s
  }

  async available(account: string, currency: string) { return this.#bal(account, currency) - this.#held(account, currency) }

  async balances(account: string) {
    const out: Record<string, { balance: bigint; available: bigint }> = {}
    for (const key of this.#balances.keys()) {
      const [a, c] = key.split('|')
      if (a === account) out[c] = { balance: this.#bal(a, c), available: this.#bal(a, c) - this.#held(a, c) }
    }
    return out
  }

  async reserve(r: { ref: string; account: string; amount: bigint; currency: string }) {
    if (r.amount <= 0n) throw new Error('amount must be positive')
    if (this.#holds.has(r.ref)) throw new Error(`reservation ${r.ref} exists`)
    if (!isSystemAccount(r.account) && (await this.available(r.account, r.currency)) < r.amount) throw new InsufficientFunds()
    this.#holds.set(r.ref, { account: r.account, amount: r.amount, currency: r.currency })
  }

  async commit(ref: string, to: string) {
    const h = this.#holds.get(ref)
    if (!h) throw new Error(`no reservation ${ref}`)
    this.#holds.delete(ref)
    this.#move(ref, h.account, to, h.amount, h.currency)
  }

  async release(ref: string) { this.#holds.delete(ref) }

  async transfer(t: { ref: string; from: string; to: string; amount: bigint; currency: string }) {
    await this.reserve({ ref: t.ref, account: t.from, amount: t.amount, currency: t.currency })
    await this.commit(t.ref, t.to)
  }

  #move(ref: string, from: string, to: string, amount: bigint, currency: string) {
    const at = Date.now()
    this.#balances.set(this.#k(from, currency), this.#bal(from, currency) - amount)
    this.#balances.set(this.#k(to, currency), this.#bal(to, currency) + amount)
    this.postings.push({ ref, account: from, currency, amount: -amount, at }, { ref, account: to, currency, amount, at })
  }
}

/** "12.30" → 1230n. Throws on more than two decimals or a malformed number. */
export function toMinor(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim())
  if (!m) throw new Error(`not an amount with at most two decimals: ${s}`)
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'))
}

/** 1230n → "12.30" */
export function fromMinor(n: bigint): string {
  const neg = n < 0n
  const a = neg ? -n : n
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`
}
