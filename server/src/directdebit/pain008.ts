// Reads a Customer Direct Debit Initiation (pain.008.001.08) into a plain structure and
// checks what the service relies on. Schema validation against the published XSD (when
// present) happens before this; without it these checks are all there is.
import { many, text } from '../xml.js'

export const PAIN008 = 'pain.008.001.08'
export const PAIN007 = 'pain.007.001.09'

export interface DdTx {
  instrId?: string
  endToEndId?: string
  amount?: string
  currency?: string
  scheme?: string
  localInstrument?: string
  seqTp?: string
  mandateId?: string
  signedOn?: string
  amended?: boolean
  creditorSchemeId?: string
  creditorSchemeName?: string
  debtorBic?: string
  debtorName?: string
  debtorIban?: string
  ustrd?: string
  reference?: string
}

export interface DdBlock {
  pmtInfId?: string
  nbOfTxs?: string
  ctrlSum?: string
  scheme?: string
  localInstrument?: string
  seqTp?: string
  dueDate?: string
  creditorName?: string
  creditorCountry?: string
  creditorAddress?: string[]
  creditorIban?: string
  creditorBic?: string
  creditorSchemeId?: string
  creditorSchemeName?: string
  txs: DdTx[]
}

export interface CollectionFile {
  msgId?: string
  creDtTm?: string
  nbOfTxs?: string
  ctrlSum?: string
  initiator?: string
  blocks: DdBlock[]
}

/**
 * The ISO message a document is, from its namespace (`pain.008.001.08`). Read from the
 * raw text: the parser drops namespace declarations (docs/2026-10-23-orkestracija-subagenata.md).
 */
export function isoMessage(raw: string): string | undefined {
  const m = /<(?:[\w.-]+:)?Document[^>]*\sxmlns(?::[\w.-]+)?="urn:iso:std:iso:20022:tech:xsd:([a-z]{4}\.\d{3}\.\d{3}\.\d{2})"/.exec(raw)
  return m?.[1]
}

const schemeId = (s: any) => {
  const o = many(s?.Id?.PrvtId?.Othr)[0]
  return { id: text(o?.Id), name: text(o?.SchmeNm?.Prtry) }
}

export function readPain008(doc: any): CollectionFile {
  const root = doc?.Document?.CstmrDrctDbtInitn ?? {}
  const g = root.GrpHdr ?? {}
  return {
    msgId: text(g.MsgId), creDtTm: text(g.CreDtTm), nbOfTxs: text(g.NbOfTxs), ctrlSum: text(g.CtrlSum), initiator: text(g.InitgPty?.Nm),
    blocks: many(root.PmtInf).map((p: any): DdBlock => {
      const ci = schemeId(p.CdtrSchmeId)
      return {
        pmtInfId: text(p.PmtInfId), nbOfTxs: text(p.NbOfTxs), ctrlSum: text(p.CtrlSum),
        scheme: text(many(p.PmtTpInf?.SvcLvl)[0]?.Prtry), localInstrument: text(p.PmtTpInf?.LclInstrm?.Cd), seqTp: text(p.PmtTpInf?.SeqTp),
        dueDate: text(p.ReqdColltnDt),
        creditorName: text(p.Cdtr?.Nm), creditorCountry: text(p.Cdtr?.PstlAdr?.Ctry),
        creditorAddress: many(p.Cdtr?.PstlAdr?.AdrLine).map((l) => text(l)!).filter(Boolean),
        creditorIban: text(p.CdtrAcct?.Id?.IBAN), creditorBic: text(p.CdtrAgt?.FinInstnId?.BICFI),
        creditorSchemeId: ci.id, creditorSchemeName: ci.name,
        txs: many(p.DrctDbtTxInf).map((t: any): DdTx => {
          const tci = schemeId(t.DrctDbtTx?.CdtrSchmeId)
          const m = t.DrctDbtTx?.MndtRltdInf ?? {}
          return {
            instrId: text(t.PmtId?.InstrId), endToEndId: text(t.PmtId?.EndToEndId),
            amount: text(t.InstdAmt), currency: t.InstdAmt?.['@Ccy'],
            scheme: text(many(t.PmtTpInf?.SvcLvl)[0]?.Prtry), localInstrument: text(t.PmtTpInf?.LclInstrm?.Cd), seqTp: text(t.PmtTpInf?.SeqTp),
            mandateId: text(m.MndtId), signedOn: text(m.DtOfSgntr), amended: text(m.AmdmntInd) === 'true',
            creditorSchemeId: tci.id, creditorSchemeName: tci.name,
            debtorBic: text(t.DbtrAgt?.FinInstnId?.BICFI), debtorName: text(t.Dbtr?.Nm), debtorIban: text(t.DbtrAcct?.Id?.IBAN),
            ustrd: many(t.RmtInf?.Ustrd).map((u) => text(u)).join(' ') || undefined,
            reference: text(t.RmtInf?.Strd?.CdtrRefInf?.Ref) ?? many(t.RmtInf?.Strd).map((s: any) => text(s?.CdtrRefInf?.Ref)).find(Boolean),
          }
        }),
      }
    }),
  }
}

