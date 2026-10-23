// GET /messages/test/next?mockLargeMessage=true (G get-next-message-1, UK prelive): "a
// mock account statement (CAMT.053) with dummy transactions, resulting in an uncompressed
// payload of approximately 10.6MB", for trying response compression. A real camt.053.001.02
// from the statement writer, for a dummy account; it is not stored in any inbox.
import { camt053, type StatementVersion } from './camt053.js'
import type { JournalEntry } from './journal.js'

/** Approximate uncompressed size of the published mock. */
export const MOCK_SIZE = 10_600_000
const IBAN = 'EE382200221020145685'
const OWNER = { name: 'Mock Statement Customer', code: '00000000' }

/** camt.053.001.02 as published; `version` '08' only lets tests check the entries against an XSD the mirror has. */
export function mockLargeStatement(now: Date, bank: { bic: string; name: string }, size = MOCK_SIZE, version: StatementVersion = '02'): string {
  const to = now.getTime()
  const from = to - 24 * 60 * 60 * 1000
  const build = (n: number) => {
    const entries: JournalEntry[] = []
    let sum = 0n
    for (let i = 0; i < n; i++) {
      const credit = i % 2 === 0
      const amount = BigInt(100 + (i % 9000))
      sum += credit ? amount : -amount
      entries.push({
        seq: i + 1, account: IBAN, owner: OWNER, direction: credit ? 'CRDT' : 'DBIT', amount, currency: 'EUR',
        servicerRef: `MOCK${String(i).padStart(28, '0')}`, scheme: 'SEPA', bookedAt: new Date(from + 1000 + (i % 80000) * 1000),
        endToEndId: `MOCK-E2E-${i}`, counterparty: { name: `Dummy Counterparty ${i % 100}`, iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' },
        remittance: `Dummy transaction ${i}`,
      })
    }
    entries.sort((a, b) => a.bookedAt.getTime() - b.bookedAt.getTime() || a.seq - b.seq)
    return camt053({
      version, created: now, from, to, fullDays: false, iban: IBAN, owner: OWNER, bank,
      blocks: [{ currency: 'EUR', opening: { amount: 1_000_000n }, closing: { amount: 1_000_000n + sum }, entries }],
    })
  }
  const base = build(0).length
  const per = build(100).length - base
  return build(Math.ceil(((size - base) * 100) / per))
}
