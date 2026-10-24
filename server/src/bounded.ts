// Remembered keys with a limit (docs/decisions.md 504): idempotency keys, inbox tombstones
// and business MsgIds. An entry is forgotten when its time to live has passed (by the
// injectable clock) or, beyond `max` entries, oldest first (insertion order; setting a key
// again makes it the newest). Expired entries are dropped from the front on every write
// and by purge(), so memory stays bounded without a timer.
import { DAY_MS, type Clock } from './clock.js'

export interface Bounds {
  /** Milliseconds an entry is remembered; undefined: until evicted by `max`. */
  ttlMs?: number
  /** Most entries kept; the oldest go first. */
  max: number
}

/** Defaults: tombstones as long as an unread message lives, keys 24 h, MsgIds by count only. */
export const DEFAULT_BOUNDS = {
  tombstones: { ttlMs: 5 * DAY_MS, max: 100_000 },
  msgIds: { max: 200_000 },
  idempotencyKeys: { ttlMs: DAY_MS, max: 100_000 },
} satisfies Record<string, Bounds>

export class BoundedMap<K, V> {
  #m = new Map<K, { value: V; until: number }>()
  constructor(private clock: Clock, readonly bounds: Bounds) {
    if (!(bounds.max >= 1)) throw new Error(`bounds.max must be at least 1, not ${bounds.max}`)
  }

  get size() { return this.#m.size }

  set(key: K, value: V): this {
    const now = this.clock.now().getTime()
    this.#m.delete(key)
    this.#m.set(key, { value, until: this.bounds.ttlMs === undefined ? Infinity : now + this.bounds.ttlMs })
    this.#dropFront(now)
    return this
  }

  get(key: K): V | undefined {
    const e = this.#m.get(key)
    if (!e) return undefined
    if (e.until <= this.clock.now().getTime()) { this.#m.delete(key); return undefined }
    return e.value
  }

  has(key: K): boolean { return this.get(key) !== undefined }

  delete(key: K): boolean { return this.#m.delete(key) }

  /** The live entries, oldest first. */
  entries(): [K, V][] {
    const now = this.clock.now().getTime()
    return [...this.#m].filter(([, e]) => e.until > now).map(([k, e]) => [k, e.value])
  }

  /** Drops every expired entry; returns how many. */
  purge(): number {
    const now = this.clock.now().getTime()
    let n = 0
    for (const [k, e] of this.#m) if (e.until <= now) { this.#m.delete(k); n++ }
    return n
  }

  /** Over `max`, and expired entries at the front (the oldest, with one TTL). */
  #dropFront(now: number) {
    for (const [k, e] of this.#m) {
      if (this.#m.size <= this.bounds.max && e.until > now) break
      this.#m.delete(k)
    }
  }
}

export class BoundedSet<K> {
  #m: BoundedMap<K, true>
  constructor(clock: Clock, bounds: Bounds) { this.#m = new BoundedMap(clock, bounds) }
  get size() { return this.#m.size }
  add(key: K): this { this.#m.set(key, true); return this }
  has(key: K): boolean { return this.#m.has(key) }
  purge(): number { return this.#m.purge() }
}
