// Customer Payment Status Report. A pain.001.001.09 file is answered with
// pain.002.001.10, a pain.001.001.03 file with pain.002.001.03 (ISO element names of
// that version: BIC, BICOrBEI, no Pty wrapper, plain ISODate).
import { isoLondon, isoTallinn } from '../time.js'
import { statusReportMsgId } from '../ids.js'
import { document, el, opt, toXml } from '../xml.js'
import type { Block, PainVersion, Tx } from './pain001.js'

export type TxStatusCode = 'ACSC' | 'ACSP' | 'ACWC' | 'PDNG' | 'RJCT'
export type GroupStatusCode = TxStatusCode | 'PART'

export interface TxStatus {
  block: Block
  tx: Tx
  status: TxStatusCode
  reason?: string
  servicerRef?: string
  scheme?: string
  creditorBic?: string
}

export interface StatusReport {
  version: PainVersion
  originalMsgId: string
  /** Present only in the first report about a file. */
  groupStatus?: GroupStatusCode
  groupReason?: string
  blocks: { pmtInfId: string; status?: GroupStatusCode; txs: TxStatus[] }[]
}

/** The group status over a set of transaction statuses (docs: RJCT, PDNG, PART, ACSP, ACSC). */
export function aggregate(statuses: TxStatusCode[]): GroupStatusCode {
  if (statuses.every((s) => s === 'RJCT')) return 'RJCT'
  if (statuses.some((s) => s === 'PDNG')) return 'PDNG'
  if (statuses.some((s) => s === 'RJCT')) return 'PART'
  if (statuses.every((s) => s === 'ACSC')) return 'ACSC'
  return 'ACSP'
}

/** LHV UK in a status report (G PSP use cases): InitgPty `LHVBGB2LXXX`, DbtrAgt `LHVBGB2L`, UK time (decision 843). */
export const UK_STATUS = { initiatingParty: 'LHVBGB2LXXX', debtorAgent: 'LHVBGB2L' }

export function pain002(r: StatusReport, bankBic: string, now: Date, o: { uk?: boolean } = {}): string {
  const v10 = r.version === 'pain.001.001.09'
  const ownAgent = o.uk ? UK_STATUS.debtorAgent : bankBic
  const reason = (text?: string) => text ? el('StsRsnInf', el('Rsn', el('Cd', 'NARR')), el('AddtlInf', text.slice(0, 105))) : null
  const party = (name?: string) => (name ? (v10 ? el('Pty', el('Nm', name)) : el('Nm', name)) : null)
  const agent = (bic?: string) => el('FinInstnId', bic ? el(v10 ? 'BICFI' : 'BIC', bic) : null)
  const account = (iban?: string, other?: string) => el('Id', iban ? el('IBAN', iban) : el('Othr', el('Id', other ?? '')))

  const tx = (s: TxStatus) => el('TxInfAndSts',
    opt('OrgnlInstrId', s.tx.instrId),
    v10 ? opt('OrgnlUETR', s.tx.uetr) : null,
    el('TxSts', s.status),
    s.status === 'RJCT' || s.status === 'ACWC' || s.status === 'PDNG' ? reason(s.reason) : null,
    s.status !== 'RJCT' ? opt('AcctSvcrRef', s.servicerRef) : null,
    el('OrgnlTxRef',
      el('Amt', el('InstdAmt', { Ccy: s.tx.currency ?? '' }, s.tx.amount ?? '0')),
      s.block.reqdExctnDt ? el('ReqdExctnDt', v10 ? el('Dt', s.block.reqdExctnDt) : s.block.reqdExctnDt) : null,
      s.scheme ? el('PmtTpInf', el('SvcLvl', el('Prtry', s.scheme))) : null,
      s.block.debtorName ? el('Dbtr', party(s.block.debtorName)) : null,
      s.block.debtorIban ? el('DbtrAcct', s.block.debtorOther ? account(undefined, s.block.debtorIban) : account(s.block.debtorIban)) : null,
      el('DbtrAgt', agent(s.block.debtorAgentShown ?? ownAgent)),
      el('CdtrAgt', agent(s.creditorBic ?? s.tx.creditorBic)),
      s.tx.creditorName ? el('Cdtr', party(s.tx.creditorName)) : null,
      el('CdtrAcct', account(s.tx.creditorIban, s.tx.creditorOther)),
    ))

  const body = el('CstmrPmtStsRpt',
    el('GrpHdr',
      el('MsgId', statusReportMsgId()),
      el('CreDtTm', o.uk ? isoLondon(now) : isoTallinn(now)),
      el('InitgPty', el('Id', el('OrgId', el(v10 ? 'AnyBIC' : 'BICOrBEI', o.uk ? UK_STATUS.initiatingParty : bankBic)))),
    ),
    el('OrgnlGrpInfAndSts',
      el('OrgnlMsgId', r.originalMsgId),
      el('OrgnlMsgNmId', r.version),
      opt('GrpSts', r.groupStatus),
      r.groupStatus === 'RJCT' ? reason(r.groupReason) : null,
    ),
    r.blocks.map((b) => el('OrgnlPmtInfAndSts',
      el('OrgnlPmtInfId', b.pmtInfId),
      opt('PmtInfSts', b.status),
      b.txs.map(tx),
    )),
  )
  return toXml(document(v10 ? 'pain.002.001.10' : 'pain.002.001.03', body))
}
