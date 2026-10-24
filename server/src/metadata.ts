// Messages Metadata (G messages-metadata.md, decision 623): the key values of a message
// body surfaced next to it, so a client can route a message without parsing it. Shared by
// GET /v2/messages?includeMetadata=true and, later, the UK webhooks (webhook-metadata.md).
// Keys are the documented dotted paths; values are the element texts as strings. A
// message whose type has no documented fields (or whose body is an <Errors> document) has
// no metadata at all, as the HEARTBEAT in the G sample.
import type { Message } from './inbox.js'
import { many, parseXml, text } from './xml.js'

type Fields = Record<string, string | Record<string, string>[]>

/** Only the fields that have a value, in the given order. */
function pick(pairs: [string, string | undefined][]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of pairs) if (v !== undefined && v !== '') out[k] = v
  return out
}

/** IBAN, or the other identification (BBAN) under `<prefix>.Id`. */
const account = (prefix: string, acct: any): [string, string | undefined][] => {
  const iban = text(acct?.Id?.IBAN)
  return iban ? [[`${prefix}.IBAN`, iban]] : [[`${prefix}.Id`, text(acct?.Id?.Othr?.Id)]]
}

const nonEmpty = (f: Fields): Fields | undefined => (Object.keys(f).length ? f : undefined)

function camt052(r: any): Fields | undefined {
  const reports = many(r.Rpt).map((x: any) => pick([['Acct.IBAN', text(x.Acct?.Id?.IBAN)], ['Acct.Ccy', text(x.Acct?.Ccy)]]))
  return reports.length ? { Reports: reports } : undefined
}

function camt053(r: any): Fields | undefined {
  const statements = many(r.Stmt).map((x: any) => pick([
    ['Acct.IBAN', text(x.Acct?.Id?.IBAN)], ['Acct.Ccy', text(x.Acct?.Ccy)],
    ['TtlCdtNtries.NbOfNtries', text(x.TxsSummry?.TtlCdtNtries?.NbOfNtries)],
    ['TtlDbtNtries.NbOfNtries', text(x.TxsSummry?.TtlDbtNtries?.NbOfNtries)],
  ]))
  return statements.length ? { Statements: statements } : undefined
}

/** camt.054: "only one transaction", the first entry of the first notification. */
function camt054(r: any): Fields | undefined {
  const n = many(r.Ntfctn)[0]
  const e = many(n?.Ntry)[0]
  const parties = many(many(e?.NtryDtls)[0]?.TxDtls)[0]?.RltdPties
  return nonEmpty(pick([
    ['Acct.IBAN', text(n?.Acct?.Id?.IBAN)], ['AcctSvcrRef', text(e?.AcctSvcrRef)], ['CdtDbtInd', text(e?.CdtDbtInd)],
    ...(parties?.DbtrAcct ? account('DbtrAcct', parties.DbtrAcct) : []),
    ...(parties?.CdtrAcct ? account('CdtrAcct', parties.CdtrAcct) : []),
  ]))
}

/** pain.002 of a payment: the group and one block per transaction ("Payments", name ours). */
function pain002(r: any): Fields | undefined {
  const g = r.OrgnlGrpInfAndSts
  const payments = many(r.OrgnlPmtInfAndSts).flatMap((b: any) => many(b.TxInfAndSts).map((t: any) => pick([
    ['DebtorAcct.IBAN', text(t.OrgnlTxRef?.DbtrAcct?.Id?.IBAN) ?? text(b.OrgnlDbtrAcct?.Id?.IBAN)],
    ['CreditorAcct.IBAN', text(t.OrgnlTxRef?.CdtrAcct?.Id?.IBAN) ?? text(t.OrgnlTxRef?.CdtrAcct?.Id?.Othr?.Id)],
    ['TxSts', text(t.TxSts)], ['AcctSvcrRef', text(t.AcctSvcrRef)],
  ])))
  const f: Fields = pick([['GrpSts', text(g?.GrpSts)], ['OrgnlMsgId', text(g?.OrgnlMsgId)]])
  if (payments.length) f.Payments = payments
  return nonEmpty(f)
}

function viban(r: any): Fields | undefined {
  return nonEmpty(pick([
    ['MasterAccount', text(r.MasterAccount)], ['VirtualIBAN', text(r.VirtualIBAN)],
    ['ClientReference', text(r.ClientReference)], ['Status', text(r.Status)],
  ]))
}

function json(m: Message): Fields | undefined {
  if (m.type !== 'CONFIRMATION_OF_PAYEE') return undefined
  let b: any
  try { b = JSON.parse(m.body) } catch { return undefined }
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return nonEmpty(pick([['OriginalMessageId', s(b?.OriginalMessageId)], ['ReasonCode', s(b?.Data?.ReasonCode)], ['Description', s(b?.Data?.Description)]]))
}

/** The documented metadata of a message, or undefined when it has none. */
export function messageMetadata(m: Message): Fields | undefined {
  if (m.contentType.includes('json')) return json(m)
  let doc: any
  try { doc = parseXml(m.body) } catch { return undefined }
  const d = doc.Document
  if (d?.BkToCstmrAcctRpt) return camt052(d.BkToCstmrAcctRpt)
  if (d?.BkToCstmrStmt) return camt053(d.BkToCstmrStmt)
  if (d?.BkToCstmrDbtCdtNtfctn) return camt054(d.BkToCstmrDbtCdtNtfctn)
  if (d?.CstmrPmtStsRpt) return m.type === 'PAYMENT' ? pain002(d.CstmrPmtStsRpt) : undefined
  const root = Object.keys(doc).find((k) => /^Viban\w+(Response|Notification)$/.test(k))
  return root ? viban(doc[root]) : undefined
}
