// Shared test set-up: an emulator on a manual clock with the dev seed, requests by
// fastify inject (the certificate identity comes from a test header instead of TLS;
// mtls.test.ts covers the real transport), and a pain.001 writer for fixtures.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { buildApp } from '../src/app.js'
import { ManualClock } from '../src/clock.js'
import { Emulator, type EmulatorOptions, type Seed } from '../src/emulator.js'
import { XsdValidator } from '../src/payments/xsd.js'
import { parseXml } from '../src/xml.js'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
/**
 * The bank's published XSDs and samples, used by reference, never copied here: the
 * local docs mirror (LHV_DOCS_DIR, default the nearest ../docs.lhv-connect up the tree) when present, else what
 * scripts/fetch-reference.sh downloaded into reference/. Tests that need them skip
 * with a message when neither exists.
 */
export const MIRROR_DIR = process.env.LHV_DOCS_DIR ? resolve(process.env.LHV_DOCS_DIR) : findMirror()
export const MIRROR_FILES = join(MIRROR_DIR, '_raw/partners/assets/files')
/** ../docs.lhv-connect next to the repo, also from a git worktree nested inside it (.claude/worktrees/x). */
function findMirror(): string {
  for (let dir = ROOT; ; dir = dirname(dir)) {
    const candidate = join(dir, '../docs.lhv-connect')
    if (existsSync(join(candidate, '_raw'))) return resolve(candidate)
    if (dirname(dir) === dir) return resolve(ROOT, '../docs.lhv-connect')
  }
}
const MIRROR = existsSync(join(MIRROR_FILES, 'XSD/pain.001.001.09.xsd'))
export const XSD_DIR = MIRROR ? join(MIRROR_FILES, 'XSD') : join(ROOT, 'reference/xsd')
export const HAVE_REFERENCE = existsSync(join(XSD_DIR, 'pain.001.001.09.xsd'))
export const NO_REFERENCE = HAVE_REFERENCE ? false : 'no published XSDs (docs mirror or scripts/fetch-reference.sh)'
/** A published sample, e.g. sample('PAYMENT_SEPA', 'PAYMENT_PAIN.001.xml'); undefined when absent. */
export function sample(scenario: string, file: string): string | undefined {
  const p = MIRROR ? join(MIRROR_FILES, 'samples', scenario, file) : join(ROOT, 'reference/samples', `${scenario}__${file}`)
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined
}
export const xsd = new XsdValidator(XSD_DIR)

export const C1 = { code: '12340001', country: 'EE', iban: 'EE337700771001260958' }
export const C2 = { code: '12340002', country: 'EE', iban: 'EE267700771001260987' }
export const SP = { code: '10000001', country: 'EE', iban: 'EE707700771001260001' }
/** A valid German IBAN at another bank. */
export const DE_IBAN = 'DE89370400440532013000'

export function seed(): Seed {
  return JSON.parse(readFileSync(join(ROOT, 'config/dev-seed.json'), 'utf8'))
}

export interface Ctx { app: FastifyInstance; emulator: Emulator; clock: ManualClock }

export async function setup(opts: EmulatorOptions = {}, s: Seed = seed()): Promise<Ctx> {
  const clock = new ManualClock('2026-03-10T08:00:00Z')
  const emulator = await Emulator.fromSeed(s, { clock, xsdDir: HAVE_REFERENCE ? XSD_DIR : undefined, ...opts })
  const identify = (req: FastifyRequest) => {
    const serial = req.headers['x-test-serial']
    const cn = req.headers['x-test-cn']
    if (serial === undefined && cn === undefined) return undefined
    return { serialNumber: serial as string | undefined, commonName: cn as string | undefined, certSerial: '0A1B', validFrom: 'Jan  1 00:00:00 2026 GMT', validTo: 'Jan  1 00:00:00 2028 GMT' }
  }
  const app = buildApp({ emulator, identify })
  await app.ready()
  return { app, emulator, clock }
}

export interface Req { method?: string; url: string; as?: string | null; headers?: Record<string, string>; body?: string | object; contentType?: string }

export async function call(ctx: Ctx, r: Req) {
  const headers: Record<string, string> = { ...(r.headers ?? {}) }
  if (r.as !== null) headers['x-test-serial'] = r.as ?? C1.code
  let payload: string | undefined
  if (typeof r.body === 'string') { payload = r.body; headers['content-type'] = r.contentType ?? 'application/xml' }
  else if (r.body !== undefined) { payload = JSON.stringify(r.body); headers['content-type'] = 'application/json' }
  const res = await ctx.app.inject({ method: (r.method ?? 'GET') as any, url: r.url, headers, payload })
  return res
}

