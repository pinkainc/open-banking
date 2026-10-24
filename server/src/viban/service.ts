// The VIBAN services: POST /viban/{open,bulk,modify,info,close}. Each request is
// checked in this order, the first failing step answering with its documented error:
//
//   1. well-formed XML with the operation's root element          INVALID_REQUEST
//   2. birth dates and country codes                               INVALID_BIRTH_DATE / INVALID_COUNTRY
//   3. the published XSD, then the required elements              INVALID_REQUEST
//   4. master account: known, the caller's, with an agreement     INVALID_ACCOUNT / FORBIDDEN / MASTER_ACCOUNT_AGREEMENT_MISSING
//   5. the VIBAN: exists, issued under that master account         INVALID_VIBAN / FORBIDDEN
//   6. the operation's own rules                                   INVALID_STATUS / INVALID_REASON / INVALID_USER_TYPE / INVALID_CLIENT_REFERENCE
//
// Anything unexpected is TECHNICAL_ERROR. Whether the errors reach the client in the
// inbox or in the HTTP response is `errorDelivery` (docs/decisions.md 200).
import type { Clock } from '../clock.js'
import { keyOf, type CustomerKey, type DirectoryStore } from '../directory.js'
import { normalizeIban } from '../iban.js'
import type { InboxStore } from '../inbox.js'
import { memoryKeyed, UNBOUNDED, updateKeyed, type KeyedFactory, type KeyedStore } from '../keyed.js'
import { dateTallinn } from '../time.js'
import { parseXml } from '../xml.js'
import { isCountry } from './countries.js'
import {
  birthDates, bulkResponse, closeResponse, countryFields, infoResponse, modifyResponse, openResponse, readRequest,
  RESPONSE_TYPE, ROOT, STATUS_NOTIFICATION, statusNotification, type Op, type VibanRequest, type VibanSchemas,
} from './messages.js'
import { BANK_TRANSITIONS, DEFAULT_RANGE, holderName, VibanRegistry, type Viban, type VibanRange, type VibanStatus, type VibanUser } from './registry.js'

export interface VibanError { code: string; description: string; field?: string }

/** The documented error table (P 10 "Virtual IBAN Error Codes"). */
export const E = {
  request: { code: 'INVALID_REQUEST', description: 'Invalid request.' },
  technical: { code: 'TECHNICAL_ERROR', description: 'Technical error.' },
  masterForbidden: { code: 'FORBIDDEN', description: 'Unauthorized master account.', field: 'MasterAccount' },
  vibanForbidden: { code: 'FORBIDDEN', description: 'Unauthorized virtual IBAN.', field: 'VirtualIBAN' },
  account: { code: 'INVALID_ACCOUNT', description: 'Account does not exist.', field: 'MasterAccount' },
  birthFormat: { code: 'INVALID_BIRTH_DATE', description: 'Birth date format is YYYY-MM-DD.', field: 'BirthDate' },
  birthFuture: { code: 'INVALID_BIRTH_DATE', description: 'Birth date cannot be in the future.', field: 'BirthDate' },
  country: (field: string) => ({ code: 'INVALID_COUNTRY', description: 'Unknown country.', field }),
  statusClose: { code: 'INVALID_STATUS', description: 'Virtual IBAN has to be in ACTIVE / PENDING / BLOCKED status.', field: 'VirtualIBAN' },
  statusModify: { code: 'INVALID_STATUS', description: 'Virtual IBAN has to be in ACTIVE / PENDING / ON_HOLD status.', field: 'VirtualIBAN' },
  viban: { code: 'INVALID_VIBAN', description: 'Virtual IBAN does not exist.', field: 'VirtualIBAN' },
  agreement: { code: 'MASTER_ACCOUNT_AGREEMENT_MISSING', description: 'Active master account agreement is missing.', field: 'MasterAccount' },
  reasonMissing: { code: 'INVALID_REASON', description: 'Reason for the change is missing.', field: 'ModifyReason' },
  reasonPending: { code: 'INVALID_REASON', description: 'Reason for the change is not allowed when status is PENDING.', field: 'ModifyReason' },
  userType: { code: 'INVALID_USER_TYPE', description: 'Changing user type is not allowed.', field: 'User' },
  refUnique: { code: 'INVALID_CLIENT_REFERENCE', description: 'Client reference number must be unique.', field: 'ClientReference' },
  refChange: { code: 'INVALID_CLIENT_REFERENCE', description: 'Client reference number change is not allowed.', field: 'ClientReference' },
} satisfies Record<string, VibanError | ((f: string) => VibanError)>

/**
 * inbox: 202, then a VIBAN_<OP> message whose body is <Errors> (default).
 * sync: the <Errors> document as the HTTP answer (403 FORBIDDEN, 500 TECHNICAL_ERROR, else 400).
 */
export type ErrorDelivery = 'inbox' | 'sync'

export type Outcome = { type: string; body: string } | { type: string; errors: VibanError[] }

