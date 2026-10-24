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
import type { Bounds } from '../bounded.js'
import { DAY_MS, type Clock } from '../clock.js'
import { keyOf, type CustomerKey, type DirectoryStore } from '../directory.js'
import { requestRecorded } from '../ids.js'
import type { InboxStore, Message } from '../inbox.js'
import { claimName, memoryKeyed, UNBOUNDED, updateKeyed, type KeyedFactory, type KeyedStore } from '../keyed.js'
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
  bankOf?: (m: Message) => string | Promise<string>
  naming?: Naming
  events?: Bounds
  /** Where configurations, events and claims are kept (decision 985); default in memory. */
  keyed?: KeyedFactory
}

/** An attempt ready to send: the event's claim is held. */
interface Ready { id: string; c: Config; payload: string }

/** How long an attempt holds its event (decision 986): longer than a delivery may take. */
export const CLAIM_MS = 5 * MINUTE

// Stored forms (decision 985): times in ms, the message with its body (Base64 when binary).
interface StoredConfig extends Omit<Config, 'createdAt'> { createdAt: number }
interface StoredMessage extends Omit<Message, 'createdAt' | 'restoredAt' | 'body'> { createdAt: number; body: string; binary?: true }
interface StoredAttempt extends Omit<UkAttempt, 'at'> { at: number }
interface StoredEvent extends Omit<UkEvent, 'createdAt' | 'message' | 'attempts'> { createdAt: number; message: StoredMessage; attempts: StoredAttempt[] }

const encodeConfig = (c: Config): StoredConfig => ({ ...c, owner: { code: c.owner.code, country: c.owner.country }, createdAt: c.createdAt.getTime() })
const decodeConfig = (s: StoredConfig): Config => ({ ...s, owner: { ...s.owner }, createdAt: new Date(s.createdAt) })
const encodeEvent = (e: UkEvent): StoredEvent => JSON.parse(JSON.stringify({
  ...e, createdAt: e.createdAt.getTime(),
  message: {
    id: e.message.id, requestId: e.message.requestId, type: e.message.type, clientCode: e.message.clientCode, clientCountry: e.message.clientCountry,
    createdAt: e.message.createdAt.getTime(), contentType: e.message.contentType, seq: e.message.seq,
    ...(typeof e.message.body === 'string' ? { body: e.message.body } : { body: e.message.body.toString('base64'), binary: true }),
  },
  attempts: e.attempts.map((a) => ({ ...a, at: a.at.getTime() })),
}))
const decodeEvent = (s: StoredEvent): UkEvent => {
  const { binary, ...m } = s.message
  return {
    ...s, createdAt: new Date(s.createdAt), fields: { ...s.fields },
    message: { ...m, createdAt: new Date(m.createdAt), body: binary ? Buffer.from(m.body, 'base64') : m.body },
    attempts: s.attempts.map((a) => ({ ...a, at: new Date(a.at) })),
  }
}

export class UkWebhooks {
  readonly #configs: KeyedStore<StoredConfig>
  readonly #events: KeyedStore<StoredEvent>
  /** One attempt of an event at a time, across emulators on a namespace (decision 986). */
  readonly #claims: KeyedStore<true>
  /** The message type each owner has a configuration of, `<owner key>|<type>` → its subscriptionReference (decision 1012). */
  readonly #types: KeyedStore<string>
  #queue: Promise<unknown> = Promise.resolve()
  #inflight = new Set<Promise<unknown>>()
  deliver: UkDeliver
  readonly immediate: boolean
  readonly naming: Naming
  readonly #bankOf: (m: Message) => string | Promise<string>

  constructor(private inbox: InboxStore, private directory: DirectoryStore, private clock: Clock, opts: UkWebhookOptions = {}) {
    this.deliver = opts.deliver ?? httpUkDeliver
    this.immediate = opts.immediate ?? true
    this.naming = opts.naming ?? 'regCode'
    this.#bankOf = opts.bankOf ?? (() => 'LHVUK')
    const keyed = opts.keyed ?? memoryKeyed(clock)
    this.#configs = keyed('uk-webhook-configs', UNBOUNDED)
    this.#events = keyed('uk-webhook-events', opts.events ?? DEFAULT_EVENT_BOUNDS)
    this.#claims = keyed('uk-webhook-claims', { ttlMs: CLAIM_MS, max: 100_000 })
    this.#types = keyed('uk-webhook-types', UNBOUNDED)
    inbox.onAdd((m) => this.#onMessage(m))
  }

  /** Changes of configurations and events run one after the other in this process (decision 986). */
  #serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(f, f)
    this.#queue = run.catch(() => undefined)
    return run
  }