/** Reads every pending message of a caller (oldest first), confirming each. */
export async function drain(ctx: Ctx, as = C1.code, headers: Record<string, string> = {}) {
  const out: { type: string; requestId?: string; id: string; body: string; doc: any }[] = []
  for (let i = 0; i < 1000; i++) {
    const res = await call(ctx, { url: '/messages/next', as, headers })
    if (res.statusCode === 204) return out
    const id = res.headers['message-response-id'] as string
    out.push({ id, type: res.headers['message-response-type'] as string, requestId: res.headers['message-request-id'] as string | undefined, body: res.body, doc: parseXml(res.body) })
    await call(ctx, { method: 'DELETE', url: `/messages/${id}`, as, headers })
  }
  throw new Error('inbox does not drain')
}

export interface TxSpec {
  amount: string; currency?: string; creditorName?: string; creditorIban?: string; scheme?: string
  instrId?: string; endToEndId?: string; ustrd?: string | null; reference?: string
}
export interface BlockSpec { pmtInfId?: string; debtorIban?: string; debtorName?: string; scheme?: string; txs: TxSpec[]; nbOfTxs?: string; ctrlSum?: string }

let n = 0
/** A pain.001 (version 09 or 03) with the given blocks. Counts and sums are right unless overridden. */
export function pain001(blocks: BlockSpec[], o: { version?: '09' | '03'; msgId?: string; nbOfTxs?: string; ctrlSum?: string } = {}) {
  const v09 = (o.version ?? '09') === '09'
  const id = ++n
  const sum = (txs: TxSpec[]) => txs.reduce((s, t) => s + Math.round(Number(t.amount) * 100), 0) / 100
  const all = blocks.flatMap((b) => b.txs)
  const bic = (b: string) => (v09 ? `<BICFI>${b}</BICFI>` : `<BIC>${b}</BIC>`)
  const svc = (s?: string) => (s ? `<PmtTpInf><SvcLvl><Prtry>${s}</Prtry></SvcLvl></PmtTpInf>` : '')
  const tx = (t: TxSpec, i: number, b: number) => `
      <CdtTrfTxInf>
        <PmtId><InstrId>${t.instrId ?? `INSTR-${id}-${b}-${i}`}</InstrId><EndToEndId>${t.endToEndId ?? `E2E-${id}-${b}-${i}`}</EndToEndId></PmtId>
        ${svc(t.scheme)}
        <Amt><InstdAmt Ccy="${t.currency ?? 'EUR'}">${t.amount}</InstdAmt></Amt>
        ${t.creditorName === '' ? '' : `<Cdtr><Nm>${t.creditorName ?? 'Creditor Name'}</Nm></Cdtr>`}
        <CdtrAcct><Id><IBAN>${t.creditorIban ?? C2.iban}</IBAN></Id></CdtrAcct>
        ${t.ustrd === null && !t.reference ? '' : `<RmtInf>${t.ustrd === null ? '' : `<Ustrd>${t.ustrd ?? 'Invoice 42'}</Ustrd>`}${t.reference ? `<Strd><CdtrRefInf><Ref>${t.reference}</Ref></CdtrRefInf></Strd>` : ''}</RmtInf>`}
      </CdtTrfTxInf>`
  const block = (b: BlockSpec, bi: number) => `
    <PmtInf>
      <PmtInfId>${b.pmtInfId ?? `PMTINF-${id}-${bi}`}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${b.nbOfTxs ?? b.txs.length}</NbOfTxs>
      <CtrlSum>${b.ctrlSum ?? sum(b.txs).toFixed(2)}</CtrlSum>
      ${svc(b.scheme)}
      <ReqdExctnDt>${v09 ? '<Dt>2026-03-10</Dt>' : '2026-03-10'}</ReqdExctnDt>
      <Dbtr><Nm>${b.debtorName ?? 'Demo Customer 1'}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${b.debtorIban ?? C1.iban}</IBAN></Id></DbtrAcct>
      <DbtrAgt><FinInstnId>${bic('LHVBEE22XXX')}</FinInstnId></DbtrAgt>
      ${b.txs.map((t, i) => tx(t, i, bi)).join('')}
    </PmtInf>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.${v09 ? '09' : '03'}">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${o.msgId ?? `MSG-${id}-${Date.now()}`}</MsgId>
      <CreDtTm>2026-03-10T10:00:00</CreDtTm>
      <NbOfTxs>${o.nbOfTxs ?? all.length}</NbOfTxs>
      <CtrlSum>${o.ctrlSum ?? sum(all).toFixed(2)}</CtrlSum>
      <InitgPty><Nm>Demo Customer 1</Nm></InitgPty>
    </GrpHdr>${blocks.map(block).join('')}
  </CstmrCdtTrfInitn>
</Document>`
}

