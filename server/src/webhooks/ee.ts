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
import type { Inbox, Message } from '../inbox.js'

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
}

export class EeWebhooks {
  readonly #subs = new Map<string, Subscription>()
  readonly deliveries: Delivery[] = []
  #eventSeq = 0
  #inflight = new Set<Promise<void>>()
  #running = new Set<Delivery>()
  deliver: Deliver
  readonly immediate: boolean

  constructor(inbox: Inbox, private clock: Clock, opts: EeWebhookOptions = {}) {
    this.deliver = opts.deliver ?? httpDeliver
    this.immediate = opts.immediate ?? true
    inbox.onAdd((m) => this.#onMessage(m))
  }

  // --- Subscriptions ---------------------------------------------------------------

  /** Subscribing a URL the customer already has returns that subscription (decision 420). */
  subscribe(customer: CustomerKey, url: string, eventType = EVENT_TYPE): Subscription {
    const existing = this.list(customer).find((s) => s.url === url)
    if (existing) return existing
    const s: Subscription = {
      subscriptionReference: randomUUID(), customer: { code: customer.code, country: customer.country }, url, eventType, createdAt: this.clock.now(),
    }
    this.#subs.set(s.subscriptionReference, s)
    return s
  }

  list(customer: CustomerKey): Subscription[] {
    return [...this.#subs.values()].filter((s) => keyOf(s.customer) === keyOf(customer))
  }

  all(): Subscription[] { return [...this.#subs.values()] }

  /** The customer's subscription, or undefined (also for another customer's reference). */
  get(customer: CustomerKey, ref: string): Subscription | undefined {
    const s = this.#subs.get(ref.toLowerCase())
    return s && keyOf(s.customer) === keyOf(customer) ? s : undefined
  }

  update(customer: CustomerKey, ref: string, url: string): boolean {
    const s = this.get(customer, ref)
    if (!s) return false
    s.url = url
    return true
  }

  /** Unsubscribes; pending deliveries of the subscription are dropped. */
  remove(customer: CustomerKey, ref: string): boolean {
    const s = this.get(customer, ref)
    if (!s) return false
    this.#subs.delete(s.subscriptionReference)
    for (const d of this.deliveries) {
      if (d.subscriptionReference === s.subscriptionReference && d.state === 'PENDING') { d.state = 'CANCELLED'; d.nextAt = undefined }
    }
    return true
  }

  // --- Delivery --------------------------------------------------------------------

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

  #onMessage(m: Message) {
    const subs = this.list({ code: m.clientCode, country: m.clientCountry })
    if (subs.length === 0) return
    const now = this.clock.now().getTime()
    for (const s of subs) {
      const eventId = ++this.#eventSeq
      this.deliveries.push({
        eventId, subscriptionReference: s.subscriptionReference, messageResponseId: m.id,
        payload: JSON.stringify(this.payload(eventId, s, m)), state: 'PENDING', attempts: [], nextAt: now,
      })
    }
    this.#prune()
    if (this.immediate) void this.tick().catch(() => undefined)
  }

  /** Keeps the delivery log bounded: finished deliveries beyond the last MAX_LOG go. */
  #prune() {
    let extra = this.deliveries.length - MAX_LOG
    for (let i = 0; extra > 0 && i < this.deliveries.length;) {
      if (this.deliveries[i].state !== 'PENDING') { this.deliveries.splice(i, 1); extra-- } else i++
    }
  }

  /** Starts every due attempt; resolves when they have finished. Returns how many ran. */
  async tick(): Promise<number> {
    const now = this.clock.now().getTime()
    const due = this.deliveries.filter((d) => d.state === 'PENDING' && d.nextAt !== undefined && d.nextAt <= now && !this.#running.has(d))
    await Promise.all(due.map((d) => this.#track(this.#attempt(d))))
    return due.length
  }

  /** Waits until no attempt is in flight. */
  async idle(): Promise<void> {
    while (this.#inflight.size) await Promise.all([...this.#inflight])
  }

  #track(p: Promise<void>) {
    this.#inflight.add(p)
    return p.finally(() => this.#inflight.delete(p))
  }

  async #attempt(d: Delivery) {
    const s = this.#subs.get(d.subscriptionReference)
    if (!s) { d.state = 'CANCELLED'; d.nextAt = undefined; return }
    this.#running.add(d)
    const attempt: Attempt = { at: this.clock.now(), url: s.url }
    d.attempts.push(attempt)
    try {
      attempt.status = await this.deliver(s.url, d.payload)
    } catch (e) {
      attempt.error = (e as Error).message || String(e)
    } finally {
      this.#running.delete(d)
    }
    if (d.state !== 'PENDING') return
    if (attempt.status !== undefined && attempt.status >= 200 && attempt.status < 300) {
      d.state = 'DELIVERED'; d.nextAt = undefined
      return
    }
    const retry = RETRY_DELAYS_MS[d.attempts.length - 1]
    if (retry === undefined) { d.state = 'FAILED'; d.nextAt = undefined; return }
    d.nextAt = this.clock.now().getTime() + retry
  }
}
