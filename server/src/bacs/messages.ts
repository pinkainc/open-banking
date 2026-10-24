// The messages of Bacs on the UK host (G bacs-direct-debit/*, account-reports/incoming-bacs-
// credit-notification.md): what LHV sends — the Mandate Initiation Request (pain.009.001.07),
// the Mandate Cancellation Response (pain.012.001.07), the collection notification
// (pain.008.001.11), the reversal notification (pain.007.001.11) and the JSON ones
// (BACS_INCOMING, the two confirmations, the scheme cancellation) — and the readers of what
// the customer sends: pain.012 (mandate response), pain.011 (mandate cancellation) and
// pain.002 (collection response). Element order follows the G samples, which the ISO XSDs
// accept (tests).
import { fromMinor } from '../ledger.js'
import { isoLondon } from '../time.js'
import { document, el, many, opt, parseXml, text, toXml, type XmlEl } from '../xml.js'

/** A Bacs party: name, sort code and 8-digit account number. */
export interface Party { name: string; sortCode: string; accountNumber: string }

export const BACS_TYPES = {
  incoming: 'BACS_INCOMING',
  mandateInitiation: 'DIRECT_DEBIT_MANDATE_INITIATION',
  mandateConfirm: 'DIRECT_DEBIT_MANDATE_CONFIRM',
  mandateCancel: 'DIRECT_DEBIT_MANDATE_CANCEL',
  schemeCancel: 'DIRECT_DEBIT_MANDATE_SCHEME_CANCEL',
  collection: 'DIRECT_DEBIT_COLLECTION_NOTIFICATION',
  collectionConfirm: 'DIRECT_DEBIT_COLLECTION_CONFIRMATION',
  reversal: 'DIRECT_DEBIT_REVERSAL_NOTIFICATION',
} as const

export const PAIN009 = 'pain.009.001.07'
export const PAIN012 = 'pain.012.001.07'
export const PAIN011 = 'pain.011.001.07'
export const PAIN008 = 'pain.008.001.11'
/** The collection response: pain.002.001.14 in the operation and the samples, .13 in the G message table (decision 746). */
export const PAIN002 = ['pain.002.001.14', 'pain.002.001.13']
export const PAIN007 = 'pain.007.001.11'

/** Sort code and account number together: the 14-digit BBAN Bacs messages carry. */
export const bban = (p: Party) => `${p.sortCode}${p.accountNumber}`

const bbanAcct = (p: Party) => el('Id', el('Othr', el('Id', bban(p)), el('SchmeNm', el('Cd', 'BBAN'))))
const sortCodeAgt = (sortCode: string) => el('FinInstnId', el('ClrSysMmbId', el('ClrSysId', el('Cd', 'GBDSC')), el('MmbId', sortCode)))
const sun = (id: string) => el('Id', el('OrgId', el('Othr', el('Id', id), el('SchmeNm', el('Cd', 'BANK')))))
const doc = (ns: string, body: XmlEl) => toXml(document(ns, body))

// --- What LHV sends -----------------------------------------------------------------------

export interface MandateDoc {
  msgId: string; mandateId: string; reference: string; serviceUserNumber: string
  creditor: Party; debtor: Party
}

/** DIRECT_DEBIT_MANDATE_INITIATION: one mandate per message (G samples "In one file there is information about one Mandate"). */
export function pain009(m: MandateDoc, now: Date): string {
  return doc(PAIN009, el('MndtInitnReq',
    el('GrpHdr', el('MsgId', m.msgId), el('CreDtTm', isoLondon(now))),
    el('Mndt',
      el('MndtId', m.mandateId),
      el('MndtReqId', m.reference),
      el('TrckgInd', 'false'),
      el('Cdtr', el('Nm', m.creditor.name.slice(0, 140)), sun(m.serviceUserNumber)),
      el('CdtrAcct', bbanAcct(m.creditor), el('Ccy', 'GBP')),
      el('Dbtr', el('Nm', m.debtor.name.slice(0, 140))),
      el('DbtrAcct', bbanAcct(m.debtor), el('Ccy', 'GBP')),
      el('DbtrAgt', sortCodeAgt(m.debtor.sortCode)),
    )))
}

