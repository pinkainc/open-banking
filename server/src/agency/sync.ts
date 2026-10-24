// Agency account synchronisation (P 11, G agency-account-synchronization; decisions 803–807).
// v1: POST /agent/account/synchronize, XML (account.agent.sync.xsd), on both hosts; the whole
// bulk is refused when one entry is wrong, the answer (the accounts, or <Errors>) is an
// AGENT_ACCOUNT_SYNC message. v2: POST /v2/agent/account/synchronize, JSON, LHV UK only;
// every account is answered on its own (Confirmed, ErrorInfo), AcceptanceStatus
// OK / PARTIAL / FAILED, in a JSON AGENT_ACCOUNT_SYNC message.
import type { Clock } from '../clock.js'
import { keyOf, type Customer, type Directory } from '../directory.js'
import { errorsXml } from '../errors.js'
import { ibanChecksumOk, isSepaCountry, normalizeIban } from '../iban.js'
import type { InboxStore } from '../inbox.js'
import { JsonBodyError, asObject, parseJsonBody } from '../jsonbody.js'
import { el, parseXml, toXml } from '../xml.js'
import {
  AGENCY_STATUSES, GB_ACCOUNT_NO, GB_IBAN, agencyKey, rangeFor,
  type AccountCategory, type AgencyAccount, type AgencyBank, type AgencyStatus, type AgencyStore,
} from './store.js'

export const AGENT_ACCOUNT_SYNC = 'AGENT_ACCOUNT_SYNC'
export const SYNC_MAX = 1000

/** v1 error codes and the descriptions of the G table (decision 803). */
const V1 = {
  INVALID_REGION: 'Invalid Region.',
  INVALID_ACCOUNT_NO_OR_IBAN: 'Account number invalid.',
  ACCOUNT_NO_AND_IBAN_MISMATCH: 'AccountNo and AccountNoIban mismatch.',
  INVALID_IBAN: 'Invalid IBAN.',
  MASTER_ACCOUNT_NOT_FOUND: 'Master account not found.',
  TECHNICAL_ERROR: 'Technical error.',
  INVALID_REQUEST: 'Invalid request.',
} as const
type V1Code = keyof typeof V1

/** v2 error codes and the descriptions of the G table (decision 806). */
export const V2 = {
  INVALID_REGION: 'Invalid Region.',
  INVALID_ACCOUNT_NO_OR_IBAN: 'Account number invalid.',
  INVALID_IBAN: 'Invalid IBAN.',
  IBAN_AND_REGION_MISMATCH: 'IBAN and region must match.',
  MASTER_ACCOUNT_NOT_FOUND: 'Master account not found.',
  TECHNICAL_ERROR: 'Technical error.',
  INVALID_JSON_REQUEST: 'JSON validation error',
  ACCOUNTS_OVER_MAXIMUM_ALLOWED_LIMIT: 'Maximum 1000 accounts allowed in the file.',
  IBAN_MUST_EXIST_FOR_THIS_REGION: 'IBAN must exist for this region.',
  CONFIRMATION_OF_PAYEE_NAME_NOT_PROVIDED: 'Confirmation of Payee name not provided.',
  CONFIRMATION_OF_PAYEE_ACCOUNT_CATEGORY_NOT_PROVIDED: 'Confirmation of Payee account category (PERSONAL, BUSINESS) not provided.',
  DUPLICATE_ACCOUNT: 'Duplicate account.',
  INVALID_ACCOUNT_STATUS: 'Account status must be ACTIVE or CLOSED.',
  NAME_TOO_LONG: 'Name can be max 140 characters long.',
  NOT_FOUND: 'Account not found',
} as const
type V2Code = keyof typeof V2

/** LHV's bank codes in BankCodes (P 11 "Usage of Bank Codes"). */
const BANK_CODES: Record<string, AgencyBank> = { LHVBEE22: 'LHVEE', LHVBEE22XXX: 'LHVEE', LHVBGB2L: 'LHVUK', LHVBGB2LXXX: 'LHVUK' }
const BIC = /^[A-Z]{6}[A-Z2-9][A-NP-Z0-9]([A-Z0-9]{3})?$/
const IBAN_SHAPE = /^[A-Z]{2}[0-9]{2}[a-zA-Z0-9]{1,30}$/
/** A region: GB or a SEPA scheme country (G "'GB' or ISO country code (SEPA Scheme Country)"). */
const regionOk = (r: string) => r === 'GB' || isSepaCountry(r)

export interface SyncDeps { directory: Directory; inbox: InboxStore; clock: Clock; store: AgencyStore }

