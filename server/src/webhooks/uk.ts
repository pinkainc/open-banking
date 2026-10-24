// LHV UK webhooks (G services/webhooks/*): one configuration per message type and
// customer; every new inbox message of a subscribed type is POSTed to the configured URL,
// signed with X-LHV-HMAC (hex HMAC-SHA256 of the raw body, key the UTF-8 shared secret).
// Optional message metadata, the full message in Base64, gzip, and marking the message
// processed on delivery. A delivery that is not answered 2xx is RETRY_PENDING and retried
// with the same eventId for up to 24 h from the event, then FAILED. History and replay
// (a new eventId) are kept per event. The EE system (P 15) is separate: webhooks/ee.ts.
//
// The event is created when the message is (eventTimestamp); the first attempt runs on
// the next turn of the event loop (decision 724), so the request that produced the
// message has been recorded and its X-Bank-Code is known. tick() runs due retries
// (main.ts every 15 s; tests and /_sim/webhooks/uk/tick), idle() waits for attempts.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { BoundedMap, type Bounds } from '../bounded.js'
import { DAY_MS, type Clock } from '../clock.js'
import { keyOf, type CustomerKey, type Directory } from '../directory.js'
import type { Inbox, Message } from '../inbox.js'
import { messageMetadata } from '../metadata.js'
import { isoLondon } from '../time.js'

export const EVENT_TYPE = 'GENERAL_WEBHOOK'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** Pause before each retry after a failure; the last one repeats (decision 723). */
export const RETRY_DELAYS_MS = [MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR]
/** Retries stop this long after the event was generated (G introduction-and-payload-format). */
export const RETRY_WINDOW_MS = DAY_MS
/** A successful delivery can be replayed while it is at most this old (G replay-webhooks). */
export const REPLAY_SUCCESS_MS = 5 * DAY_MS
/** Events kept for history and replay (decision 726). */
export const DEFAULT_EVENT_BOUNDS: Bounds = { ttlMs: 7 * DAY_MS, max: 10_000 }
export const DELIVERY_TIMEOUT_MS = 10_000

/** The documented HMAC: hex(HMAC-SHA256(key = UTF-8 secret, message = raw body bytes)). */
export function hmacHex(secret: string, body: string | Buffer): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(body).digest('hex')
}

/** A generated secret: 64 characters of [a-zA-Z0-9_-] (384 bits, G webhook-security). */
export const generateSecret = () => randomBytes(48).toString('base64url')

export interface UkRequest { url: string; headers: Record<string, string>; body: Buffer }
export interface UkResponse { status: number; contentLength: number }
/** Sends one webhook; resolves with the answer, rejects on a transport error. */
export type UkDeliver = (r: UkRequest) => Promise<UkResponse>

export const httpUkDeliver: UkDeliver = async (r) => {
  const res = await fetch(r.url, { method: 'POST', headers: r.headers, body: new Uint8Array(r.body), signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) })
  const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0))
  return { status: res.status, contentLength: buf.byteLength }
}

export interface Config {
  subscriptionReference: string
  /** The customer the configuration belongs to (the request's customer). */
  owner: CustomerKey
  messageType: string
  requestUrl: string
  active: boolean
  sharedSecret: string
  attachMetadata: boolean
  attachFullBody: boolean
  removeAfterDelivery: boolean
  compressionEnabled: boolean
  createdAt: Date
}

export type ConfigInput = Partial<Pick<Config, 'messageType' | 'requestUrl' | 'active' | 'sharedSecret' | 'attachMetadata' | 'attachFullBody' | 'removeAfterDelivery' | 'compressionEnabled'>>

/** The configuration as the API shows it; the secret only when asked (create and edit). */
export function configView(c: Config, withSecret = false) {
  return {
    subscriptionReference: c.subscriptionReference,
    eventType: EVENT_TYPE,
    messageType: c.messageType,
    requestUrl: c.requestUrl,
    active: c.active,
    ...(withSecret ? { sharedSecret: c.sharedSecret } : {}),
    attachMetadata: c.attachMetadata,
    attachFullBody: c.attachFullBody,
    removeAfterDelivery: c.removeAfterDelivery,
    compressionEnabled: c.compressionEnabled,
  }
}

