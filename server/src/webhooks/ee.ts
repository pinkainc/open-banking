// LHV EE webhooks (P 15): a customer subscribes a URL, and every new inbox message of
// that customer is announced there with a small JSON payload (ids, type, customer); the
// client then fetches the message itself. One GENERAL_WEBHOOK subscription covers all
// message types; there is no signature. This is not the UK webhook system (per-type
// configs, HMAC, history, replay), which lives elsewhere.
//
// Delivery is a POST from the bank. P 15 documents no retry policy; ours (decision 421):
// the first attempt when the message is created, then retries 1 min, 5 min, 30 min and
// 2 h after the previous failure on the emulator clock, then FAILED. A 2xx answer is
// delivered. tick() runs the due attempts (main.ts every 15 s; tests and
// /_sim/webhooks/ee/tick call it, idle() waits for attempts in flight).
import { randomUUID } from 'node:crypto'
import type { Clock } from '../clock.js'
import { keyOf, type CustomerKey } from '../directory.js'
import type { InboxStore, Message } from '../inbox.js'
import { memoryKeyed, UNBOUNDED, type KeyedFactory, type KeyedStore } from '../keyed.js'

export const EVENT_TYPE = 'GENERAL_WEBHOOK'
/** Pause before each retry, after a failed attempt; the length is the number of retries. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]
/** Deliveries kept for /_sim/webhooks/ee/deliveries (pending ones are never dropped). */
export const MAX_LOG = 1000
/** A delivery attempt that has not answered in this time failed. */
export const DELIVERY_TIMEOUT_MS = 10_000

/** Sends one payload; resolves with the HTTP status, rejects on a transport error. */
export type Deliver = (url: string, body: string) => Promise<number>

export const httpDeliver: Deliver = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  })
  await res.arrayBuffer().catch(() => undefined)
  return res.status
}

export interface Subscription {
  subscriptionReference: string
  customer: CustomerKey
  url: string
  eventType: string
  createdAt: Date
}

export interface Attempt { at: Date; url: string; status?: number; error?: string }

export interface Delivery {
  eventId: number
  subscriptionReference: string
  messageResponseId: string
  /** The JSON body, the same on every attempt. */
  payload: string
  state: 'PENDING' | 'DELIVERED' | 'FAILED' | 'CANCELLED'
  attempts: Attempt[]
  /** When the next attempt is due (epoch ms), while PENDING. */
  nextAt?: number
}

/** "2024-03-25T06:01:02.171+00:00", the P 15 sample's form. */
export const utcIso = (d: Date) => d.toISOString().replace('Z', '+00:00')

export interface EeWebhookOptions {
  deliver?: Deliver
  /** Start the first attempt as soon as the message is created (default true). */
  immediate?: boolean
  /** Where subscriptions, deliveries and claims are kept (decision 985); default in memory. */
  keyed?: KeyedFactory
}

/** How long an attempt holds its delivery (decision 986). */
export const CLAIM_MS = 5 * 60_000

// Stored forms (decision 985): times in ms.
interface StoredSubscription extends Omit<Subscription, 'createdAt'> { createdAt: number }
interface StoredDelivery extends Omit<Delivery, 'attempts'> { attempts: (Omit<Attempt, 'at'> & { at: number })[] }
const encodeDelivery = (d: Delivery): StoredDelivery => JSON.parse(JSON.stringify({ ...d, attempts: d.attempts.map((a) => ({ ...a, at: a.at.getTime() })) }))
const decodeDelivery = (s: StoredDelivery): Delivery => ({ ...s, attempts: s.attempts.map((a) => ({ ...a, at: new Date(a.at) })) })
const decodeSubscription = (s: StoredSubscription): Subscription => ({ ...s, customer: { ...s.customer }, createdAt: new Date(s.createdAt) })

export class EeWebhooks {
  readonly #subs: KeyedStore<StoredSubscription>
  readonly #deliveries: KeyedStore<StoredDelivery>
  /** One attempt of a delivery at a time, across emulators on a namespace (decision 986). */
  readonly #claims: KeyedStore<true>
  #queue: Promise<unknown> = Promise.resolve()
  #eventSeq: number | undefined
  #inflight = new Set<Promise<unknown>>()
  deliver: Deliver
  readonly immediate: boolean

