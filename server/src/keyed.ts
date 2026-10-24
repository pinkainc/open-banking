// Remembered business state behind one async interface (decision 961): duplicate MsgId
// and InstrId sets, report settings, parked payments, in-flight limit amounts. Each use is
// a `kind` with its own bounds (decision 504: a time to live from the injected clock and a
// maximum count, oldest first, setting a key again makes it the newest), so one Postgres
// table (PgKeyed, pg/keyed.ts) serves them all under a namespace. Values are JSON-safe
// (bigints as strings, times as ms), so memory and Postgres hand back the same thing.
import { BoundedMap, type Bounds } from './bounded.js'
import type { Clock } from './clock.js'

export interface KeyedStore<V> {
  get(key: string): Promise<V | undefined>
  has(key: string): Promise<boolean>
  set(key: string, value: V): Promise<void>
  /** Sets the key only when it is absent (or expired); whether it did. One step in Postgres. */
  add(key: string, value: V): Promise<boolean>
  /** Removes and returns the value; at most once for a key. */
  take(key: string): Promise<V | undefined>
  /** Replaces the value of a live key, keeping its place and expiry (unlike set); whether it did. */
  replace(key: string, value: V): Promise<boolean>
  /** The live entries, oldest first. */
  entries(): Promise<[string, V][]>
}

/** Makes the store of one kind; an emulator builds every kind from one factory. */
export type KeyedFactory = <V>(kind: string, bounds: Bounds) => KeyedStore<V>

/** Bounds of state that is never forgotten by time or count (settings). */
export const UNBOUNDED: Bounds = { max: Number.MAX_SAFE_INTEGER }

export class MemoryKeyed<V> implements KeyedStore<V> {
  #m: BoundedMap<string, V>
  constructor(clock: Clock, bounds: Bounds) { this.#m = new BoundedMap(clock, bounds) }
  async get(key: string) { return this.#m.get(key) }
  async has(key: string) { return this.#m.has(key) }
  async set(key: string, value: V) { this.#m.set(key, value) }
  async add(key: string, value: V) {
    if (this.#m.has(key)) return false
    this.#m.set(key, value)
    return true
  }
  async take(key: string) {
    const v = this.#m.get(key)
    if (v !== undefined) this.#m.delete(key)
    return v
  }
  async replace(key: string, value: V) { return this.#m.replace(key, value) }
  async entries() { return this.#m.entries() }
}

export const memoryKeyed = (clock: Clock): KeyedFactory => <V>(_kind: string, bounds: Bounds) => new MemoryKeyed<V>(clock, bounds)