/** What must be there for the service to work (no XSD at hand): the first problem, or undefined. */
export function structuralProblem(f: CollectionFile): string | undefined {
  if (!f.msgId) return 'GrpHdr/MsgId'
  if (!f.creDtTm) return 'GrpHdr/CreDtTm'
  if (!f.nbOfTxs || !/^\d{1,15}$/.test(f.nbOfTxs)) return 'GrpHdr/NbOfTxs'
  if (!f.ctrlSum || !/^\d+(\.\d{1,17})?$/.test(f.ctrlSum)) return 'GrpHdr/CtrlSum'
  if (f.blocks.length === 0) return 'PmtInf'
  for (const b of f.blocks) {
    if (!b.pmtInfId) return 'PmtInf/PmtInfId'
    if (!b.dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate)) return `PmtInf ${b.pmtInfId}: ReqdColltnDt`
    if (!b.creditorIban) return `PmtInf ${b.pmtInfId}: CdtrAcct/Id/IBAN`
    if (b.txs.length === 0) return `PmtInf ${b.pmtInfId}: DrctDbtTxInf`
    for (const t of b.txs) {
      if (!t.endToEndId) return `PmtInf ${b.pmtInfId}: PmtId/EndToEndId`
      if (!t.amount || !/^\d+(\.\d{1,2})?$/.test(t.amount)) return `PmtInf ${b.pmtInfId}: InstdAmt`
      if (t.currency !== 'EUR') return `PmtInf ${b.pmtInfId}: InstdAmt/@Ccy`
      if (!t.debtorIban) return `PmtInf ${b.pmtInfId}: DbtrAcct/Id/IBAN`
      if (!t.signedOn) return `PmtInf ${b.pmtInfId}: MndtRltdInf/DtOfSgntr`
    }
  }
  return undefined
}

/**
 * A SEPA Creditor Identifier: country, two ISO 7064 mod-97 check digits, a three-character
 * business code (not part of the check) and the national identifier.
 */
export function creditorIdOk(ci: string): boolean {
  const s = ci.replace(/\s+/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{3}[A-Z0-9]{1,28}$/.test(s)) return false
  let r = 0
  for (const ch of s.slice(7) + s.slice(0, 2) + s.slice(2, 4)) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of v) r = (r * 10 + Number(d)) % 97
  }
  return r === 1
}

/** A Customer Payment Reversal (pain.007.001.09) as the debtor's refusal uses it. */
export interface Refusal {
  msgId?: string
  nbOfTxs?: string
  ctrlSum?: string
  pmtInfIds: string[]
  txs: { pmtInfId?: string; endToEndId?: string; reason?: string }[]
}

export function readPain007(doc: any): Refusal {
  const root = doc?.Document?.CstmrPmtRvsl ?? {}
  const g = root.GrpHdr ?? {}
  const code = (r: any) => text(r?.Rsn?.Cd) ?? text(r?.Rsn?.Prtry)
  const groupReason = code(root.OrgnlGrpInf?.RvslRsnInf)
  const blocks = many(root.OrgnlPmtInfAndRvsl)
  return {
    msgId: text(g.MsgId), nbOfTxs: text(g.NbOfTxs), ctrlSum: text(g.CtrlSum),
    pmtInfIds: blocks.map((p: any) => text(p.OrgnlPmtInfId)!),
    // Reason Information may sit on the transaction, the block or the group (EPC usage rule).
    txs: blocks.flatMap((p: any) => many(p.TxInf).map((t: any) => ({
      pmtInfId: text(p.OrgnlPmtInfId), endToEndId: text(t.OrgnlEndToEndId),
      reason: code(t.RvslRsnInf) ?? code(p.RvslRsnInf) ?? groupReason,
    }))),
  }
}
