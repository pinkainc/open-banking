// HttpRails end to end against a fake bridge (fastify on port 0) and the callback endpoint
// (railsCallbackApp on port 0): accepted then settled or rejected by callback, a bad HMAC
// refused, a repeated callback ignored, reachability false → SEPA, a bridge that is down,
// credits from the scheme, Faster Payments to sort code + account number (decisions 935–938).
import assert from 'node:assert/strict'
import { after, beforeEach, describe, test } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { many } from '../src/xml.js'
import { HttpRails, HMAC_HEADER, hmacMatches, railsCallbackApp, railsHmac } from '../src/rails-http.js'
import { FUNDING } from '../src/emulator.js'
import { C1, C2, DE_IBAN, FR_IBAN, balance, call, ddDrain, ddEntry, drain, pain001, pain008, setup, type Ctx, type TxSpec } from './helpers.js'

const SECRET = 'bridge-secret'

/** A bridge as the protocol describes it: checks our HMAC, keeps payments by ref, answers as told. */
class FakeBridge {
  readonly app: FastifyInstance = Fastify()
  readonly payments = new Map<string, any>()
  readonly calls: { path: string; hmacOk: boolean }[] = []
  answer: any = { status: 'accepted' }
  down = false
  noInstant = new Set<string>()
  url = ''
  constructor() {
    this.app.removeAllContentTypeParsers()
    this.app.addContentTypeParser('*', { parseAs: 'string' }, (_r, b, done) => done(null, b))
    const ok = (req: any) => {
      const good = hmacMatches(SECRET, typeof req.body === 'string' ? req.body : '', req.headers[HMAC_HEADER])
      this.calls.push({ path: req.url, hmacOk: good })
      return good
    }
    this.app.post('/v1/payments', async (req, reply) => {
      if (!ok(req)) return reply.code(401).send({ error: 'bad HMAC' })
      if (this.down) return reply.code(503).send({ error: 'down' })
      const p = JSON.parse(req.body as string)
      // Idempotent by ref: a repeat answers what the first got.
      if (!this.payments.has(p.ref)) this.payments.set(p.ref, { ...p, answer: this.answer })
      return this.payments.get(p.ref).answer
    })
    this.app.get('/v1/reachability/:iban', async (req, reply) => {
      if (!ok(req)) return reply.code(401).send({ error: 'bad HMAC' })
      if (this.down) return reply.code(503).send({ error: 'down' })
      return { instant: !this.noInstant.has((req.params as any).iban) }
    })
    this.app.post('/v1/collections', async (req, reply) => {
      if (!ok(req)) return reply.code(401).send({ error: 'bad HMAC' })
      const c = JSON.parse(req.body as string)
      return c.debtor.iban === DE_IBAN ? { status: 'rejected', code: 'AC04' } : { status: 'settled' }
    })
  }
  async start() { await this.app.listen({ port: 0, host: '127.0.0.1' }); this.url = `http://127.0.0.1:${(this.app.server.address() as any).port}/v1`; return this }
}

const bridge = await new FakeBridge().start()
const rails = new HttpRails({ url: bridge.url, secret: SECRET, retries: 1, retryDelayMs: 5, timeoutMs: 2000 })
const callbacks = railsCallbackApp(rails)
await callbacks.listen({ port: 0, host: '127.0.0.1' })
const callbackUrl = `http://127.0.0.1:${(callbacks.server.address() as any).port}/rails/events`
after(async () => { await callbacks.close(); await bridge.app.close() })

