// RTF - Routing Table Files (P 11, G rtf-routing-table-files-message; decision 811): the
// scheme's participant lists, sent unsolicited as AGENT_REPORT messages whose content type
// names the scheme. Only RT1 files are gzip-ed (P 11). The bytes are the file itself: the
// simulator passes one in, or for TARGET2 the emulator writes a small directory in the
// fixed-width format of the published RTGSFULLCURRENTEUR sample. The EBA samples are
// password-protected zips, so their format is not known and nothing is made up for them.
import { gzipSync } from 'node:zlib'
import type { Clock } from '../clock.js'
import type { Customer, CustomerKey, Directory } from '../directory.js'
import type { Inbox, Message } from '../inbox.js'
import type { Bank } from '../payments/engine.js'
import { dateTallinn } from '../time.js'
import type { RtfScheme } from './store.js'

export const AGENT_REPORT = 'AGENT_REPORT'

/** The content type of each scheme's file (P 11 list; RT1 with +gzip, as P 11 writes it). */
export const RTF_CONTENT_TYPES: Record<RtfScheme, string> = {
  'step2.in': 'application/vnd.lhv.step2.in.rtf',
  'step2.di': 'application/vnd.lhv.step2.di.rtf',
  'rt1.in': 'application/vnd.lhv.rt1.in.rtf+gzip',
  'rt1.di': 'application/vnd.lhv.rt1.di.rtf+gzip',
  'sdd.in': 'application/vnd.lhv.sdd.in.rtf',
  'sdd.di': 'application/vnd.lhv.sdd.di.rtf',
  tips: 'application/vnd.lhv.tips.rtf',
  t2: 'application/vnd.lhv.t2.rtf',
}

export class RtfError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message) }
}

export interface RtfDeps { directory: Directory; inbox: Inbox; clock: Clock; bank: Bank }

const pad = (s: string, n: number) => s.slice(0, n).padEnd(n, ' ')
const isGzip = (b: Buffer) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b

/**
 * A TARGET2 (RTGS) directory with the bank itself as the only participant, in the layout of
 * the published sample: BIC, addressee BIC and account BIC (11 each), institution name
 * (105), city (50), then the two-letter code, valid from and to (YYYYMMDD) and the
 * two-digit participation type copied from the sample's lines.
 */
export function t2Directory(bank: Bank, today: string): string {
  const bic = pad(`${bank.bic}XXX`, 11)
  const day = today.replace(/-/g, '')
  const line = `${bic}${bic}${bic}${pad(bank.name.toUpperCase(), 105)}${pad('TALLINN', 50)}TU${day}9999123101`
  return `<File fileId = "RTGSEURFULL${day}" xmlns="urn:CRDM:RTGSDirectory">${line}\n</File>\n`
}

export class RtfService {
  constructor(private deps: RtfDeps) {}

  /** Who receives a scheme's files: the agents that have it in their set-up. */
  recipients(scheme: RtfScheme): Customer[] {
    return this.deps.directory.all().filter((c) => c.agency?.agreement && c.agency.rtf?.includes(scheme))
  }

  /**
   * Sends one file to every agent that receives the scheme, or to one of them. Without
   * `content` only TARGET2 has a file of its own.
   */
  deliver(o: { scheme: RtfScheme; content?: Buffer; customer?: CustomerKey }): Message[] {
    let to = this.recipients(o.scheme)
    if (o.customer) {
      const c = this.deps.directory.get(o.customer)
      if (!c) throw new RtfError(404, `no customer ${o.customer.country}:${o.customer.code}`)
      if (!to.includes(c)) throw new RtfError(409, `customer ${c.country}:${c.code} does not receive ${o.scheme} RTFs (agency.rtf)`)
      to = [c]
    }
    let file = o.content
    if (!file) {
      if (o.scheme !== 't2') throw new RtfError(400, `content is required for ${o.scheme}: the published EBA samples are encrypted, so the emulator has no file of its own`)
      file = Buffer.from(t2Directory(this.deps.bank, dateTallinn(this.deps.clock.now())), 'utf8')
    }
    if (o.scheme.startsWith('rt1.') && !isGzip(file)) file = gzipSync(file)
    const contentType = RTF_CONTENT_TYPES[o.scheme]
    return to.map((c) => this.deps.inbox.add({ customer: c, type: AGENT_REPORT, body: file, contentType }))
  }
}
