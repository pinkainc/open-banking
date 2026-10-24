// Reads a Customer Credit Transfer Initiation (pain.001.001.03 or .09) into a plain
// structure, and checks the parts the engine relies on. Full schema validation (when
// the XSDs are available) happens before this, in xsd.ts.
import { many, text } from '../xml.js'

export type PainVersion = 'pain.001.001.03' | 'pain.001.001.09'

/**
 * An ultimate party (UltmtDbtr / UltmtCdtr) as the notifications echo it (decision 841):
 * the name, an organisation's `Othr` identification, the structured postal address.
 */
export interface UltimateParty {
  name?: string
  orgOther?: { id: string; scheme?: string }
  address?: { StrtNm?: string; BldgNb?: string; PstCd?: string; TwnNm?: string; Ctry?: string }
}

export function readUltimate(p: any): UltimateParty | undefined {
  if (!p || typeof p !== 'object') return undefined
  const othr = many(p.Id?.OrgId?.Othr)[0]
  const a = p.PstlAdr
  const address = a && typeof a === 'object'
    ? Object.fromEntries((['StrtNm', 'BldgNb', 'PstCd', 'TwnNm', 'Ctry'] as const).map((k) => [k, text(a[k])]).filter(([, v]) => v)) : undefined
  return {
    name: text(p.Nm),
    ...(othr && text(othr.Id) ? { orgOther: { id: text(othr.Id)!, scheme: text(othr.SchmeNm?.Cd) } } : {}),
    ...(address && Object.keys(address).length ? { address } : {}),
  }
}

export interface Tx {
  ultimateDebtor?: UltimateParty
  ultimateCreditor?: UltimateParty
  instrId?: string
  endToEndId?: string
  uetr?: string
  amount?: string
  currency?: string
  scheme?: string
  creditorName?: string
  creditorIban?: string
  creditorOther?: string
  creditorBic?: string
  ustrd?: string
  reference?: string
}

export interface Block {
  pmtInfId?: string
  nbOfTxs?: string
  ctrlSum?: string
  reqdExctnDt?: string
  debtorName?: string
  /** The debtor account: an IBAN, or with `debtorOther` the `Othr/Id` (an agency account, decision 830). */
  debtorIban?: string
  debtorOther?: boolean
  /** Dbtr/PstlAdr: country and town (mandatory for an indirect scheme participant, decision 831). */
  debtorAddress?: { country?: string; town?: string }
  /** DbtrAgt BIC as sent; the status report shows it for an agency debtor (`debtorAgentShown`, decision 842). */
  debtorAgentBic?: string
  debtorAgentShown?: string
  ultimateDebtor?: UltimateParty
  scheme?: string
  txs: Tx[]
}

export interface PaymentFile {
  version: PainVersion
  msgId?: string
  creDtTm?: string
  nbOfTxs?: string
  ctrlSum?: string
  blocks: Block[]
}

const NS = 'urn:iso:std:iso:20022:tech:xsd:'

/** The namespace version of a parsed document, or undefined when it is not pain.001. */
export function painVersion(raw: string): PainVersion | undefined {
  const m = /<(?:\w+:)?Document[^>]*\sxmlns(?::\w+)?="urn:iso:std:iso:20022:tech:xsd:(pain\.001\.001\.0[39])"/.exec(raw)
  return m ? (m[1] as PainVersion) : undefined
}

const scheme = (pmtTpInf: any) => text(pmtTpInf?.SvcLvl?.Prtry) ?? undefined

