// Where acquiring state lives (decision 945): the merchants' set-ups and the card
// transactions fed through /_sim/acq. In memory (MemoryAcquiringStore) or in Postgres
// (PgAcquiringStore, pg/acquiring.ts); every call is async.
import { BoundedMap, type Bounds } from '../bounded.js'
import type { Clock } from '../clock.js'
import type { CardTransaction, MerchantSetup } from './service.js'

export const ACQ_BOUNDS: Bounds = { max: 100_000 }

export interface AcquiringStore {
  /** A merchant's set-up by customer key (keyOf, country in capitals). */
  merchant(key: string): Promise<MerchantSetup | undefined>
  /** Replaces a merchant's set-up; undefined removes it. */
  setMerchant(key: string, m: MerchantSetup | undefined): Promise<void>
  /** The next card transaction reference: 4901, 4902, … per store (namespace). */
  nextRef(): Promise<string>
  add(t: CardTransaction): Promise<void>
  /** Card transactions, oldest first; of one account (normalised) when given. */
  transactions(account?: string): Promise<CardTransaction[]>
}

export class MemoryAcquiringStore implements AcquiringStore {
  #merchants = new Map<string, MerchantSetup>()
  #tx: BoundedMap<string, CardTransaction>
  #seq = 4900
  constructor(clock: Clock, bounds: Bounds = ACQ_BOUNDS) { this.#tx = new BoundedMap(clock, bounds) }

  async merchant(key: string) { return this.#merchants.get(key) }
  async setMerchant(key: string, m: MerchantSetup | undefined) {
    if (m === undefined) this.#merchants.delete(key)
    else this.#merchants.set(key, m)
  }
  async nextRef() { return String(++this.#seq) }
  async add(t: CardTransaction) { this.#tx.set(t.ref, t) }
  async transactions(account?: string) {
    const all = this.#tx.entries().map(([, t]) => t)
    return account ? all.filter((t) => t.account === account) : all
  }
}
