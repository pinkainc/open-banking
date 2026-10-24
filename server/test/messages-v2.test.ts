// S4b, the UK host's messages V2 family and requests API (decisions 620–632): GET
// /v2/messages (pages, filters, includeProcessed, metadata), PATCH /v2/messages/processed
// (delete, undelete, archive) as a view of the same inbox as v1, GET /v2/requests and GET
// /v2/requests/{id} (the request as submitted, recorded by every 202), GET
// /messages/test/next without mockLargeMessage, and the UK list time. Every JSON answer is
// checked with ajv against ssot/json-schemas; G samples are replayed.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { DAY_MS } from '../src/clock.js'
import { messageMetadata } from '../src/metadata.js'
import { C1, C2, MIRROR_DIR, SP, call, camt060, drain, jsonInvalid, jsonValid, pain001, schemaValid, setup, type Ctx } from './helpers.js'

const G = 'docs/gitbook/connect/services/messages'
/** The fenced blocks of a G messages page (any language tag), in order. */
function gBlocks(page: string): string[] {
  const p = join(MIRROR_DIR, G, page)
  if (!existsSync(p)) return []
  return [...readFileSync(p, 'utf8').matchAll(/(`{3,4})(\w*)\n([\s\S]*?)\1/g)].map((m) => m[3])
}

const SP_OWN = { 'Client-Code': SP.code, 'Client-Country': 'EE' }
const SP_FOR = (c: { code: string }) => ({ 'Client-Code': c.code, 'Client-Country': 'EE' })

let ctx: Ctx
beforeEach(async () => { ctx = await setup({}, undefined, { flavour: 'UK' }) })

/** Puts a message in a customer's inbox, one second after the previous one. */
function put(type = 'PAYMENT', customer: { code: string; country: string } = C1, requestId?: string, body = '<x/>') {
  ctx.clock.advance(1000)
  return ctx.emulator.inbox.add({ customer, type, body, requestId })
}

async function v2(query = '', as = C1.code, headers: Record<string, string> = {}) {
  const r = await call(ctx, { url: `/v2/messages${query}`, as, headers })
  if (r.statusCode === 204) { assert.equal(r.body, ''); return undefined }
  assert.equal(r.statusCode, 200, r.body)
  assert.match(String(r.headers['content-type']), /^application\/json/)
  return jsonValid('messages-list-v2.response', r.body)
}

const patch = (body: unknown, as = C1.code, headers: Record<string, string> = {}) =>
  call(ctx, { method: 'PATCH', url: '/v2/messages/processed', as, headers, ...(typeof body === 'string' ? { body, contentType: 'application/json' } : { body: body as object }) })
const mark = (processed: boolean, ...ids: string[]) => patch({ messages: ids.map((messageResponseId) => ({ messageResponseId, messageProcessed: processed })) })
const nextId = async (as = C1.code) => (await call(ctx, { url: '/messages/next', as })).headers['message-response-id']
const BAD = (description: string) => ({ errors: [{ errorCode: 'BAD_REQUEST', description }] })

describe('host flavour (decision 620)', () => {
  test('the EE host has no v2 routes: 404', async () => {
    const ee = await setup()
    for (const r of [{ url: '/v2/messages' }, { url: '/v2/requests' }, { url: '/v2/requests/REQ1' },
      { method: 'PATCH', url: '/v2/messages/processed', body: { messages: [] } }]) {
      assert.equal((await call(ee, r)).statusCode, 404, r.url)
    }
  })
  test('v2 asks for a certificate like every route: 403 XML without one', async () => {
    const r = await call(ctx, { url: '/v2/messages', as: null })
    assert.equal(r.statusCode, 403)
    assert.match(r.body, /<ErrorCode>FORBIDDEN<\/ErrorCode>/)
  })
})

describe('GET /v2/messages', () => {
  test('the G samples satisfy the ssot schema', () => {
    const samples = gBlocks('get-list-of-messages-1.md').filter((b) => b.trimStart().startsWith('{') && !b.includes('....') && !b.includes('```'))
    for (const s of samples) jsonValid('messages-list-v2.response', s)
    if (existsSync(join(MIRROR_DIR, G))) assert.ok(samples.length >= 1)
  })

  test('empty is 204', async () => {
    assert.equal(await v2(), undefined)
  })

  test('shape as the G sample: paging fields, UK time with offset, bankCode, no messageProcessed or metadata by default', async () => {
    const a = put('ACCOUNT_STATEMENT', C1, 'REQ06d2e575a6c94061b7235ca160350680')
    const b = put('CREDIT_DEBIT_NOTIFICATION')
    const body = await v2()
    assert.deepEqual(body, {
      pageNumber: 1, pageSize: 100, totalPages: 1, totalElements: 2,
      messages: [
        { messageResponseId: a.id, messageRequestId: 'REQ06d2e575a6c94061b7235ca160350680', messageResponseType: 'ACCOUNT_STATEMENT', clientCode: C1.code, clientCountry: 'EE', messageCreatedTime: '2026-03-10T08:00:01.000+00:00', bankCode: 'LHVUK' },
        { messageResponseId: b.id, messageResponseType: 'CREDIT_DEBIT_NOTIFICATION', clientCode: C1.code, clientCountry: 'EE', messageCreatedTime: '2026-03-10T08:00:02.000+00:00', bankCode: 'LHVUK' },
      ],
    })
    // The key order of the G sample.
    assert.deepEqual(Object.keys(body.messages[0]), ['messageResponseId', 'messageRequestId', 'messageResponseType', 'clientCode', 'clientCountry', 'messageCreatedTime', 'bankCode'])
  })

  test('UK summer time: +01:00', async () => {
    ctx.clock.set(new Date('2026-06-24T11:04:02.791Z'))
    put()
    assert.equal((await v2()).messages[0].messageCreatedTime, '2026-06-24T12:04:03.791+01:00')
  })

  test('pages: pageSize and 1-based pageNumber, 204 past the last page', async () => {
    const ids = [1, 2, 3, 4, 5].map(() => put().id)
    const p1 = await v2('?pageSize=2')
    assert.deepEqual([p1.pageNumber, p1.pageSize, p1.totalPages, p1.totalElements], [1, 2, 3, 5])
    assert.deepEqual(p1.messages.map((m: any) => m.messageResponseId), ids.slice(0, 2))
    const p3 = await v2('?pageSize=2&pageNumber=3')
    assert.deepEqual(p3.messages.map((m: any) => m.messageResponseId), ids.slice(4))
    assert.equal(await v2('?pageSize=2&pageNumber=4'), undefined)
    // Listing does not consume.
    assert.equal(await nextId(), ids[0])
  })

  test('pageSize above 1000 is served as 1000; invalid paging and booleans are 400 JSON', async () => {
    put()
    assert.equal((await v2('?pageSize=5000')).pageSize, 1000)
    for (const q of ['?pageSize=0', '?pageSize=abc', '?pageNumber=0', '?pageNumber=-1', '?includeProcessed=yes', '?includeMetadata=2', '?serviceProvider=maybe']) {
      const r = await call(ctx, { url: `/v2/messages${q}` })
      assert.equal(r.statusCode, 400, q)
      const e = JSON.parse(r.body)
      assert.equal(e.errors[0].errorCode, 'BAD_REQUEST', q)
    }
  })

  test('responseType and messageRequestId filters', async () => {
    const a = put('PAYMENT', C1, 'REQa')
    put('PAYMENT', C1, 'REQb')
    put('ACCOUNT_BALANCE', C1, 'REQa')
    assert.deepEqual((await v2('?responseType=ACCOUNT_BALANCE')).messages.map((m: any) => m.messageResponseType), ['ACCOUNT_BALANCE'])
    assert.deepEqual((await v2('?messageRequestId=REQa&responseType=PAYMENT')).messages.map((m: any) => m.messageResponseId), [a.id])
    assert.equal((await v2('?messageRequestId=REQa')).totalElements, 2)
    assert.equal(await v2('?responseType=HEARTBEAT'), undefined)
  })

  test('service provider: own value lists its customers too; serviceProvider=true only its own; Client-Code one customer', async () => {
    const own = put('PAYMENT', SP)
    const c1 = put('PAYMENT', C1)
    const c2 = put('PAYMENT', C2)
    const ids = async (q: string, h: Record<string, string>) => ((await v2(q, SP.code, h))?.messages ?? []).map((m: any) => m.messageResponseId)
    assert.deepEqual(await ids('', SP_OWN), [own.id, c1.id, c2.id])
    assert.deepEqual(await ids('?serviceProvider=true', SP_OWN), [own.id])
    assert.deepEqual(await ids('', { ...SP_OWN, 'Filter-Service-Provider': 'true' }), [own.id])
    assert.deepEqual(await ids('', SP_FOR(C2)), [c2.id])
    assert.deepEqual(await ids('?serviceProvider=true', SP_FOR(C2)), [])
    // Customers do not see each other's messages.
    assert.deepEqual((await v2('', C2.code)).messages.map((m: any) => m.messageResponseId), [c2.id])
  })
})