export function readPain001(doc: any, version: PainVersion): PaymentFile {
  const root = doc?.Document?.CstmrCdtTrfInitn ?? {}
  const g = root.GrpHdr ?? {}
  const v09 = version === 'pain.001.001.09'
  const bic = (agt: any) => text(v09 ? agt?.FinInstnId?.BICFI : agt?.FinInstnId?.BIC)
  return {
    version,
    msgId: text(g.MsgId), creDtTm: text(g.CreDtTm), nbOfTxs: text(g.NbOfTxs), ctrlSum: text(g.CtrlSum),
    blocks: many(root.PmtInf).map((p: any): Block => ({
      pmtInfId: text(p.PmtInfId), nbOfTxs: text(p.NbOfTxs), ctrlSum: text(p.CtrlSum),
      reqdExctnDt: v09 ? (text(p.ReqdExctnDt?.Dt) ?? text(p.ReqdExctnDt?.DtTm)?.slice(0, 10)) : text(p.ReqdExctnDt),
      debtorName: text(p.Dbtr?.Nm), debtorIban: text(p.DbtrAcct?.Id?.IBAN) ?? text(p.DbtrAcct?.Id?.Othr?.Id),
      ...(p.DbtrAcct?.Id?.IBAN === undefined && p.DbtrAcct?.Id?.Othr?.Id !== undefined ? { debtorOther: true } : {}),
      ...(p.Dbtr?.PstlAdr ? { debtorAddress: { country: text(p.Dbtr.PstlAdr.Ctry), town: text(p.Dbtr.PstlAdr.TwnNm) ?? many(p.Dbtr.PstlAdr.AdrLine).map((l) => text(l)).find(Boolean) } } : {}),
      scheme: scheme(p.PmtTpInf),
      debtorAgentBic: bic(p.DbtrAgt),
      ultimateDebtor: readUltimate(p.UltmtDbtr),
      txs: many(p.CdtTrfTxInf).map((t: any): Tx => ({
        ultimateDebtor: readUltimate(t.UltmtDbtr), ultimateCreditor: readUltimate(t.UltmtCdtr),
        instrId: text(t.PmtId?.InstrId), endToEndId: text(t.PmtId?.EndToEndId), uetr: text(t.PmtId?.UETR),
        amount: text(t.Amt?.InstdAmt), currency: t.Amt?.InstdAmt?.['@Ccy'],
        scheme: scheme(t.PmtTpInf),
        creditorName: text(t.Cdtr?.Nm), creditorIban: text(t.CdtrAcct?.Id?.IBAN), creditorOther: text(t.CdtrAcct?.Id?.Othr?.Id),
        creditorBic: bic(t.CdtrAgt),
        ustrd: many(t.RmtInf?.Ustrd).map((u) => text(u)).join(' ') || undefined,
        reference: text(t.RmtInf?.Strd?.CdtrRefInf?.Ref) ?? many(t.RmtInf?.Strd).map((s: any) => text(s?.CdtrRefInf?.Ref)).find(Boolean),
      })),
    })),
  }
}

/** What must be there for the engine to work: the first problem, or undefined. */
export function structuralProblem(f: PaymentFile): string | undefined {
  if (!f.msgId) return 'GrpHdr/MsgId is missing'
  if (!f.creDtTm) return 'GrpHdr/CreDtTm is missing'
  if (!f.nbOfTxs || !/^\d{1,15}$/.test(f.nbOfTxs)) return 'GrpHdr/NbOfTxs is missing or not a number'
  if (f.ctrlSum !== undefined && !/^\d+(\.\d{1,17})?$/.test(f.ctrlSum)) return 'GrpHdr/CtrlSum is not a decimal number'
  if (f.blocks.length === 0) return 'PmtInf is missing'
  for (const b of f.blocks) {
    if (!b.pmtInfId) return 'PmtInf/PmtInfId is missing'
    if (!b.reqdExctnDt) return `PmtInf ${b.pmtInfId}: ReqdExctnDt is missing`
    if (!b.debtorIban) return `PmtInf ${b.pmtInfId}: DbtrAcct/Id is missing`
    if (b.txs.length === 0) return `PmtInf ${b.pmtInfId}: CdtTrfTxInf is missing`
    for (const t of b.txs) {
      if (!t.endToEndId) return `PmtInf ${b.pmtInfId}: PmtId/EndToEndId is missing`
      if (!t.amount || !/^\d+(\.\d{1,5})?$/.test(t.amount)) return `PmtInf ${b.pmtInfId}: Amt/InstdAmt is missing or malformed`
      if (!t.currency || !/^[A-Z]{3}$/.test(t.currency)) return `PmtInf ${b.pmtInfId}: InstdAmt/@Ccy is missing or malformed`
      if (!t.creditorIban && !t.creditorOther) return `PmtInf ${b.pmtInfId}: CdtrAcct is missing`
    }
  }
  return undefined
}

/** Sum of decimal strings, exact, at up to five decimals (pain.001 control sums). */
export function decimalSum(values: string[]): bigint {
  let s = 0n
  for (const v of values) {
    const [i, f = ''] = v.split('.')
    s += BigInt(i) * 100000n + BigInt(f.slice(0, 5).padEnd(5, '0'))
  }
  return s
}
export const decimalEq = (a: string, sum: bigint) => decimalSum([a]) === sum
export { NS }