/** What the bridge does: POST our callback endpoint, signed. */
async function callback(event: object, secret = SECRET) {
  const body = JSON.stringify(event)
  const res = await fetch(callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json', [HMAC_HEADER]: railsHmac(secret, body) }, body })
  return { status: res.status, body: await res.json() as any }
}

let ctx: Ctx
beforeEach(async () => {
  bridge.payments.clear(); bridge.calls.length = 0; bridge.answer = { status: 'accepted' }; bridge.down = false; bridge.noInstant.clear()
  // A fresh emulator per test; it registers its engine with the shared HttpRails.
  ctx = await setup({ rails })
})

async function messages(as = C1.code) {
  const msgs = await drain(ctx, as)
  return {
    reports: msgs.filter((m) => m.type === 'PAYMENT').map((m) => many(m.doc.Document.CstmrPmtStsRpt.OrgnlPmtInfAndSts).flatMap((b: any) => many(b.TxInfAndSts))
      .map((t: any) => [t.TxSts as string, t.OrgnlTxRef?.PmtTpInf?.SvcLvl?.Prtry as string | undefined, t.StsRsnInf?.AddtlInf as string | undefined])),
    notes: msgs.filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION').map((m) => {
      const n = m.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn
      return [n.Ntry.CdtDbtInd as string, String(n.Ntry.Amt['#text'] ?? n.Ntry.Amt), n.Ntry.AcctSvcrRef as string]
    }),
  }
}
const pay = async (txs: TxSpec[]) => {
  const res = await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs }]) })
  assert.equal(res.statusCode, 202, res.body)
}
const available = async (iban: string) => (await call(ctx, { url: `/_sim/accounts/${iban}` })).json().balances.EUR.available as string
const onlyPayment = () => { assert.equal(bridge.payments.size, 1); return [...bridge.payments.values()][0] }

