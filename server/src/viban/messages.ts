// The VIBAN services' own XML (not ISO 20022, no namespace): reading the five requests,
// writing their responses and the status notification. Element order follows the
// documented samples; the XSDs use xs:all, so any order would validate.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateXML } from 'xmllint-wasm'
import { isoTallinn } from '../time.js'
import { el, opt, text, toXml, type XmlEl } from '../xml.js'
import type { Address, Company, Person, Viban, VibanUser } from './registry.js'

export type Op = 'open' | 'bulk' | 'modify' | 'info' | 'close'

export const ROOT: Record<Op, string> = {
  open: 'VibanOpenRequest', bulk: 'VibanBulkRequest', modify: 'VibanModifyRequest', info: 'VibanInfoRequest', close: 'VibanCloseRequest',
}
export const RESPONSE_TYPE: Record<Op, string> = {
  open: 'VIBAN_OPEN', bulk: 'VIBAN_BULK', modify: 'VIBAN_MODIFY', info: 'VIBAN_INFO', close: 'VIBAN_CLOSE',
}
export const STATUS_NOTIFICATION = 'VIBAN_STATUS_NOTIFICATION'

/** The parsed request; only the fields the operation has are set. */
export interface VibanRequest {
  masterAccount: string
  virtualIban?: string
  clientReference?: string
  user?: VibanUser
  amount?: number
  modifyReason?: string
}

const s = (v: unknown) => {
  const t = text(v)
  return t === undefined ? undefined : t.replace(/\s+/g, ' ').trim()
}
class Missing extends Error {}
const req = (v: unknown) => {
  const t = s(v)
  if (!t) throw new Missing()
  return t
}

function readUser(u: any): VibanUser {
  if (!u || typeof u !== 'object') throw new Missing()
  if ((u.Person === undefined) === (u.Company === undefined)) throw new Missing()
  const a = u.Address
  if (!a || typeof a !== 'object') throw new Missing()
  const address: Address = { Country: req(a.Country), StreetNo: req(a.StreetNo), CityCounty: req(a.CityCounty) }
  if (u.Person !== undefined) {
    const p = u.Person
    if (!p || typeof p !== 'object') throw new Missing()
    const person: Person = { Name: req(p.Name), BirthDate: req(p.BirthDate), BirthCountry: s(p.BirthCountry), Residency: req(p.Residency), DocumentNumber: s(p.DocumentNumber) }
    return { person, address }
  }
  const c = u.Company
  const r = c?.Representative
  if (!c || typeof c !== 'object' || !r || typeof r !== 'object') throw new Missing()
  const company: Company = {
    Name: req(c.Name), CountryOfOrigin: req(c.CountryOfOrigin), TaxResidency: req(c.TaxResidency), RegistrationNumber: req(c.RegistrationNumber),
    Representative: { Name: req(r.Name), BirthDate: req(r.BirthDate), Residency: req(r.Residency) },
  }
  return { company, address }
}

/** Reads a request of the operation; undefined when its required elements are missing. */
export function readRequest(op: Op, root: any): VibanRequest | undefined {
  try {
    const r: VibanRequest = { masterAccount: req(root.MasterAccount) }
    if (op === 'modify' || op === 'info' || op === 'close') r.virtualIban = req(root.VirtualIBAN)
    if (op === 'open' || op === 'modify') {
      r.clientReference = s(root.ClientReference)
      r.user = readUser(root.User)
    }
    if (op === 'modify') r.modifyReason = s(root.ModifyReason)
    if (op === 'bulk') {
      const a = req(root.Amount)
      if (!/^\+?\d+$/.test(a)) return undefined
      r.amount = Number(a)
    }
    return r
  } catch (e) {
    if (e instanceof Missing) return undefined
    throw e
  }
}

/** The country fields of a user with their element names (for INVALID_COUNTRY). */
export function countryFields(root: any): [string, string][] {
  const out: [string, string][] = []
  const add = (name: string, v: unknown) => { const t = s(v); if (t !== undefined) out.push([name, t]) }
  const u = root?.User
  add('BirthCountry', u?.Person?.BirthCountry)
  add('Residency', u?.Person?.Residency)
  add('CountryOfOrigin', u?.Company?.CountryOfOrigin)
  add('TaxResidency', u?.Company?.TaxResidency)
  add('Residency', u?.Company?.Representative?.Residency)
  add('Country', u?.Address?.Country)
  return out
}