/** The fields of a payload, in the order of every G sample. */
export interface PayloadFields {
  eventId: string
  eventTimestamp: string
  subscriptionReference: string
  messageResponseId: string
  messageRequestId?: string
  messageType: string
  messageCreatedTime: string
  /** regCode (samples) or clientCode (payload table, HMAC vector). */
  code: string
  country: string
  bankCode: string
  metadata?: unknown
  messageBase64?: string
}

/**
 * Field names of the customer: `regCode`/`regCodeIssuer` as every JSON sample (default),
 * or `clientCode`/`clientCountry` as the payload table and the HMAC vector (decision 721).
 */
export type Naming = 'regCode' | 'clientCode'

/** The payload JSON, compact, in the documented field order. */
export function payloadJson(f: PayloadFields, naming: Naming = 'regCode'): string {
  const [code, country] = naming === 'clientCode' ? ['clientCode', 'clientCountry'] : ['regCode', 'regCodeIssuer']
  return JSON.stringify({
    eventId: f.eventId,
    eventTimestamp: f.eventTimestamp,
    subscriptionReference: f.subscriptionReference,
    messageResponseId: f.messageResponseId,
    ...(f.messageRequestId ? { messageRequestId: f.messageRequestId } : {}),
    messageType: f.messageType,
    messageCreatedTime: f.messageCreatedTime,
    [code]: f.code,
    [country]: f.country,
    bankCode: f.bankCode,
    ...(f.metadata !== undefined ? { metadata: f.metadata } : {}),
    ...(f.messageBase64 !== undefined ? { messageBase64: f.messageBase64 } : {}),
  })
}

export type EventStatus = 'SUCCESS' | 'FAILED' | 'RETRY_PENDING'

export interface UkAttempt {
  at: Date
  url: string
  status?: number
  contentLength?: number
  latencyMs: number
  error?: string
  /** The X-LHV-HMAC sent. */
  hmac: string
  compressed: boolean
}

export interface UkEvent {
  eventId: string
  createdAt: Date
  subscriptionReference: string
  message: Message
  /** The message's customer. */
  customer: string
  /** Payload fields; bankCode is filled in on first use (decision 724). */
  fields: PayloadFields
  /** The body, fixed at the first attempt: every retry sends the same bytes. */
  payload?: string
  status: EventStatus
  attempts: UkAttempt[]
  nextAt?: number
  /** The event this one replays. */
  replayOf?: string
  /** Why it failed without a delivery (configuration removed, inactive, replayed). */
  reason?: string
}

export interface UkWebhookOptions {
  deliver?: UkDeliver
  /** Start the first attempt right after the message is created (default true). */
  immediate?: boolean
  /** The LHV entity of a message (X-Bank-Code of the request that produced it). */
  bankOf?: (m: Message) => string
  naming?: Naming
  events?: Bounds
}

export class UkWebhooks {
  readonly #configs = new Map<string, Config>()
  readonly #events: BoundedMap<string, UkEvent>
  #inflight = new Set<Promise<unknown>>()
  #running = new Set<UkEvent>()
  deliver: UkDeliver
  readonly immediate: boolean
  readonly naming: Naming
  readonly #bankOf: (m: Message) => string

