// The Postgres inbox beyond the shared semantics (inbox.test.ts, messages-v2.test.ts and
// bounded.test.ts run those against both stores): binary bodies round-trip, namespaces
// keep emulators apart, two instances on one namespace are one queue, the bounds and
// purge hold in the table, and an emulator built on it answers end to end. Registered
// only when DATABASE_URL is set (npm run check sets it).
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { describe, test } from 'node:test'
import { DAY_MS, ManualClock } from '../src/clock.js'
import { keyOf } from '../src/directory.js'
import type { Message } from '../src/inbox.js'
import { PgInbox } from '../src/pg/inbox.js'
import { C1, C2, INBOXES, call, drain, pain001, pgInboxDb, setup } from './helpers.js'

const scope = (...cs: { code: string; country: string }[]) => ({ customers: new Set(cs.map(keyOf)) })

if (process.env.DATABASE_URL) describe('PgInbox (Postgres)', () => {
  const make = async (o: ConstructorParameters<typeof PgInbox>[2] = {}, clock = new ManualClock('2026-03-10T08:00:00Z')) =>
    ({ inbox: new PgInbox(await pgInboxDb(), clock, o), clock })

  test('a binary body comes back as the same bytes, a string as the same string', async () => {
    const { inbox, clock } = await make()
    const zip = gzipSync(Buffer.from('RT1 file õäöü'))
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a])
    const text = '<Ustrd>Õie € & šž 😀</Ustrd>'
    const a = await inbox.add({ customer: C1, type: 'AGENT_REPORT', body: zip, contentType: 'application/gzip' })
    clock.advance(1000)
    const b = await inbox.add({ customer: C1, type: 'AGENT_REPORT', body: raw, contentType: 'application/octet-stream' })
    clock.advance(1000)
    const c = await inbox.add({ customer: C1, type: 'PAYMENT', body: text, requestId: 'REQ1' })
    const got = await inbox.list(scope(C1))
    assert.deepEqual(got.map((m) => m.id), [a.id, b.id, c.id])
    assert.ok(Buffer.isBuffer(got[0].body) && Buffer.isBuffer(got[1].body))
    assert.deepEqual(got[0].body, zip)
    assert.deepEqual(got[1].body, raw)
    assert.equal(got[2].body, text)
    assert.deepEqual(got[2], c, 'every field as add returned it')
    assert.equal(got[0].contentType, 'application/gzip')
    assert.equal((await inbox.get(scope(C1), c.id))?.requestId, 'REQ1')
  })

  test('namespaces do not see each other', async () => {
    const { inbox: a } = await make()
    const { inbox: b } = await make()
    assert.notEqual(a.namespace, b.namespace)
    const m = await a.add({ customer: C1, type: 'PAYMENT', body: '<x/>' })
    assert.equal(await b.count(scope(C1)), 0)
    assert.equal(await b.next(scope(C1)), undefined)
    assert.equal(await b.get(scope(C1), m.id), undefined)
    assert.equal(await b.delete(scope(C1), m.id), 'unknown')
    assert.equal(await a.count(scope(C1)), 1, 'the other namespace deleted nothing')
    assert.equal(await a.delete(scope(C1), m.id), 'deleted')
    assert.equal(await b.tombstones(), 0)
    assert.equal(await a.tombstones(), 1)
  })

  test('two instances on one namespace are one queue: oldest first across both, a delete seen by both', async () => {
    const clock = new ManualClock('2026-03-10T08:00:00Z')
    const { inbox: a } = await make({}, clock)
    const { inbox: b } = await make({ namespace: a.namespace }, clock)
    const m1 = await a.add({ customer: C1, type: 'PAYMENT', body: '<1/>' })
    const m2 = await b.add({ customer: C1, type: 'PAYMENT', body: '<2/>' }) // same instant: seq decides
    const m3 = await a.add({ customer: C2, type: 'PAYMENT', body: '<3/>' })
    assert.deepEqual((await b.list(scope(C1, C2))).map((m) => m.id), [m1.id, m2.id, m3.id])
    assert.equal((await b.next(scope(C1)))?.id, m1.id)
    assert.equal(await b.delete(scope(C1), m1.id), 'deleted')
    assert.equal((await a.next(scope(C1)))?.id, m2.id)
    assert.equal(await a.delete(scope(C1), m1.id), 'deleted', 'a repeat DELETE on the other instance: the shared tombstone')
    assert.deepEqual((await a.entries(scope(C1), { includeProcessed: true })).map((e) => [e.message.id, e.processed]), [[m1.id, true], [m2.id, false]])
    assert.equal(await b.setProcessed(scope(C1), [{ id: m1.id, processed: false }]), undefined)
    assert.equal(await a.count(scope(C1)), 2, 'undeleted on one, pending on the other')
  })

  test('onAdd listeners run after the row is stored', async () => {
    const { inbox } = await make()
    const seen: Promise<Message | undefined>[] = []
    inbox.onAdd((m) => seen.push(inbox.get(scope(C1), m.id)))
    const m = await inbox.add({ customer: C1, type: 'HEARTBEAT', body: '<h/>' })
    assert.equal(seen.length, 1)
    assert.equal((await seen[0])?.id, m.id)
  })

  test('bounds: the oldest tombstones and processed messages beyond max go first', async () => {
    const { inbox } = await make({ tombstones: { ttlMs: 5 * DAY_MS, max: 2 }, processed: { ttlMs: 7 * DAY_MS, max: 2 } })
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await inbox.add({ customer: C1, type: 'HEARTBEAT', body: '<x/>' })).id)
    for (const id of ids) assert.equal(await inbox.delete(scope(C1), id), 'deleted')
    assert.equal(await inbox.tombstones(), 2)
    assert.equal(await inbox.processedKept(), 2)
    assert.equal(await inbox.delete(scope(C1), ids[0]), 'unknown', 'forgotten')
    assert.equal(await inbox.delete(scope(C1), ids[2]), 'deleted')
  })

  test('purge: expired messages become tombstones, then tombstones expire and processed ones are archived', async () => {
    const { inbox, clock } = await make()
    const kept = await inbox.add({ customer: C1, type: 'PAYMENT', body: '<k/>' })
    const unread = await inbox.add({ customer: C1, type: 'PAYMENT', body: '<u/>' })
    assert.equal(await inbox.delete(scope(C1), kept.id), 'deleted')
    clock.advance(5 * DAY_MS + 1)
    assert.equal(await inbox.purge(), 1)
    assert.equal(await inbox.count(scope(C1)), 0)
    assert.equal(await inbox.tombstones(), 1, "the confirmed one's tombstone expired; the unread one has a fresh one")
    assert.equal(await inbox.delete(scope(C1), unread.id), 'deleted')
    assert.equal(await inbox.processedKept(), 1)
    clock.advance(2 * DAY_MS)
    assert.equal(await inbox.purge(), 0)
    assert.equal(await inbox.processedKept(), 0, 'archived a week after creation')
    clock.advance(5 * DAY_MS)
    await inbox.purge()
    assert.equal(await inbox.tombstones(), 0)
    assert.equal(await inbox.delete(scope(C1), unread.id), 'unknown')
  })

  test('an emulator on PgInbox answers a payment end to end (pain.002, camt.054s, v1 and v2 views)', async () => {
    const pg = INBOXES.find(([name]) => name === 'postgres')![1]
    const ctx = await setup(await pg(), undefined, { flavour: 'UK' })
    const res = await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '1.00', creditorIban: C2.iban }] }]) })
    assert.equal(res.statusCode, 202, res.body)
    const list = JSON.parse((await call(ctx, { url: '/v2/messages' })).body)
    assert.ok(list.messages.length >= 2, 'pain.002 and the camt.054 DBIT are listed')
    const msgs = await drain(ctx)
    assert.ok(msgs.some((m) => m.type === 'PAYMENT') && msgs.some((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION'))
    assert.deepEqual((await drain(ctx, C2.code)).map((m) => m.type), ['CREDIT_DEBIT_NOTIFICATION'])
    assert.equal((await call(ctx, { url: '/messages/next' })).statusCode, 204)
  })
})
