// The ledger's outbox (decisions 990-992): a crash after a booking and before its report
// (statement entry and camt.054) loses neither; after the restart the report is delivered
// once, also when the crash came after the message but before the outbox row went. The
// Postgres part is registered only when DATABASE_URL is set; recover()'s rules for intents
// (open-ledger) run on memory always.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ManualClock } from '../src/clock.js'
import { MemoryLedger } from '../src/ledger.js'
import { INTENT_GRACE_MS, Outbox, type OutboxItem } from '../src/outbox.js'
import { C1, C2, balance, call, drain, pain001, postgresStore, setup, type Ctx } from './helpers.js'

const notifications = async (ctx: Ctx, as: string) => (await drain(ctx, as)).filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION')
const journal = async (ctx: Ctx, iban: string) => (await ctx.emulator.journal.entries(iban, -Infinity, Infinity)).filter((e) => e.amount === 125n)
const pay = (ctx: Ctx) => call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '1.25', creditorIban: C2.iban }] }]) })

if (process.env.DATABASE_URL) describe('outbox (Postgres)', () => {
  test('a crash between the booking and its report: after the restart both camt.054s and statement entries, once', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const [d0, c0] = [Number(await balance(a, C1.iban)), Number(await balance(a, C2.iban))]
    // The process dies once the booking's transaction has committed, before anything reports it.
    a.emulator.outbox.deliver = async () => { throw new Error('crash') }
    await pay(a)
    assert.equal(Number(await balance(a, C1.iban)), d0 - 1.25, 'booked')
    assert.equal((await a.emulator.ledger.outbox.pending()).length, 2, 'its two notices wait with it')
    assert.deepEqual(await journal(a, C1.iban), [])

    const b = await setup(opts) // the restart: fromSeed recovers
    assert.equal((await b.emulator.ledger.outbox.pending()).length, 0)
    assert.deepEqual((await notifications(b, C1.code)).map((m) => m.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn.Ntry.CdtDbtInd), ['DBIT'])
    assert.deepEqual((await notifications(b, C2.code)).map((m) => m.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn.Ntry.CdtDbtInd), ['CRDT'])
    assert.deepEqual((await journal(b, C1.iban)).map((e) => e.direction), ['DBIT'])
    assert.deepEqual((await journal(b, C2.iban)).map((e) => e.direction), ['CRDT'])
    assert.equal(Number(await balance(b, C2.iban)), c0 + 1.25, 'booked once')

    const c = await setup(opts) // another restart delivers nothing again
    assert.equal(await c.emulator.outbox.recover(), 0)
    assert.equal((await call(c, { url: '/messages/next' })).statusCode, 204)
    assert.equal((await journal(c, C1.iban)).length, 1)
  })

  test('a crash after the message, before the outbox row goes: delivered again after the restart, kept once by its key', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const remove = a.emulator.ledger.outbox.remove
    a.emulator.ledger.outbox.remove = async () => { throw new Error('crash') }
    await pay(a)
    a.emulator.ledger.outbox.remove = remove
    assert.equal((await a.emulator.ledger.outbox.pending()).length, 2, 'delivered, not removed')
    const b = await setup(opts)
    assert.equal((await b.emulator.ledger.outbox.pending()).length, 0)
    assert.equal((await notifications(b, C1.code)).length, 1)
    assert.equal((await notifications(b, C2.code)).length, 1)
    assert.equal((await journal(b, C1.iban)).length, 1)
    assert.equal((await journal(b, C2.iban)).length, 1)
  })

  test('two emulators recovering one outbox at once deliver each item once', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    a.emulator.outbox.deliver = async () => { throw new Error('crash') }
    for (let i = 0; i < 3; i++) await pay(a)
    const [b, c] = [await setup(opts), await setup(opts)] // each recovers at start; and once more, at once
    await Promise.all([b.emulator.outbox.recover(), c.emulator.outbox.recover()])
    assert.equal((await notifications(b, C1.code)).length, 3)
    assert.equal((await notifications(c, C2.code)).length, 3)
    assert.equal((await journal(b, C1.iban)).length, 3)
  })
})

describe('outbox recover (memory)', () => {
  test('an intent is delivered once its ledger shows the booking, dropped when it does not after the grace; minAgeMs leaves new items', async () => {
    const clock = new ManualClock('2026-03-10T08:00:00Z')
    const booked = new Set<string>()
    const ledger = Object.assign(new MemoryLedger(), { booked: async (intent: string) => booked.has(intent) })
    const outbox = new Outbox(ledger, clock, { bic: 'LHVBEE22', name: 'AS LHV Pank' })
    const got: string[] = []
    outbox.on('note', async (i) => { got.push(i.key) })
    const item = (key: string, intent?: string): OutboxItem => ({ key, kind: 'note', payload: {}, at: clock.now().getTime(), ...(intent ? { intent } : {}) })
    await ledger.outbox.put([item('plain'), item('yes', 'b1:r1'), item('no', 'b2:r2')])
    clock.advance(1000)
    assert.equal(await outbox.recover({ minAgeMs: 60_000 }), 0, 'too new for the timer')
    booked.add('b1:r1')
    assert.equal(await outbox.recover(), 2)
    assert.deepEqual(got, ['plain', 'yes'])
    assert.deepEqual((await ledger.outbox.pending()).map((i) => i.key), ['no'], 'not booked yet: kept')
    clock.advance(INTENT_GRACE_MS)
    assert.equal(await outbox.recover(), 0)
    assert.deepEqual(await ledger.outbox.pending(), [], 'not booked after the grace: the booking never happened')
  })
})