export interface VibanOptions { schemas?: VibanSchemas; errors?: ErrorDelivery; range?: VibanRange; keyed?: KeyedFactory }

export const BULK_MAX = 1000

export class VibanService {
  readonly registry: VibanRegistry
  /** The delivery when /_sim/viban/errors has not set one (EmulatorOptions.vibanErrors). */
  readonly #errorDelivery: ErrorDelivery
  /**
   * The /_sim/viban settings (decision 989), kind viban-sim: `screening` (holder names the
   * simulated background check flags, lower case: their VIBANs stay ON_HOLD), `faults` (the
   * next requests answered TECHNICAL_ERROR) and `errors` (the error delivery).
   */
  readonly #sim: KeyedStore<string[] | number | ErrorDelivery>

  /** The service's operations in this process, one after the other (decision 984). */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(private directory: DirectoryStore, private inbox: InboxStore, private clock: Clock, private opts: VibanOptions = {}) {
    this.registry = new VibanRegistry(opts.range ?? DEFAULT_RANGE, async (iban) => !!(await directory.ownerOf(iban)), opts.keyed ?? memoryKeyed(clock))
    this.#errorDelivery = opts.errors ?? 'inbox'
    this.#sim = (opts.keyed ?? memoryKeyed(clock))('viban-sim', UNBOUNDED)
  }