  constructor(inbox: InboxStore, private clock: Clock, opts: EeWebhookOptions = {}) {
    this.deliver = opts.deliver ?? httpDeliver
    this.immediate = opts.immediate ?? true
    const keyed = opts.keyed ?? memoryKeyed(clock)
    this.#subs = keyed('ee-webhook-subscriptions', UNBOUNDED)
    this.#deliveries = keyed('ee-webhook-deliveries', UNBOUNDED)
    this.#claims = keyed('ee-webhook-claims', { ttlMs: CLAIM_MS, max: 100_000 })
    inbox.onAdd((m) => this.#onMessage(m))
  }

  /** Changes run one after the other in this process (decision 986). */
  #serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(f, f)
    this.#queue = run.catch(() => undefined)
    return run
  }

  // --- Subscriptions ---------------------------------------------------------------

  /** Subscribing a URL the customer already has returns that subscription (decision 420). */
  subscribe(customer: CustomerKey, url: string, eventType = EVENT_TYPE): Promise<Subscription> {
    return this.#serial(async () => {
      const existing = (await this.list(customer)).find((s) => s.url === url)
      if (existing) return existing
      const s: Subscription = {
        subscriptionReference: randomUUID(), customer: { code: customer.code, country: customer.country }, url, eventType, createdAt: this.clock.now(),
      }
      await this.#subs.add(s.subscriptionReference, { ...s, createdAt: s.createdAt.getTime() })
      return s
    })
  }

  async list(customer: CustomerKey): Promise<Subscription[]> {
    return (await this.all()).filter((s) => keyOf(s.customer) === keyOf(customer))
  }

  async all(): Promise<Subscription[]> { return (await this.#subs.entries()).map(([, s]) => decodeSubscription(s)) }

  /** The customer's subscription, or undefined (also for another customer's reference). */
  async get(customer: CustomerKey, ref: string): Promise<Subscription | undefined> {
    const s = await this.#subs.get(ref.toLowerCase())
    return s && keyOf(s.customer) === keyOf(customer) ? decodeSubscription(s) : undefined
  }

  update(customer: CustomerKey, ref: string, url: string): Promise<boolean> {
    return this.#serial(async () => {
      const s = await this.get(customer, ref)
      if (!s) return false
      return this.#subs.replace(s.subscriptionReference, { ...s, url, createdAt: s.createdAt.getTime() })
    })
  }

  /** Unsubscribes; pending deliveries of the subscription are dropped. */
  remove(customer: CustomerKey, ref: string): Promise<boolean> {
    return this.#serial(async () => {
      const s = await this.get(customer, ref)
      if (!s || !(await this.#subs.take(s.subscriptionReference))) return false
      for (const [, d] of await this.#deliveries.entries()) {
        if (d.subscriptionReference === s.subscriptionReference && d.state === 'PENDING') {
          await this.#deliveries.replace(String(d.eventId), { ...d, state: 'CANCELLED', nextAt: undefined })
        }
      }
      return true
    })
  }

  // --- Delivery --------------------------------------------------------------------

  /** The delivery log, oldest first. */
  async deliveries(): Promise<Delivery[]> { return (await this.#deliveries.entries()).map(([, d]) => decodeDelivery(d)) }

  /** The P 15 payload of one message for one subscription. */
  payload(eventId: number, s: Subscription, m: Message) {
    return {
      eventId: String(eventId),
      subscriptionReference: s.subscriptionReference,
      eventTimestamp: utcIso(this.clock.now()),
      messageResponseId: m.id,
      ...(m.requestId ? { messageRequestId: m.requestId } : {}),
      messageCreatedTime: utcIso(m.createdAt),
      messageType: m.type,
      regCode: m.clientCode,
      regCodeIssuer: m.clientCountry,
      bankCode: 'LHVEE',
    }
  }

  async #onMessage(m: Message) {
    const subs = await this.list({ code: m.clientCode, country: m.clientCountry })
    if (subs.length === 0) return
    const now = this.clock.now().getTime()
    for (const s of subs) {
      // The next free number: past every stored one, and taken with add, so a restarted
      // emulator or a second one on the namespace never repeats an eventId (decision 985).
      this.#eventSeq ??= Math.max(0, ...(await this.#deliveries.entries()).map(([k]) => Number(k)))
      for (;;) {
        const eventId = ++this.#eventSeq
        const d: Delivery = {
          eventId, subscriptionReference: s.subscriptionReference, messageResponseId: m.id,
          payload: JSON.stringify(this.payload(eventId, s, m)), state: 'PENDING', attempts: [], nextAt: now,
        }
        if (await this.#deliveries.add(String(eventId), encodeDelivery(d))) break
      }
    }
    await this.#prune()
    if (this.immediate) void this.#track(this.tick()).catch(() => undefined)
  }

  /** Keeps the delivery log bounded: finished deliveries beyond the last MAX_LOG go. */
  async #prune() {
    const all = await this.#deliveries.entries()
    let extra = all.length - MAX_LOG
    for (const [k, d] of all) {
      if (extra <= 0) break
      if (d.state !== 'PENDING') { await this.#deliveries.take(k); extra-- }
    }
  }

  /** Starts every due attempt; resolves when they have finished. Returns how many ran. */
  async tick(): Promise<number> {
    const now = this.clock.now().getTime()
    const due = (await this.#deliveries.entries()).map(([, d]) => d).filter((d) => d.state === 'PENDING' && d.nextAt !== undefined && d.nextAt <= now)
    // Prepared in the stored order, then sent at once: the deliveries start in event order.
    const ready: { id: string; url: string; payload: string }[] = []
    let ran = 0
    for (const d of due) {
      const r = await this.#track(this.#prepare(String(d.eventId), now))
      if (r) ran++
      if (r && r !== true) ready.push(r)
    }
    await Promise.all(ready.map((r) => this.#track(this.#send(r))))
    return ran
  }

  /** Waits until no attempt is in flight. */
  async idle(): Promise<void> {
    while (this.#inflight.size) await Promise.all([...this.#inflight])
  }

  #track<T>(p: Promise<T>): Promise<T> {
    this.#inflight.add(p)
    return p.finally(() => this.#inflight.delete(p))
  }

  /**
   * Takes a due delivery's claim and makes its attempt ready (decision 986): false when
   * another holds it or it is no longer due, true when it was cancelled, else what to send.
   * The claim is held until #send has stored the outcome.
   */
  async #prepare(id: string, now: number): Promise<{ id: string; url: string; payload: string } | boolean> {
    if (!(await this.#claims.add(id, true))) return false
    let sending = false
    try {
      const due = (d: StoredDelivery | undefined): d is StoredDelivery => !!d && d.state === 'PENDING' && d.nextAt !== undefined && d.nextAt <= now
      const ready = await this.#serial(async () => {
        const d = await this.#deliveries.get(id)
        if (!due(d)) return undefined
        const s = await this.#subs.get(d.subscriptionReference)
        if (!s) {
          await this.#deliveries.replace(id, { ...d, state: 'CANCELLED', nextAt: undefined })
          return undefined
        }
        return { id, url: s.url, payload: d.payload }
      })
      if (!ready) return true
      sending = true
      return ready
    } finally {
      if (!sending) await this.#claims.take(id)
    }
  }

  async #send(ready: { id: string; url: string; payload: string }) {
    const { id } = ready
    try {
      const attempt: Attempt = { at: this.clock.now(), url: ready.url }
      try {
        attempt.status = await this.deliver(ready.url, ready.payload)
      } catch (e) {
        attempt.error = (e as Error).message || String(e)
      }
      await this.#serial(async () => {
        const stored = await this.#deliveries.get(id)
        if (!stored) return
        const d = decodeDelivery(stored)
        d.attempts.push(attempt)
        if (d.state === 'PENDING') {
          if (attempt.status !== undefined && attempt.status >= 200 && attempt.status < 300) {
            d.state = 'DELIVERED'; d.nextAt = undefined
          } else {
            const retry = RETRY_DELAYS_MS[d.attempts.length - 1]
            if (retry === undefined) { d.state = 'FAILED'; d.nextAt = undefined } else d.nextAt = this.clock.now().getTime() + retry
          }
        }
        await this.#deliveries.replace(id, encodeDelivery(d))
      })
    } finally {
      await this.#claims.take(id)
    }
  }
}