/** Birth dates of a user (the person's and the representative's). */
export function birthDates(root: any): string[] {
  const u = root?.User
  return [s(u?.Person?.BirthDate), s(u?.Company?.Representative?.BirthDate)].filter((d): d is string => d !== undefined)
}

// --- Writing -----------------------------------------------------------------------

/** xs:date with the Tallinn offset, as the samples: 2018-05-22+03:00. */
export function vibanDate(d: Date): string {
  const iso = isoTallinn(d)
  return iso.slice(0, 10) + iso.slice(-6)
}

export function userXml(u: VibanUser): XmlEl {
  const p = u.person
  const c = u.company
  return el('User',
    p ? el('Person', el('Name', p.Name), el('BirthDate', p.BirthDate), opt('BirthCountry', p.BirthCountry), el('Residency', p.Residency), opt('DocumentNumber', p.DocumentNumber)) : null,
    c ? el('Company', el('Name', c.Name), el('CountryOfOrigin', c.CountryOfOrigin), el('TaxResidency', c.TaxResidency), el('RegistrationNumber', c.RegistrationNumber),
      el('Representative', el('Name', c.Representative.Name), el('BirthDate', c.Representative.BirthDate), el('Residency', c.Representative.Residency))) : null,
    el('Address', el('Country', u.address.Country), el('StreetNo', u.address.StreetNo), el('CityCounty', u.address.CityCounty)))
}

const xml = (root: XmlEl) => toXml(root)

export const openResponse = (v: Viban) => xml(el('VibanOpenResponse',
  el('MasterAccount', v.master), opt('ClientReference', v.clientReference), el('VirtualIBAN', v.iban), userXml(v.user!), el('Status', v.status)))

export const bulkResponse = (master: string, ibans: string[]) => xml(el('VibanBulkResponse',
  el('MasterAccount', master), el('VirtualIBANList', ibans.map((i) => el('VirtualIBAN', i)))))

export const modifyResponse = (v: Viban) => xml(el('VibanModifyResponse',
  opt('ClientReference', v.clientReference), el('VirtualIBAN', v.iban), userXml(v.user!), el('Status', v.status)))

const dates = (v: Viban) => [v.activatedAt ? el('DateActivated', vibanDate(v.activatedAt)) : null, v.closedAt ? el('DateClosed', vibanDate(v.closedAt)) : null]

export const infoResponse = (v: Viban) => xml(el('VibanInfoResponse',
  opt('ClientReference', v.clientReference), el('VirtualIBAN', v.iban), v.user ? userXml(v.user) : null, el('Status', v.status), dates(v)))

export const closeResponse = (v: Viban) => xml(el('VibanCloseResponse',
  el('VirtualIBAN', v.iban), el('Status', v.status), el('DateClosed', vibanDate(v.closedAt!))))

export const statusNotification = (v: Viban) => xml(el('VibanStatusNotification',
  opt('ClientReference', v.clientReference), el('MasterAccount', v.master), el('VirtualIBAN', v.iban), v.user ? userXml(v.user) : null, el('Status', v.status), dates(v)))

// --- Schemas -------------------------------------------------------------------------

/** The published viban.*.xsd files; each includes viban.common.xsd. */
export class VibanSchemas {
  constructor(readonly dir: string) {}

  /** e.g. has('viban.open.request') */
  has(name: string) { return existsSync(join(this.dir, `${name}.xsd`)) && existsSync(join(this.dir, 'viban.common.xsd')) }

  async validate(doc: string, name: string): Promise<string[]> {
    const file = (n: string) => ({ fileName: `${n}.xsd`, contents: readFileSync(join(this.dir, `${n}.xsd`), 'utf8') })
    const r = await validateXML({ xml: [{ fileName: 'request.xml', contents: doc }], schema: [file(name)], preload: [file('viban.common')] })
    return r.valid ? [] : r.errors.map((e) => e.message.replace(/^.*?Schemas validity error : /, '').trim())
  }
}
