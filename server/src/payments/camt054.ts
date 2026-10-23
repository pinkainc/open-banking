// Bank To Customer Debit Credit Notification: one booked entry on one account.
// camt.054.001.02 is the default; camt.054.001.08 is sent to customers set up for it.
import { notificationMsgId } from '../ids.js'
import { dateTallinn, isoTallinn, localTallinn } from '../time.js'
import { fromMinor } from '../ledger.js'
import { document, el, opt, toXml } from '../xml.js'

export interface Booking {
  account: string
  owner: { name: string; code: string }
  direction: 'DBIT' | 'CRDT'
  amount: bigint
  currency: string
  servicerRef: string
  scheme: string
  bookedAt: Date
  pmtInfId?: string
  instrId?: string
  endToEndId?: string
  /** The other side of the movement. */
  counterparty: { name?: string; iban?: string; account?: string; bic?: string; code?: string }
  remittance?: string
  reference?: string
  /**
   * The VIBAN the entry went through when `account` is its master account: shown as the
   * own party, Dbtr/DbtrAcct on a debit and Cdtr/CdtrAcct on a credit (P 06).
   */
  virtual?: { iban: string; name?: string; country?: string; address?: string }
}

export function camt054(b: Booking, version: '02' | '08', bank: { bic: string; name: string }): string {
  const v8 = version === '08'
  const bicTag = v8 ? 'BICFI' : 'BIC'
  const ts = (d: Date) => (v8 ? isoTallinn(d) : localTallinn(d))
  const msgId = notificationMsgId()
  const amt = fromMinor(b.amount)
  const cp = b.counterparty
  const cpParty = cp.name ? (v8 ? el('Pty', el('Nm', cp.name.slice(0, 140))) : [el('Nm', cp.name.slice(0, 140))]) : null
  const cpAcct = cp.iban ? el('Id', el('IBAN', cp.iban)) : cp.account ? el('Id', el('Othr', el('Id', cp.account))) : null
  const vb = b.virtual
  const vAdr = vb?.country ? el('PstlAdr', el('Ctry', vb.country), opt('AdrLine', vb.address?.slice(0, 70))) : null
  const vParty = vb?.name ? (v8 ? el('Pty', el('Nm', vb.name.slice(0, 140)), vAdr) : [el('Nm', vb.name.slice(0, 140)), vAdr]) : null
  const vAcct = vb ? el('Id', el('IBAN', vb.iban)) : null
  const [dbtr, dbtrAcct, cdtr, cdtrAcct] = b.direction === 'DBIT' ? [vParty, vAcct, cpParty, cpAcct] : [cpParty, cpAcct, vParty, vAcct]
  const ownAgent = el('FinInstnId', el(bicTag, bank.bic.slice(0, 8)), el('Nm', bank.name))
  const cpAgent = cp.bic ? el('FinInstnId', el(bicTag, cp.bic.slice(0, 8))) : null
  const ustrd = b.remittance && b.remittance.length > 140 ? b.remittance.slice(0, 137) + '…' : b.remittance

  const relatedParties = dbtr || dbtrAcct || cdtr || cdtrAcct
    ? el('RltdPties',
        dbtr ? el('Dbtr', dbtr) : null,
        dbtrAcct ? el('DbtrAcct', dbtrAcct) : null,
        cdtr ? el('Cdtr', cdtr) : null,
        cdtrAcct ? el('CdtrAcct', cdtrAcct) : null)
    : null
  const debtorAgent = b.direction === 'DBIT' ? ownAgent : cpAgent
  const creditorAgent = b.direction === 'DBIT' ? cpAgent : ownAgent
  const relatedAgents = debtorAgent || creditorAgent
    ? el('RltdAgts', debtorAgent ? el('DbtrAgt', debtorAgent) : null, creditorAgent ? el('CdtrAgt', creditorAgent) : null)
    : null

  const body = el('BkToCstmrDbtCdtNtfctn',
    el('GrpHdr', el('MsgId', msgId), el('CreDtTm', ts(b.bookedAt))),
    el('Ntfctn',
      el('Id', `${msgId}${b.currency}`),
      el('CreDtTm', ts(b.bookedAt)),
      el('Acct',
        el('Id', el('IBAN', b.account)),
        el('Ccy', b.currency),
        el('Ownr', el('Nm', b.owner.name.slice(0, 140)), el('Id', el('OrgId', el('Othr', el('Id', b.owner.code))))),
        el('Svcr', ownAgent),
      ),
      el('Ntry',
        el('Amt', { Ccy: b.currency }, amt),
        el('CdtDbtInd', b.direction),
        v8 ? el('RvslInd', 'false') : null,
        el('Sts', v8 ? el('Cd', 'BOOK') : 'BOOK'),
        el('BookgDt', el('Dt', dateTallinn(b.bookedAt))),
        v8 ? el('ValDt', el('DtTm', isoTallinn(b.bookedAt))) : el('ValDt', el('Dt', dateTallinn(b.bookedAt))),
        el('AcctSvcrRef', b.servicerRef),
        el('BkTxCd',
          el('Domn', el('Cd', 'PMNT'), el('Fmly', el('Cd', b.direction === 'DBIT' ? 'ICDT' : 'RCDT'), el('SubFmlyCd', 'OTHR'))),
          el('Prtry', el('Cd', b.scheme))),
        el('NtryDtls', el('TxDtls',
          el('Refs',
            el('AcctSvcrRef', b.servicerRef),
            opt('PmtInfId', b.pmtInfId),
            opt('InstrId', b.instrId),
            opt('EndToEndId', b.endToEndId)),
          el('AmtDtls', el('InstdAmt', el('Amt', { Ccy: b.currency }, amt)), el('TxAmt', el('Amt', { Ccy: b.currency }, amt))),
          relatedParties,
          relatedAgents,
          ustrd || b.reference
            ? el('RmtInf',
                opt('Ustrd', ustrd),
                b.reference ? el('Strd', el('CdtrRefInf', el('Tp', el('CdOrPrtry', el('Cd', 'SCOR'))), el('Ref', b.reference))) : null)
            : null,
        )),
      ),
    ),
  )
  return toXml(document(v8 ? 'camt.054.001.08' : 'camt.054.001.02', body))
}
