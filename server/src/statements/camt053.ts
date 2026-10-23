// Bank To Customer Statement: camt.053.001.08 (answer to camt.060.001.05) and
// camt.053.001.02 (answer to camt.060.001.03). One Stmt block per currency; a long
// statement is split into pages (GrpHdr/MsgPgntn) and a currency whose entries cross a
// page boundary carries INTM balances at the boundary.
import { notificationMsgId } from '../ids.js'
import { fromMinor } from '../ledger.js'
import { dateTallinn, isoTallinn, localTallinn } from '../time.js'
import { document, el, opt, toXml, type Node } from '../xml.js'
import { fold1257 } from './codepage.js'
import type { JournalEntry } from './journal.js'

export type StatementVersion = '08' | '02'

export interface Balance {
  amount: bigint
  /** Set on an intermediate (page-boundary) balance: the time of the boundary entry. */
  intm?: Date
}

export interface StatementBlock {
  currency: string
  opening: Balance
  closing: Balance
  entries: JournalEntry[]
}

export interface StatementPage {
  version: StatementVersion
  created: Date
  page?: { number: number; last: boolean }
  /** Reporting period: from inclusive, to exclusive (epoch ms). */
  from: number
  to: number
  /** The period covers whole Tallinn calendar days (balances carry dates only). */
  fullDays: boolean
  iban: string
  owner: { name: string; code: string }
  bank: { bic: string; name: string }
  blocks: StatementBlock[]
}

const name = (s: string | undefined) => (s ? fold1257(s).slice(0, 140) : undefined)
const ustrd = (s: string | undefined) => (s ? fold1257(s).slice(0, 140) : undefined)
const sign = (n: bigint) => (n < 0n ? 'DBIT' : 'CRDT')
const abs = (n: bigint) => fromMinor(n < 0n ? -n : n)