/** Balance of an account in a currency as a decimal string. */
export async function balance(ctx: Ctx, iban: string, ccy = 'EUR') {
  const b = (await ctx.emulator.ledger.balances(iban))[ccy]
  return b ? (Number(b.balance) / 100).toFixed(2) : '0.00'
}

// --- Account reports (L2) ------------------------------------------------------------

export interface ReportReq {
  /** camt.060 version: '05' (default) or '03'. */
  version?: '05' | '03'
  kind?: 'statement' | 'balance'
  iban?: string
  frDt?: string | null
  toDt?: string
  frTm?: string
  toTm?: string
  prtry?: string
  msgId?: string
  /** ReqdMsgNmId; default the right answer for kind and version. */
  reqd?: string
}

let rq = 0
/** A camt.060.001.05/.03 Account Reporting Request. frDt null leaves RptgPrd out. */
export function camt060(o: ReportReq = {}) {
  const v = o.version ?? '05'
  const kind = o.kind ?? 'statement'
  const reqd = o.reqd ?? (kind === 'statement' ? (v === '05' ? 'camt.053.001.08' : 'camt.053.001.02') : (v === '05' ? 'camt.052.001.08' : 'camt.052.001.06'))
  const frDt = o.frDt === undefined ? '2026-03-10' : o.frDt
  // FrToTm is optional in .05 and mandatory in .03 (ignored for DATE requests).
  const frTm = o.frTm ?? (v === '03' ? '00:00:00' : undefined)
  const tm = frTm ? `<FrToTm><FrTm>${frTm}</FrTm>${o.toTm ? `<ToTm>${o.toTm}</ToTm>` : ''}</FrToTm>` : ''
  const prd = frDt === null ? '' : `<RptgPrd><FrToDt><FrDt>${frDt}</FrDt>${o.toDt ? `<ToDt>${o.toDt}</ToDt>` : ''}</FrToDt>${tm}<Tp>ALLL</Tp></RptgPrd>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.060.001.${v}">
  <AcctRptgReq>
    <GrpHdr><MsgId>${o.msgId ?? `RPT-${++rq}-${Date.now()}`}</MsgId><CreDtTm>2026-03-10T10:00:00Z</CreDtTm></GrpHdr>
    <RptgReq>
      <ReqdMsgNmId>${reqd}</ReqdMsgNmId>
      <Acct><Id><IBAN>${o.iban ?? C1.iban}</IBAN></Id></Acct>
      <AcctOwnr><Pty/></AcctOwnr>
      ${prd}
      ${o.prtry ? `<ReqdBalTp><CdOrPrtry><Prtry>${o.prtry}</Prtry></CdOrPrtry></ReqdBalTp>` : ''}
    </RptgReq>
  </AcctRptgReq>
</Document>`
}

/**
 * POSTs a camt.060 to /account-statement or /account-balance (202 expected) and returns
 * the inbox messages answering it, in order, with their headers.
 */
export async function report(ctx: Ctx, o: ReportReq | string, opts: { kind?: 'statement' | 'balance'; as?: string; headers?: Record<string, string> } = {}) {
  const kind = opts.kind ?? (typeof o === 'string' ? 'statement' : o.kind ?? 'statement')
  const body = typeof o === 'string' ? o : camt060({ ...o, kind })
  const res = await call(ctx, { method: 'POST', url: kind === 'statement' ? '/account-statement' : '/account-balance', body, as: opts.as, headers: opts.headers })
  if (res.statusCode !== 202) throw new Error(`expected 202, got ${res.statusCode}: ${res.body}`)
  const id = res.headers['message-request-id'] as string
  const msgs = await drain(ctx, opts.as ?? C1.code, opts.headers)
  return { id, msgs: msgs.filter((m) => m.requestId === id), all: msgs }
}

/** The <Error> of an <Errors> answer. */
export function reportError(m: { doc: any }) {
  const e = m.doc?.Errors?.Error
  return e ? { code: String(e.ErrorCode), description: String(e.Description), field: e.Field === undefined ? undefined : String(e.Field) } : undefined
}

/** Asserts a message against its published XSD when there is one; returns whether it was checked. */
export async function schemaValid(body: string): Promise<boolean> {
  const ns = /xmlns="urn:iso:std:iso:20022:tech:xsd:([^"]+)"/.exec(body)?.[1]
  if (!HAVE_REFERENCE || !ns || !xsd.has(ns)) return false
  const errors = await xsd.validate(body, ns)
  if (errors.length) throw new Error(`${ns} is not schema-valid: ${errors.join('; ')}\n${body.slice(0, 4000)}`)
  return true
}
