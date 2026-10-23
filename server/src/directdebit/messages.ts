// The messages of SEPA Direct Debit: the Payment Status Report (pain.002.001.10) for
// collections and refusals, and the incoming collection notification, a pain.008.001.08
// with the one collection, sent to the debtor.
import type { Customer } from '../directory.js'
import { statusReportMsgId } from '../ids.js'
import { fromMinor } from '../ledger.js'
import { isoTallinn } from '../time.js'
import { document, el, opt, toXml } from '../xml.js'
import { PAIN008 } from './pain008.js'

export type CollectionStatus = 'PENDING' | 'SETTLED' | 'REJECTED' | 'REFUSED' | 'REFUNDED'

/** One collection, from acceptance to its final state. */
export interface Collection {
  /** The bank's reference (AcctSvcrRef of the acceptance and of the settlement entries). */
  id: string
  /** The creditor's pain.008 MsgId. */
  msgId: string
  pmtInfId: string
  endToEndId: string
  instrId?: string
  amount: bigint
  currency: string
  dueDate: string
  settlementDate: string
  scheme: string
  localInstrument: string
  seqTp?: string
  mandateId?: string
  signedOn?: string
  creditorSchemeId?: string
  creditor: { name?: string; iban: string; bic?: string; country?: string; address?: string[] }
  debtor: { name?: string; iban: string; bic?: string }
  ustrd?: string
  reference?: string
  status: CollectionStatus
  /** Set when the creditor is our customer: its reports go there. */
  creditorCustomer?: Customer
  /** Set when the debtor's account is ours. */
  debtorCustomer?: Customer
  /** The creditor's Message-Request-Id, carried by every later report. */
  requestId?: string
  settledAt?: Date
  /** The refusal / return code once the collection is refused, returned or refunded. */
  reason?: string
  /** A debtor refusal that came after the cut-off: returned right after settlement. */
  returnOnSettle?: string
  /** MsgId of the DIRECT_DEBIT_INCOMING_COLLECTION_NOTIFICATION the debtor got. */
  notificationMsgId?: string
}

export type DdTxStatus = 'ACCP' | 'ACSP' | 'ACSC' | 'PDNG' | 'RJCT'
export type DdGroupStatus = DdTxStatus | 'PART'

export interface DdStatus {
  pmtInfId: string
  endToEndId?: string
  instrId?: string
  status: DdTxStatus
  /** A SEPA reason code (AM04, MS02 …); NARR when only a text is documented. */
  code?: string
  text?: string
  /** The collection this status is about, for OrgnlTxRef (absent when nothing matched). */
  collection?: Collection
}

export interface DdReport {
  originalMsgId: string
  /** pain.008.001.08 for collections, pain.007.001.09 for refusals. */
  originalMsgName: string
  /** Present only in the first report about a file. */
  groupStatus?: DdGroupStatus
  groupReason?: string
  blocks: { pmtInfId: string; status?: DdGroupStatus; txs: DdStatus[] }[]
}

/** The group status of a set of collection statuses (P 09 group level table). */
export function aggregate(s: DdTxStatus[]): DdGroupStatus {
  if (s.every((x) => x === 'RJCT')) return 'RJCT'
  if (s.some((x) => x === 'RJCT')) return 'PART'
  if (s.some((x) => x === 'PDNG')) return 'PDNG'
  for (const x of ['ACCP', 'ACSP', 'ACSC'] as const) if (s.every((y) => y === x)) return x
  return 'ACCP'
}

const agent = (bic?: string) => el('FinInstnId', opt('BICFI', bic))
const iban = (v: string) => el('Id', el('IBAN', v))
const creditorScheme = (id?: string) => id
  ? el('CdtrSchmeId', el('Id', el('PrvtId', el('Othr', el('Id', id), el('SchmeNm', el('Prtry', 'SEPA'))))))
  : null
const remittance = (c: Collection) => c.ustrd || c.reference
  ? el('RmtInf', opt('Ustrd', c.ustrd?.slice(0, 140)),
      c.reference ? el('Strd', el('CdtrRefInf', el('Tp', el('CdOrPrtry', el('Cd', 'SCOR'))), el('Ref', c.reference))) : null)
  : null
const paymentType = (c: Collection) =>
  el('PmtTpInf', el('SvcLvl', el('Prtry', c.scheme)), el('LclInstrm', el('Cd', c.localInstrument)), opt('SeqTp', c.seqTp))