export interface CancelResult { mandateId?: string; accepted: boolean; code?: string; text?: string }

/** DIRECT_DEBIT_MANDATE_CANCEL: LHV's pain.012 answer to a pain.011, one block per cancellation. */
export function pain012Cancel(msgId: string, originalMsgId: string, results: CancelResult[], now: Date): string {
  return doc(PAIN012, el('MndtAccptncRpt',
    el('GrpHdr', el('MsgId', msgId), el('CreDtTm', isoLondon(now))),
    results.map((r) => el('UndrlygAccptncDtls',
      el('OrgnlMsgInf', el('MsgId', originalMsgId), el('MsgNmId', 'pain.011')),
      el('AccptncRslt', el('Accptd', String(r.accepted)),
        r.code ? el('RjctRsn', el('Cd', r.code)) : null, opt('AddtlRjctRsnInf', r.text)),
      r.mandateId ? el('OrgnlMndt', el('OrgnlMndtId', r.mandateId)) : null,
    ))))
}

export interface CollectionDoc {
  msgId: string; pmtInfId: string; endToEndId: string; amount: bigint; seqTp: 'FRST' | 'RCUR'
  collectionDate: string; creditor: Party; debtor: Party; reference?: string
}

/** DIRECT_DEBIT_COLLECTION_NOTIFICATION: the collection the creditor's bank sent (one per message). */
export function pain008(c: CollectionDoc, now: Date): string {
  const amt = fromMinor(c.amount)
  const tp = el('PmtTpInf', el('SvcLvl', el('Prtry', 'BACSDD')), el('SeqTp', c.seqTp))
  return doc(PAIN008, el('CstmrDrctDbtInitn',
    el('GrpHdr', el('MsgId', c.msgId), el('CreDtTm', isoLondon(now)), el('NbOfTxs', '1'), el('CtrlSum', amt),
      el('InitgPty', el('Nm', c.creditor.name.slice(0, 140)))),
    el('PmtInf',
      el('PmtInfId', c.pmtInfId), el('PmtMtd', 'DD'), el('NbOfTxs', '1'), el('CtrlSum', amt), tp,
      el('ReqdColltnDt', c.collectionDate),
      el('Cdtr', el('Nm', c.creditor.name.slice(0, 140))),
      el('CdtrAcct', bbanAcct(c.creditor), el('Ccy', 'GBP')),
      el('CdtrAgt', sortCodeAgt(c.creditor.sortCode)),
      el('DrctDbtTxInf',
        el('PmtId', el('EndToEndId', c.endToEndId)), tp,
        el('InstdAmt', { Ccy: 'GBP' }, amt),
        el('DbtrAgt', sortCodeAgt(c.debtor.sortCode)),
        el('Dbtr', el('Nm', c.debtor.name.slice(0, 140))),
        el('DbtrAcct', bbanAcct(c.debtor), el('Ccy', 'GBP'), el('Nm', c.debtor.name.slice(0, 70))),
        c.reference ? el('RmtInf', el('Ustrd', c.reference.slice(0, 140))) : null,
      ))))
}

export interface ReversalDoc {
  msgId: string; originalMsgId: string; originalCreatedAt: Date; reversalPmtInfId: string; pmtInfId: string
  amount: bigint; code: string; text: string
}

/** DIRECT_DEBIT_REVERSAL_NOTIFICATION: one reversed collection per message (G sample). */
export function pain007(r: ReversalDoc, now: Date): string {
  const amt = fromMinor(r.amount)
  const reason = el('RvslRsnInf', el('Rsn', el('Prtry', r.code)), el('AddtlInf', r.text.slice(0, 105)))
  return doc(PAIN007, el('CstmrPmtRvsl',
    el('GrpHdr', el('MsgId', r.msgId), el('CreDtTm', isoLondon(now)), el('NbOfTxs', '1'), el('CtrlSum', amt), el('GrpRvsl', 'false')),
    el('OrgnlGrpInf', el('OrgnlMsgId', r.originalMsgId), el('OrgnlMsgNmId', PAIN008), el('OrgnlCreDtTm', isoLondon(r.originalCreatedAt)), reason),
    el('OrgnlPmtInfAndRvsl', el('RvslPmtInfId', r.reversalPmtInfId), el('OrgnlPmtInfId', r.pmtInfId),
      el('OrgnlNbOfTxs', '1'), el('OrgnlCtrlSum', amt), reason),
  ))
}

