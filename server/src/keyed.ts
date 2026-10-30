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
  /**
   * Replaces the value of a live key, keeping its place and expiry (unlike set); whether it did.
   * With `expected`, only while the stored value is still that one (equal as JSON): a
   * compare-and-set, one step in Postgres (decision 1008). See updateKeyed.
   */
  replace(key: string, value: V, expected?: V): Promise<boolean>
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
  async replace(key: string, value: V, expected?: V) {
    if (expected !== undefined) {
      const cur = this.#m.get(key)
      if (cur === undefined || canonical(cur) !== canonical(expected)) return false
    }
    return this.#m.replace(key, value)
  }
  async entries() { return this.#m.entries() }
}

/** JSON with object keys sorted, so two equal values compare equal whatever their key order (as jsonb does). */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x)
}

/**
 * Changes the value of a key with f and stores it with a compare-and-set, reading and
 * calling f again when another writer (another emulator of the namespace) changed it in
 * between, so neither write is lost (decision 1008). f gets a copy of the stored value
 * (undefined: absent) and answers the new value, or undefined to store nothing; an absent
 * key is added. Returns the value stored, or undefined when f stored nothing.
 */
export async function updateKeyed<V>(store: KeyedStore<V>, key: string, f: (v: V | undefined) => V | undefined | Promise<V | undefined>): Promise<V | undefined> {
  for (let i = 0; ; i++) {
    const cur = await store.get(key)
    const next = await f(cur === undefined ? undefined : structuredClone(cur))
    if (next === undefined) return undefined
    if (cur === undefined ? await store.add(key, next) : await store.replace(key, next, cur)) return next
    if (i >= 1000) throw new Error(`keyed ${key}: too many conflicting writes`)
  }
}

/**
 * Claims `key` for `owner` (a file's MsgId for the work that carries it, decisions 1017,
 * 1021): true when added now, or already held by `owner` (a resumed work claimed it before
 * the crash); another value, also a `true` stored before claims had owners, is another's.
 */
export async function claimKey<V>(store: KeyedStore<V>, key: string, owner: V): Promise<boolean> {
  return (await store.add(key, owner)) || (await store.get(key)) === owner
}

/**
 * Takes a unique name (a VIBAN clientReference, a webhook message type, a subscribed URL)
 * for `ref` in a store of names → holder refs, once for the namespace (decision 1012), and
 * answers its holder: `ref` when taken now or before, else the other holder. A holder that
 * does not show (`shows` false: its thing not stored, or not with this name) is waited for,
 * polling every 10 ms up to `waitMs` of real time, since it is usually being stored right
 * now; after that it is taken over with a compare-and-set (left by a crash between the two).
 */
export async function claimName(store: KeyedStore<string>, key: string, ref: string, shows: (holder: string) => Promise<boolean>, waitMs = 1000): Promise<string> {
  const start = Date.now()
  for (;;) {
    if (await store.add(key, ref)) return ref
    const holder = await store.get(key)
    if (holder === undefined) continue // given back meanwhile
    if (holder === ref || (await shows(holder))) return holder
    if (Date.now() - start >= waitMs) {
      if (await store.replace(key, ref, holder)) return ref
      continue
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

export const memoryKeyed = (clock: Clock): KeyedFactory => <V>(_kind: string, bounds: Bounds) => new MemoryKeyed<V>(clock, bounds)