  constructor(private inbox: Inbox, private directory: Directory, private clock: Clock, opts: UkWebhookOptions = {}) {
    this.deliver = opts.deliver ?? httpUkDeliver
    this.immediate = opts.immediate ?? true
    this.naming = opts.naming ?? 'regCode'
    this.#bankOf = opts.bankOf ?? (() => 'LHVUK')
    this.#events = new BoundedMap(clock, opts.events ?? DEFAULT_EVENT_BOUNDS)
    inbox.onAdd((m) => this.#onMessage(m))
  }

  // --- Configurations ----------------------------------------------------------------

  list(owner: CustomerKey): Config[] {
    return [...this.#configs.values()].filter((c) => keyOf(c.owner) === keyOf(owner))
  }

  all(): Config[] { return [...this.#configs.values()] }

  get(owner: CustomerKey, ref: string): Config | undefined {
    const c = this.#configs.get(ref.toLowerCase())
    return c && keyOf(c.owner) === keyOf(owner) ? c : undefined
  }

  /** The owner's configuration of a message type, if any (active or not). */
  forType(owner: CustomerKey, messageType: string): Config | undefined {
    return this.list(owner).find((c) => c.messageType === messageType)
  }

  /** A new configuration; the caller has checked the mandatory fields and duplicates. */
  create(owner: CustomerKey, input: ConfigInput & Pick<Config, 'messageType' | 'requestUrl' | 'active'>): Config {
    const c: Config = {
      subscriptionReference: randomUUID(),
      owner: { code: owner.code, country: owner.country },
      messageType: input.messageType,
      requestUrl: input.requestUrl,
      active: input.active,
      sharedSecret: input.sharedSecret ?? generateSecret(),
      attachMetadata: input.attachMetadata ?? false,
      attachFullBody: input.attachFullBody ?? false,
      removeAfterDelivery: input.removeAfterDelivery ?? false,
      compressionEnabled: input.compressionEnabled ?? false,
      createdAt: this.clock.now(),
    }
    this.#configs.set(c.subscriptionReference, c)
    return c
  }

  /** Edits the given fields; an absent secret is replaced by a new one (G "Editing a Config"). */
  update(c: Config, input: ConfigInput): Config {
    for (const k of ['messageType', 'requestUrl', 'active', 'attachMetadata', 'attachFullBody', 'removeAfterDelivery', 'compressionEnabled'] as const) {
      if (input[k] !== undefined) (c as any)[k] = input[k]
    }
    c.sharedSecret = input.sharedSecret ?? generateSecret()
    if (!c.active) this.#stop(c.subscriptionReference, 'Webhook configuration is not active')
    return c
  }

  remove(c: Config) {
    this.#configs.delete(c.subscriptionReference)
    this.#stop(c.subscriptionReference, 'Webhook configuration was deleted')
  }

  /** Pending events of a configuration fail: nothing more is sent for them. */
  #stop(ref: string, reason: string) {
    for (const [, e] of this.#events.entries()) {
      if (e.subscriptionReference === ref && e.status === 'RETRY_PENDING') this.#fail(e, reason)
    }
  }

  #fail(e: UkEvent, reason?: string) {
    e.status = 'FAILED'
    e.nextAt = undefined
    if (reason) e.reason = reason
  }

  // --- Events --------------------------------------------------------------------------

  /** Active configurations a message goes to: its customer's, and its service providers'. */
  #targets(m: Message): Config[] {
    const k = keyOf({ code: m.clientCode, country: m.clientCountry })
    return this.all().filter((c) => {
      if (!c.active || c.messageType !== m.type) return false
      if (keyOf(c.owner) === k) return true
      return this.directory.get(c.owner)?.connected?.some((x) => keyOf(x) === k) ?? false
    })
  }

  #onMessage(m: Message) {
    const targets = this.#targets(m)
    if (targets.length === 0) return
    for (const c of targets) this.#newEvent(c, m)
    if (this.immediate) this.#kick()
  }

