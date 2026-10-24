// Foreign exchange on the customer's own multi-currency account (P 12):
//
//   POST /fx/trade-offer               → 202; FX_TRADE_OFFER in the inbox: a quote valid
//                                        two minutes (CONFIRMATION_PENDING), a CANCELLED
//                                        offer with errorCode (business errors), or only
//                                        {errorCode} (technical errors)
//   POST /fx/trade-offer-confirmation  → 202; FX_TRADE_OFFER_CONFIRMATION: the sold amount
//                                        is reserved; TODAY settles at once (COMPLETED),
//                                        SPOT is SETTLEMENT_PENDING and settles in the first
//                                        hour of the settlement date (Tallinn), then a
//                                        second message COMPLETED
//
// Settlement books both legs against the bank's FX position (@fx): a DBIT in the sold and
// a CRDT in the bought currency, FORX / OTHR / OTHR, PmtInfId = the deal's pmtInfId, each
// with a camt.054 and a statement entry. tick() settles due SPOT deals (main.ts calls it
// every minute, tests and /_sim/fx/settle call it directly).
//
// Offers, their deals and the pricing settings are kept in the emulator's keyed store
// (decision 980), so an offer made before a restart can still be confirmed within its
// validity, once, and a SPOT deal is settled once (a claim per offer, decision 981).
import { randomUUID } from 'node:crypto'
import type { Clock } from '../clock.js'
import { keyOf, type Customer, type CustomerKey, type DirectoryStore } from '../directory.js'
import { memoryKeyed, UNBOUNDED, type KeyedFactory, type KeyedStore } from '../keyed.js'
import { normalizeIban } from '../iban.js'
import { servicerRef } from '../ids.js'
import type { InboxStore } from '../inbox.js'
import { fromMinor, InsufficientFunds, type Ledger } from '../ledger.js'
import type { Booking } from '../payments/camt054.js'
import type { Outbox } from '../outbox.js'
import type { Bank } from '../payments/engine.js'
import { addDays, instant } from '../statements/camt060.js'
import { dateTallinn, isoTallinn } from '../time.js'
import { isTarget2Day } from '../directdebit/target2.js'
import { asObject, JsonBodyError, parseJsonBody } from '../jsonbody.js'
import { convert, Pricing, type PricingState } from './pricing.js'

export const FX_TYPES = { offer: 'FX_TRADE_OFFER', confirmation: 'FX_TRADE_OFFER_CONFIRMATION' } as const
/** The bank's FX position: both legs of every deal are booked against it. */
export const FX_POSITION = '@fx:position'
/** How long a quote can be confirmed (P 12: "typically around 2 minutes"). */
export const VALIDITY_MS = 2 * 60 * 1000
/** SPOT settles this many TARGET2 days after the trade date. */
export const SPOT_DAYS = 2

/** errorCode texts: the documented ones (P 12 "Errors") and ours where P 12 has none (decision 405). */
export const FX_E = {
  noFunds: (from: string, to: string, quote: number) => `Conversion not possible, because there are no funds for currency (${from} -> ${to}, ${quote.toFixed(5)})`,
  noAmount: 'At least one amount for the trade must be given',
  expired: 'Trade offer quote has expired',
  account: 'Incorrect Account',
  pricing: 'Pricing not available, try again later',
  internal: 'INTERNAL_ERROR',
  // Not documented:
  bothAmounts: 'Only one of amountFrom or amountTo can be given',
  amount: (v: string) => `Invalid amount ${v}: must be positive with at most 2 decimals`,
  currency: (c: string) => `Currency ${c} is not supported`,
  sameCurrency: 'currencyFrom and currencyTo must differ',
  missing: (field: string) => `Missing required field ${field}`,
  type: (field: string, type: string, v: unknown) => `Cannot deserialize value of type \`${type}\` from ${typeof v === 'string' ? `String ${JSON.stringify(v)}` : JSON.stringify(v)} (field ${field})`,
  tenor: (v: unknown) => `Cannot deserialize value of type \`Tenor\` from String ${JSON.stringify(String(v))}: not one of the values accepted for Enum class: [SPOT, TODAY]`,
  boolean: (v: unknown) => `Cannot deserialize value of type \`boolean\` from String ${JSON.stringify(String(v))}: only "true" or "false" recognized`,
  duplicate: (ref: string) => `Trade offer with requestReference ${ref} already exists`,
  unknownOffer: (ref: string) => `Trade offer with requestReference ${ref} not found`,
  notPending: (ref: string) => `Trade offer with requestReference ${ref} cannot be confirmed`,
}

