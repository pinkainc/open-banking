// The message box: every response and notification waits here until the client
// confirms it with DELETE. Reads return the oldest unconfirmed message first; unread
// messages older than the retention period (five days) are gone.
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
  body: string
  contentType: string
  seq: number
}

/** Which customers' messages a request may see, and an optional type filter. */
export interface Scope { customers: Set<string>; type?: string }

export class Inbox {
  #messages = new Map<string, Message>()
  /**
   * Ids that existed and are gone (confirmed or expired), with their owner: a repeat
   * DELETE is 200 while remembered (decision 504), 404 after.
   */
  #gone: BoundedMap<string, string>
  #seq = 0
  #listeners: ((m: Message) => void)[] = []
  constructor(private clock: Clock, private retentionMs = 5 * DAY_MS, tombstones: Bounds = DEFAULT_BOUNDS.tombstones) {
    this.#gone = new BoundedMap(clock, tombstones)
  }

  /** Remembered tombstones (tests, diagnostics). */
  get tombstones() { return this.#gone.size }

  /** Called with every new message, after it is stored (EE webhook delivery). */
  onAdd(listener: (m: Message) => void) { this.#listeners.push(listener) }

  add(m: { customer: CustomerKey; type: string; body: string; requestId?: string; contentType?: string }): Message {
    const msg: Message = {
      id: responseId(), requestId: m.requestId, type: m.type,
      clientCode: m.customer.code, clientCountry: m.customer.country,
      createdAt: this.clock.now(), body: m.body, contentType: m.contentType ?? 'application/xml', seq: ++this.#seq,
    }
    this.#messages.set(msg.id, msg)
    for (const l of this.#listeners) l(msg)
    return msg
  }

  #expired(m: Message) { return this.clock.now().getTime() - m.createdAt.getTime() > this.retentionMs }

  /** Drops expired messages and tombstones. Reads skip them anyway; this frees the memory. */
  purge(): number {
    let n = 0
    for (const m of this.#messages.values()) if (this.#expired(m)) { this.#remove(m); n++ }
    this.#gone.purge()
    return n
  }

  #inScope(m: Message, s: Scope) {
    return s.customers.has(keyOf({ code: m.clientCode, country: m.clientCountry })) && (!s.type || m.type === s.type) && !this.#expired(m)
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

  /**
   * Confirms a message. 'deleted' also covers an id deleted (or expired) before, as
   * documented; 'unknown' is an id that never existed for this caller (404).
   */
  delete(s: Scope, id: string): 'deleted' | 'unknown' {
    const m = this.#messages.get(id)
    if (m && s.customers.has(keyOf({ code: m.clientCode, country: m.clientCountry }))) { this.#remove(m); return 'deleted' }
    const owner = this.#gone.get(id)
    return owner !== undefined && s.customers.has(owner) ? 'deleted' : 'unknown'
  }
}