describe('HttpRails: payments through the bridge', () => {
  test('accepted, then settled by callback: ACSP, then ACSC + camt.054 DBIT', async () => {
    await pay([{ amount: '7.00', creditorIban: DE_IBAN, endToEndId: 'E2E-1', ustrd: 'Invoice 1' }])
    const p = onlyPayment()
    assert.deepEqual({ scheme: p.scheme, amount: p.amount, currency: p.currency, creditor: p.creditor.iban, debtor: p.debtor.iban, e2e: p.endToEndId, remittance: p.remittance },
      { scheme: 'INST', amount: '7.00', currency: 'EUR', creditor: DE_IBAN, debtor: C1.iban, e2e: 'E2E-1', remittance: 'Invoice 1' })
    assert.ok(bridge.calls.every((c) => c.hmacOk), 'every request signed')
    assert.deepEqual(bridge.calls.map((c) => c.path), [`/v1/reachability/${DE_IBAN}`, '/v1/payments'])
    assert.deepEqual((await messages()).reports, [[['ACSP', 'INST', undefined]]])
    assert.equal(await available(C1.iban), '9993.00')

    assert.deepEqual(await callback({ type: 'payment.outcome', ref: p.ref, outcome: { status: 'settled' } }), { status: 200, body: { applied: true } })
    const m = await messages()
    assert.deepEqual(m.reports, [[['ACSC', 'INST', undefined]]])
    assert.deepEqual(m.notes, [['DBIT', '7.00', p.ref]])
    assert.equal(await balance(ctx, C1.iban), '9993.00')
  })

  test('rejected by callback: RJCT with the reason, funds released', async () => {
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    await messages()
    const r = await callback({ type: 'payment.outcome', ref: onlyPayment().ref, outcome: { status: 'rejected', reason: 'Account closed.' } })
    assert.deepEqual(r.body, { applied: true })
    assert.deepEqual(await messages(), { reports: [[['RJCT', 'INST', 'Account closed.']]], notes: [] })
    assert.equal(await available(C1.iban), '10000.00')
  })

  test('a bad HMAC is refused 401 and changes nothing; the signed one then applies', async () => {
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    await messages()
    const event = { type: 'payment.outcome', ref: onlyPayment().ref, outcome: { status: 'settled' } }
    assert.equal((await callback(event, 'wrong-secret')).status, 401)
    const unsigned = await fetch(callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) })
    assert.equal(unsigned.status, 401)
    assert.deepEqual(await messages(), { reports: [], notes: [] })
    assert.equal(await balance(ctx, C1.iban), '10000.00')
    assert.deepEqual(await ctx.emulator.engine.atRails(), [event.ref])
    assert.equal((await callback(event)).body.applied, true)
    assert.equal((await messages()).notes.length, 1)
  })

  test('a repeated callback is ignored: 200 applied false, booked once', async () => {
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    await messages()
    const event = { type: 'payment.outcome', ref: onlyPayment().ref, outcome: { status: 'settled' } }
    assert.equal((await callback(event)).body.applied, true)
    assert.deepEqual(await callback(event), { status: 200, body: { applied: false } })
    assert.deepEqual(await callback({ ...event, outcome: { status: 'rejected', reason: 'late' } }), { status: 200, body: { applied: false } })
    assert.deepEqual((await messages()).notes.map((n) => n[0]), ['DBIT'])
    assert.equal(await balance(ctx, C1.iban), '9993.00')
  })

  test('callbacks outside the protocol: 400', async () => {
    assert.equal((await callback({ type: 'payment.outcome', ref: 'X' })).status, 400)
    assert.equal((await callback({ type: 'payment.outcome', ref: 'X', outcome: { status: 'accepted' } })).status, 400)
    assert.equal((await callback({ type: 'nonsense' })).status, 400)
    assert.equal((await callback({ type: 'credit', credit: { ref: 'C', iban: C2.iban, amount: '1.234', currency: 'EUR', scheme: 'SEPA' } })).status, 400)
    assert.equal((await callback({ type: 'credit', credit: { ref: 'C', iban: C2.iban, amount: '1.00', currency: 'EUR', scheme: 'ACH' } })).status, 400)
  })

  test('reachability false: automatic SEPA; requested INST refused before the rails', async () => {
    bridge.noInstant.add(DE_IBAN)
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    assert.equal(onlyPayment().scheme, 'SEPA')
    assert.deepEqual((await messages()).reports, [[['ACSP', 'SEPA', undefined]]])
    await pay([{ amount: '1.00', creditorIban: DE_IBAN, scheme: 'INST' }])
    assert.deepEqual((await messages()).reports, [[['RJCT', undefined, 'Instant payment forbidden, try European payment.']]])
    assert.equal(bridge.payments.size, 1)
  })

  test('an INST accepted, then unavailable by callback: ACWC and SEPA sent again (same ref), settled', async () => {
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    await messages()
    const ref = onlyPayment().ref
    // The bridge keeps the INST attempt under its ref; the SEPA attempt reuses the ref, so it answers anew.
    bridge.payments.clear()
    assert.equal((await callback({ type: 'payment.outcome', ref, outcome: { status: 'unavailable' } })).body.applied, true)
    assert.deepEqual((await messages()).reports, [[['ACWC', 'SEPA', 'Payment processed as European payment']]])
    assert.equal(onlyPayment().scheme, 'SEPA')
    assert.equal(onlyPayment().ref, ref)
    await callback({ type: 'payment.outcome', ref, outcome: { status: 'settled' } })
    assert.deepEqual((await messages()).reports, [[['ACSC', 'SEPA', undefined]]])
  })

  test('the bridge answers at once: settled is booked without a callback', async () => {
    bridge.answer = { status: 'settled' }
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    const m = await messages()
    assert.deepEqual(m.reports, [[['ACSP', 'INST', undefined]], [['ACSC', 'INST', undefined]]])
    assert.equal(m.notes.length, 1)
  })

  test('the bridge is down (5xx, retried): not reachable → SEPA, unavailable → RJCT "Technical problem", released', async () => {
    bridge.down = true
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    assert.deepEqual((await messages()).reports, [[['ACSP', 'SEPA', undefined]], [['RJCT', 'SEPA', 'Technical problem. Try again']]])
    assert.equal(bridge.calls.filter((c) => c.path === '/v1/payments').length, 2, 'one retry')
    assert.equal(await available(C1.iban), '10000.00')
  })
})