export function ddStatusReport(r: DdReport, bankBic: string, now: Date): string {
  const reason = (code?: string, text?: string) => code || text
    ? el('StsRsnInf', el('Rsn', el('Cd', code ?? 'NARR')), opt('AddtlInf', text?.slice(0, 105)))
    : null
  const party = (name?: string) => (name ? el('Pty', el('Nm', name.slice(0, 140))) : null)
  const txRef = (c: Collection) => el('OrgnlTxRef',
    el('Amt', el('InstdAmt', { Ccy: c.currency }, fromMinor(c.amount))),
    el('ReqdColltnDt', c.dueDate),
    creditorScheme(c.creditorSchemeId),
    paymentType(c),
    el('MndtRltdInf', opt('MndtId', c.mandateId), opt('DtOfSgntr', c.signedOn)),
    remittance(c),
    c.debtor.name ? el('Dbtr', party(c.debtor.name)) : null,
    el('DbtrAcct', iban(c.debtor.iban)),
    el('DbtrAgt', agent(c.debtor.bic)),
    el('CdtrAgt', agent(c.creditor.bic)),
    c.creditor.name ? el('Cdtr', party(c.creditor.name)) : null,
    el('CdtrAcct', iban(c.creditor.iban)),
  )
  const tx = (s: DdStatus) => el('TxInfAndSts',
    opt('OrgnlInstrId', s.instrId),
    opt('OrgnlEndToEndId', s.endToEndId),
    el('TxSts', s.status),
    reason(s.code, s.text),
    s.status !== 'RJCT' ? opt('AcctSvcrRef', s.collection?.id) : null,
    s.collection ? txRef(s.collection) : null,
  )
  const body = el('CstmrPmtStsRpt',
    el('GrpHdr',
      el('MsgId', statusReportMsgId()),
      el('CreDtTm', isoTallinn(now)),
      el('InitgPty', el('Id', el('OrgId', el('AnyBIC', bankBic)))),
    ),
    el('OrgnlGrpInfAndSts',
      el('OrgnlMsgId', r.originalMsgId),
      el('OrgnlMsgNmId', r.originalMsgName),
      opt('GrpSts', r.groupStatus),
      r.groupStatus === 'RJCT' && r.groupReason ? reason('NARR', r.groupReason) : null,
    ),
    r.blocks.map((b) => el('OrgnlPmtInfAndSts', el('OrgnlPmtInfId', b.pmtInfId), opt('PmtInfSts', b.status), b.txs.map(tx))),
  )
  return toXml(document('pain.002.001.10', body))
}

/**
 * DIRECT_DEBIT_INCOMING_COLLECTION_NOTIFICATION: the collection as the debtor's bank
 * received it, one per message. PmtInfId and EndToEndId are the creditor's, since the
 * debtor's refusal (pain.007) names them.
 */
export function incomingCollection(c: Collection, msgId: string, now: Date): string {
  const amt = fromMinor(c.amount)
  const cr = c.creditor
  const body = el('CstmrDrctDbtInitn',
    el('GrpHdr',
      el('MsgId', msgId),
      el('CreDtTm', isoTallinn(now)),
      el('NbOfTxs', '1'),
      el('CtrlSum', amt),
      el('InitgPty', opt('Nm', cr.name?.slice(0, 140))),
    ),
    el('PmtInf',
      el('PmtInfId', c.pmtInfId),
      el('PmtMtd', 'DD'),
      el('NbOfTxs', '1'),
      el('CtrlSum', amt),
      paymentType(c),
      el('ReqdColltnDt', c.dueDate),
      el('Cdtr', el('Nm', (cr.name ?? '').slice(0, 70)),
        cr.country ? el('PstlAdr', el('Ctry', cr.country), (cr.address ?? []).slice(0, 2).map((l) => el('AdrLine', l.slice(0, 70)))) : null),
      el('CdtrAcct', iban(cr.iban)),
      el('CdtrAgt', agent(cr.bic)),
      el('ChrgBr', 'SLEV'),
      creditorScheme(c.creditorSchemeId),
      el('DrctDbtTxInf',
        el('PmtId', opt('InstrId', c.instrId), el('EndToEndId', c.endToEndId)),
        el('InstdAmt', { Ccy: c.currency }, amt),
        el('DrctDbtTx', el('MndtRltdInf', el('MndtId', c.mandateId ?? 'NOTPROVIDED'), el('DtOfSgntr', c.signedOn ?? c.dueDate))),
        el('DbtrAgt', agent(c.debtor.bic)),
        el('Dbtr', el('Nm', (c.debtor.name ?? '').slice(0, 70))),
        el('DbtrAcct', iban(c.debtor.iban)),
        remittance(c),
      ),
    ),
  )
  return toXml(document(PAIN008, body))
}
