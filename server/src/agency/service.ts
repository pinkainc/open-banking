// Indirect scheme access in one place (decisions 800–819): the agency account store, the
// account synchronisation (v1 XML, v2 JSON), the CoP/VoP responder and the RTF deliveries.
import type { Bounds } from '../bounded.js'
import type { Clock } from '../clock.js'
import type { Directory } from '../directory.js'
import type { InboxStore } from '../inbox.js'
import type { Bank } from '../payments/engine.js'
import { AgencyResponder } from './responder.js'
import { RtfService } from './rtf.js'
import { AGENCY_BOUNDS, MemoryAgencyStore, type AgencyStore } from './store.js'
import { AgencySync } from './sync.js'

export interface AgencyDeps { directory: Directory; inbox: InboxStore; clock: Clock; bank: Bank }

export class Agency {
  /** Synchronised agency accounts: the lookup API for payments (store.ts). */
  readonly accounts: AgencyStore
  readonly sync: AgencySync
  readonly responder: AgencyResponder
  readonly rtf: RtfService
  /** `store`: where the accounts and set-ups live (decision 940); default in memory. */
  constructor(deps: AgencyDeps, bounds: Partial<Bounds> = {}, store?: (clock: Clock, bounds: Bounds) => AgencyStore) {
    const b = { ...AGENCY_BOUNDS, ...bounds }
    this.accounts = store ? store(deps.clock, b) : new MemoryAgencyStore(deps.clock, b)
    this.sync = new AgencySync({ ...deps, store: this.accounts })
    this.responder = new AgencyResponder({ ...deps, store: this.accounts })
    this.rtf = new RtfService({ ...deps, store: this.accounts })
  }
}
