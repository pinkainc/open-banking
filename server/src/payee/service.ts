// Payee verification, requester side (docs/decisions.md 600–609): the EE Verification of
// Payee (XML, POST /verification-of-payee), the UK one (JSON, POST /payment/vop-request)
// and UK Confirmation of Payee (JSON, POST /payment/cop-request). Every answer, errors
// included, is an inbox message of the operation's type. The holder is who the bank knows:
// a customer's account (always a BUSINESS account: Connect customers are legal entities),
// an ACTIVE VIBAN with a holder (a person PERSONAL, a company BUSINESS), or an account the
// simulator registered for another bank (`/_sim/payee/accounts`, which can also force an
// answer). Nothing else is remembered.
import { BoundedMap, type Bounds } from '../bounded.js'
import type { Clock } from '../clock.js'
import type { CustomerKey, Directory } from '../directory.js'
import { errorsXml } from '../errors.js'
import { ibanChecksumOk, ibanCountry, isSepaCountry, normalizeIban } from '../iban.js'
import type { Inbox } from '../inbox.js'
import { JsonBodyError, asObject, parseJsonBody } from '../jsonbody.js'
import type { VibanRegistry } from '../viban/registry.js'
import { el, parseXml, toXml } from '../xml.js'
import { matchName } from './match.js'

export type Category = 'PERSONAL' | 'BUSINESS'
export const CATEGORIES: Category[] = ['PERSONAL', 'BUSINESS']

/** What the simulator knows of an account (another bank's, or one of ours to steer). */
export interface SimAccount { name?: string; category?: Category; answer?: string }

export const VOP_EE = 'VERIFICATION_OF_PAYEE'
export const COP = 'CONFIRMATION_OF_PAYEE'

export const PARTY_NAME_MATCH = ['FULL_MATCH', 'CLOSE_MATCH', 'NO_MATCH', 'NOT_APPLICABLE']

const UNABLE = 'We are currently unable to verify the account details. You can either try again in a few minutes or continue your payment without verification. If you continue, please double check the details.'
const NOT_SUPPORTED = 'Cannot check details. Confirmation of Payee is not supported by this account.'
const NO_MATCH = "The name you provided doesn't match the name for the account. You can still continue with the payment, but your money may be sent to the wrong account."

/** UK VoP reason codes and their documented descriptions (G verification-of-payee-requester). */
export const VOP_REASONS: Record<string, string> = {
  MTCH: "It's a match. The account name and details match those on record.",
  NMTC: NO_MATCH,
  CMTC: 'The name is a close match. The actual name on the account is (...).',
  NOAP: UNABLE,
  TECH: UNABLE,
}

/** CoP reason codes and their documented descriptions (G confirmation-of-payee-requester). */
export const COP_REASONS: Record<string, string> = {
  ACCP: "It's a match. The account name and details match those on record.",
  AC01: 'Account not found. There was no account with the account number you provided. Please check and try again.',
  ACNS: NOT_SUPPORTED,
  ANNM: NO_MATCH,
  BAMM: 'The account details are a close match. However, it is a business account, not a personal account and the actual name on the account is (...).',
  BANM: 'The account details match. However, it is a business account, not a personal account.',
  CASS: 'Account no longer exists. This account has been switched to a new one. Please contact your recipient for updated account details.',
  IVCR: 'Cannot check details. Unable to locate the account based on the Reference provided. Please check and retry.',
  MBAM: 'The name is a close match. The actual name on the account is (...).',
  OPTO: NOT_SUPPORTED,
  PAMM: "The account details are a close match. However, it's a personal account, not a business account and the actual name on the account is (...).",
  PANM: "Close match. The account details match, however it's a personal account, not a business account.",
  SCNS: "Not a match. The sort code you provided doesn't match the account. Please check and try again.",
  CNOR: UNABLE, FF01: UNABLE, AB07: UNABLE, TKCM: UNABLE, RC02: UNABLE, DS14: UNABLE, AB05: UNABLE,
  AB13: UNABLE, AB08: UNABLE, BE11: NOT_SUPPORTED, TECH: UNABLE, TM01: UNABLE,
}