describe('HttpRails: credits from the scheme', () => {
  const credit = (ref: string, iban = C2.iban) => callback({ type: 'credit', credit: {
    ref, iban, amount: '12.34', currency: 'EUR', scheme: 'INST', debtor: { name: 'Hans Muster', iban: DE_IBAN, bic: 'COBADEFFXXX' }, remittance: 'Invoice 7',
  } })

  test('booked once per ref: camt.054 CRDT; a repeat answers the same AcctSvcrRef', async () => {
    const r = await credit('SCT-1')
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'booked')
    assert.deepEqual(await credit('SCT-1'), r)
    assert.deepEqual((await messages(C2.code)).notes, [['CRDT', '12.34', r.body.servicerRef]])
    assert.equal(await balance(ctx, C2.iban), '112.34')
  })

  test('an account not here: returned AC01', async () => {
    assert.deepEqual((await credit('SCT-2', 'EE127700771001260999')).body, { status: 'returned', code: 'AC01', reason: 'Incorrect account number.' })
  })
})

describe('HttpRails: R-transactions after settlement and recalls (decisions 1000, 1001)', () => {
  test('collection.returned: a collection the bridge settled is debited back once; unknown false; 400 outside the protocol', async () => {
    const xml = pain008([{ txs: [{ debtorIban: FR_IBAN, debtorBic: 'SATPFRP0', endToEndId: 'E2E-RT', instrId: 'INSTR-RT', amount: '30.00' }] }])
    assert.equal((await call(ctx, { method: 'POST', url: '/direct-debit/collection', body: xml })).statusCode, 202)
    ctx.clock.set('2026-03-12T10:30:00Z')
    assert.equal(await ctx.emulator.directDebit.tick(), 1)
    const [c] = await ctx.emulator.directDebit.collections()
    assert.equal(c.status, 'SETTLED')
    await ddDrain(ctx)
    assert.equal(await balance(ctx, C1.iban), '10030.00')
    assert.deepEqual(await callback({ type: 'collection.returned', ref: c.id, code: 'MD06' }), { status: 200, body: { applied: true } })
    const [m] = await ddDrain(ctx)
    const e = ddEntry(m)
    assert.deepEqual([e.ind, e.amount, e.returnInfo], ['DBIT', '30.00', ['INSTR-RT', 'CD:MD06']])
    assert.deepEqual(await callback({ type: 'collection.returned', ref: c.id, code: 'MD06' }), { status: 200, body: { applied: false } }, 'a repeat')
    assert.deepEqual(await callback({ type: 'collection.returned', ref: 'NO-SUCH', code: 'MD06' }), { status: 200, body: { applied: false } })
    assert.equal((await callback({ type: 'collection.returned', ref: c.id, code: 'md6' })).status, 400)
    assert.equal(await balance(ctx, C1.iban), '10000.00')
  })

  test('collection.returned without the funds: 503 (the bridge retries), nothing booked', async () => {
    const xml = pain008([{ txs: [{ debtorIban: FR_IBAN, debtorBic: 'SATPFRP0', endToEndId: 'E2E-RF', amount: '30.00' }] }])
    assert.equal((await call(ctx, { method: 'POST', url: '/direct-debit/collection', body: xml })).statusCode, 202)
    ctx.clock.set('2026-03-12T10:30:00Z')
    await ctx.emulator.directDebit.tick()
    const [c] = await ctx.emulator.directDebit.collections()
    await ctx.emulator.ledger.transfer({ ref: 'drain', from: C1.iban, to: FUNDING, amount: 1000001n, currency: 'EUR' })
    const r = await callback({ type: 'collection.returned', ref: c.id, code: 'MD01' })
    assert.equal(r.status, 503)
    assert.equal(r.body.retry, true)
    assert.equal((await ctx.emulator.directDebit.collections())[0].status, 'SETTLED')
  })

  test('credit.recall: DUPL returned (camt.054 DBIT), CUST refused NOAS, unknown NOOR, a repeat the first answer', async () => {
    const credit = (ref: string) => callback({ type: 'credit', credit: { ref, iban: C2.iban, amount: '5.00', currency: 'EUR', scheme: 'SEPA', debtor: { name: 'Hans Muster', iban: DE_IBAN } } })
    const recall = (ref: string, code: string) => callback({ type: 'credit.recall', recall: { ref, recallRef: `CXL-${ref}`, code } })
    assert.equal((await credit('SCT-R1')).body.status, 'booked')
    assert.equal((await credit('SCT-R2')).body.status, 'booked')
    await messages(C2.code)
    const r = await recall('SCT-R1', 'DUPL')
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'returned')
    assert.deepEqual((await messages(C2.code)).notes, [['DBIT', '5.00', r.body.servicerRef]])
    assert.deepEqual(await recall('SCT-R1', 'DUPL'), r)
    assert.deepEqual((await recall('SCT-R2', 'CUST')).body, { status: 'refused', code: 'NOAS' })
    assert.deepEqual((await recall('SCT-NONE', 'TECH')).body, { status: 'refused', code: 'NOOR' })
    assert.equal((await callback({ type: 'credit.recall', recall: { ref: 'SCT-R2', code: 'DUPL' } })).status, 400)
    assert.equal(await balance(ctx, C2.iban), '105.00')
  })
})

