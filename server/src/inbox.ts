// The message box: every response and notification waits here until the client
// confirms it with DELETE. Reads return the oldest unconfirmed message first; unread
// messages older than the retention period (five days) are gone.
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
  #seq = 0
  constructor(private clock: Clock, private retentionMs = 5 * DAY_MS) {}

  add(m: { customer: CustomerKey; type: string; body: string; requestId?: string; contentType?: string }): Message {
    const msg: Message = {
      id: responseId(), requestId: m.requestId, type: m.type,
      clientCode: m.customer.code, clientCountry: m.customer.country,
      createdAt: this.clock.now(), body: m.body, contentType: m.contentType ?? 'application/xml', seq: ++this.#seq,
    }
    this.#messages.set(msg.id, msg)
    return msg
  }

  #expired(m: Message) { return this.clock.now().getTime() - m.createdAt.getTime() > this.retentionMs }

  /** Drops expired messages. Reads skip them anyway; this frees the memory. */
  purge(): number {
    let n = 0
    for (const m of this.#messages.values()) if (this.#expired(m)) { this.#messages.delete(m.id); n++ }
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

  /** Confirms a message. Deleting an unknown or already deleted id is not an error. */
  delete(s: Scope, id: string): void {
    const m = this.#messages.get(id)
    if (m && s.customers.has(keyOf({ code: m.clientCode, country: m.clientCountry }))) this.#messages.delete(id)
  }
}
