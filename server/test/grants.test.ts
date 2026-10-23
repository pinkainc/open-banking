// Per-contract service grants (decision 501): a route whose P 14 service is not enabled
// in the contract is 403 "User has not been granted the requested service".
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parseXml } from '../src/xml.js'
import { C1, C2, SP, call, pain001, seed, setup, type Ctx } from './helpers.js'

const C3 = { code: '12340003', country: 'EE' }
const SP_FOR = (c: { code: string; country: string }) => ({ 'Client-Code': c.code, 'Client-Country': c.country })

/** Every gated route, answered by the caller `as` (with headers). */
const routes = (headers: Record<string, string> = {}) => [
  { service: 'HEARTBEAT', method: 'GET', url: '/heartbeat', headers },
  { service: 'HEARTBEAT', method: 'GET', url: '/heartbeat/mq', headers },
  { service: 'HEARTBEAT', method: 'POST', url: '/heartbeat', body: 'x', headers },
  { service: 'ACCOUNT_STATEMENT', method: 'POST', url: '/account-statement', body: '<x/>', headers },
  { service: 'ACCOUNT_BALANCE', method: 'POST', url: '/account-balance', body: '<x/>', headers },
  { service: 'PAYMENTS_WITHOUT_SIGNATURE', method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '1.00' }] }]), headers },
]

function denied(r: { statusCode: number; body: string; headers: Record<string, unknown> }, what: string) {
  assert.equal(r.statusCode, 403, what)
  assert.match(String(r.headers['content-type']), /application\/xml/)
  assert.deepEqual(parseXml(r.body).Errors.Error, { ErrorCode: 'FORBIDDEN', Description: 'User has not been granted the requested service' }, what)
}

async function check(ctx: Ctx, as: string, headers: Record<string, string>, enabled: string[]) {
  for (const r of routes(headers)) {
    const res = await call(ctx, { ...r, as })
    if (enabled.includes(r.service)) assert.notEqual(res.statusCode, 403, `${r.method} ${r.url}: ${res.body}`)
    else denied(res, `${r.method} ${r.url}`)
  }
}

describe('service grants', () => {
  test('a customer without services in the seed has them all (the default)', async () => {
    const ctx = await setup()
    await check(ctx, C1.code, {}, routes().map((r) => r.service))
  })

  test("a customer's own contract: only the enabled services pass", async () => {
    const s = seed()
    s.customers.find((c) => c.code === C1.code)!.services = ['HEARTBEAT', 'ACCOUNT_BALANCE']
    const ctx = await setup({}, s)
    await check(ctx, C1.code, {}, ['HEARTBEAT', 'ACCOUNT_BALANCE'])
    // Nothing was produced by the refused requests: only heartbeat/mq, POST heartbeat and the balance answer.
    assert.deepEqual(JSON.parse((await call(ctx, { url: '/messages/count' })).body), { count: 3 })
  })

  test('an empty service list refuses every gated route; the messages API stays open', async () => {
    const s = seed()
    s.customers.find((c) => c.code === C2.code)!.services = []
    const ctx = await setup({}, s)
    await check(ctx, C2.code, {}, [])
    for (const url of ['/messages/next', '/messages', '/messages/count']) {
      assert.ok([200, 204].includes((await call(ctx, { url, as: C2.code })).statusCode), url)
    }
  })

  test('a signed payment is still 415, whatever the services', async () => {
    const s = seed()
    s.customers.find((c) => c.code === C1.code)!.services = []
    const ctx = await setup({}, s)
    const r = await call(ctx, { method: 'POST', url: '/payment', body: 'PK', contentType: 'application/vnd.etsi.asic-e+zip' })
    assert.equal(r.statusCode, 415)
  })

  test("a service provider acting for a customer: the contract's services, not the provider's own", async () => {
    const s = seed()
    const sp = s.customers.find((c) => c.code === SP.code)!
    sp.services = ['HEARTBEAT', 'ACCOUNT_STATEMENT']
    s.customers.push({ code: C3.code, country: C3.country, name: 'Demo Customer 3' })
    const ctx = await setup({}, s)
    // Seeded connections carry the P 14 sample services (decision 413).
    await check(ctx, SP.code, SP_FOR(C1), routes().map((r) => r.service))
    // The provider itself has only its own contract's services.
    await check(ctx, SP.code, SP_FOR(SP), ['HEARTBEAT', 'ACCOUNT_STATEMENT'])

    // A new contract takes the provider's configuration.
    const created = JSON.parse((await call(ctx, { method: 'POST', url: '/contracts', as: SP.code, headers: SP_FOR(SP), body: { companyCode: C3.code, companyCodeIssuer: 'EE' } })).body)
    const pending = JSON.parse((await call(ctx, { url: '/contracts', as: SP.code, headers: SP_FOR(SP) })).body)
    const c3 = pending.customers.find((c: any) => c.companyCode === C3.code)
    assert.deepEqual(c3.contracts[0].services.map((x: any) => x.name), ['HEARTBEAT', 'ACCOUNT_STATEMENT'])
    // Pending: no connection yet.
    assert.equal((await call(ctx, { url: '/heartbeat', as: SP.code, headers: SP_FOR(C3) })).statusCode, 403)
    assert.equal((await call(ctx, { method: 'POST', url: `/_sim/contracts/${created.contractId}/activate` })).statusCode, 200)
    await check(ctx, SP.code, SP_FOR(C3), ['HEARTBEAT', 'ACCOUNT_STATEMENT'])
  })
})