  async #save(e: UkEvent) { await this.#events.replace(e.eventId, encodeEvent(e)) }

  // --- Configurations ----------------------------------------------------------------

  async list(owner: CustomerKey): Promise<Config[]> {
    return (await this.all()).filter((c) => keyOf(c.owner) === keyOf(owner))
  }

  async all(): Promise<Config[]> { return (await this.#configs.entries()).map(([, c]) => decodeConfig(c)) }

  async #config(ref: string): Promise<Config | undefined> {
    const c = await this.#configs.get(ref.toLowerCase())
    return c && decodeConfig(c)
  }

  async get(owner: CustomerKey, ref: string): Promise<Config | undefined> {
    const c = await this.#config(ref)
    return c && keyOf(c.owner) === keyOf(owner) ? c : undefined
  }

  /** The owner's configuration of a message type, if any (active or not). */
  async forType(owner: CustomerKey, messageType: string): Promise<Config | undefined> {
    return (await this.list(owner)).find((c) => c.messageType === messageType)
  }

  /**
   * Takes an owner's message type for a configuration, once for the namespace (decision
   * 1012): whether it is this configuration's now.
   */
  async #claimType(owner: CustomerKey, messageType: string, ref: string): Promise<boolean> {
    const shows = async (holder: string) => (await this.#config(holder))?.messageType === messageType
    return (await claimName(this.#types, `${keyOf(owner)}|${messageType}`, ref, shows)) === ref
  }
  async #releaseType(owner: CustomerKey, messageType: string, ref: string) {
    const k = `${keyOf(owner)}|${messageType}`
    if ((await this.#types.get(k)) === ref) await this.#types.take(k)
  }

  /** A new configuration; the caller has checked the mandatory fields. Undefined: the owner has one of that type. */
  create(owner: CustomerKey, input: ConfigInput & Pick<Config, 'messageType' | 'requestUrl' | 'active'>): Promise<Config | undefined> {
    return this.#serial(async () => {
      if (await this.forType(owner, input.messageType)) return undefined
      const subscriptionReference = randomUUID()
      // The type is taken before the configuration is stored: of two emulators at once, one makes it.
      if (!(await this.#claimType(owner, input.messageType, subscriptionReference))) return undefined
      const c: Config = {
        subscriptionReference,
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
      await this.#configs.add(c.subscriptionReference, encodeConfig(c))
      return c
    })
  }

  /**
   * Edits the given fields; an absent secret is replaced by a new one (G "Editing a Config").
   * Applied to the stored configuration with a compare-and-set, again on the newer one when
   * another emulator edited it meanwhile, so both edits stay (decision 1012). Undefined: the
   * new message type is taken by another configuration of the owner.
   */
  update(cfg: Config, input: ConfigInput): Promise<Config | undefined> {
    return this.#serial(async () => {
      const ref = cfg.subscriptionReference
      const before = (await this.#config(ref)) ?? cfg
      const retyped = input.messageType !== undefined && input.messageType !== before.messageType
      if (retyped && !(await this.#claimType(before.owner, input.messageType!, ref))) return undefined
      const secret = input.sharedSecret ?? generateSecret()
      const edit = (c: Config) => {
        for (const k of ['messageType', 'requestUrl', 'active', 'attachMetadata', 'attachFullBody', 'removeAfterDelivery', 'compressionEnabled'] as const) {
          if (input[k] !== undefined) (c as any)[k] = input[k]
        }
        c.sharedSecret = secret
        return c
      }
      const s = await updateKeyed(this.#configs, ref, (stored) => stored && encodeConfig(edit(decodeConfig(stored))))
      const c = s ? decodeConfig(s) : edit(before) // removed meanwhile: answered as edited, nothing stored (as before)
      if (retyped) await this.#releaseType(before.owner, s ? before.messageType : input.messageType!, ref)
      if (!c.active) await this.#stop(ref, 'Webhook configuration is not active')
      return c
    })
  }

  remove(c: Config): Promise<void> {
    return this.#serial(async () => {
      await this.#configs.take(c.subscriptionReference)
      await this.#releaseType(c.owner, c.messageType, c.subscriptionReference)
      await this.#stop(c.subscriptionReference, 'Webhook configuration was deleted')
    })
  }

  /** Pending events of a configuration fail: nothing more is sent for them. */
  async #stop(ref: string, reason: string) {
    for (const [, s] of await this.#events.entries()) {
      if (s.subscriptionReference !== ref || s.status !== 'RETRY_PENDING') continue
      const e = decodeEvent(s)
      this.#fail(e, reason)
      await this.#save(e)
    }
  }

  #fail(e: UkEvent, reason?: string) {
    e.status = 'FAILED'
    e.nextAt = undefined
    if (reason) e.reason = reason
  }

  // --- Events --------------------------------------------------------------------------

  /** Active configurations a message goes to: its customer's, and its service providers'. */
  async #targets(m: Message): Promise<Config[]> {
    const k = keyOf({ code: m.clientCode, country: m.clientCountry })
    const out: Config[] = []
    for (const c of await this.all()) {
      if (!c.active || c.messageType !== m.type) continue
      if (keyOf(c.owner) === k || ((await this.directory.get(c.owner))?.connected?.some((x) => keyOf(x) === k) ?? false)) out.push(c)
    }
    return out
  }

  async #onMessage(m: Message) {
    const targets = await this.#targets(m)
    if (targets.length === 0) return
    for (const c of targets) await this.#newEvent(c, m)
    if (this.immediate) this.#kick()
  }

  async #newEvent(c: Config, m: Message, replayOf?: UkEvent): Promise<UkEvent> {
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
    await this.#events.add(eventId, encodeEvent(e))
    return e
  }