  #newEvent(c: Config, m: Message, replayOf?: UkEvent): UkEvent {
    const now = this.clock.now()
    const eventId = randomUUID()
    const e: UkEvent = {
      eventId, createdAt: now, subscriptionReference: c.subscriptionReference, message: m,
      customer: keyOf({ code: m.clientCode, country: m.clientCountry }),
      fields: {
        eventId, eventTimestamp: isoLondon(now), subscriptionReference: c.subscriptionReference,
        messageResponseId: m.id, messageRequestId: m.requestId, messageType: m.type, messageCreatedTime: isoLondon(m.createdAt),
        code: m.clientCode, country: m.clientCountry, bankCode: replayOf?.fields.bankCode ?? '',
        metadata: c.attachMetadata ? messageMetadata(m) : undefined,
        messageBase64: c.attachFullBody ? (typeof m.body === 'string' ? Buffer.from(m.body, 'utf8') : m.body).toString('base64') : undefined,
      },
      status: 'RETRY_PENDING', attempts: [], nextAt: now.getTime(),
      ...(replayOf ? { replayOf: replayOf.eventId } : {}),
    }
    this.#events.set(eventId, e)
    return e
  }

  #bank(e: UkEvent): string {
    if (!e.fields.bankCode) e.fields.bankCode = this.#bankOf(e.message)
    return e.fields.bankCode
  }

  /** The body of an event (fixed at its first attempt). */
  body(e: UkEvent): string {
    this.#bank(e)
    return e.payload ?? payloadJson(e.fields, this.naming)
  }

  /** The history's `message`: the payload without metadata and messageBase64. */
  summary(e: UkEvent): Record<string, unknown> {
    this.#bank(e)
    return JSON.parse(payloadJson({ ...e.fields, metadata: undefined, messageBase64: undefined }, this.naming))
  }

  event(id: string): UkEvent | undefined { return this.#events.get(id.toLowerCase()) }

  /** Events whose message belongs to one of the customers, newest first. */
  events(customers?: Set<string>): UkEvent[] {
    return this.#events.entries().map(([, e]) => e).filter((e) => !customers || customers.has(e.customer)).reverse()
  }

  /**
   * Replays one event of the caller's customers: a new event (new eventId) of the same
   * message to the configuration as it is now. Returns the new event or the error text.
   */
  replay(customers: Set<string>, contract: string, id: string): UkEvent | string {
    const notFound = `Cannot replay webhook. WebhookResponse not found for contract ${contract} and webhook eventId: ${id}`
    const e = /^[0-9a-f-]{36}$/i.test(id) ? this.event(id) : undefined
    if (!e || !customers.has(e.customer)) return notFound
    const c = this.#configs.get(e.subscriptionReference)
    if (!c || !c.active) return `Cannot replay webhook. No valid and active webhook configuration found for webhook response with eventId: ${id}`
    if (e.status === 'SUCCESS' && this.clock.now().getTime() - e.createdAt.getTime() > REPLAY_SUCCESS_MS) {
      return `Cannot replay webhook. Successfully delivered webhook with eventId: ${id} is older than 120 hours`
    }
    if (e.status === 'RETRY_PENDING') this.#fail(e, 'Replayed: the scheduled retry was cancelled')
    this.#bank(e)
    const fresh = this.#newEvent(c, e.message, e)
    if (this.immediate) this.#kick()
    return fresh
  }

  // --- Delivery ------------------------------------------------------------------------

  /** Runs the due attempts on the next turn of the event loop (tracked by idle()). */
  #kick() {
    this.#track(new Promise<void>((r) => setImmediate(r)).then(() => this.tick()).catch(() => undefined))
  }

  /** Starts every due attempt; resolves when they have finished. Returns how many ran. */
  async tick(): Promise<number> {
    const now = this.clock.now().getTime()
    const due = this.#events.entries().map(([, e]) => e)
      .filter((e) => e.status === 'RETRY_PENDING' && e.nextAt !== undefined && e.nextAt <= now && !this.#running.has(e))
    await Promise.all(due.map((e) => this.#track(this.#attempt(e))))
    return due.length
  }

  async idle(): Promise<void> {
    while (this.#inflight.size) await Promise.all([...this.#inflight])
  }

  #track<T>(p: Promise<T>): Promise<T> {
    this.#inflight.add(p)
    return p.finally(() => this.#inflight.delete(p))
  }

  async #attempt(e: UkEvent) {
    const c = this.#configs.get(e.subscriptionReference)
    if (!c) return this.#fail(e, 'Webhook configuration was deleted')
    if (!c.active) return this.#fail(e, 'Webhook configuration is not active')
    e.payload = this.body(e)
    const raw = Buffer.from(e.payload, 'utf8')
    const hmac = hmacHex(c.sharedSecret, raw)
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-lhv-hmac': hmac }
    if (c.compressionEnabled) headers['content-encoding'] = 'gzip'
    const attempt: UkAttempt = { at: this.clock.now(), url: c.requestUrl, latencyMs: 0, hmac, compressed: c.compressionEnabled }
    e.attempts.push(attempt)
    this.#running.add(e)
    const started = performance.now()
    try {
      const res = await this.deliver({ url: c.requestUrl, headers, body: c.compressionEnabled ? gzipSync(raw) : raw })
      attempt.status = res.status
      attempt.contentLength = res.contentLength
    } catch (err) {
      attempt.error = (err as Error).message || String(err)
    } finally {
      attempt.latencyMs = Math.round(performance.now() - started)
      this.#running.delete(e)
    }
    if (e.status !== 'RETRY_PENDING') return
    if (attempt.status !== undefined && attempt.status >= 200 && attempt.status < 300) {
      e.status = 'SUCCESS'
      e.nextAt = undefined
      if (c.removeAfterDelivery) {
        this.inbox.delete({ customers: new Set([e.customer]) }, e.message.id)
      }
      return
    }
    const delay = RETRY_DELAYS_MS[Math.min(e.attempts.length - 1, RETRY_DELAYS_MS.length - 1)]
    const next = this.clock.now().getTime() + delay
    if (next > e.createdAt.getTime() + RETRY_WINDOW_MS) return this.#fail(e)
    e.nextAt = next
  }
}
