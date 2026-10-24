// Bank To Customer Debit Credit Notification: one booked entry on one account.
// camt.054.001.02 is the default; camt.054.001.08 is sent to customers set up for it.
import { notificationMsgId } from '../ids.js'
import { dateLondon, dateTallinn, isoLondon, isoTallinn, localTallinn } from '../time.js'
import { isUkAccount } from '../routing.js'
import { UK_ADDRESS, postalAddress } from '../statements/bank-address.js'
import type { UltimateParty } from './pain001.js'
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
  virtual?: {
    iban?: string; /** A non-IBAN identifier (an agency account's Othr/Id). */ account?: string
    name?: string; country?: string; address?: string
    /** An agency account of an indirect scheme participant, not a VIBAN (decision 832). */ agency?: boolean
  }
  /** Bank transaction domain, family and sub-family; default PMNT, ICDT / RCDT with OTHR (credit transfers). */
  bankTxCode?: { domain?: string; family: string; subFamily: string }
  /** Direct debits: the mandate (Refs/MndtId). */
  mandateId?: string
  /** UltmtDbtr / UltmtCdtr of the payment (decision 841). */
  ultimateDebtor?: UltimateParty
  ultimateCreditor?: UltimateParty
  /** A returned or refunded payment: RtrInf (reason code, additional information lines). */
  returnInfo?: { code: string; additional: string[] }
}

/** LHV UK as the servicer of a GB account (G PSP use cases, decision 843). */
export const UK_BANK = { bic: 'LHVBGB2L', name: 'LHV BANK LIMITED' }

/** An ultimate party: the name, then an organisation's Othr id, else (UltmtDbtr only) the postal address (decision 841). */
function ultimate(tag: 'UltmtDbtr' | 'UltmtCdtr', u: UltimateParty | undefined, v8: boolean) {
  if (!u?.name && !u?.orgOther) return null
  const id = u.orgOther ? el('Id', el('OrgId', el('Othr', el('Id', u.orgOther.id.slice(0, 35)), u.orgOther.scheme ? el('SchmeNm', el('Cd', u.orgOther.scheme)) : null))) : null
  const a = u.address
  const adr = !id && tag === 'UltmtDbtr' && a ? el('PstlAdr', opt('StrtNm', a.StrtNm), opt('BldgNb', a.BldgNb), opt('PstCd', a.PstCd), opt('TwnNm', a.TwnNm), opt('Ctry', a.Ctry)) : null
  const inner = [opt('Nm', u.name?.slice(0, 140)), adr, id]
  return el(tag, v8 ? el('Pty', inner) : inner)
}

