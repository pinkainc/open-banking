// The Account Reporting Request (camt.060.001.05 and .03) shared by /account-statement
// and /account-balance, and the reporting-period arithmetic in Europe/Tallinn time.
import { isoTallinn } from '../time.js'
import { many, parseXml, text } from '../xml.js'

export type RequestVersion = '05' | '03'

export interface ReportRequest {
  version: RequestVersion
  msgId?: string
  reqdMsgNmId?: string
  iban?: string
  /** Number of RptgReq blocks (one account per request is supported). */
  requests: number
  frDt?: string
  toDt?: string
  frTm?: string
  toTm?: string
  /** ReqdBalTp/CdOrPrtry/Prtry (DATE, DATETIME, PAYMENT_LIMITS, END_OF_DAY_BALANCE, …). */
  prtry?: string
}

export class RequestInvalid extends Error {}

/** Parses a camt.060 document; RequestInvalid when it is not one. */
export function parseCamt060(xml: string): ReportRequest {
  let doc: any
  try { doc = parseXml(xml) } catch (e) { throw new RequestInvalid((e as Error).message) }
  const root = doc?.Document
  // The parser drops namespace declarations (removeNSPrefix), so read it from the text.
  const m = /<(?:\w+:)?Document[^>]*\sxmlns(?::\w+)?="urn:iso:std:iso:20022:tech:xsd:camt\.060\.001\.(0[35])"/.exec(xml)
  if (!m || typeof root?.AcctRptgReq !== 'object') throw new RequestInvalid('not a camt.060.001.05 or camt.060.001.03 document')
  const req = root.AcctRptgReq
  const rr = many<any>(req.RptgReq)
  const r = rr[0] ?? {}
  const prd = r.RptgPrd ?? {}
  return {
    version: m[1] as RequestVersion,
    msgId: text(req.GrpHdr?.MsgId),
    reqdMsgNmId: text(r.ReqdMsgNmId)?.trim(),
    iban: text(r.Acct?.Id?.IBAN)?.replace(/\s+/g, '').toUpperCase(),
    requests: rr.length,
    frDt: text(prd.FrToDt?.FrDt),
    toDt: text(prd.FrToDt?.ToDt),
    frTm: text(prd.FrToTm?.FrTm),
    toTm: text(prd.FrToTm?.ToTm),
    prtry: text(many<any>(r.ReqdBalTp)[0]?.CdOrPrtry?.Prtry)?.trim(),
  }
}

// --- Europe/Tallinn wall time ---------------------------------------------------------

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/

/** Offset of Tallinn time from UTC at an instant, in minutes. */
function offsetAt(t: number): number {
  const o = isoTallinn(new Date(t)).slice(-6)
  return (o[0] === '-' ? -1 : 1) * (Number(o.slice(1, 3)) * 60 + Number(o.slice(4, 6)))
}

/** The instant of a Tallinn wall-clock time (date + optional time, with or without an offset). */
export function instant(date: string, time = '00:00:00'): number {
  const d = DATE.exec(date)
  const t = TIME.exec(time)
  if (!d || !t) throw new RangeError(`invalid date/time ${date} ${time}`)
  const ms = Number((t[4] ?? '').padEnd(3, '0').slice(0, 3))
  const wall = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], +t[3], ms)
  if (Number.isNaN(wall) || new Date(wall).toISOString().slice(0, 10) !== date) throw new RangeError(`invalid date ${date}`)
  if (t[5] === 'Z') return wall
  if (t[5]) {
    const sign = t[5][0] === '-' ? -1 : 1
    return wall - sign * (Number(t[5].slice(1, 3)) * 60 + Number(t[5].slice(4, 6))) * 60_000
  }
  const guess = wall - offsetAt(wall) * 60_000
  return wall - offsetAt(guess) * 60_000
}

/** A date shifted by whole days. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export const isDate = (s: string | undefined): s is string => !!s && DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
export const isTime = (s: string | undefined): s is string => !!s && TIME.test(s)

/** Is the instant a Tallinn midnight? */
export const isMidnight = (t: number) => isoTallinn(new Date(t)).slice(11, 23) === '00:00:00.000'