/** Every value `answer` may take in /_sim/payee/accounts. */
export const ANSWERS = new Set([...PARTY_NAME_MATCH, ...Object.keys(VOP_REASONS), ...Object.keys(COP_REASONS)])
/** Answers that carry the holder's name (ActualName). */
const CLOSE = new Set(['CLOSE_MATCH', 'CMTC', 'MBAM', 'BAMM', 'PAMM'])

/** A UK BBAN: sort code (6) and account number (8). */
export const BBAN = /^[0-9]{14}$/
/** The BBAN of a GB IBAN (after the 4-letter bank code), else undefined. */
const gbBban = (iban: string) => (/^GB[0-9]{2}[A-Z]{4}[0-9]{14}$/.test(iban) ? iban.slice(8) : undefined)

/** The key of an account in /_sim/payee/accounts: an IBAN (normalised) or a 14-digit BBAN. */
export function accountKey(s: string): string | undefined {
  const t = s.replace(/[\s-]+/g, '')
  if (BBAN.test(t)) return t
  const n = normalizeIban(t)
  return ibanChecksumOk(n) ? n : undefined
}

interface Holder { name: string; category: Category }
interface Found { holder?: Holder; answer?: string }

export interface PayeeDeps { directory: Directory; viban: VibanRegistry; inbox: Inbox; clock: Clock }

export const DEFAULT_PAYEE_ACCOUNTS: Bounds = { max: 10_000 }

/** One <Error> of the EE answer; descriptions as the P 07 sample (no closing full stop). */
const EE_ERR = {
  INVALID_REQUEST: 'XSD validation error',
  NAME_REQUIRED: 'Name is required',
  NAME_LENGTH_CHECK_FAILED: 'Name must not be blank and must not be longer than 140 characters',
  IBAN_REQUIRED: 'IBAN is required',
  IBAN_FORMAT_INVALID: 'IBAN is invalid',
  UNABLE_TO_CALCULATE_BIC_FROM_IBAN: 'Unable to calculate BIC from IBAN, please validate IBAN correctness',
  UNABLE_TO_VERIFY: 'Unable to verify payee due to an unexpected technical error',
} as const
const FIELD = 'VerificationOfPayeeRequestMessage'
const IBAN_PATTERN = /^[A-Z]{2}[0-9]{2}[a-zA-Z0-9]{1,30}$/
const BIC_PATTERN = /^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/

export class PayeeService {
  readonly accounts: BoundedMap<string, SimAccount>
  constructor(private deps: PayeeDeps, bounds: Bounds = DEFAULT_PAYEE_ACCOUNTS) {
    this.accounts = new BoundedMap(deps.clock, bounds)
  }

