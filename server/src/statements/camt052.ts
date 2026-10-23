// Bank To Customer Account Report: camt.052.001.08 (answer to camt.060.001.05) and
// camt.052.001.06 (answer to camt.060.001.03). One Rpt block per currency with the
// balances of the requested report type; entries are never reported.
import { notificationMsgId } from '../ids.js'
import { fromMinor } from '../ledger.js'
import { isoTallinn, localTallinn } from '../time.js'
import { document, el, toXml } from '../xml.js'

export type ReportVersion = '08' | '06'

export interface ReportBalance {
  /** ISO code (ITBD, ITAV, CLBD) or, for payment limits, the proprietary name. */
  code?: string
  prtry?: string
  amount: bigint
}

export interface AccountReport {
  version: ReportVersion
  created: Date
  /** The point in time the balances refer to (FrDtTm = ToDtTm). */
  at: Date
  /** The balance date (Bal/Dt/Dt). */
  date: string
  iban: string
  blocks: { currency: string; balances: ReportBalance[] }[]
}

export function camt052(r: AccountReport): string {
  const v8 = r.version === '08'
  const msgId = notificationMsgId()
  // v06 reports local time with microseconds, v08 milliseconds with the offset.
  const dt = (d: Date) => (v8 ? isoTallinn(d) : `${localTallinn(d)}000`)
  const bal = (ccy: string, b: ReportBalance) => {
    // v06 reported payment limits as DBIT; v08 derives the indicator from the sign.
    const ind = !v8 && b.prtry ? 'DBIT' : b.amount < 0n ? 'DBIT' : 'CRDT'
    return el('Bal',
      el('Tp', el('CdOrPrtry', b.code ? el('Cd', b.code) : el('Prtry', b.prtry!))),
      el('Amt', { Ccy: ccy }, fromMinor(b.amount < 0n ? -b.amount : b.amount)),
      el('CdtDbtInd', ind),
      el('Dt', el('Dt', r.date)))
  }
  const body = el('BkToCstmrAcctRpt',
    el('GrpHdr', el('MsgId', msgId), el('CreDtTm', dt(r.created))),
    r.blocks.map((b) => el('Rpt',
      el('Id', `${msgId}${b.currency}`),
      el('CreDtTm', dt(r.created)),
      el('FrToDt', el('FrDtTm', dt(r.at)), el('ToDtTm', dt(r.at))),
      el('Acct', el('Id', el('IBAN', r.iban)), el('Ccy', b.currency)),
      b.balances.map((x) => bal(b.currency, x)))))
  return toXml(document(v8 ? 'camt.052.001.08' : 'camt.052.001.06', body))
}