export function camt054(b: Booking, version: '02' | '08', bankIn: { bic: string; name: string }): string {
  const v8 = version === '08'
  // A GB account is LHV UK's: its servicer, UK time, NtryRef, RvslInd and ValDt/DtTm as the G samples.
  const uk = !v8 && isUkAccount(b.account)
  const bank = uk ? UK_BANK : bankIn
  const bicTag = v8 ? 'BICFI' : 'BIC'
  const ts = (d: Date) => (uk ? isoLondon(d) : v8 ? isoTallinn(d) : localTallinn(d))
  const msgId = notificationMsgId()
  const amt = fromMinor(b.amount)
  const cp = b.counterparty
  const cpParty = cp.name ? (v8 ? el('Pty', el('Nm', cp.name.slice(0, 140))) : [el('Nm', cp.name.slice(0, 140))]) : null
  const cpAcct = cp.iban ? el('Id', el('IBAN', cp.iban)) : cp.account ? el('Id', el('Othr', el('Id', cp.account))) : null
  const vb = b.virtual
  const vAdr = vb?.country ? el('PstlAdr', el('Ctry', vb.country), opt('AdrLine', vb.address?.slice(0, 70))) : null
  const vParty = vb?.name ? (v8 ? el('Pty', el('Nm', vb.name.slice(0, 140)), vAdr) : [el('Nm', vb.name.slice(0, 140)), vAdr]) : null
  const vAcct = vb ? (vb.iban ? el('Id', el('IBAN', vb.iban)) : el('Id', el('Othr', el('Id', vb.account ?? '')))) : null
  const [dbtr, dbtrAcct, cdtr, cdtrAcct] = b.direction === 'DBIT' ? [vParty, vAcct, cpParty, cpAcct] : [cpParty, cpAcct, vParty, vAcct]
  const ownAgent = el('FinInstnId', el(bicTag, bank.bic.slice(0, 8)), el('Nm', bank.name))
  const cpAgent = cp.bic ? el('FinInstnId', el(bicTag, uk ? cp.bic : cp.bic.slice(0, 8))) : null
  const ustrd = b.remittance && b.remittance.length > 140 ? b.remittance.slice(0, 137) + '…' : b.remittance

  const relatedParties = dbtr || dbtrAcct || cdtr || cdtrAcct || b.ultimateDebtor || b.ultimateCreditor
    ? el('RltdPties',
        dbtr ? el('Dbtr', dbtr) : null,
        dbtrAcct ? el('DbtrAcct', dbtrAcct) : null,
        ultimate('UltmtDbtr', b.ultimateDebtor, v8),
        cdtr ? el('Cdtr', cdtr) : null,
        cdtrAcct ? el('CdtrAcct', cdtrAcct) : null,
        ultimate('UltmtCdtr', b.ultimateCreditor && { name: b.ultimateCreditor.name, orgOther: b.ultimateCreditor.orgOther }, v8))
    : null
  // LHV UK names no own agent (G use case 7: only the other bank's).
  const debtorAgent = b.direction === 'DBIT' ? (uk ? null : ownAgent) : cpAgent
  const creditorAgent = b.direction === 'DBIT' ? cpAgent : (uk ? null : ownAgent)
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
        el('Svcr', uk ? el('FinInstnId', el('BIC', bank.bic), el('Nm', bank.name), postalAddress(UK_ADDRESS, false)) : ownAgent),
      ),
      el('Ntry',
        uk ? el('NtryRef', '1') : null,
        el('Amt', { Ccy: b.currency }, amt),
        el('CdtDbtInd', b.direction),
        v8 || uk ? el('RvslInd', 'false') : null,
        el('Sts', v8 ? el('Cd', 'BOOK') : 'BOOK'),
        el('BookgDt', el('Dt', uk ? dateLondon(b.bookedAt) : dateTallinn(b.bookedAt))),
        uk ? el('ValDt', el('DtTm', isoLondon(b.bookedAt))) : v8 ? el('ValDt', el('DtTm', isoTallinn(b.bookedAt))) : el('ValDt', el('Dt', dateTallinn(b.bookedAt))),
        el('AcctSvcrRef', b.servicerRef),
        el('BkTxCd',
          el('Domn', el('Cd', b.bankTxCode?.domain ?? 'PMNT'), el('Fmly', el('Cd', b.bankTxCode?.family ?? (b.direction === 'DBIT' ? 'ICDT' : 'RCDT')), el('SubFmlyCd', b.bankTxCode?.subFamily ?? 'OTHR'))),
          el('Prtry', el('Cd', b.scheme))),
        el('NtryDtls', el('TxDtls',
          el('Refs',
            el('AcctSvcrRef', b.servicerRef),
            opt('PmtInfId', b.pmtInfId),
            opt('InstrId', b.instrId),
            opt('EndToEndId', b.endToEndId),
            opt('MndtId', b.mandateId)),
          el('AmtDtls', el('InstdAmt', el('Amt', { Ccy: b.currency }, amt)), el('TxAmt', el('Amt', { Ccy: b.currency }, amt))),
          relatedParties,
          relatedAgents,
          ustrd || b.reference
            ? el('RmtInf',
                opt('Ustrd', ustrd),
                b.reference ? el('Strd', el('CdtrRefInf', el('Tp', el('CdOrPrtry', el('Cd', 'SCOR'))), el('Ref', b.reference))) : null)
            : null,
          b.returnInfo ? el('RtrInf', el('Rsn', el('Cd', b.returnInfo.code)), b.returnInfo.additional.map((a) => el('AddtlInf', a.slice(0, 105)))) : null,
        )),
      ),
    ),
  )
  return toXml(document(v8 ? 'camt.054.001.08' : 'camt.054.001.02', body))
}