  async #bank(e: UkEvent): Promise<string> {
    if (!e.fields.bankCode) e.fields.bankCode = await this.#bankOf(e.message)
    return e.fields.bankCode
  }

  /** The body of an event (fixed at its first attempt). */
  async body(e: UkEvent): Promise<string> {
    await this.#bank(e)
    return e.payload ?? payloadJson(e.fields, this.naming)
  }

  /** The history's `message`: the payload without metadata and messageBase64. */
  async summary(e: UkEvent): Promise<Record<string, unknown>> {
    await this.#bank(e)
    return JSON.parse(payloadJson({ ...e.fields, metadata: undefined, messageBase64: undefined }, this.naming))
  }

  async event(id: string): Promise<UkEvent | undefined> {
    const s = await this.#events.get(id.toLowerCase())
    return s && decodeEvent(s)
  }

  /** Events whose message belongs to one of the customers, newest first. */
  async events(customers?: Set<string>): Promise<UkEvent[]> {
    return (await this.#events.entries()).filter(([, e]) => !customers || customers.has(e.customer)).reverse().map(([, e]) => decodeEvent(e))
  }

  /**
   * Replays one event of the caller's customers: a new event (new eventId) of the same
   * message to the configuration as it is now. Returns the new event or the error text.
   */
  replay(customers: Set<string>, contract: string, id: string): Promise<UkEvent | string> {
    return this.#serial(async () => {
      const notFound = `Cannot replay webhook. WebhookResponse not found for contract ${contract} and webhook eventId: ${id}`
      const e = /^[0-9a-f-]{36}$/i.test(id) ? await this.event(id) : undefined
      if (!e || !customers.has(e.customer)) return notFound
      const c = await this.#config(e.subscriptionReference)
      if (!c || !c.active) return `Cannot replay webhook. No valid and active webhook configuration found for webhook response with eventId: ${id}`
      if (e.status === 'SUCCESS' && this.clock.now().getTime() - e.createdAt.getTime() > REPLAY_SUCCESS_MS) {
        return `Cannot replay webhook. Successfully delivered webhook with eventId: ${id} is older than 120 hours`
      }
      if (e.status === 'RETRY_PENDING') {
        this.#fail(e, 'Replayed: the scheduled retry was cancelled')
        await this.#save(e)
      }
      await this.#bank(e)
      const fresh = await this.#newEvent(c, e.message, e)
      if (this.immediate) this.#kick()
      return fresh
    })
  }

  // --- Delivery ------------------------------------------------------------------------

  /** Runs the due attempts on the next turn of the event loop (tracked by idle()). */
  #kick() {
    this.#track(new Promise<void>((r) => setImmediate(r)).then(() => this.tick()).catch(() => undefined))
  }

  /** Starts every due attempt; resolves when they have finished. Returns how many ran. */
  async tick(): Promise<number> {
    const now = this.clock.now().getTime()
    const due = (await this.#events.entries()).map(([, e]) => e)
      .filter((e) => e.status === 'RETRY_PENDING' && e.nextAt !== undefined && e.nextAt <= now)
    // Prepared in the stored order, then sent at once: the deliveries start in event order.
    const ready: Ready[] = []
    let ran = 0
    for (const e of due) {
      const r = await this.#track(this.#prepare(e.eventId, now))
      if (r) ran++
      if (r && r !== true) ready.push(r)
    }
    await Promise.all(ready.map((r) => this.#track(this.#send(r))))
    return ran
  }

  async idle(): Promise<void> {
    while (this.#inflight.size) await Promise.all([...this.#inflight])
  }

  #track<T>(p: Promise<T>): Promise<T> {
    this.#inflight.add(p)
    return p.finally(() => this.#inflight.delete(p))
  }

  /**
   * Takes a due event's claim and makes its attempt ready (decision 986): false when another
   * holds it or it is no longer due, true when it failed without a delivery, else what to send.
   * The claim is held until #send has stored the outcome.
   */
  async #prepare(id: string, now: number): Promise<Ready | boolean> {
    if (!(await this.#claims.add(id, true))) return false
    let sending = false
    try {
      const due = (e: UkEvent | undefined): e is UkEvent => !!e && e.status === 'RETRY_PENDING' && e.nextAt !== undefined && e.nextAt <= now
      const first = await this.event(id)
      if (!due(first)) return false
      // The request behind the message is recorded first, so its bank code is known (decision 987).
      if (first.payload === undefined) await requestRecorded(first.message.requestId)
      const ready = await this.#serial(async () => {
        const e = await this.event(id)
        if (!due(e)) return undefined
        const c = await this.#config(e.subscriptionReference)
        if (!c || !c.active) {
          this.#fail(e, c ? 'Webhook configuration is not active' : 'Webhook configuration was deleted')
          await this.#save(e)
          return undefined
        }
        if (e.payload === undefined) {
          e.payload = await this.body(e)
          await this.#save(e)
        }
        return { id, c, payload: e.payload }
      })
      if (!ready) return true
      sending = true
      return ready
    } finally {
      if (!sending) await this.#claims.take(id)
    }
  }

  async #send({ id, c, payload }: Ready) {
    try {
      const raw = Buffer.from(payload, 'utf8')
      const hmac = hmacHex(c.sharedSecret, raw)
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-lhv-hmac': hmac }
      if (c.compressionEnabled) headers['content-encoding'] = 'gzip'
      const attempt: UkAttempt = { at: this.clock.now(), url: c.requestUrl, latencyMs: 0, hmac, compressed: c.compressionEnabled }
      const started = performance.now()
      try {
        const res = await this.deliver({ url: c.requestUrl, headers, body: c.compressionEnabled ? gzipSync(raw) : raw })
        attempt.status = res.status
        attempt.contentLength = res.contentLength
      } catch (err) {
        attempt.error = (err as Error).message || String(err)
      } finally {
        attempt.latencyMs = Math.round(performance.now() - started)
      }
      const delivered = await this.#serial(async () => {
        const e = await this.event(id)
        if (!e) return undefined
        e.attempts.push(attempt)
        let ok = false
        // Failed meanwhile (configuration changed, replayed): the attempt is recorded, the status kept.
        if (e.status === 'RETRY_PENDING') {
          if (attempt.status !== undefined && attempt.status >= 200 && attempt.status < 300) {
            e.status = 'SUCCESS'
            e.nextAt = undefined
            ok = true
          } else {
            const delay = RETRY_DELAYS_MS[Math.min(e.attempts.length - 1, RETRY_DELAYS_MS.length - 1)]
            const next = this.clock.now().getTime() + delay
            if (next > e.createdAt.getTime() + RETRY_WINDOW_MS) this.#fail(e)
            else e.nextAt = next
          }
        }
        await this.#save(e)
        return ok ? e : undefined
      })
      if (delivered && c.removeAfterDelivery) await this.inbox.delete({ customers: new Set([delivered.customer]) }, delivered.message.id)
    } finally {
      await this.#claims.take(id)
    }
  }
}
