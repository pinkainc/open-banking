// Which LHV entity answers (routing.ts, decisions 700–704): X-Bank-Code on the response,
// the UK host's X-Bank-Code override, EE-only services on the UK host, UK-only services
// on the EE host, and the heartbeat time of the answering entity.
import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { parseXml } from '../src/xml.js'
import { EE_ONLY, UK_ONLY, bankFor, isUkAccount } from '../src/routing.js'
import { call, setup, type Ctx } from './helpers.js'

const EE = { 'x-bank-code': 'LHVEE' }
const subscribe = { url: 'https://example.com/hook', eventType: 'GENERAL_WEBHOOK' }

describe('host routing', () => {
  let uk: Ctx, ee: Ctx
  before(async () => { uk = await setup({}, undefined, { flavour: 'UK' }); ee = await setup() })

  test('the UK host answers as LHVUK, and as LHVEE when the request asks for LHV EE (any case)', async () => {
    for (const url of ['/heartbeat', '/messages/next', '/messages/count']) {
      assert.equal((await call(uk, { url })).headers['x-bank-code'], 'LHVUK', url)
      assert.equal((await call(uk, { url, headers: EE })).headers['x-bank-code'], 'LHVEE', url)
      assert.equal((await call(uk, { url, headers: { 'X-Bank-Code': 'lhvee' } })).headers['x-bank-code'], 'LHVEE', url)
      assert.equal((await call(uk, { url, headers: { 'x-bank-code': 'LHVUK' } })).headers['x-bank-code'], 'LHVUK', url)
      assert.equal((await call(uk, { url, headers: { 'x-bank-code': 'NOPE' } })).headers['x-bank-code'], 'LHVUK', url)
    }
  })

  test('the EE host ignores the header: always LHVEE', async () => {
    for (const h of [{}, { 'x-bank-code': 'LHVUK' }] as Record<string, string>[]) {
      assert.equal((await call(ee, { url: '/heartbeat', headers: h })).headers['x-bank-code'], 'LHVEE')
    }
  })

  test('EE webhooks on the UK host: 404 without the header, served as LHVEE with it', async () => {
    const plain = await call(uk, { method: 'POST', url: '/notifications/subscribe', body: subscribe })
    assert.equal(plain.statusCode, 404)
    assert.equal(plain.headers['x-bank-code'], 'LHVUK')
    const res = await call(uk, { method: 'POST', url: '/notifications/subscribe', body: subscribe, headers: EE })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal(res.headers['x-bank-code'], 'LHVEE')
    const list = await call(uk, { url: '/notifications/subscriptions', headers: EE })
    assert.equal(list.statusCode, 200)
    assert.equal(JSON.parse(list.body).subscriptions.length, 1)
    assert.equal((await call(uk, { url: '/notifications/subscriptions' })).statusCode, 404)
    // The EE host serves them as before (none there: 204).
    assert.equal((await call(ee, { url: '/notifications/subscriptions' })).statusCode, 204)
  })

  test('FX, contracts, SEPA direct debit and the signed heartbeat: EE only, reachable from the UK host with the header', async () => {
    const cases = [
      { method: 'POST', url: '/fx/trade-offer', body: {} },
      { method: 'GET', url: '/contracts' },
      { method: 'POST', url: '/direct-debit/collection', body: '<x/>' },
      { method: 'POST', url: '/direct-debit/incoming-collection', body: '<x/>' },
      { method: 'POST', url: '/heartbeat', body: 'x' },
    ]
    for (const c of cases) {
      assert.equal((await call(uk, c)).statusCode, 404, `${c.method} ${c.url}`)
      const r = await call(uk, { ...c, headers: EE })
      assert.notEqual(r.statusCode, 404, `${c.method} ${c.url} with LHVEE: ${r.body}`)
      assert.equal(r.headers['x-bank-code'], 'LHVEE')
      assert.notEqual((await call(ee, c)).statusCode, 404, `${c.method} ${c.url} on the EE host`)
    }
  })

  test('UK-only services: absent on the EE host, refused on the UK host for LHV EE', async () => {
    for (const url of ['/v2/messages', '/v2/requests', '/messages/test/next']) {
      assert.equal((await call(ee, { url })).statusCode, 404, url)
      assert.notEqual((await call(uk, { url })).statusCode, 404, url)
      const r = await call(uk, { url, headers: EE })
      assert.equal(r.statusCode, 404, url)
      assert.equal(r.headers['x-bank-code'], 'LHVEE')
    }
  })

  test('services on both hosts stay reachable on the UK host for LHV EE; the EE VoP is LHVEE either way', async () => {
    assert.equal((await call(uk, { url: '/heartbeat/mq', headers: EE })).statusCode, 202)
    const vop = await call(uk, { method: 'POST', url: '/verification-of-payee', body: '<VerificationOfPayeeRequest/>' })
    assert.equal(vop.statusCode, 202)
    assert.equal(vop.headers['x-bank-code'], 'LHVEE')
  })

  test('a 202 for LHV EE is logged with LHVEE, and its answer stays out of /v2/messages (decision 625)', async () => {
    const ctx = await setup({}, undefined, { flavour: 'UK' })
    const viaEe = await call(ctx, { url: '/heartbeat/mq', headers: EE })
    const viaUk = await call(ctx, { url: '/heartbeat/mq' })
    assert.equal(ctx.emulator.requests.bankCodeOf(viaEe.headers['message-request-id'] as string), 'LHVEE')
    assert.equal(ctx.emulator.requests.bankCodeOf(viaUk.headers['message-request-id'] as string), 'LHVUK')
    const v2 = JSON.parse((await call(ctx, { url: '/v2/messages' })).body)
    assert.deepEqual(v2.messages.map((m: { messageRequestId: string }) => m.messageRequestId), [viaUk.headers['message-request-id']])
  })

  test('heartbeat time: UK time from LHV UK, Tallinn time from LHV EE (also in the inbox message)', async () => {
    const ctx = await setup({}, undefined, { flavour: 'UK' })
    const ts = async (h: Record<string, string>) => parseXml((await call(ctx, { url: '/heartbeat', headers: h })).body).HeartBeatResponse.TimeStamp
    assert.equal(await ts({}), '2026-03-10T08:00:00.0000000+00:00')
    assert.equal(await ts(EE), '2026-03-10T10:00:00.0000000+02:00')
    ctx.clock.set('2026-07-01T11:30:00.123Z')
    assert.equal(await ts({}), '2026-07-01T12:30:00.1230000+01:00')
    await call(ctx, { url: '/heartbeat/mq' })
    const m = await call(ctx, { url: '/messages/next' })
    assert.equal(parseXml(m.body).HeartBeatResponse.TimeStamp, '2026-07-01T12:30:00.1230000+01:00')
  })

  test('the tables: no route is on both lists; GB IBANs are UK accounts', () => {
    for (const u of ['/fx/trade-offer', '/contracts', '/notifications/subscribe', '/notifications/subscriptions/x']) {
      assert.ok(EE_ONLY.some((r) => r.path.test(u)), u)
      assert.ok(!UK_ONLY.some((r) => r.path.test(u)), u)
    }
    for (const u of ['/accounts/list', '/notifications/subscription', '/notifications/subscription/x', '/notifications/history', '/notifications/replay', '/direct-debit/bacs-mandate']) {
      assert.ok(UK_ONLY.some((r) => r.path.test(u)), u)
      assert.ok(!EE_ONLY.some((r) => r.path.test(u)), u)
    }
    assert.ok(isUkAccount('GB33BUKB20201555555555'))
    assert.ok(!isUkAccount('EE337700771001260958'))
    assert.equal(bankFor({ headers: EE } as never, 'EE', 'LHVEE'), 'LHVEE')
  })
})