const jsonParty = (p: Party) => ({
  AccountName: p.name, AccountNumber: p.accountNumber, AccountNumberCode: 'BBAN', Bank: { BankId: p.sortCode, BankIdCode: 'GBDSC' },
})

export interface IncomingDoc {
  beneficiary: Party; debtor: Party; amount: bigint; serviceUserNumber?: string; numericReference?: string
  schemeTransactionId: string; uniqueSchemeId: string; processingDate: string; schemeProcessingDate: string
  reference: string; servicerRef: string
}

/** BACS_INCOMING: the day-2 advance notice of an incoming Bacs credit, in the G field order. */
export function bacsIncoming(p: IncomingDoc): string {
  return JSON.stringify({
    Payment: {
      Beneficiary: jsonParty(p.beneficiary), Debtor: jsonParty(p.debtor), Amount: fromMinor(p.amount),
      ...(p.serviceUserNumber ? { ClearingId: p.serviceUserNumber } : {}), Currency: 'GBP',
      ...(p.numericReference ? { NumericReference: p.numericReference } : {}),
      SchemeTransactionId: p.schemeTransactionId, UniqueSchemeId: p.uniqueSchemeId, PaymentScheme: 'BACS',
      ProcessingDate: p.processingDate, SchemeProcessingDate: p.schemeProcessingDate, Reference: p.reference,
      SchemePaymentType: 'Credit', AccountServicerReference: p.servicerRef,
    },
  })
}

export interface Confirmation { id: string; confirmed: boolean; error?: { code: string; description: string } }

const status = (items: Confirmation[]) =>
  items.every((m) => m.confirmed) ? 'OK' : items.some((m) => m.confirmed) ? 'PARTIAL' : 'FAILED'
const confirmations = (items: Confirmation[], key: string) => items.map((m) => ({
  [key]: m.id, Confirmed: m.confirmed, ...(m.error ? { ErrorInfo: { ErrorCode: m.error.code, ErrorDescription: m.error.description } } : {}),
}))

/** DIRECT_DEBIT_MANDATE_CONFIRM: LHV's answer to a pain.012 (keys with literal dots). */
export const mandateConfirm = (msgId: string, items: Confirmation[]) =>
  JSON.stringify({ 'GrpHdr.MsgId': msgId, AcceptanceStatus: status(items), Messages: confirmations(items, 'OrgnlMsgInf.MsgId') })

/** DIRECT_DEBIT_COLLECTION_CONFIRMATION: LHV's answer to a pain.002. */
export const collectionConfirm = (msgId: string, originalMsgId: string, items: Confirmation[]) => JSON.stringify({
  'GrpHdr.MsgId': msgId, 'OrgnlGrpInfAndSts.OrgnlMsgId': originalMsgId, AcceptanceStatus: status(items), Messages: confirmations(items, 'OrgnlPmtInfId'),
})

export interface SchemeCancelDoc {
  creditor: Party; debtor: Party; mandateId: string; reference: string; serviceUserNumber: string; reason: string; closed: string
}

/** DIRECT_DEBIT_MANDATE_SCHEME_CANCEL: a mandate cancelled by the Service User through AUDDIS. */
export const schemeCancel = (m: SchemeCancelDoc) => JSON.stringify({
  Mandate: {
    Beneficiary: jsonParty(m.creditor), Debtor: jsonParty(m.debtor),
    OriginalMandateId: m.mandateId, Reference: m.reference, ClearingId: m.serviceUserNumber,
  },
  Status: 'CANCELLED_BY_SCHEME', ReasonCode: 'MD17', Reason: m.reason, DateClosed: m.closed,
})

// --- What the customer sends --------------------------------------------------------------