/** One account to write: where, under which key, what was given. */
interface Entry {
  key: string; country: string; iban?: string; accountNo?: string
  status?: AgencyStatus; name?: string; category?: AccountCategory; copOptOut?: boolean; master: string
}

export class AgencySync {
  /** One synchronisation at a time in this process: checks and writes do not interleave (decision 942). */
  #gate: Promise<unknown> = Promise.resolve()
  constructor(private deps: SyncDeps) {}

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#gate.then(fn)
    this.#gate = run.catch(() => undefined)
    return run
  }

  /** Writes an account to one entity: given fields replace, missing ones keep (new: ACTIVE). */
  async #write(bank: AgencyBank, agent: Customer, e: Entry): Promise<AgencyAccount> {
    const old = await this.deps.store.get(bank, e.key)
    const now = this.deps.clock.now()
    const a: AgencyAccount = {
      bank, id: e.key, country: e.country,
      iban: e.iban ?? old?.iban, accountNo: e.accountNo ?? old?.accountNo,
      status: e.status ?? old?.status ?? 'ACTIVE',
      name: e.name ?? old?.name, category: e.category ?? old?.category, copOptOut: e.copOptOut ?? old?.copOptOut ?? false,
      agent: { code: agent.code, country: agent.country }, master: e.master,
      createdAt: old?.createdAt ?? now, updatedAt: now,
    }
    if (a.iban === undefined) delete a.iban
    if (a.accountNo === undefined) delete a.accountNo
    if (a.name === undefined) delete a.name
    if (a.category === undefined) delete a.category
    await this.deps.store.put(a)
    return a
  }

  /** Held by another agent in one of the entities (decision 802). */
  async #foreign(banks: AgencyBank[], agent: Customer, key: string) {
    for (const b of banks) { const a = await this.deps.store.get(b, key); if (a !== undefined && keyOf(a.agent) !== keyOf(agent)) return true }
    return false
  }

  /** Whether one of the entities holds the account. */
  async #anyOf(banks: AgencyBank[], key: string) {
    for (const b of banks) if (await this.deps.store.get(b, key)) return true
    return false
  }

  // --- v1, XML ------------------------------------------------------------------------

  /**
   * POST /agent/account/synchronize. `ukHost`: the request is processed by the UK host
   * (BankCodes allowed, decision 804). Returns nothing; the answer is in the inbox.
   */
  syncXml(body: unknown, agent: Customer, requestId: string, ukHost: boolean) {
    return this.#serial(() => this.#syncXml(body, agent, requestId, ukHost))
  }

  async #syncXml(body: unknown, agent: Customer, requestId: string, ukHost: boolean) {
    const setup = await this.deps.store.setup(agent)
    const send = (xml: string) => this.deps.inbox.add({ customer: agent, type: AGENT_ACCOUNT_SYNC, requestId, body: xml })
    const errors: { code: V1Code; field?: string }[] = []
    const fail = () => send(errorsXml(errors.map((e) => ({ code: e.code, description: V1[e.code], field: e.field }))))
    let root: any
    try {
      root = typeof body === 'string' && body.trim() ? parseXml(body).AgentAccountSyncRequest : undefined
    } catch { root = undefined }
    if (root === '') root = {} // <AgentAccountSyncRequest/>: no Accounts
    if (root === undefined || root === null || typeof root !== 'object' || Array.isArray(root)) {
      errors.push({ code: 'INVALID_REQUEST' })
      return fail()
    }
    // What the XSD allows: xs:all (each element at most once, nothing else), the patterns.
    const only = (o: any, allowed: string[], where: string) => {
      for (const k of Object.keys(o)) {
        if (k.startsWith('@')) continue
        if (!allowed.includes(k)) errors.push({ code: 'INVALID_REQUEST', field: `${where}${k}` })
        else if (Array.isArray(o[k]) && k !== 'BankCode' && k !== 'Account') errors.push({ code: 'INVALID_REQUEST', field: `${where}${k}` })
      }
    }
    only(root, ['BankCodes', 'Accounts'], '')
    const textOf = (v: unknown) => (v === undefined ? undefined : typeof v === 'object' && v !== null ? null : String(v))

    // Bank codes: which entities (P 11). The EE host and requests handed to LHV EE know none.
    let banks: AgencyBank[] = ['LHVEE']
    if (root.BankCodes !== undefined && !Array.isArray(root.BankCodes)) {
      const bc = root.BankCodes === '' ? {} : root.BankCodes
      if (typeof bc !== 'object') errors.push({ code: 'INVALID_REQUEST', field: 'BankCodes' })
      else {
        only(bc, ['BankCode'], 'BankCodes.')
        const codes = (Array.isArray(bc.BankCode) ? bc.BankCode : bc.BankCode === undefined ? [] : [bc.BankCode]).map(textOf)
        if (codes.length > 2 || codes.some((c: string | null) => c === null || !BIC.test(c))) errors.push({ code: 'INVALID_REQUEST', field: 'BankCodes.BankCode' })
        else if (codes.length) {
          const mapped = codes.map((c: string) => BANK_CODES[c])
          if (mapped.some((b: AgencyBank | undefined) => b === undefined) || (!ukHost && mapped.includes('LHVUK'))) {
            errors.push({ code: 'INVALID_REQUEST', field: 'BankCodes.BankCode' })
          } else banks = [...new Set<AgencyBank>(mapped)]
        }
      }
    }

    const accounts = root.Accounts === '' ? {} : root.Accounts === undefined || typeof root.Accounts !== 'object' || Array.isArray(root.Accounts)
      ? undefined : root.Accounts
    if (!accounts) { errors.push({ code: 'INVALID_REQUEST', field: 'Accounts' }); return fail() }
    only(accounts, ['Account'], 'Accounts.')
    const list: any[] = Array.isArray(accounts.Account) ? accounts.Account : accounts.Account === undefined ? [] : [accounts.Account]
    if (!list.length || list.length > SYNC_MAX) { errors.push({ code: 'INVALID_REQUEST', field: 'Accounts.Account' }); return fail() }

    const entries: { e: Entry; given: { region: string; accountNo?: string; iban?: string; name?: string } }[] = []
    const check = async (a: any, i: number) => {
      const at = `account[${i}]`
      const n = errors.length
      if (typeof a !== 'object' || a === null) { errors.push({ code: 'INVALID_REQUEST', field: at }); return }
      only(a, ['Region', 'AccountNo', 'Iban', 'Status', 'Name'], `${at}.`)
      if (errors.length > n) return
      const region = textOf(a.Region)
      const accountNo = textOf(a.AccountNo)
      const iban = textOf(a.Iban)
      const status = textOf(a.Status)
      const rawName = textOf(a.Name)
      const name = typeof rawName === 'string' ? rawName.replace(/\s+/g, ' ').trim() : rawName
      if (region === undefined || region === null || !/^[A-Z]{2}$/.test(region)) errors.push({ code: 'INVALID_REQUEST', field: `${at}.Region` })
      if (accountNo === null || (accountNo !== undefined && !/^(\d{14}|\d{12})$/.test(accountNo))) errors.push({ code: 'INVALID_REQUEST', field: `${at}.AccountNo` })
      if (iban === null || (iban !== undefined && !IBAN_SHAPE.test(iban))) errors.push({ code: 'INVALID_REQUEST', field: `${at}.Iban` })
      // The XSD's AccountStatus has ACTIVE and CLOSED only (decision 803).
      if (status === null || (status !== undefined && status !== 'ACTIVE' && status !== 'CLOSED')) errors.push({ code: 'INVALID_REQUEST', field: `${at}.Status` })
      if (name === null || (name !== undefined && (!name || [...name].length > 140))) errors.push({ code: 'INVALID_REQUEST', field: `${at}.Name` })
      if (errors.length > n) return
      if (!regionOk(region!)) { errors.push({ code: 'INVALID_REGION', field: `${at}.Region` }); return }
      // AccountNo counts for GB only ("AccountNo's for other regions than 'GB' are ignored").
      const no = region === 'GB' ? accountNo ?? undefined : undefined
      if (!no && !iban) { errors.push({ code: 'INVALID_ACCOUNT_NO_OR_IBAN', field: `${at}.AccountNo, ${at}.Iban` }); return }
      if (no && !GB_ACCOUNT_NO.test(no)) { errors.push({ code: 'INVALID_ACCOUNT_NO_OR_IBAN', field: `${at}.AccountNo` }); return }
      const ib = iban ? normalizeIban(iban) : undefined
      if (ib && (!ibanChecksumOk(ib) || (ib.startsWith('GB') && !GB_IBAN.test(ib)))) { errors.push({ code: 'INVALID_IBAN', field: `${at}.Iban` }); return }
      if (ib && ib.slice(0, 2) !== region) { errors.push({ code: 'INVALID_REGION', field: `${at}.Region` }); return }
      if (ib && no && ib.slice(8) !== no) { errors.push({ code: 'ACCOUNT_NO_AND_IBAN_MISMATCH', field: `${at}.AccountNo, ${at}.Iban` }); return }
      const key = agencyKey(ib ?? no!)!
      const range = rangeFor(setup, key)
      if (!range || await this.#foreign(banks, agent, key)) { errors.push({ code: 'MASTER_ACCOUNT_NOT_FOUND', field: `${at}.AccountNo, ${at}.Iban` }); return }
      entries.push({
        e: { key, country: region!, iban: ib, accountNo: no ?? (ib && region === 'GB' ? ib.slice(8) : undefined), status: (status ?? undefined) as AgencyStatus | undefined, name: name ?? undefined, master: range.master },
        given: { region: region!, accountNo: accountNo ?? undefined, iban: iban ?? undefined, name: name ?? undefined },
      })
    }
    for (const [i, a] of list.entries()) await check(a, i)
    if (errors.length) return fail()

    // Valid: every account written to every entity ("duplicity is not checked": the last wins).
    const out = []
    for (const { e, given } of entries) {
      let written: AgencyAccount | undefined
      for (const b of banks) written = await this.#write(b, agent, e)
      // The response status is the account's; the XSD has no INST_RESTRICTED, so it is left out then.
      const st = written!.status === 'INST_RESTRICTED' ? undefined : written!.status
      out.push(el('Account', el('Region', given.region), given.accountNo ? el('AccountNo', given.accountNo) : null,
        given.iban ? el('Iban', given.iban) : null, st ? el('Status', st) : null, given.name ? el('Name', given.name) : null))
    }
    return send(toXml(el('AgentAccountSyncResponse', el('Accounts', ...out))))
  }

  // --- v2, JSON -----------------------------------------------------------------------

  /** POST /v2/agent/account/synchronize (LHV UK). The answer is in the inbox. */
  syncJson(raw: unknown, agent: Customer, requestId: string) {
    return this.#serial(() => this.#syncJson(raw, agent, requestId))
  }

  async #syncJson(raw: unknown, agent: Customer, requestId: string) {
    const send = (b: object) => this.deps.inbox.add({ customer: agent, type: AGENT_ACCOUNT_SYNC, requestId, body: JSON.stringify(b), contentType: 'application/json' })
    const failed = (code: V2Code, detail?: string) => send({
      OriginalMsgId: requestId, AcceptanceStatus: 'FAILED', Accounts: [],
      Errors: [{ Code: code, Description: detail ? `${V2[code]}: ${detail}` : V2[code] }],
    })
    let b: Record<string, unknown> | undefined
    try { b = asObject(parseJsonBody(raw)) } catch (e) {
      if (!(e instanceof JsonBodyError)) throw e
      return failed('INVALID_JSON_REQUEST', e.message)
    }
    if (!b) return failed('INVALID_JSON_REQUEST', 'the body must be a JSON object')
    // Schema violations fail the file (decision 806).
    let banks: AgencyBank[] = ['LHVUK']
    if (b.BankCodes !== undefined && b.BankCodes !== null) {
      if (!Array.isArray(b.BankCodes) || b.BankCodes.some((c) => typeof c !== 'string')) return failed('INVALID_JSON_REQUEST', 'BankCodes must be an array of strings')
      // v2 documents LHV UK's codes only; anything else is refused (decision 806).
      const bad = (b.BankCodes as string[]).find((c) => BANK_CODES[c] !== 'LHVUK')
      if (bad !== undefined) return failed('INVALID_JSON_REQUEST', `unsupported bank code ${bad}`)
      banks = ['LHVUK']
    }
    if (!Array.isArray(b.Accounts)) return failed('INVALID_JSON_REQUEST', 'Accounts must be an array')
    if (b.Accounts.length > SYNC_MAX) return failed('ACCOUNTS_OVER_MAXIMUM_ALLOWED_LIMIT')
    if (!b.Accounts.length) return failed('INVALID_JSON_REQUEST', 'Accounts must not be empty')
    const str = (v: unknown) => v === undefined || v === null || typeof v === 'string'
    for (const [i, a] of (b.Accounts as unknown[]).entries()) {
      const o = asObject(a)
      if (!o) return failed('INVALID_JSON_REQUEST', `Accounts[${i}] must be an object`)
      for (const k of ['Country', 'Identification']) if (typeof o[k] !== 'string') return failed('INVALID_JSON_REQUEST', `Accounts[${i}].${k} is mandatory`)
      for (const k of ['Status', 'Name', 'AccountCategory']) if (!str(o[k])) return failed('INVALID_JSON_REQUEST', `Accounts[${i}].${k} must be a string`)
      for (const k of ['CopOptOut', 'CoPOptOut']) if (o[k] !== undefined && o[k] !== null && typeof o[k] !== 'boolean') return failed('INVALID_JSON_REQUEST', `Accounts[${i}].${k} must be a boolean`)
    }

    const setup = await this.deps.store.setup(agent)
    const responder = !!(setup?.cop || setup?.vop)
    const seen = new Set<string>()
    const results = []
    for (const o of b.Accounts as Record<string, unknown>[]) results.push(await (async () => {
      const country = o.Country as string
      const identification = o.Identification as string
      const status = (o.Status ?? undefined) as string | undefined
      const name = typeof o.Name === 'string' && o.Name.trim() ? o.Name.replace(/\s+/g, ' ').trim() : undefined
      const category = (o.AccountCategory ?? undefined) as string | undefined
      const opt = (o.CopOptOut ?? o.CoPOptOut ?? undefined) as boolean | undefined
      const id = normalizeIban(identification)
      let code: V2Code | undefined
      let key: string | undefined
      let master: string | undefined
      if (!/^[A-Z]{2}$/.test(country) || !regionOk(country)) code = 'INVALID_REGION'
      else if (country === 'GB' && !GB_ACCOUNT_NO.test(id) && !/^[A-Z]{2}[0-9]{2}/.test(id)) code = 'INVALID_ACCOUNT_NO_OR_IBAN'
      else if (country !== 'GB' && !/^[A-Z]{2}[0-9]{2}/.test(id)) code = 'IBAN_MUST_EXIST_FOR_THIS_REGION'
      else if (!GB_ACCOUNT_NO.test(id) && (!IBAN_SHAPE.test(id) || !ibanChecksumOk(id) || (id.startsWith('GB') && !GB_IBAN.test(id)))) code = 'INVALID_IBAN'
      else if (!GB_ACCOUNT_NO.test(id) && id.slice(0, 2) !== country) code = 'IBAN_AND_REGION_MISMATCH'
      else if (status !== undefined && !AGENCY_STATUSES.includes(status as AgencyStatus)) code = 'INVALID_ACCOUNT_STATUS'
      else if (name !== undefined && [...name].length > 140) code = 'NAME_TOO_LONG'
      else if (responder && name === undefined) code = 'CONFIRMATION_OF_PAYEE_NAME_NOT_PROVIDED'
      else if ((responder && category === undefined) || (category !== undefined && category !== 'PERSONAL' && category !== 'BUSINESS')) code = 'CONFIRMATION_OF_PAYEE_ACCOUNT_CATEGORY_NOT_PROVIDED'
      else {
        key = agencyKey(id)!
        const range = rangeFor(setup, key)
        if (seen.has(key) || await this.#foreign(banks, agent, key)) code = 'DUPLICATE_ACCOUNT'
        else if (!range) code = 'MASTER_ACCOUNT_NOT_FOUND'
        else if (status === 'CLOSED' && !(await this.#anyOf(banks, key))) code = 'NOT_FOUND'
        else master = range.master
        seen.add(key)
      }
      // Echoed as sent, except values the message schema cannot carry (decision 806).
      const data = (st: string | undefined, copOptOut: boolean | undefined) => ({
        Country: country, Identification: identification, ...(st !== undefined && AGENCY_STATUSES.includes(st as AgencyStatus) ? { Status: st } : {}),
        ...(typeof o.Name === 'string' && [...o.Name].length <= 140 ? { Name: o.Name } : {}),
        ...(category === 'PERSONAL' || category === 'BUSINESS' ? { AccountCategory: category } : {}),
        ...(copOptOut !== undefined ? { CopOptOut: copOptOut } : {}),
      })
      if (code) {
        const current = key ? (await this.deps.store.get(banks[0], key))?.status : undefined
        return { Data: data(status ?? current, opt), Confirmed: false, ErrorInfo: { ErrorCode: code, ErrorDescription: V2[code] } }
      }
      const entry: Entry = {
        key: key!, country, master: master!, status: status as AgencyStatus | undefined, name, category: category as AccountCategory | undefined, copOptOut: opt,
        ...(GB_ACCOUNT_NO.test(id) ? { accountNo: id } : { iban: id, ...(country === 'GB' ? { accountNo: id.slice(8) } : {}) }),
      }
      let written: AgencyAccount | undefined
      for (const bk of banks) written = await this.#write(bk, agent, entry)
      return { Data: data(written!.status, written!.copOptOut), Confirmed: true }
    })())
    const ok = results.filter((r) => r.Confirmed).length
    return send({
      OriginalMsgId: requestId,
      AcceptanceStatus: ok === results.length ? 'OK' : ok === 0 ? 'FAILED' : 'PARTIAL',
      Accounts: results,
    })
  }
}
