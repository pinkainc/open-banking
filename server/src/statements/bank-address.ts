// The bank's postal address in the account servicer block of a statement
// (Stmt/Acct/Svcr/FinInstnId/PstlAdr), as the published samples show it: AS LHV Pank,
// Tartu mnt. 2 (EE), and LHV Bank Limited, 1 Angel Court (UK). Decision 553.
import { el, opt, type Node } from '../xml.js'

/** ISO 20022 element names; only those both camt.053.001.02 and .08 have. */
export interface BankAddress {
  /** Address type code (AddressType2Code), BIZZ in the samples. */
  AdrTp?: string
  Dept?: string
  SubDept?: string
  StrtNm?: string
  BldgNb?: string
  PstCd?: string
  TwnNm?: string
  CtrySubDvsn?: string
  Ctry?: string
  AdrLine?: string[]
}

/** P 05 / PAYMENT_VIBAN_SEPA ACCOUNT_STATEMENT_CAMT.053A. */
export const EE_ADDRESS: BankAddress = { AdrTp: 'BIZZ', StrtNm: 'Tartu mnt.', BldgNb: '2', PstCd: '10145', TwnNm: 'Tallinn', CtrySubDvsn: 'Harjumaa', Ctry: 'EE' }
/** G account-statement (v02 and v08 examples). */
export const UK_ADDRESS: BankAddress = { AdrTp: 'BIZZ', StrtNm: 'Angel Court', BldgNb: '1', PstCd: 'EC2R 7HJ', TwnNm: 'London', Ctry: 'GB' }

/** The published address of the bank behind a BIC: the UK one for a GB BIC, else the EE one. */
export const defaultBankAddress = (bic: string): BankAddress => (bic.slice(4, 6) === 'GB' ? UK_ADDRESS : EE_ADDRESS)

const ADDRESS_TYPES = ['ADDR', 'PBOX', 'HOME', 'BIZZ', 'MLTO', 'DLVY']
const MAX: Record<string, number> = { Dept: 70, SubDept: 70, StrtNm: 70, BldgNb: 16, PstCd: 16, TwnNm: 35, CtrySubDvsn: 35 }

/** Throws on an address the schemas would refuse (checked once, when the bank is set up). */
export function checkBankAddress(a: BankAddress) {
  const bad = (m: string) => { throw new Error(`bank.address: ${m}`) }
  for (const k of Object.keys(a)) if (!(k in MAX) && !['AdrTp', 'Ctry', 'AdrLine'].includes(k)) bad(`unknown field ${k}`)
  if (a.AdrTp !== undefined && !ADDRESS_TYPES.includes(a.AdrTp)) bad(`AdrTp must be one of ${ADDRESS_TYPES.join(', ')}`)
  if (a.Ctry !== undefined && !/^[A-Z]{2}$/.test(a.Ctry)) bad('Ctry must be an ISO country code')
  for (const [k, n] of Object.entries(MAX)) {
    const v = a[k as keyof BankAddress]
    if (v !== undefined && (typeof v !== 'string' || !v || v.length > n)) bad(`${k} must be 1 to ${n} characters`)
  }
  if (a.AdrLine !== undefined && (!Array.isArray(a.AdrLine) || a.AdrLine.length > 7 || a.AdrLine.some((l) => typeof l !== 'string' || !l || l.length > 70))) {
    bad('AdrLine must be at most 7 lines of 1 to 70 characters')
  }
}

/** PstlAdr in schema order; v08 wraps the type in Cd. Nothing when there is no field. */
export function postalAddress(a: BankAddress | null | undefined, v8: boolean): Node {
  if (!a) return null
  const fields = [
    a.AdrTp ? el('AdrTp', v8 ? el('Cd', a.AdrTp) : a.AdrTp) : null,
    opt('Dept', a.Dept), opt('SubDept', a.SubDept), opt('StrtNm', a.StrtNm), opt('BldgNb', a.BldgNb), opt('PstCd', a.PstCd),
    opt('TwnNm', a.TwnNm), opt('CtrySubDvsn', a.CtrySubDvsn), opt('Ctry', a.Ctry), (a.AdrLine ?? []).map((l) => el('AdrLine', l)),
  ]
  return fields.flat().some((f) => f) ? el('PstlAdr', fields) : null
}
