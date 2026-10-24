// The emulator's FX pricing: mid rates against EUR, a margin taken from the customer,
// and the base currency of a pair. P 12 only says the rate "includes the LHV margin
// agreed with the customer" and that the base currency is "selected automatically based
// on the currency pair"; the order below is the market convention (docs/decisions.md 403).

/** Base currency priority: the earlier currency of a pair is its base (EUR/USD, GBP/USD, EUR/AUD). */
export const BASE_ORDER = ['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'NOK', 'SEK', 'DKK', 'PLN', 'CZK']

/** Units of each currency per 1 EUR (made up, roughly 2026 levels). */
export const DEFAULT_RATES: Record<string, string> = {
  EUR: '1', USD: '1.08', GBP: '0.85', AUD: '1.65', NZD: '1.80', CAD: '1.47',
  CHF: '0.95', NOK: '11.50', SEK: '11.20', DKK: '7.46', PLN: '4.30', CZK: '25.00',
}

/** Margin taken on the mid rate, as a fraction (0.003 = 0.3 %). */
export const DEFAULT_MARGIN = 0.003

/** The pricing settings as stored. */
export interface PricingState { rates: Record<string, number>; margin: number; available: boolean }

export class Pricing {
  #rates = new Map<string, number>()
  margin = DEFAULT_MARGIN
  /** false: every quote fails with "Pricing not available, try again later". */
  available = true

  constructor(state?: PricingState) {
    this.setRates(DEFAULT_RATES)
    if (state) { this.#rates.clear(); this.setRates(state.rates); this.margin = state.margin; this.available = state.available }
  }

  /** What the emulator stores (decision 980): JSON-safe. */
  state(): PricingState { return { rates: this.rates(), margin: this.margin, available: this.available } }

  setRates(rates: Record<string, string | number>) {
    for (const [ccy, v] of Object.entries(rates)) {
      const n = Number(v)
      if (!/^[A-Z]{3}$/.test(ccy) || !Number.isFinite(n) || n <= 0) throw new RangeError(`invalid rate ${ccy} ${v}`)
      this.#rates.set(ccy, n)
    }
    if (this.#rates.get('EUR') !== 1) this.#rates.set('EUR', 1)
  }

  rates(): Record<string, number> { return Object.fromEntries(this.#rates) }
  supports(ccy: string) { return this.#rates.has(ccy) }

  /** The base of a pair: by BASE_ORDER, then alphabetically for currencies outside it. */
  base(a: string, b: string): string {
    const rank = (c: string) => { const i = BASE_ORDER.indexOf(c); return i < 0 ? BASE_ORDER.length : i }
    return rank(a) !== rank(b) ? (rank(a) < rank(b) ? a : b) : (a < b ? a : b)
  }

  /**
   * The quote for selling `from` and buying `to`, five decimals, in the base direction
   * (base amount × quote = quote-currency amount). The margin always works against the
   * customer: selling the base gives fewer quote units, buying it costs more.
   */
  quote(from: string, to: string): { base: string; quote: number } {
    const base = this.base(from, to)
    const other = base === from ? to : from
    const mid = this.#rates.get(other)! / this.#rates.get(base)!
    const q = base === from ? mid * (1 - this.margin) : mid * (1 + this.margin)
    return { base, quote: Number(q.toFixed(5)) }
  }
}

/**
 * The other amount of a deal in minor units, rounded half up: the given side converted
 * with the quote in its base direction.
 */
export function convert(amount: bigint, fromCcy: string, base: string, quote: number): bigint {
  const v = fromCcy === base ? Number(amount) * quote : Number(amount) / quote
  return BigInt(Math.round(v))
}