  /** How business errors are delivered: "inbox" or "sync" (/_sim/viban/errors, else the option). */
  async errorDelivery(): Promise<ErrorDelivery> { return ((await this.#sim.get('errors')) as ErrorDelivery | undefined) ?? this.#errorDelivery }
  async setErrorDelivery(d: ErrorDelivery) { await this.#sim.set('errors', d) }
  /** The screening list, lower case. */
  async screening(): Promise<string[]> { return ((await this.#sim.get('screening')) as string[] | undefined) ?? [] }
  /** Replaces the screening list. */
  async setScreening(names: string[]) { await this.#sim.set('screening', [...new Set(names.map((n) => n.toLowerCase()))]) }
  /** The next `count` requests fail with TECHNICAL_ERROR. */
  setFaults(count: number): Promise<void> { return this.#serial(() => this.#sim.set('faults', count)) }

  #serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(f, f)
    this.#queue = run.catch(() => undefined)
    return run
  }

  handle(op: Op, body: string, customer: CustomerKey): Promise<Outcome> { return this.#serial(() => this.#handle(op, body, customer)) }

  async #handle(op: Op, body: string, customer: CustomerKey): Promise<Outcome> {
    const type = RESPONSE_TYPE[op]
    const fail = (...errors: VibanError[]): Outcome => ({ type, errors })
    // A fault is used up with a decrement-if-positive, so two emulators never use one twice (decision 1010).
    let faulted = false
    await updateKeyed(this.#sim, 'faults', (n) => {
      faulted = typeof n === 'number' && n > 0
      return faulted ? (n as number) - 1 : undefined
    })
    if (faulted) return fail(E.technical)
    try {
      let doc: any
      try { doc = parseXml(body) } catch { return fail(E.request) }
      const root = doc?.[ROOT[op]]
      if (!root || typeof root !== 'object') return fail(E.request)

      const fieldErrors = this.#fieldErrors(root)
      if (fieldErrors.length) return fail(...fieldErrors)
      const schema = `viban.${op}.request`
      if (this.opts.schemas?.has(schema) && (await this.opts.schemas.validate(body, schema)).length) return fail(E.request)
      const r = readRequest(op, root)
      if (!r) return fail(E.request)
      if (op === 'bulk' && !(r.amount! >= 1 && r.amount! <= BULK_MAX)) return fail(E.request)

      const master = normalizeIban(r.masterAccount)
      const owner = (await this.registry.get(master)) ? undefined : await this.directory.ownerOf(master)
      if (!owner) return fail(E.account)
      if (keyOf(owner) !== keyOf(customer)) return fail(E.masterForbidden)
      if ((op === 'open' || op === 'bulk' || op === 'modify') && !(await this.registry.hasAgreement(master))) return fail(E.agreement)

      if (op === 'open') return await this.#open(r, master, owner)
      if (op === 'bulk') {
        const ibans = await this.#bulk(r.amount!, master, owner)
        return { type, body: bulkResponse(master, ibans) }
      }
      return await retried(async () => {
        const v = await this.registry.get(r.virtualIban!)
        if (!v) return fail(E.viban)
        if (v.master !== master) return fail(E.vibanForbidden)
        if (op === 'info') return { type, body: infoResponse(v) }
        if (op === 'close') {
          if (!['ACTIVE', 'PENDING', 'BLOCKED'].includes(v.status)) return fail(E.statusClose)
          stored(await this.registry.setStatus(v, 'CLOSED', this.clock.now()))
          return { type, body: closeResponse(v) }
        }
        return await this.#modify(r, v)
      })
    } catch {
      return fail(E.technical)
    }
  }

  #fieldErrors(root: any): VibanError[] {
    const out: VibanError[] = []
    const today = dateTallinn(this.clock.now())
    for (const d of birthDates(root)) {
      const valid = /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d
      if (!valid) out.push(E.birthFormat)
      else if (d > today) out.push(E.birthFuture)
    }
    for (const [field, value] of countryFields(root)) if (!isCountry(value)) out.push(E.country(field))
    return out
  }

  /** The simulated background check: ACTIVE unless a holder name is on the screening list. */
  async #screen(u: VibanUser): Promise<VibanStatus> {
    const names = [holderName(u), u.company?.Representative.Name].filter((n): n is string => !!n).map((n) => n.toLowerCase())
    const flagged = new Set(await this.screening())
    return names.some((n) => flagged.has(n)) ? 'ON_HOLD' : 'ACTIVE'
  }

  async #open(r: VibanRequest, master: string, owner: CustomerKey): Promise<Outcome> {
    const type = RESPONSE_TYPE.open
    if (r.clientReference && (await this.registry.byClientReference(owner, r.clientReference))) return { type, errors: [E.refUnique] }
    const now = this.clock.now()
    const iban = await this.registry.generate(master)
    // The reference is taken before the VIBAN is stored: of two emulators opening one at once, one gets it.
    if (r.clientReference && !(await this.registry.claimReference(owner, r.clientReference, iban))) return { type, errors: [E.refUnique] }
    const v = await this.registry.add({
      iban, master, owner: { code: owner.code, country: owner.country },
      status: 'PENDING', clientReference: r.clientReference, user: r.user, createdAt: now,
    })
    stored(await this.registry.setStatus(v, await this.#screen(r.user!), now))
    return { type, body: openResponse(v) }
  }

  async #bulk(amount: number, master: string, owner: CustomerKey): Promise<string[]> {
    const now = this.clock.now()
    const out: string[] = []
    for (let i = 0; i < amount; i++) {
      out.push((await this.registry.add({ iban: await this.registry.generate(master), master, owner: { code: owner.code, country: owner.country }, status: 'PENDING', createdAt: now })).iban)
    }
    return out
  }

  async #modify(r: VibanRequest, v: Viban): Promise<Outcome> {
    const type = RESPONSE_TYPE.modify
    const fail = (e: VibanError): Outcome => ({ type, errors: [e] })
    if (!['ACTIVE', 'PENDING', 'ON_HOLD'].includes(v.status)) return fail(E.statusModify)
    if (v.status === 'PENDING' && r.modifyReason) return fail(E.reasonPending)
    if (v.status !== 'PENDING' && !r.modifyReason) return fail(E.reasonMissing)
    if (v.user && !!v.user.person !== !!r.user!.person) return fail(E.userType)
    const claimed = !!r.clientReference && r.clientReference !== v.clientReference
    if (claimed) {
      if (v.clientReference) return fail(E.refChange)
      if (await this.registry.byClientReference(v.owner, r.clientReference!)) return fail(E.refUnique)
      if (!(await this.registry.claimReference(v.owner, r.clientReference!, v.iban))) return fail(E.refUnique)
      v.clientReference = r.clientReference
    }
    v.user = r.user // block replace
    if (!(await this.registry.setStatus(v, await this.#screen(r.user!), this.clock.now()))) {
      if (claimed) await this.registry.releaseReference(v.owner, r.clientReference!, v.iban)
      throw new Conflict()
    }
    return { type, body: modifyResponse(v) }
  }

  /**
   * A status change made by the bank (the outcome of a manual screening, a block, a
   * closure), notified to the master account owner with VIBAN_STATUS_NOTIFICATION.
   * Returns an explanation when the change is not one the bank makes from this status.
   */
  bankStatus(iban: string, status: VibanStatus): Promise<string | undefined> { return this.#serial(() => retried(() => this.#bankStatus(iban, status))) }

  async #bankStatus(iban: string, status: VibanStatus): Promise<string | undefined> {
    const v = await this.registry.get(iban)
    if (!v) return `no VIBAN ${normalizeIban(iban)}`
    if (!BANK_TRANSITIONS[v.status].includes(status)) return `${v.status} cannot become ${status}`
    stored(await this.registry.setStatus(v, status, this.clock.now()))
    await this.inbox.add({ customer: v.owner, type: STATUS_NOTIFICATION, body: statusNotification(v) })
    return undefined
  }
}

/** The VIBAN was changed by another emulator after it was read (decision 1009). */
class Conflict extends Error { constructor() { super('VIBAN changed meanwhile') } }
const stored = (ok: boolean) => { if (!ok) throw new Conflict() }
/** Runs a change of one VIBAN again, from its read, while another emulator's change gets in between. */
async function retried<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f()
    } catch (e) {
      if (!(e instanceof Conflict) || i >= 100) throw e
    }
  }
}