describe('v1 and v2 share one inbox (decision 620)', () => {
  test('includeProcessed: a v1 DELETE is messageProcessed=true in v2, in creation order', async () => {
    const a = put()
    const b = put()
    assert.equal((await call(ctx, { method: 'DELETE', url: `/messages/${a.id}` })).statusCode, 200)
    assert.deepEqual((await v2()).messages.map((m: any) => m.messageResponseId), [b.id])
    const all = await v2('?includeProcessed=true')
    assert.deepEqual(all.messages.map((m: any) => [m.messageResponseId, m.messageProcessed]), [[a.id, true], [b.id, false]])
    assert.equal(all.totalElements, 2)
    assert.deepEqual(Object.keys(all.messages[0]).slice(3, 5), ['clientCountry', 'messageProcessed'])
  })

  test('PATCH true deletes as v1 DELETE does: v1 no longer serves it, a repeat DELETE is 200', async () => {
    const a = put()
    const b = put()
    const r = await mark(true, a.id)
    assert.equal(r.statusCode, 204)
    assert.equal(r.body, '')
    assert.equal(await nextId(), b.id)
    assert.equal((await call(ctx, { url: '/messages/count' })).body, '{"count":1}')
    assert.equal((await call(ctx, { url: `/messages/${a.id}` })).statusCode, 404)
    assert.equal((await call(ctx, { method: 'DELETE', url: `/messages/${a.id}` })).statusCode, 200)
    // Marking it processed again is accepted too.
    assert.equal((await mark(true, a.id)).statusCode, 204)
  })

  test('PATCH false undeletes a message deleted with v1: next serves it again, in its old place', async () => {
    const a = put()
    const b = put()
    await call(ctx, { method: 'DELETE', url: `/messages/${a.id}` })
    assert.equal(await nextId(), b.id)
    assert.equal((await mark(false, a.id)).statusCode, 204)
    assert.equal(await nextId(), a.id)
    assert.deepEqual((await v2('?includeProcessed=true')).messages.map((m: any) => m.messageProcessed), [false, false])
    // false on a pending message changes nothing.
    assert.equal((await mark(false, b.id)).statusCode, 204)
    assert.equal((await call(ctx, { url: '/messages/count' })).body, '{"count":2}')
  })

  test('the G samples replayed: unknown ids are 400 with the G text, and nothing is updated', async () => {
    const blocks = gBlocks('mark-batch-of-messages-as-processed-1.md').filter((b) => b.includes('"messages"'))
    if (existsSync(join(MIRROR_DIR, G))) assert.equal(blocks.length, 2)
    for (const raw of blocks) {
      const sample = JSON.parse(raw)
      jsonValid('messages-processed-v2.request', sample)
      const r = await patch(raw)
      assert.equal(r.statusCode, 400)
      assert.deepEqual(JSON.parse(r.body), BAD(`Invalid Message-Request-Id: ${sample.messages[0].messageResponseId}`))
    }
    // The documented error sample's shape.
    const err = gBlocks('mark-batch-of-messages-as-processed-1.md').find((b) => b.includes('"errors"'))
    if (err) assert.deepEqual(Object.keys(JSON.parse(err).errors[0]), ['errorCode', 'description'])
    // The sample with our own ids: 204, all three processed.
    const ids = [put().id, put().id, put().id]
    const own = JSON.parse(blocks[1] ?? '{"messages":[{},{},{}]}')
    own.messages.forEach((m: any, i: number) => { m.messageResponseId = ids[i]; m.messageProcessed = true })
    assert.equal((await patch(JSON.stringify(own, null, '\t'))).statusCode, 204)
    assert.equal((await call(ctx, { url: '/messages/next' })).statusCode, 204)
  })

  test('all or nothing: one unknown id among valid ones changes none', async () => {
    const a = put()
    const r = await patch({ messages: [{ messageResponseId: a.id, messageProcessed: true }, { messageResponseId: 'RESnope', messageProcessed: true }] })
    assert.equal(r.statusCode, 400)
    assert.deepEqual(JSON.parse(r.body), BAD('Invalid Message-Request-Id: RESnope'))
    assert.equal(await nextId(), a.id)
  })

  test("another customer's message is unknown", async () => {
    const a = put('PAYMENT', C2)
    assert.equal((await mark(true, a.id)).statusCode, 400)
    assert.equal(await nextId(C2.code), a.id)
  })

  test('malformed bodies are 400 JSON errors', async () => {
    const cases: [unknown, string][] = [
      ['{"messages": [', ''], ['', ''], [{}, 'messages must be a non-empty array'], [{ messages: [] }, 'messages must be a non-empty array'],
      [{ messages: [{ messageProcessed: true }] }, 'messages[0].messageResponseId must be a string'],
      [{ messages: [{ messageResponseId: 'RES1' }] }, 'messages[0].messageProcessed must be true or false'],
      [{ messages: [{ messageResponseId: 'RES1', messageProcessed: 'true' }] }, 'messages[0].messageProcessed must be true or false'],
      [[1], 'messages must be a non-empty array'],
    ]
    for (const [body, text] of cases) {
      // The schema has no minItems: an empty list is schema-valid, refused by the server.
      if (typeof body !== 'string' && !(Array.isArray((body as any).messages) && (body as any).messages.length === 0)) jsonInvalid('messages-processed-v2.request', body)
      const r = await patch(body)
      assert.equal(r.statusCode, 400, JSON.stringify(body))
      const e = JSON.parse(r.body).errors[0]
      assert.equal(e.errorCode, 'BAD_REQUEST')
      if (text) assert.equal(e.description, text)
    }
    const many = { messages: Array.from({ length: 1001 }, (_, i) => ({ messageResponseId: `RES${i}`, messageProcessed: true })) }
    assert.deepEqual(JSON.parse((await patch(many)).body), BAD('At most 1000 messages can be updated at once'))
  })

  test('a week after creation a processed message is archived: no undelete, no longer listed', async () => {
    const a = put()
    ctx.clock.advance(3 * DAY_MS)
    await mark(true, a.id)
    ctx.clock.advance(4 * DAY_MS - 1)
    assert.equal((await v2('?includeProcessed=true')).messages[0].messageProcessed, true)
    ctx.clock.advance(1)
    assert.equal(await v2('?includeProcessed=true'), undefined)
    const r = await mark(false, a.id)
    assert.equal(r.statusCode, 400)
    assert.deepEqual(JSON.parse(r.body), BAD(`Message ${a.id} is archived and cannot be undeleted`))
    // Deleting it again is still fine while the tombstone lives (five days after the confirmation).
    assert.equal((await mark(true, a.id)).statusCode, 204)
  })

  test('an undeleted message has five days again from the undelete', async () => {
    const a = put()
    ctx.clock.advance(4 * DAY_MS)
    await mark(true, a.id)
    ctx.clock.advance(2 * DAY_MS)
    assert.equal((await mark(false, a.id)).statusCode, 204)
    ctx.clock.advance(5 * DAY_MS)
    assert.equal(await nextId(), a.id)
    ctx.clock.advance(1)
    assert.equal((await call(ctx, { url: '/messages/next' })).statusCode, 204)
  })

  test('expired unread messages are not listed as processed', async () => {
    put()
    ctx.clock.advance(5 * DAY_MS + 1)
    assert.equal(await v2('?includeProcessed=true'), undefined)
  })
})