export type Tenor = 'TODAY' | 'SPOT'
export type OfferStatus = 'CONFIRMATION_PENDING' | 'CANCELLED'
export type TradeStatus = 'SETTLEMENT_PENDING' | 'COMPLETED' | 'CANCELLED'

export interface Offer {
  customer: Customer
  requestReference: string
  account: string
  currencyFrom: string
  currencyTo: string
  amountFrom?: bigint
  amountTo?: bigint
  baseCurrency?: string
  quote?: number
  tenor: Tenor
  comment?: string
  accountServicerReference: string
  orderedAt: Date
  tradeDate: string
  settlementDate?: string
  validUntil?: Date
  status: OfferStatus
  errors?: string[]
  /** Set once the offer was answered with confirm true or false. */
  deal?: Deal
}

export interface Deal {
  status: TradeStatus
  pmtInfId?: number
  /** The ledger reservation of the sold amount. */
  reservation?: string
  confirmRequestId: string
  confirmedAt: Date
  settledAt?: Date
  errors?: string[]
}

/** The deal references are numbers, as the P 12 sample sends; each is taken once in the store. */
let pmtInfSeq = 10_357_000
/** How long a claim on an offer holds when its holder never lets go (a crash), by the clock. */
export const CLAIM_MS = 5 * 60 * 1000

export interface FxDeps {
  directory: DirectoryStore
  ledger: Ledger
  inbox: InboxStore
  clock: Clock
  bank: Bank
  /** A booking's statement entry and camt.054 go with it (decision 990). */
  outbox: Outbox
  /** Where offers and pricing are kept (decision 980); memory when not given. */
  keyed?: KeyedFactory
}

/** "2021-12-15T23:59:59+02:00": the end of a Tallinn date, without milliseconds. */
export const endOfDay = (date: string) => isoTallinn(new Date(instant(date, '23:59:59'))).replace('.000', '')

/** The SPOT settlement date: SPOT_DAYS TARGET2 days after the trade date. */
export function spotDate(trade: string): string {
  let d = trade
  for (let n = 0; n < SPOT_DAYS;) { d = addDays(d, 1); if (isTarget2Day(d)) n++ }
  return d
}

/** An amount field: a JSON number or a numeric string (Jackson coerces both), null or absent. */
function readAmount(v: unknown, field: string): { minor?: bigint; error?: string; technical?: string } {
  if (v === undefined || v === null) return {}
  if (typeof v !== 'number' && !(typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v))) return { technical: FX_E.type(field, 'java.math.BigDecimal', v) }
  const s = String(v).trim()
  const m = /^(\d+)(?:\.(\d{1,2})0*)?$/.exec(s.includes('e') || s.includes('E') ? Number(s).toFixed(2) : s)
  if (!m) return { error: FX_E.amount(s) }
  const minor = BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'))
  return minor > 0n ? { minor } : { error: FX_E.amount(s) }
}

const num = (n: bigint) => Number(fromMinor(n))

export class FxService {
  /** Every offer by customer key and requestReference, in the order they came (decision 980). */
  #offers: KeyedStore<StoredOffer>
  /** The /_sim pricing settings, one entry; the defaults while it is absent. */
  #pricing: KeyedStore<PricingState>
  /** Who is confirming or settling an offer right now (decision 981). */
  #claims: KeyedStore<true>
  /** The pmtInfIds given out, so a restarted emulator does not give one twice. */
  #pmtInfIds: KeyedStore<true>
  /** The service's operations in this process, one after the other (decision 981). */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(private d: FxDeps) {
    const keyed = d.keyed ?? memoryKeyed(d.clock)
    this.#offers = keyed('fx-offers', UNBOUNDED)
    this.#pricing = keyed('fx-pricing', UNBOUNDED)
    this.#claims = keyed('fx-claims', { ttlMs: CLAIM_MS, max: 100_000 })
    this.#pmtInfIds = keyed('fx-pmtinfids', UNBOUNDED)
  }