/** Not the document the operation takes: the route answers 400 (decision 745). */
export class BacsRequestError extends Error {}

function root(xml: string, namespaces: string[], name: string): { ns: string; body: any } {
  const d = parseXml(xml).Document
  const ns = /<(?:[\w.-]+:)?Document[^>]*\sxmlns(?::[\w.-]+)?="urn:iso:std:iso:20022:tech:xsd:([a-z]{4}\.\d{3}\.\d{3}\.\d{2})"/.exec(xml)?.[1] ?? ''
  const body = d?.[name]
  if (!body || typeof body !== 'object' || !namespaces.includes(ns)) {
    throw new BacsRequestError(`The request body must be a ${namespaces[0]} document (${name})`)
  }
  return { ns, body }
}
const msgIdOf = (body: any) => {
  const id = text(body.GrpHdr?.MsgId)
  if (!id) throw new BacsRequestError('GrpHdr/MsgId is missing')
  return id
}

export interface MandateResponse { originalMsgId?: string; mandateId?: string; accepted?: string; reason?: string }

/** pain.012 from the customer: one accept/reject per UndrlygAccptncDtls. */
export function readPain012(xml: string): { msgId: string; items: MandateResponse[] } {
  const { body } = root(xml, [PAIN012], 'MndtAccptncRpt')
  const items = many(body.UndrlygAccptncDtls).map((u: any) => ({
    originalMsgId: text(u.OrgnlMsgInf?.MsgId), mandateId: text(u.OrgnlMndt?.OrgnlMndtId),
    accepted: text(u.AccptncRslt?.Accptd), reason: text(u.AccptncRslt?.RjctRsn?.Cd) ?? text(u.AccptncRslt?.RjctRsn?.Prtry),
  }))
  if (!items.length) throw new BacsRequestError('MndtAccptncRpt has no UndrlygAccptncDtls')
  return { msgId: msgIdOf(body), items }
}

export interface MandateCancellation { originalMsgId?: string; mandateId?: string; reason?: string }

/** pain.011 from the customer: one cancellation per UndrlygCxlDtls. */
export function readPain011(xml: string): { msgId: string; items: MandateCancellation[] } {
  const { body } = root(xml, [PAIN011], 'MndtCxlReq')
  const items = many(body.UndrlygCxlDtls).map((u: any) => ({
    originalMsgId: text(u.OrgnlMsgInf?.MsgId),
    mandateId: text(u.OrgnlMndt?.OrgnlMndtId) ?? text(u.OrgnlMndt?.OrgnlMndt?.MndtId),
    reason: text(u.CxlRsn?.Rsn?.Cd) ?? text(u.CxlRsn?.Rsn?.Prtry),
  }))
  if (!items.length) throw new BacsRequestError('MndtCxlReq has no UndrlygCxlDtls')
  return { msgId: msgIdOf(body), items }
}

export interface CollectionResponse { pmtInfId?: string; status?: string; reason?: string }

/** pain.002 from the customer: the pain.008 it answers and one status per OrgnlPmtInfAndSts. */
export function readPain002(xml: string): { msgId: string; originalMsgId: string; items: CollectionResponse[] } {
  const { body } = root(xml, PAIN002, 'CstmrPmtStsRpt')
  const g = body.OrgnlGrpInfAndSts
  const originalMsgId = text(g?.OrgnlMsgId)
  if (!originalMsgId) throw new BacsRequestError('OrgnlGrpInfAndSts/OrgnlMsgId is missing')
  const groupReason = text(many(g?.StsRsnInf)[0]?.Rsn?.Cd)
  const items = many(body.OrgnlPmtInfAndSts).map((b: any) => ({
    pmtInfId: text(b.OrgnlPmtInfId),
    status: text(b.PmtInfSts) ?? text(g?.GrpSts),
    reason: text(many(b.StsRsnInf)[0]?.Rsn?.Cd) ?? groupReason,
  }))
  if (!items.length) throw new BacsRequestError('CstmrPmtStsRpt has no OrgnlPmtInfAndSts')
  return { msgId: msgIdOf(body), originalMsgId, items }
}
