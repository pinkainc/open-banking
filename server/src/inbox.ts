// The message box: every response and notification waits here until the client
// confirms it, with the v1 DELETE or the v2 PATCH /v2/messages/processed (one state:
// a deleted message is a processed one, decision 620). Reads return the oldest
// unconfirmed message first; unread messages older than the retention period (five days)
// are gone. A processed message is kept, body included, until it is a week old, so v2
// can list it (includeProcessed) and undelete it; then it is archived.
import { BoundedMap, DEFAULT_BOUNDS, type Bounds } from './bounded.js'
import { DAY_MS, type Clock } from './clock.js'
import { keyOf, type CustomerKey } from './directory.js'
import { responseId } from './ids.js'

export interface Message {
  id: string
  requestId?: string
  type: string
  clientCode: string
  clientCountry: string
  createdAt: Date
  body: string | Buffer
  contentType: string
  seq: number
  /** When it was undeleted (v2 messageProcessed=false): its five days run again from then. */
  restoredAt?: Date
}

/** Processed messages older than this (from creation) are archived: no undelete (G "older than a week"). */
export const ARCHIVE_MS = 7 * DAY_MS

/** A message as v2 lists it: pending or processed. */
export interface Entry { message: Message; processed: boolean }

/** Why a v2 status change was refused: an id the caller never had, or one already archived. */
export type ProcessedRefusal = { id: string; reason: 'unknown' | 'archived' }

/** Which customers' messages a request may see, and an optional type filter. */
export interface Scope { customers: Set<string>; type?: string }

export class Inbox {
  #messages = new Map<string, Message>()
  /**
   * Ids that existed and are gone (confirmed or expired), with their owner: a repeat
   * DELETE is 200 while remembered (decision 504), 404 after.
   */
  #gone: BoundedMap<string, string>
  /** Confirmed messages, kept for the v2 list and undelete until archived (decision 621). */
  #processed: BoundedMap<string, Message>
  #seq = 0
  #listeners: ((m: Message) => void)[] = []
  constructor(private clock: Clock, private retentionMs = 5 * DAY_MS, tombstones: Bounds = DEFAULT_BOUNDS.tombstones,
    processed: Bounds = DEFAULT_BOUNDS.processed) {
    this.#gone = new BoundedMap(clock, tombstones)
    this.#processed = new BoundedMap(clock, processed)
  }