describe('metadata (decision 623)', () => {
  test('only with includeMetadata=true; a message type without fields has none (G HEARTBEAT sample)', async () => {
    const hb = await call(ctx, { url: '/heartbeat/mq' })
    assert.equal(hb.statusCode, 202)
    const plain = await v2()
    assert.equal(plain.messages[0].metadata, undefined)
    const withMeta = await v2('?includeMetadata=true')
    assert.equal(withMeta.messages[0].messageResponseType, 'HEARTBEAT')
    assert.equal('metadata' in withMeta.messages[0], false)
  })

  test('payment: pain.002 group and payments, camt.054 of the booking', async () => {
    const r = await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '1.00', creditorIban: C2.iban }] }], { msgId: 'META-1' }) })
    assert.equal(r.statusCode, 202, r.body)
    const id = r.headers['message-request-id']
    const list = (await v2('?includeMetadata=true')).messages
    const pay = list.find((m: any) => m.messageResponseType === 'PAYMENT' && m.messageRequestId === id)
    assert.equal(pay.metadata.OrgnlMsgId, 'META-1')
    assert.ok(pay.metadata.Payments.length >= 1)
    const p = pay.metadata.Payments.at(-1)
    assert.equal(p['DebtorAcct.IBAN'], C1.iban)
    assert.equal(p['CreditorAcct.IBAN'], C2.iban)
    assert.match(p.TxSts, /^(ACSP|ACSC)$/)
    const note = list.find((m: any) => m.messageResponseType === 'CREDIT_DEBIT_NOTIFICATION')
    assert.ok(note, JSON.stringify(list.map((m: any) => m.messageResponseType)))
    assert.equal(note.metadata['Acct.IBAN'], C1.iban)
    assert.equal(note.metadata.CdtDbtInd, 'DBIT')
    assert.equal(note.metadata['CdtrAcct.IBAN'], C2.iban)
    assert.match(note.metadata.AcctSvcrRef, /^[0-9A-F]{32}$/)
  })

  test('account balance (camt.052 Reports) and statement (camt.053 Statements), bodies XSD-valid', async () => {
    for (const kind of ['balance', 'statement'] as const) {
      const r = await call(ctx, { method: 'POST', url: `/account-${kind}`, body: camt060({ kind, frDt: kind === 'statement' ? '2026-03-09' : undefined, toDt: kind === 'statement' ? '2026-03-09' : undefined }) })
      assert.equal(r.statusCode, 202, r.body)
    }
    const list = (await v2('?includeMetadata=true')).messages
    const bal = list.find((m: any) => m.messageResponseType === 'ACCOUNT_BALANCE')
    assert.deepEqual(bal.metadata.Reports[0], { 'Acct.IBAN': C1.iban, 'Acct.Ccy': 'EUR' })
    const st = list.find((m: any) => m.messageResponseType === 'ACCOUNT_STATEMENT')
    assert.equal(st.metadata.Statements[0]['Acct.IBAN'], C1.iban)
    assert.equal(st.metadata.Statements[0]['Acct.Ccy'], 'EUR')
    // The bodies these came from (read through v1, which checks every camt.052/053 with its XSD).
    const bodies = await drain(ctx)
    assert.ok(bodies.some((m) => m.type === 'ACCOUNT_BALANCE') && bodies.some((m) => m.type === 'ACCOUNT_STATEMENT'))
    for (const m of bodies) await schemaValid(m.body)
  })

  test('VIBAN, CoP and camt.053 entry totals from bodies', () => {
    const msg = (type: string, body: string, contentType = 'application/xml') =>
      ({ id: 'RES1', type, clientCode: C1.code, clientCountry: 'EE', createdAt: new Date(), body, contentType, seq: 1 })
    assert.deepEqual(messageMetadata(msg('VIBAN_OPEN', '<?xml version="1.0"?><VibanOpenResponse><MasterAccount>EE1</MasterAccount><ClientReference>R</ClientReference><VirtualIBAN>EE2</VirtualIBAN><Status>ACTIVE</Status></VibanOpenResponse>')),
      { MasterAccount: 'EE1', VirtualIBAN: 'EE2', ClientReference: 'R', Status: 'ACTIVE' })
    assert.deepEqual(messageMetadata(msg('CONFIRMATION_OF_PAYEE', JSON.stringify({ OriginalMessageId: 'REQ1', Data: { ReasonCode: 'ANNM', Description: 'No match' }, Errors: null }), 'application/json')),
      { OriginalMessageId: 'REQ1', ReasonCode: 'ANNM', Description: 'No match' })
    const stmt = '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Acct><Id><IBAN>EE1</IBAN></Id><Ccy>EUR</Ccy></Acct><TxsSummry><TtlCdtNtries><NbOfNtries>2</NbOfNtries></TtlCdtNtries><TtlDbtNtries><NbOfNtries>1</NbOfNtries></TtlDbtNtries></TxsSummry></Stmt><Stmt><Acct><Id><IBAN>EE1</IBAN></Id><Ccy>USD</Ccy></Acct></Stmt></BkToCstmrStmt></Document>'
    assert.deepEqual(messageMetadata(msg('ACCOUNT_STATEMENT', stmt)), { Statements: [
      { 'Acct.IBAN': 'EE1', 'Acct.Ccy': 'EUR', 'TtlCdtNtries.NbOfNtries': '2', 'TtlDbtNtries.NbOfNtries': '1' }, { 'Acct.IBAN': 'EE1', 'Acct.Ccy': 'USD' }] })
    assert.equal(messageMetadata(msg('ACCOUNT_STATEMENT', '<Errors><Error><ErrorCode>X</ErrorCode></Error></Errors>')), undefined)
    assert.equal(messageMetadata(msg('FX_TRADE_OFFER', '{}', 'application/json')), undefined)
  })
})