  #serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(f, f)
    this.#queue = run.catch(() => undefined)
    return run
  }

  /** The current pricing (a copy: change it with setPricing). */
  async pricing(): Promise<Pricing> { return new Pricing(await this.#pricing.get('pricing')) }

  /** Changes the pricing with f (which may throw: nothing is stored then) and stores it. */
  setPricing(f: (p: Pricing) => void): Promise<Pricing> {
    return this.#serial(async () => {
      const p = await this.pricing()
      f(p)
      await this.#pricing.set('pricing', p.state())
      return p
    })
  }

  /** Every offer, oldest first; one whose customer is gone from the directory is left out. */
  async offers(): Promise<Offer[]> {
    const out: Offer[] = []
    for (const [, s] of await this.#offers.entries()) {
      const o = await this.#decode(s)
      if (o) out.push(o)
    }
    return out
  }

  async #decode(s: StoredOffer, customer?: Customer): Promise<Offer | undefined> {
    const { customer: k, amountFrom, amountTo, orderedAt, validUntil, deal, ...rest } = s
    const c = customer ?? (await this.d.directory.get(k))
    if (!c) return undefined
    const o: Offer = { ...rest, customer: c, orderedAt: new Date(orderedAt) }
    if (amountFrom !== undefined) o.amountFrom = BigInt(amountFrom)
    if (amountTo !== undefined) o.amountTo = BigInt(amountTo)
    if (validUntil !== undefined) o.validUntil = new Date(validUntil)
    if (deal) {
      const { confirmedAt, settledAt, ...d } = deal
      o.deal = { ...d, confirmedAt: new Date(confirmedAt), ...(settledAt !== undefined ? { settledAt: new Date(settledAt) } : {}) }
    }
    return o
  }

  /**
   * Runs f on the stored offer while holding its claim (keyed `add`, one holder across
   * emulators on a namespace); undefined when another holds it or the offer is gone.
   */
  async #claimed<T>(key: string, f: (o: Offer) => Promise<T>, customer?: Customer): Promise<T | undefined> {
    if (!(await this.#claims.add(key, true))) return undefined
    try {
      const s = await this.#offers.get(key)
      const o = s && (await this.#decode(s, customer))
      return o ? await f(o) : undefined
    } finally {
      await this.#claims.take(key)
    }
  }

  async #save(o: Offer) { await this.#offers.replace(this.#key(o.customer, o.requestReference), encodeOffer(o)) }

  /** The next free pmtInfId: the counter, past every one the store has given out. */
  async #nextPmtInfId() {
    let id: number
    do id = ++pmtInfSeq; while (!(await this.#pmtInfIds.add(String(id), true)))
    return id
  }

  #key = (c: Customer, ref: string) => `${keyOf(c)}|${ref}`

  async #send(customer: Customer, type: string, requestId: string | undefined, body: object) {
    await this.d.inbox.add({ customer, type, requestId, body: JSON.stringify(body), contentType: 'application/json' })
  }

  /** POST /fx/trade-offer: always answered in the inbox. */
  offer(raw: unknown, customer: Customer, requestId: string): Promise<void> {
    return this.#serial(async () => { await this.#send(customer, FX_TYPES.offer, requestId, await this.#offer(raw, customer)) })
  }

  async #offer(raw: unknown, customer: Customer): Promise<object> {
    let parsed: unknown
    try { parsed = parseJsonBody(raw) } catch (e) {
      if (e instanceof JsonBodyError) return { errorCode: [e.message] }
      throw e
    }
    const b = asObject(parsed)
    if (!b) return { errorCode: [FX_E.type('body', 'TradeOfferRequest', parsed)] }

    // Technical errors: only errorCode, no offer is created.
    const refRaw = b.requestReference
    if (refRaw === undefined || refRaw === null || refRaw === '') return { errorCode: [FX_E.missing('requestReference')] }
    if (typeof refRaw !== 'string' && typeof refRaw !== 'number') return { errorCode: [FX_E.type('requestReference', 'java.lang.String', refRaw)] }
    const requestReference = String(refRaw)
    for (const f of ['currencyFrom', 'currencyTo', 'comment'] as const) {
      if (b[f] !== undefined && b[f] !== null && typeof b[f] !== 'string') return { errorCode: [FX_E.type(f, 'java.lang.String', b[f])] }
    }
    const ibanRaw = b.accountIBAN ?? b.accountIban
    if (ibanRaw !== undefined && ibanRaw !== null && typeof ibanRaw !== 'string') return { errorCode: [FX_E.type('accountIBAN', 'java.lang.String', ibanRaw)] }
    if (b.tenor === undefined || b.tenor === null) return { errorCode: [FX_E.missing('tenor')] }
    if (b.tenor !== 'TODAY' && b.tenor !== 'SPOT') return { errorCode: [FX_E.tenor(b.tenor)] }
    const from = readAmount(b.amountFrom, 'amountFrom')
    const to = readAmount(b.amountTo, 'amountTo')
    if (from.technical || to.technical) return { errorCode: [(from.technical ?? to.technical)!] }
    const key = this.#key(customer, requestReference)
    const duplicate = { errorCode: [FX_E.duplicate(requestReference)] }
    if (await this.#offers.has(key)) return duplicate
    const account = typeof ibanRaw === 'string' ? normalizeIban(ibanRaw) : ''
    if (!account || !customer.accounts.includes(account)) return { errorCode: [FX_E.account] }
    const pricing = await this.pricing()
    if (!pricing.available) return { errorCode: [FX_E.pricing] }

    const now = this.d.clock.now()
    const tradeDate = dateTallinn(now)
    const currencyFrom = typeof b.currencyFrom === 'string' ? b.currencyFrom.toUpperCase() : ''
    const currencyTo = typeof b.currencyTo === 'string' ? b.currencyTo.toUpperCase() : ''
    const offer: Offer = {
      customer, requestReference, account, currencyFrom, currencyTo, tenor: b.tenor,
      comment: typeof b.comment === 'string' ? b.comment : undefined,
      accountServicerReference: randomUUID(), orderedAt: now, tradeDate, status: 'CANCELLED',
    }
    // Stored once, as answered; `add` lets one of two emulators have the reference (decision 980).
    const done = async () => (await this.#offers.add(key, encodeOffer(offer))) ? this.offerView(offer) : duplicate

    // Business errors: the offer is created CANCELLED with the error.
    const cancel = (error: string) => { offer.errors = [error]; return done() }
    if (!currencyFrom) return cancel(FX_E.missing('currencyFrom'))
    if (!currencyTo) return cancel(FX_E.missing('currencyTo'))
    if (pricing.supports(currencyFrom) && pricing.supports(currencyTo)) offer.baseCurrency = pricing.base(currencyFrom, currencyTo)
    if (from.minor === undefined && to.minor === undefined) return cancel(from.error ?? to.error ?? FX_E.noAmount)
    if (from.error || to.error) return cancel((from.error ?? to.error)!)
    if (from.minor !== undefined && to.minor !== undefined) return cancel(FX_E.bothAmounts)
    if (!pricing.supports(currencyFrom)) return cancel(FX_E.currency(currencyFrom))
    if (!pricing.supports(currencyTo)) return cancel(FX_E.currency(currencyTo))
    if (currencyFrom === currencyTo) return cancel(FX_E.sameCurrency)

    const { base, quote } = pricing.quote(currencyFrom, currencyTo)
    offer.quote = quote
    offer.amountFrom = from.minor ?? convert(to.minor!, currencyTo, base, quote)
    offer.amountTo = to.minor ?? convert(from.minor!, currencyFrom, base, quote)
    offer.settlementDate = offer.tenor === 'TODAY' ? tradeDate : spotDate(tradeDate)
    if (offer.amountFrom <= 0n || offer.amountTo <= 0n) return cancel(FX_E.amount('0.00'))
    // "Customer account validity and available balance is checked before providing the quote."
    if ((await this.d.ledger.available(account, currencyFrom)) < offer.amountFrom) return cancel(this.#noFunds(offer))
    offer.status = 'CONFIRMATION_PENDING'
    offer.validUntil = new Date(now.getTime() + VALIDITY_MS)
    return done()
  }

  #noFunds(o: Offer) {
    return FX_E.noFunds(`${fromMinor(o.amountFrom!)} ${o.currencyFrom}`, `${fromMinor(o.amountTo!)} ${o.currencyTo}`, o.quote!)
  }

  /** The FX_TRADE_OFFER body (field order of the P 12 sample). */
  offerView(o: Offer) {
    return {
      requestReference: o.requestReference,
      accountIban: o.account,
      currencyFrom: o.currencyFrom,
      ...(o.amountFrom !== undefined ? { amountFrom: num(o.amountFrom) } : {}),
      currencyTo: o.currencyTo,
      ...(o.amountTo !== undefined ? { amountTo: num(o.amountTo) } : {}),
      ...(o.baseCurrency ? { baseCurrency: o.baseCurrency } : {}),
      orderDateTime: isoTallinn(o.orderedAt),
      tradeDate: endOfDay(o.tradeDate),
      ...(o.settlementDate ? { settlementDate: endOfDay(o.settlementDate) } : {}),
      tenor: o.tenor,
      ...(o.quote !== undefined ? { quote: o.quote } : {}),
      tradeOfferStatus: o.status,
      ...(o.comment !== undefined ? { comment: o.comment } : {}),
      accountServicerReference: o.accountServicerReference,
      ...(o.validUntil ? { validityTime: isoTallinn(o.validUntil) } : {}),
      ...(o.errors ? { errorCode: o.errors } : {}),
    }
  }

  /** The FX_TRADE_OFFER_CONFIRMATION body (field order of the P 12 sample). */
  dealView(o: Offer) {
    const d = o.deal!
    return {
      tradeStatus: d.status,
      accountIban: o.account,
      requestReference: o.requestReference,
      currencyFrom: o.currencyFrom,
      amountFrom: num(o.amountFrom!),
      currencyTo: o.currencyTo,
      amountTo: num(o.amountTo!),
      baseCurrency: o.baseCurrency,
      tenor: o.tenor,
      quote: o.quote,
      orderDateTime: isoTallinn(o.orderedAt),
      tradeDate: endOfDay(o.tradeDate),
      settlementDate: endOfDay(o.settlementDate!),
      ...(d.settledAt ? { settlementDoneDateTime: isoTallinn(d.settledAt) } : {}),
      ...(o.comment !== undefined ? { comment: o.comment } : {}),
      accountServicerReference: o.accountServicerReference,
      ...(d.pmtInfId !== undefined ? { pmtInfId: d.pmtInfId } : {}),
      ...(d.errors ? { errorCode: d.errors } : {}),
    }
  }

  /** POST /fx/trade-offer-confirmation: always answered in the inbox. */
  confirm(raw: unknown, customer: Customer, requestId: string): Promise<void> {
    return this.#serial(async () => { await this.#send(customer, FX_TYPES.confirmation, requestId, await this.#confirm(raw, customer, requestId)) })
  }

  async #confirm(raw: unknown, customer: Customer, requestId: string): Promise<object> {
    let parsed: unknown
    try { parsed = parseJsonBody(raw) } catch (e) {
      if (e instanceof JsonBodyError) return { errorCode: [e.message] }
      throw e
    }
    const b = asObject(parsed)
    if (!b) return { errorCode: [FX_E.type('body', 'TradeOfferConfirmationRequest', parsed)] }
    const refRaw = b.requestReference
    if (refRaw === undefined || refRaw === null || refRaw === '') return { errorCode: [FX_E.missing('requestReference')] }
    if (typeof refRaw !== 'string' && typeof refRaw !== 'number') return { errorCode: [FX_E.type('requestReference', 'java.lang.String', refRaw)] }
    if (b.confirm === undefined || b.confirm === null) return { errorCode: [FX_E.missing('confirm')] }
    // The field table says String "true"/"false", the sample sends a boolean: both work.
    const confirm = b.confirm === true || b.confirm === 'true' ? true : b.confirm === false || b.confirm === 'false' ? false : undefined
    if (confirm === undefined) return { errorCode: [FX_E.boolean(b.confirm)] }
    const ref = String(refRaw)
    const key = this.#key(customer, ref)
    if (!(await this.#offers.has(key))) return { errorCode: [FX_E.unknownOffer(ref)] }
    const notPending = { errorCode: [FX_E.notPending(ref)] }
    // Answered once: the offer is read again under its claim; one held by another is being answered.
    return (await this.#claimed(key, (o) => this.#answer(o, confirm, requestId), customer)) ?? notPending
  }

  async #answer(o: Offer, confirm: boolean, requestId: string): Promise<object> {
    if (o.status !== 'CONFIRMATION_PENDING' || o.deal) return { errorCode: [FX_E.notPending(o.requestReference)] }
    const now = this.d.clock.now()
    if (now.getTime() > o.validUntil!.getTime()) return { errorCode: [FX_E.expired] }

    const deal: Deal = { status: 'CANCELLED', confirmRequestId: requestId, confirmedAt: now }
    o.deal = deal
    // false rejects the offer for good: "It cannot be confirmed anymore even with validity time left."
    if (!confirm) { await this.#save(o); return this.dealView(o) }

    const reservation = `fx:${o.accountServicerReference}`
    try {
      await this.d.ledger.reserve({ ref: reservation, account: o.account, amount: o.amountFrom!, currency: o.currencyFrom })
    } catch (e) {
      if (!(e instanceof InsufficientFunds)) throw e
      deal.errors = [this.#noFunds(o)]
      await this.#save(o)
      return this.dealView(o)
    }
    deal.reservation = reservation
    deal.pmtInfId = await this.#nextPmtInfId()
    deal.status = 'SETTLEMENT_PENDING'
    await this.#save(o)
    // TODAY: "settlement is executed in seconds after the confirmation request" — here at once,
    // so the one confirmation message is already COMPLETED (decision 401).
    if (o.tenor === 'TODAY') await this.#settle(o)
    return this.dealView(o)
  }

  /** Books both legs of a confirmed deal. */
  async #settle(o: Offer) {
    const d = o.deal!
    const now = this.d.clock.now()
    const creditRef = servicerRef()
    const c = o.customer
    const leg = (direction: 'DBIT' | 'CRDT', amount: bigint, currency: string, ref: string): Booking => ({
      account: o.account, owner: { name: c.name, code: c.code }, direction, amount, currency, servicerRef: ref,
      scheme: 'INTERNAL', bookedAt: now, pmtInfId: String(d.pmtInfId),
      counterparty: { name: this.d.bank.name, bic: this.d.bank.bic },
      remittance: o.comment || `FX ${o.currencyFrom}/${o.currencyTo} ${o.quote!.toFixed(5)}`,
      bankTxCode: { domain: 'FORX', family: 'OTHR', subFamily: 'OTHR' },
    })
    // Each leg's camt.054 goes with its booking (decision 990), delivered once the deal is saved COMPLETED.
    const debit = [this.d.outbox.notice(c, leg('DBIT', o.amountFrom!, o.currencyFrom, servicerRef()))]
    const credit = [this.d.outbox.notice(c, leg('CRDT', o.amountTo!, o.currencyTo, creditRef))]
    await this.d.ledger.commit(d.reservation!, FX_POSITION, debit)
    await this.d.ledger.transfer({ ref: creditRef, from: FX_POSITION, to: o.account, amount: o.amountTo!, currency: o.currencyTo }, credit)
    d.status = 'COMPLETED'
    d.settledAt = now
    await this.#save(o)
    await this.d.outbox.deliver([...debit, ...credit])
  }

  /**
   * Settles the SPOT deals whose settlement date has begun in Tallinn and sends each a
   * second FX_TRADE_OFFER_CONFIRMATION, COMPLETED (decision 402). Returns how many.
   */
  tick(): Promise<number> { return this.#serial(() => this.#tick()) }

  async #tick(): Promise<number> {
    const now = this.d.clock.now().getTime()
    const due = (o: { deal?: { status: TradeStatus }; settlementDate?: string }) =>
      o.deal?.status === 'SETTLEMENT_PENDING' && now >= instant(o.settlementDate!, '00:00:00')
    let n = 0
    for (const [key, s] of await this.#offers.entries()) {
      if (!due(s)) continue
      const settled = await this.#claimed(key, async (o) => {
        if (!due(o)) return false
        await this.#settle(o)
        await this.#send(o.customer, FX_TYPES.confirmation, o.deal!.confirmRequestId, this.dealView(o))
        return true
      })
      if (settled) n++
    }
    return n
  }
}

/** An offer as the keyed store keeps it (decision 980): JSON, the customer by key. */
type StoredOffer = Omit<Offer, 'customer' | 'amountFrom' | 'amountTo' | 'orderedAt' | 'validUntil' | 'deal'> & {
  customer: CustomerKey
  amountFrom?: string
  amountTo?: string
  orderedAt: number
  validUntil?: number
  deal?: Omit<Deal, 'confirmedAt' | 'settledAt'> & { confirmedAt: number; settledAt?: number }
}

/** JSON-safe (undefined fields dropped), so memory hands back what Postgres would. */
const encodeOffer = (o: Offer): StoredOffer => {
  const { customer, amountFrom, amountTo, orderedAt, validUntil, deal, ...rest } = o
  return JSON.parse(JSON.stringify({
    ...rest, customer: { code: customer.code, country: customer.country },
    amountFrom: amountFrom?.toString(), amountTo: amountTo?.toString(), orderedAt: orderedAt.getTime(), validUntil: validUntil?.getTime(),
    deal: deal && { ...deal, confirmedAt: deal.confirmedAt.getTime(), settledAt: deal.settledAt?.getTime() },
  }))
}