  /** Remembered tombstones (tests, diagnostics). */
  get tombstones() { return this.#gone.size }
  /** Processed messages still kept (tests, diagnostics). */
  get processedKept() { return this.#processed.size }

  /** Called with every new message, after it is stored (EE webhook delivery). */
  onAdd(listener: (m: Message) => void) { this.#listeners.push(listener) }

  add(m: { customer: CustomerKey; type: string; body: string | Buffer; requestId?: string; contentType?: string }): Message {
    const msg: Message = {
      id: responseId(), requestId: m.requestId, type: m.type,
      clientCode: m.customer.code, clientCountry: m.customer.country,
      createdAt: this.clock.now(), body: m.body, contentType: m.contentType ?? 'application/xml', seq: ++this.#seq,
    }
    this.#messages.set(msg.id, msg)
    for (const l of this.#listeners) l(msg)
    return msg
  }

  #expired(m: Message) { return this.clock.now().getTime() - (m.restoredAt ?? m.createdAt).getTime() > this.retentionMs }
  #archived(m: Message) { return this.clock.now().getTime() - m.createdAt.getTime() >= ARCHIVE_MS }

  /** Drops expired messages, archived processed ones and tombstones. Reads skip them anyway; this frees the memory. */
  purge(): number {
    let n = 0
    for (const m of this.#messages.values()) if (this.#expired(m)) { this.#remove(m); n++ }
    for (const [id, m] of this.#processed.entries()) if (this.#archived(m)) this.#processed.delete(id)
    this.#processed.purge()
    this.#gone.purge()
    return n
  }

  #owned(m: Message, s: Scope) { return s.customers.has(keyOf({ code: m.clientCode, country: m.clientCountry })) }

  #inScope(m: Message, s: Scope) {
    return this.#owned(m, s) && (!s.type || m.type === s.type) && !this.#expired(m)
  }

  /** A processed message of the caller that is not archived yet. */
  #kept(s: Scope, id: string): Message | undefined {
    const m = this.#processed.get(id)
    if (!m || !this.#owned(m, s)) return undefined
    if (this.#archived(m)) { this.#processed.delete(id); return undefined }
    return m
  }

  /** Pending messages in scope, oldest first. */
  list(s: Scope, limit = Infinity): Message[] {
    const out: Message[] = []
    for (const m of this.#messages.values()) if (this.#inScope(m, s)) out.push(m)
    out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq)
    return out.slice(0, limit)
  }

  next(s: Scope): Message | undefined { return this.list(s, 1)[0] }
  count(s: Scope): number { return this.list(s).length }

  get(s: Scope, id: string): Message | undefined {
    const m = this.#messages.get(id)
    return m && this.#inScope(m, { customers: s.customers }) ? m : undefined
  }

  #remove(m: Message) {
    this.#messages.delete(m.id)
    this.#gone.set(m.id, keyOf({ code: m.clientCode, country: m.clientCountry }))
  }

  /** Confirmed: out of the queue, kept as processed until archived. */
  #confirm(m: Message) {
    this.#remove(m)
    if (!this.#archived(m)) this.#processed.set(m.id, m)
  }

  /** A pending message of the caller (any type), unless expired. */
  #pending(s: Scope, id: string): Message | undefined {
    const m = this.#messages.get(id)
    return m && this.#owned(m, s) && !this.#expired(m) ? m : undefined
  }

  /**
   * Confirms a message. 'deleted' also covers an id deleted (or expired) before, as
   * documented; 'unknown' is an id that never existed for this caller (404).
   */
  delete(s: Scope, id: string): 'deleted' | 'unknown' {
    const m = this.#messages.get(id)
    if (m && this.#owned(m, s)) { this.#expired(m) ? this.#remove(m) : this.#confirm(m); return 'deleted' }
    const owner = this.#gone.get(id)
    return this.#kept(s, id) || (owner !== undefined && s.customers.has(owner)) ? 'deleted' : 'unknown'
  }

  /**
   * The v2 list: pending messages in scope and, with `includeProcessed`, the processed
   * ones not archived yet, oldest first; optionally only those of one request.
   */
  entries(s: Scope, o: { includeProcessed?: boolean; requestId?: string } = {}): Entry[] {
    const want = (m: Message) => (!s.type || m.type === s.type) && (o.requestId === undefined || m.requestId === o.requestId)
    const out: Entry[] = this.list(s).filter(want).map((message) => ({ message, processed: false }))
    if (o.includeProcessed) {
      for (const [id] of this.#processed.entries()) {
        const m = this.#kept(s, id)
        if (m && want(m)) out.push({ message: m, processed: true })
      }
      out.sort((a, b) => a.message.createdAt.getTime() - b.message.createdAt.getTime() || a.message.seq - b.message.seq)
    }
    return out
  }

  /**
   * PATCH /v2/messages/processed: all changes or none (G "400 - not updated: No messages
   * updated"). true confirms (as DELETE; an id confirmed before is accepted again), false
   * undeletes a processed message that is not archived (a pending one stays as it is).
   */
  setProcessed(s: Scope, changes: { id: string; processed: boolean }[]): ProcessedRefusal | undefined {
    for (const { id, processed } of changes) {
      if (this.#pending(s, id) || this.#kept(s, id)) continue
      const owner = this.#gone.get(id)
      const gone = owner !== undefined && s.customers.has(owner)
      if (processed && gone) continue
      return { id, reason: gone ? 'archived' : 'unknown' }
    }
    for (const { id, processed } of changes) {
      const pending = this.#pending(s, id)
      if (processed) { if (pending) this.#confirm(pending); continue }
      const m = this.#kept(s, id)
      if (!m) continue
      this.#processed.delete(id)
      this.#gone.delete(id)
      m.restoredAt = this.clock.now()
      this.#messages.set(id, m)
    }
    return undefined
  }
}