export function camt053(p: StatementPage): string {
  const v8 = p.version === '08'
  const msgId = notificationMsgId()
  const bicTag = v8 ? 'BICFI' : 'BIC'
  /** Date-times: v08 with ms and offset; v02 local time (header with microseconds). */
  const dtHeader = (d: Date) => (v8 ? isoTallinn(d) : `${localTallinn(d)}000`)
  const dtPeriod = (t: number) => (v8 ? isoTallinn(new Date(t)) : localTallinn(new Date(t)).slice(0, 19))
  const lastMs = p.to - 1

  const balance = (code: 'OPBD' | 'CLBD', ccy: string, b: Balance, at: number) => el('Bal',
    el('Tp', el('CdOrPrtry', el('Cd', code)), b.intm ? el('SubTp', el('Cd', 'INTM')) : null),
    el('Amt', { Ccy: ccy }, abs(b.amount)),
    el('CdtDbtInd', sign(b.amount)),
    el('Dt', b.intm
      ? (v8 ? el('DtTm', isoTallinn(b.intm)) : el('Dt', dateTallinn(b.intm)))
      : (v8 && !p.fullDays ? el('DtTm', isoTallinn(new Date(at))) : el('Dt', dateTallinn(new Date(at))))))

  const party = (nm: string | undefined, code: string | undefined): Node => {
    if (!nm && !code) return null
    const id = code ? el('Id', el('OrgId', el('Othr', el('Id', code)))) : null
    return v8 ? el('Pty', opt('Nm', name(nm)), id) : [opt('Nm', name(nm)), id]
  }
  const account = (iban: string | undefined, other: string | undefined) =>
    iban ? el('Id', el('IBAN', iban)) : other ? el('Id', el('Othr', el('Id', other))) : null
  const agent = (bic: string | undefined, nm?: string) =>
    bic || nm ? el('FinInstnId', opt(bicTag, bic?.slice(0, 8)), opt('Nm', name(nm))) : null

  const entry = (e: JournalEntry) => {
    const amt = fromMinor(e.amount)
    const cp = e.counterparty
    // An entry of a master account that went through a VIBAN shows the VIBAN as the own side
    // (P 05 "Virtual/Agency account account number is displayed here", sample PAYMENT_VIBAN_SEPA
    // 053A): the holder's name without Id ("this tag will be empty"), the VIBAN as account. The
    // holder's address only in v08 ("when address data is available"); the 02 sample has none
    // although the camt.054 of the same payment has it (decision 551).
    const vb = e.virtual
    const vAdr = v8 && vb?.country ? el('PstlAdr', el('Ctry', vb.country), opt('AdrLine', vb.address?.slice(0, 70))) : null
    const vParty = vb?.name ? (v8 ? el('Pty', el('Nm', vb.name.slice(0, 140)), vAdr) : [el('Nm', vb.name.slice(0, 140))]) : null
    const own = vb
      ? { party: vParty, acct: account(vb.iban, undefined), agent: agent(p.bank.bic, p.bank.name) }
      : { party: party(p.owner.name, p.owner.code), acct: account(e.account, undefined), agent: agent(p.bank.bic, p.bank.name) }
    const other = { party: party(cp.name, cp.code), acct: account(cp.iban, cp.account), agent: agent(cp.bic) }
    const [dbtr, cdtr] = e.direction === 'DBIT' ? [own, other] : [other, own]
    return el('Ntry',
      el('Amt', { Ccy: e.currency }, amt),
      el('CdtDbtInd', e.direction),
      el('Sts', v8 ? el('Cd', 'BOOK') : 'BOOK'),
      el('BookgDt', el('Dt', dateTallinn(e.bookedAt))),
      // camt.053.001.02 has no ValDt (the published V2 table and sample); v08 an offset datetime.
      v8 ? el('ValDt', el('DtTm', isoTallinn(e.bookedAt))) : null,
      el('AcctSvcrRef', e.servicerRef),
      el('BkTxCd',
        el('Domn', el('Cd', e.bankTxCode?.domain ?? 'PMNT'),
          el('Fmly', el('Cd', e.bankTxCode?.family ?? (e.direction === 'DBIT' ? 'ICDT' : 'RCDT')), el('SubFmlyCd', e.bankTxCode?.subFamily ?? 'OTHR'))),
        el('Prtry', el('Cd', e.scheme))),
      el('NtryDtls', el('TxDtls',
        el('Refs',
          el('AcctSvcrRef', e.servicerRef),
          opt('PmtInfId', e.pmtInfId),
          opt('InstrId', e.instrId),
          opt('EndToEndId', e.endToEndId)),
        el('AmtDtls', el('InstdAmt', el('Amt', { Ccy: e.currency }, amt)), el('TxAmt', el('Amt', { Ccy: e.currency }, amt))),
        dbtr.party || dbtr.acct || cdtr.party || cdtr.acct
          ? el('RltdPties',
              dbtr.party ? el('Dbtr', dbtr.party) : null,
              dbtr.acct ? el('DbtrAcct', dbtr.acct) : null,
              cdtr.party ? el('Cdtr', cdtr.party) : null,
              cdtr.acct ? el('CdtrAcct', cdtr.acct) : null)
          : null,
        dbtr.agent || cdtr.agent
          ? el('RltdAgts', dbtr.agent ? el('DbtrAgt', dbtr.agent) : null, cdtr.agent ? el('CdtrAgt', cdtr.agent) : null)
          : null,
        e.remittance || e.reference
          ? el('RmtInf',
              opt('Ustrd', ustrd(e.remittance)),
              e.reference ? el('Strd', el('CdtrRefInf', el('Tp', el('CdOrPrtry', el('Cd', 'SCOR'))), el('Ref', fold1257(e.reference).slice(0, 35)))) : null)
          : null,
      )),
    )
  }

  const stmt = (b: StatementBlock) => {
    let cn = 0, cs = 0n, dn = 0, ds = 0n
    for (const e of b.entries) {
      if (e.direction === 'CRDT') { cn++; cs += e.amount } else { dn++; ds += e.amount }
    }
    return el('Stmt',
      el('Id', `${msgId}${b.currency}`),
      el('CreDtTm', v8 ? isoTallinn(p.created) : localTallinn(p.created).slice(0, 19)),
      el('FrToDt', el('FrDtTm', dtPeriod(p.from)), el('ToDtTm', dtPeriod(lastMs))),
      el('Acct',
        el('Id', el('IBAN', p.iban)),
        el('Ccy', b.currency),
        el('Svcr', el('FinInstnId', el(bicTag, p.bank.bic.slice(0, 8)), el('Nm', p.bank.name)))),
      balance('OPBD', b.currency, b.opening, p.from),
      balance('CLBD', b.currency, b.closing, lastMs),
      el('TxsSummry',
        el('TtlCdtNtries', el('NbOfNtries', String(cn)), el('Sum', fromMinor(cs))),
        el('TtlDbtNtries', el('NbOfNtries', String(dn)), el('Sum', fromMinor(ds)))),
      b.entries.map(entry),
    )
  }

  const body = el('BkToCstmrStmt',
    el('GrpHdr',
      el('MsgId', msgId),
      el('CreDtTm', dtHeader(p.created)),
      p.page ? el('MsgPgntn', el('PgNb', String(p.page.number)), el('LastPgInd', String(p.page.last))) : null),
    p.blocks.map(stmt))
  return toXml(document(v8 ? 'camt.053.001.08' : 'camt.053.001.02', body))
}