describe('HttpRails: the other calls', () => {
  test('Faster Payments to sort code + account number: both given to the bridge', async () => {
    const a = await rails.send({ ref: 'FP-1', scheme: 'FAST', amount: 101n, currency: 'GBP', debtor: { iban: 'GB20LHVB04031512345678' }, creditor: { name: 'Business Customer', account: '04032510097184' } })
    assert.deepEqual(a, { status: 'accepted' })
    const p = bridge.payments.get('FP-1')
    assert.deepEqual({ scheme: p.scheme, amount: p.amount, creditor: p.creditor }, {
      scheme: 'FAST', amount: '1.01', creditor: { name: 'Business Customer', account: '04032510097184', sortCode: '040325', accountNumber: '10097184' },
    })
    // The same ref again: the bridge's first answer, one payment.
    bridge.answer = { status: 'settled' }
    assert.deepEqual(await rails.send({ ref: 'FP-1', scheme: 'FAST', amount: 101n, currency: 'GBP', debtor: { iban: 'GB20LHVB04031512345678' }, creditor: { account: '04032510097184' } }), { status: 'accepted' })
  })

  test('collections: settled, or the R-transaction code at presentation', async () => {
    const c = { ref: 'DD-1', amount: 500n, currency: 'EUR', creditor: { iban: C1.iban }, endToEndId: 'E', settlementDate: '2026-03-12' }
    assert.deepEqual(await rails.collect({ ...c, debtor: { iban: 'FR7618206000103056966400117' } }), { status: 'settled' })
    assert.deepEqual(await rails.collect({ ...c, ref: 'DD-2', debtor: { iban: DE_IBAN } }), { status: 'rejected', code: 'AC04' })
  })

  test('requests with a wrong secret are refused by the bridge: unavailable, not reachable', async () => {
    const wrong = new HttpRails({ url: bridge.url, secret: 'other', retries: 0 })
    assert.deepEqual(await wrong.send({ ref: 'W-1', scheme: 'SEPA', amount: 1n, currency: 'EUR', debtor: { iban: C1.iban }, creditor: { iban: DE_IBAN } }), { status: 'unavailable' })
    assert.equal(await wrong.instantReachable(DE_IBAN), false)
    assert.equal(bridge.payments.has('W-1'), false)
  })
})