describe('GET /v2/requests and /v2/requests/{id} (decisions 630–632)', () => {
  const requests = async (query = '', as = C1.code, headers: Record<string, string> = {}) => {
    const r = await call(ctx, { url: `/v2/requests${query}`, as, headers })
    if (r.statusCode === 204) return undefined
    assert.equal(r.statusCode, 200, r.body)
    return jsonValid('requests-list-v2.response', r.body)
  }

  test('the G request sample (camt.060.001.03) comes back exactly as submitted, with its Content-Type', async () => {
    const sample = gBlocks('get-request-by-request-id.md').find((b) => b.includes('camt.060.001.03'))
      ?? camt060({ version: '03' })
    const r = await call(ctx, { method: 'POST', url: '/account-statement', body: sample, contentType: 'application/xml; charset=utf-8' })
    assert.equal(r.statusCode, 202)
    const id = r.headers['message-request-id'] as string
    const got = await call(ctx, { url: `/v2/requests/${id}` })
    assert.equal(got.statusCode, 200)
    assert.equal(got.body, sample)
    assert.equal(got.headers['content-type'], 'application/xml; charset=utf-8')
    assert.equal(got.headers['x-bank-code'], 'LHVUK')
  })

  test('a JSON request is kept as raw text (whitespace and key order included)', async () => {
    const raw = '{\n  "Name": "Account Name Ltd",\n  "Identification": "04000412345678",   "AccountCategory": "BUSINESS"\n}'
    const r = await call(ctx, { method: 'POST', url: '/payment/cop-request', body: raw, contentType: 'application/json' })
    assert.equal(r.statusCode, 202)
    const got = await call(ctx, { url: `/v2/requests/${r.headers['message-request-id']}` })
    assert.equal(got.body, raw)
    assert.match(String(got.headers['content-type']), /^application\/json/)
  })

  test("unknown, someone else's or forgotten (five days) is 204", async () => {
    assert.equal((await call(ctx, { url: '/v2/requests/REQ00000000000000000000000000000000' })).statusCode, 204)
    const r = await call(ctx, { method: 'POST', url: '/account-balance', body: camt060({ kind: 'balance' }) })
    const id = r.headers['message-request-id'] as string
    assert.equal((await call(ctx, { url: `/v2/requests/${id}`, as: C2.code })).statusCode, 204)
    assert.equal((await call(ctx, { url: `/v2/requests/${id}`, as: SP.code, headers: SP_FOR(C2) })).statusCode, 204)
    assert.equal((await call(ctx, { url: `/v2/requests/${id}`, as: SP.code, headers: SP_FOR(C1) })).statusCode, 200)
    ctx.clock.advance(5 * DAY_MS)
    assert.equal((await call(ctx, { url: `/v2/requests/${id}` })).statusCode, 204)
    assert.equal(await requests(), undefined)
  })

  test('every 202 is recorded with its response type; the list is the G shape, oldest first', async () => {
    const posts: [string, string | object | undefined, string, string?][] = [
      ['/heartbeat/mq', undefined, 'HEARTBEAT'],
      ['/payment', pain001([{ txs: [{ amount: '1.00' }] }]), 'PAYMENT'],
      ['/account-balance', camt060({ kind: 'balance' }), 'ACCOUNT_BALANCE'],
      ['/account-statement', camt060(), 'ACCOUNT_STATEMENT'],
      ['/viban/info', '<VibanInfoRequest><MasterAccount>x</MasterAccount><VirtualIBAN>y</VirtualIBAN></VibanInfoRequest>', 'VIBAN_INFO'],
      ['/fx/trade-offer', {}, 'FX_TRADE_OFFER', 'LHVEE'],
      ['/payment/vop-request', {}, 'VERIFICATION_OF_PAYEE'],
      ['/payment/cop-request', {}, 'CONFIRMATION_OF_PAYEE'],
      ['/verification-of-payee', '<VerificationOfPayeeRequest/>', 'VERIFICATION_OF_PAYEE', 'LHVEE'],
    ]
    const ids: string[] = []
    for (const [url, body, , bank] of posts) {
      ctx.clock.advance(1000)
      // FX is LHV EE's: the UK host reaches it with X-Bank-Code: LHVEE (decision 701).
      const headers: Record<string, string> = bank === 'LHVEE' ? { 'x-bank-code': 'LHVEE' } : {}
      const r = await call(ctx, { method: url === '/heartbeat/mq' ? 'GET' : 'POST', url, body, headers })
      assert.equal(r.statusCode, 202, `${url}: ${r.body}`)
      ids.push(r.headers['message-request-id'] as string)
    }
    const list = await requests()
    assert.deepEqual(list.messages.map((m: any) => [m.messageRequestId, m.messageResponseType, m.bankCode]),
      posts.map(([, , type, bank], i) => [ids[i], type, bank ?? 'LHVUK']))
    assert.deepEqual(list.messages[0], {
      messageRequestId: ids[0], messageResponseType: 'HEARTBEAT', clientCode: C1.code, clientCountry: 'EE',
      messageCreatedTime: '2026-03-10T08:00:01.000+00:00', bankCode: 'LHVUK',
    })
    // The G list sample has the same keys.
    const g = gBlocks('get-list-of-requests.md')[0]
    if (g) {
      const keys = /\{\s*"messageRequestId"[\s\S]*?\}/.exec(g)![0]
      assert.deepEqual(Object.keys(list.messages[0]), Object.keys(JSON.parse(keys)))
    }
  })

  test('the answer to EE VoP on the UK host is LHV EE\'s: not in /v2/messages, still read with v1 (decision 607)', async () => {
    const r = await call(ctx, { method: 'POST', url: '/verification-of-payee', body: '<VerificationOfPayeeRequest/>' })
    assert.equal(r.headers['x-bank-code'], 'LHVEE')
    put('PAYMENT')
    assert.deepEqual((await v2()).messages.map((m: any) => m.messageResponseType), ['PAYMENT'])
    assert.equal((await call(ctx, { url: '/messages/count' })).body, '{"count":2}')
  })

  test('filters: dates (UK calendar day), clientCode, clientCountry; paging; 400 on a bad date', async () => {
    const sp = (h: Record<string, string>) => call(ctx, { url: '/heartbeat/mq', as: SP.code, headers: h })
    await sp(SP_FOR(C1))
    ctx.clock.set(new Date('2026-03-11T23:30:00Z'))
    await sp(SP_FOR(C2))
    await sp(SP_OWN)
    const ids = async (q: string) => ((await requests(q, SP.code, SP_OWN))?.messages ?? []).map((m: any) => m.clientCode)
    assert.deepEqual(await ids(''), [C1.code, C2.code, SP.code])
    assert.deepEqual(await ids('?startDate=2026-03-11'), [C2.code, SP.code])
    assert.deepEqual(await ids('?endDate=2026-03-10'), [C1.code])
    assert.deepEqual(await ids('?startDate=2026-03-11&endDate=2026-03-11'), [C2.code, SP.code])
    assert.deepEqual(await ids('?clientCode=12340002'), [C2.code])
    assert.deepEqual(await ids('?clientCountry=ee&pageSize=2&pageNumber=2'), [SP.code])
    assert.deepEqual(await ids('?clientCountry=GB'), [])
    assert.deepEqual(await ids('?startDate=2026-03-12'), [])
    // Acting for one customer, only its requests.
    assert.deepEqual(((await requests('', SP.code, SP_FOR(C2)))!.messages).map((m: any) => m.clientCode), [C2.code])
    for (const q of ['?startDate=2026-02-30', '?endDate=11.03.2026', '?pageSize=0']) {
      const r = await call(ctx, { url: `/v2/requests${q}`, as: SP.code, headers: SP_OWN })
      assert.equal(r.statusCode, 400, q)
      assert.equal(JSON.parse(r.body).errors[0].errorCode, 'BAD_REQUEST')
    }
  })

  test('a refused request (4xx) is not recorded', async () => {
    const r = await call(ctx, { method: 'POST', url: '/payment', body: '' })
    assert.equal(r.statusCode, 400)
    assert.equal(await requests(), undefined)
    assert.equal(ctx.emulator.requests.size, 0)
  })

  test('bounded: beyond the cap the oldest request is forgotten', async () => {
    const c = await setup({ memory: { requests: { max: 2 } } }, undefined, { flavour: 'UK' })
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await call(c, { url: '/heartbeat/mq' })).headers['message-request-id'] as string)
    assert.equal(c.emulator.requests.size, 2)
    assert.equal((await call(c, { url: `/v2/requests/${ids[0]}` })).statusCode, 204)
    assert.equal((await call(c, { url: `/v2/requests/${ids[2]}` })).statusCode, 200)
  })
})