  /** The bank's own holder of an IBAN: a customer's account or an ACTIVE, named VIBAN. */
  #ownHolder(iban: string): Holder | undefined {
    const owner = this.deps.directory.ownerOf(iban)
    if (owner) return { name: owner.name, category: 'BUSINESS' }
    const v = this.deps.viban.get(iban)
    const name = v?.user?.person?.Name ?? v?.user?.company?.Name
    if (v && v.status === 'ACTIVE' && name) return { name, category: v.user?.person ? 'PERSONAL' : 'BUSINESS' }
    return undefined
  }

  /** Who holds an account given as an IBAN or a UK BBAN, and any forced answer. */
  lookup(account: { iban?: string; bban?: string }): Found {
    const iban = account.iban ? normalizeIban(account.iban) : undefined
    const bban = account.bban ?? (iban ? gbBban(iban) : undefined)
    const sim = (iban ? this.accounts.get(iban) : undefined) ?? (bban ? this.accounts.get(bban) : undefined)
    let own = iban ? this.#ownHolder(iban) : undefined
    if (!own && bban && !iban) {
      const match = (i: string) => gbBban(i) === bban
      const acct = this.deps.directory.all().flatMap((c) => c.accounts).find(match) ?? this.deps.viban.all().map((v) => v.iban).find(match)
      if (acct) own = this.#ownHolder(acct)
    }
    const holder = sim?.name ? { name: sim.name, category: sim.category ?? own?.category ?? 'PERSONAL' } : own
    return { holder, answer: sim?.answer }
  }

  // --- EE: XML, PartyNameMatch -------------------------------------------------------

  /** POST /verification-of-payee: the answer (or <Errors>) as a VERIFICATION_OF_PAYEE message. */
  requestEe(body: unknown, customer: CustomerKey, requestId: string) {
    const send = (xml: string) => this.deps.inbox.add({ customer, type: VOP_EE, requestId, body: xml })
    const errors = (list: { code: keyof typeof EE_ERR; field?: string }[]) =>
      send(errorsXml(list.map((e) => ({ code: e.code, description: EE_ERR[e.code], field: e.field ? `${FIELD}/${e.field}` : undefined }))))
    let root: any
    try {
      const doc = typeof body === 'string' && body.trim() ? parseXml(body) : undefined
      root = doc?.VerificationOfPayeeRequest
    } catch { root = undefined }
    if (root === '') root = {} // <VerificationOfPayeeRequest/>: both fields missing
    // Not XML, another document, an element repeated or with children: the schema would refuse it.
    if (root === undefined || root === null || typeof root !== 'object' || ['Name', 'IBAN', 'BIC'].some((k) => root[k] !== undefined && typeof root[k] === 'object')) {
      return errors([{ code: 'INVALID_REQUEST' }])
    }
    const list: { code: keyof typeof EE_ERR; field?: string }[] = []
    const name = root.Name === undefined ? undefined : String(root.Name).replace(/\s+/g, ' ').trim()
    if (name === undefined) list.push({ code: 'NAME_REQUIRED', field: 'Name' })
    else if (!name || [...name].length > 140) list.push({ code: 'NAME_LENGTH_CHECK_FAILED', field: 'Name' })
    const iban = root.IBAN === undefined ? '' : String(root.IBAN)
    if (!iban) list.push({ code: 'IBAN_REQUIRED', field: 'IBAN' })
    else if (!IBAN_PATTERN.test(iban) || !ibanChecksumOk(iban)) list.push({ code: 'IBAN_FORMAT_INVALID', field: 'IBAN' })
    const bic = root.BIC === undefined ? undefined : String(root.BIC)
    if (bic !== undefined && !BIC_PATTERN.test(bic)) list.push({ code: 'INVALID_REQUEST', field: 'BIC' })
    if (!list.length && !bic && !isSepaCountry(ibanCountry(iban))) list.push({ code: 'UNABLE_TO_CALCULATE_BIC_FROM_IBAN', field: 'IBAN' })
    if (list.length) return errors(list)

    const found = this.lookup({ iban })
    let match: string
    if (found.answer && PARTY_NAME_MATCH.includes(found.answer)) match = found.answer
    else if (!found.holder || !isSepaCountry(ibanCountry(iban))) match = 'NOT_APPLICABLE'
    else match = { FULL: 'FULL_MATCH', CLOSE: 'CLOSE_MATCH', NONE: 'NO_MATCH' }[matchName(name!, found.holder.name)]
    const actual = match === 'CLOSE_MATCH' && found.holder ? found.holder.name.replace(/\s+/g, ' ').trim().slice(0, 140) : undefined
    return send(toXml(el('VerificationOfPayeeResponse',
      el('Name', name!), el('IBAN', iban), el('PartyNameMatch', match), actual ? el('ActualName', actual) : null)))
  }

  // --- UK: JSON, reason codes -----------------------------------------------------------

  #json(customer: CustomerKey, type: string, requestId: string, body: object) {
    return this.deps.inbox.add({ customer, type, requestId, body: JSON.stringify(body), contentType: 'application/json' })
  }

  /** Parses a UK JSON request; problems are answered in the inbox and give undefined. */
  #parse(raw: unknown, customer: CustomerKey, type: string, requestId: string, check: (b: Record<string, unknown>) => string[]) {
    let problems: string[]
    let b: Record<string, unknown> | undefined
    try {
      b = asObject(parseJsonBody(raw))
      problems = b ? check(b) : ['The request body must be a JSON object']
    } catch (e) {
      if (!(e instanceof JsonBodyError)) throw e
      problems = [e.message]
    }
    if (!problems.length) return b
    this.#json(customer, type, requestId, {
      OriginalMessageId: requestId, Data: null, Errors: problems.map((m) => ({ ErrorCode: 'INVALID_REQUEST', ErrorMessage: m })),
    })
    return undefined
  }

  #answer(customer: CustomerKey, type: string, requestId: string, o: { identification: string; name: string; code: string; actual?: string; reasons: Record<string, string> }) {
    const actual = CLOSE.has(o.code) ? o.actual : undefined
    const description = actual ? o.reasons[o.code].replace('(...)', actual) : o.reasons[o.code]
    return this.#json(customer, type, requestId, {
      OriginalMessageId: requestId,
      Data: {
        Answer: o.code === 'MTCH' || o.code === 'ACCP' ? 'Confirmed' : 'Rejected',
        Identification: o.identification,
        ...(actual ? { ActualName: actual } : {}),
        Name: [o.name],
        ReasonCode: o.code,
        Description: description,
      },
      Errors: null,
    })
  }

  /** POST /payment/vop-request: Identification (IBAN) and Name; VERIFICATION_OF_PAYEE (JSON). */
  requestUk(raw: unknown, customer: CustomerKey, requestId: string) {
    const b = this.#parse(raw, customer, VOP_EE, requestId, (b) => {
      const p: string[] = []
      if (typeof b.Identification !== 'string' || !b.Identification.trim()) p.push('Identification is mandatory')
      else if (!ibanChecksumOk(b.Identification)) p.push('Identification must be a valid IBAN')
      if (typeof b.Name !== 'string' || !b.Name.trim()) p.push('Name is mandatory')
      return p
    })
    if (!b) return
    const identification = b.Identification as string
    const name = b.Name as string
    const found = this.lookup({ iban: identification })
    let code: string
    if (found.answer && VOP_REASONS[found.answer]) code = found.answer
    else if (!found.holder) code = 'NOAP'
    else code = { FULL: 'MTCH', CLOSE: 'CMTC', NONE: 'NMTC' }[matchName(name, found.holder.name)]
    return this.#answer(customer, VOP_EE, requestId, { identification, name, code, actual: found.holder?.name, reasons: VOP_REASONS })
  }

  /** POST /payment/cop-request: AccountCategory, Identification (BBAN), Name; CONFIRMATION_OF_PAYEE. */
  requestCop(raw: unknown, customer: CustomerKey, requestId: string) {
    const b = this.#parse(raw, customer, COP, requestId, (b) => {
      const p: string[] = []
      if (b.AccountCategory === undefined || b.AccountCategory === null) p.push('AccountCategory is mandatory')
      else if (!CATEGORIES.includes(b.AccountCategory as Category)) p.push('AccountCategory must be PERSONAL or BUSINESS')
      if (typeof b.Identification !== 'string' || !b.Identification.trim()) p.push('Identification is mandatory')
      else if (!BBAN.test(b.Identification)) p.push('Identification must be a sort code and account number (14 digits)')
      if (typeof b.Name !== 'string' || !b.Name.trim()) p.push('Name is mandatory')
      if (b.SecondaryIdentification !== undefined && b.SecondaryIdentification !== null && typeof b.SecondaryIdentification !== 'string') {
        p.push('SecondaryIdentification must be a string')
      }
      return p
    })
    if (!b) return
    const identification = b.Identification as string
    const name = b.Name as string
    const category = b.AccountCategory as Category
    const found = this.lookup({ bban: identification })
    let code: string
    if (found.answer && COP_REASONS[found.answer]) code = found.answer
    else if (!found.holder) code = 'AC01'
    else {
      const m = matchName(name, found.holder.name)
      const same = found.holder.category === category
      if (m === 'NONE') code = 'ANNM'
      else if (m === 'FULL') code = same ? 'ACCP' : found.holder.category === 'BUSINESS' ? 'BANM' : 'PANM'
      else code = same ? 'MBAM' : found.holder.category === 'BUSINESS' ? 'BAMM' : 'PAMM'
    }
    return this.#answer(customer, COP, requestId, { identification, name, code, actual: found.holder?.name, reasons: COP_REASONS })
  }
}