describe('GET /messages/test/next without mockLargeMessage (G get-next-message-1)', () => {
  test('it is GET /messages/next: the oldest pending message with its headers, not consumed', async () => {
    const a = put('PAYMENT', C1, 'REQt', '<a/>')
    put('PAYMENT', C1, undefined, '<b/>')
    for (const q of ['', '?mockLargeMessage=false']) {
      const r = await call(ctx, { url: `/messages/test/next${q}` })
      assert.equal(r.statusCode, 200)
      assert.equal(r.body, '<a/>')
      assert.equal(r.headers['message-response-id'], a.id)
      assert.equal(r.headers['message-request-id'], 'REQt')
      assert.equal(r.headers['x-bank-code'], 'LHVUK')
    }
    assert.equal(await nextId(), a.id)
  })
  test('the large mock is not an inbox message: next and v2 do not see it', async () => {
    const r = await call(ctx, { url: '/messages/test/next?mockLargeMessage=true', headers: { 'Accept-Encoding': 'gzip' } })
    assert.equal(r.statusCode, 200)
    assert.equal(await v2(), undefined)
  })
})

describe('UK host v1 list time (decision 627)', () => {
  test('GET /messages on the UK host: ISO-8601 with the UK offset; EE host unchanged', async () => {
    put()
    const r = jsonValid('messages-list.response', (await call(ctx, { url: '/messages' })).body)
    assert.equal(r.messages[0].messageCreatedTime, '2026-03-10T08:00:01.000+00:00')
    const ee = await setup()
    ee.clock.advance(1000)
    ee.emulator.inbox.add({ customer: C1, type: 'PAYMENT', body: '<x/>' })
    assert.equal(JSON.parse((await call(ee, { url: '/messages' })).body).messages[0].messageCreatedTime, '2026-03-10 10:00:01:000')
  })
})
