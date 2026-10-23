// L5a contract management (P 14, decisions 410-415): the published samples, who may call
// (403 for everyone but a service provider for itself), validation and business errors in
// the JSON envelope, the BDOC container as a real zip, the list filters with their
// inclusive Tallinn-date bounds, CLOSED contracts only with changedAt, and activation
// connecting the customer (the provider may then act for it). Every JSON body is checked
// against the ssot schemas (jsonValid / jsonInvalid).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { beforeEach, describe, test } from 'node:test'
import { C1, C2, SP, call, docJson, jsonDrain, jsonInvalid, jsonValid, report, setup, type Ctx } from './helpers.js'

let ctx: Ctx
beforeEach(async () => { ctx = await setup() })

const C3 = { code: '12340003', country: 'EE', iban: 'EE427700771001260990' }
const spHeaders = { 'Client-Code': SP.code, 'Client-Country': 'EE' }
const asSp = { as: SP.code, headers: spHeaders }

async function addC3() {
  const res = await call(ctx, { method: 'POST', url: '/_sim/customers', body: { code: C3.code, country: 'EE', name: 'Demo Customer 3', accounts: [C3.iban] } })
  assert.equal(res.statusCode, 201, res.body)
  await call(ctx, { method: 'POST', url: `/_sim/accounts/${C3.iban}/fund`, body: { amount: '500.00' } })
}

/** POST /contracts as the provider with a schema-valid body; 200 and the checked response. */
async function create(companyCode: string, companyCodeIssuer = 'EE') {
  const body = jsonValid('contracts-create.request', { companyCode, companyCodeIssuer })
  const res = await call(ctx, { method: 'POST', url: '/contracts', body, ...asSp })
  assert.equal(res.statusCode, 200, res.body)
  assert.match(res.headers['content-type'] as string, /^application\/json/)
  return jsonValid('contracts-create.response', res.body)
}

/** GET /contracts as the provider: 200, schema-checked. */
async function list(query = '') {
  const res = await call(ctx, { url: `/contracts${query}`, ...asSp })
  assert.equal(res.statusCode, 200, res.body)
  return jsonValid('contracts-list.response', res.body).customers as any[]
}

/** [code, statuses newest first] per listed customer. */
const summary = (customers: any[]) => customers.map((c) => [c.companyCode, c.contracts.map((x: any) => x.status).join(',')])

/** A 400 in the messages API JSON envelope. */
function jsonErr(res: { statusCode: number; body: string }, code: string, description?: string) {
  assert.equal(res.statusCode, 400, res.body)
  const e = jsonValid('error-json', res.body)
  assert.equal(e.errors.length, 1)
  assert.equal(e.errors[0].errorCode, code)
  if (description !== undefined) assert.equal(e.errors[0].description, description)
  return e.errors[0]
}

/** A 403 FORBIDDEN (XML, as every FORBIDDEN) with a text. */
function forbidden(res: { statusCode: number; body: string; headers: Record<string, unknown> }, text: string) {
  assert.equal(res.statusCode, 403, res.body)
  assert.match(String(res.headers['content-type']), /xml/)
  assert.ok(res.body.includes('FORBIDDEN'), res.body)
  assert.ok(res.body.includes(text.replace(/'/g, '&apos;')) || res.body.includes(text), res.body)
}

/** The entries of a stored zip/deflate archive, read from the central directory, CRC-checked. */
function unzip(buf: Buffer) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(eocd >= 0, 'end of central directory')
  const n = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: { name: string; method: number; offset: number; data: Buffer }[] = []
  for (let i = 0; i < n; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central directory header')
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extra = buf.readUInt16LE(p + 30)
    const comment = buf.readUInt16LE(p + 32)
    const offset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString()
    assert.equal(buf.readUInt32LE(offset), 0x04034b50, `local header of ${name}`)
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28)
    const raw = buf.subarray(start, start + size)
    const data = method === 0 ? raw : zlib.inflateRawSync(raw)
    assert.equal(data.length, buf.readUInt32LE(p + 24), `${name}: uncompressed size`)
    // zlib.crc32 (Node >= 22.2) checks the container's own CRC-32 independently.
    assert.equal((zlib as unknown as { crc32: (b: Buffer) => number }).crc32(data), crc, `${name}: CRC-32`)
    out.push({ name, method, offset, data })
    p += 46 + nameLen + extra + comment
  }
  return out
}

describe('contracts: the P 14 samples', () => {
  const samples = docJson('14-contract-management-services.md').filter((b) => b.json).map((b) => b.json)

  test('request, response and list samples are schema-valid; our answers have the samples\' fields in order', async () => {
    assert.equal(samples.length, 3)
    const [req, created, listed] = samples
    jsonValid('contracts-create.request', req)
    jsonValid('contracts-create.response', created)
    jsonValid('contracts-list.response', listed)
    await addC3()
    const c = await create(C3.code)
    assert.deepEqual(Object.keys(c), Object.keys(created))
    assert.ok(c.contractContainer.startsWith('UEsDB'), 'base64 of a zip, like the sample')
    const [mine] = (await list()).filter((x) => x.companyCode === C3.code)
    assert.deepEqual(Object.keys(mine), Object.keys(listed.customers[0]))
    assert.deepEqual(Object.keys(mine.contracts[0]), Object.keys(listed.customers[0].contracts[0]), 'PENDING: no startDate')
    assert.deepEqual(mine.contracts[0].services.map((s: any) => s.name), listed.customers[0].contracts[0].services.map((s: any) => s.name))
    const seeded = (await list()).find((x) => x.companyCode === C1.code).contracts[0]
    assert.deepEqual(Object.keys(seeded), Object.keys(listed.customers[0].contracts[1]), 'ACTIVE: with startDate')
  })
})

describe('contracts: who may call', () => {
  test('403 for a customer that is not a service provider (GET and POST)', async () => {
    const body = jsonValid('contracts-create.request', { companyCode: C2.code, companyCodeIssuer: 'EE' })
    forbidden(await call(ctx, { url: '/contracts', as: C1.code }), 'User has not been granted the requested service')
    forbidden(await call(ctx, { method: 'POST', url: '/contracts', body, as: C1.code }), 'User has not been granted the requested service')
    forbidden(await call(ctx, { url: '/contracts', as: C1.code, headers: { 'Client-Code': C1.code, 'Client-Country': 'EE' } }), 'User has not been granted the requested service')
  })

  test('403 for a service provider acting for a customer (Client-Code of another company)', async () => {
    const body = jsonValid('contracts-create.request', { companyCode: C2.code, companyCodeIssuer: 'EE' })
    const forC1 = { 'Client-Code': C1.code, 'Client-Country': 'EE' }
    forbidden(await call(ctx, { url: '/contracts', as: SP.code, headers: forC1 }), 'User has not been granted the requested service')
    forbidden(await call(ctx, { method: 'POST', url: '/contracts', body, as: SP.code, headers: forC1 }), 'User has not been granted the requested service')
    // An unconnected company is refused before that.
    await addC3()
    forbidden(await call(ctx, { url: '/contracts', as: SP.code, headers: { 'Client-Code': C3.code, 'Client-Country': 'EE' } }), "User doesn't have valid contract")
  })

  test('missing or malformed Client-Code / Client-Country headers', async () => {
    forbidden(await call(ctx, { url: '/contracts', as: SP.code }), "Can't authenticate. No 'Client-Code' header for service provider")
    forbidden(await call(ctx, { url: '/contracts', as: SP.code, headers: { 'Client-Code': SP.code } }), "Missing 'Client-Country' request header")
    forbidden(await call(ctx, { url: '/contracts', as: SP.code, headers: { 'Client-Code': SP.code, 'Client-Country': 'EST' } }),
      "'Client-Country' request header value is not in correct format. Length should be 2 characters (i.e. EE)")
    // The country is case-insensitive.
    assert.equal((await call(ctx, { url: '/contracts', as: SP.code, headers: { 'Client-Code': SP.code, 'Client-Country': 'ee' } })).statusCode, 200)
  })
})

describe('contracts: create errors', () => {
  const post = (body: string | object) => call(ctx, { method: 'POST', url: '/contracts', body, contentType: 'application/json', ...asSp })

  test('BAD_REQUEST: malformed JSON, not an object, missing or empty fields, a bad issuer', async () => {
    assert.match(jsonErr(await post('{"companyCode": '), 'BAD_REQUEST').description, /^JSON parse error: /)
    assert.match(jsonErr(await post(''), 'BAD_REQUEST').description, /^No content to map due to end-of-input/)
    jsonInvalid('contracts-create.request', [])
    jsonErr(await post([]), 'BAD_REQUEST', 'The request body must be a JSON object')
    for (const [body, text] of [
      [{ companyCodeIssuer: 'EE' }, 'companyCode is mandatory'],
      [{ companyCode: C2.code }, 'companyCodeIssuer is mandatory'],
      [{ companyCode: 12340002, companyCodeIssuer: 'EE' }, 'companyCode is mandatory'],
    ] as const) {
      jsonInvalid('contracts-create.request', body)
      jsonErr(await post(body), 'BAD_REQUEST', text)
    }
    for (const [body, text] of [
      [{ companyCode: '  ', companyCodeIssuer: 'EE' }, 'companyCode is mandatory'],
      [{ companyCode: C2.code, companyCodeIssuer: 'EST' }, 'companyCodeIssuer must be a 2-letter country code'],
      [{ companyCode: C2.code, companyCodeIssuer: 'E1' }, 'companyCodeIssuer must be a 2-letter country code'],
    ] as const) {
      jsonValid('contracts-create.request', body)
      jsonErr(await post(body), 'BAD_REQUEST', text)
    }
  })

  test('CONTRACT_CREATION_FAILED: unknown company, the provider itself, a second PENDING contract', async () => {
    const failed = 'Unable to create the contract'
    jsonErr(await post({ companyCode: '99999999', companyCodeIssuer: 'EE' }), 'CONTRACT_CREATION_FAILED', failed)
    jsonErr(await post({ companyCode: C1.code, companyCodeIssuer: 'LV' }), 'CONTRACT_CREATION_FAILED', failed)
    jsonErr(await post({ companyCode: SP.code, companyCodeIssuer: 'EE' }), 'CONTRACT_CREATION_FAILED', failed)
    await addC3()
    await create(C3.code)
    jsonErr(await post({ companyCode: C3.code, companyCodeIssuer: 'EE' }), 'CONTRACT_CREATION_FAILED', failed)
    assert.deepEqual(summary(await list()).find(([c]) => c === C3.code), [C3.code, 'PENDING'], 'still one')
  })

  test('the issuer is case-insensitive and echoed upper case; the code is trimmed', async () => {
    await addC3()
    const c = await create(` ${C3.code} `, 'ee')
    assert.deepEqual([c.companyCode, c.companyCodeIssuer, c.contractStatus], [C3.code, 'EE', 'pending'])
  })
})

describe('contracts: the BDOC container', () => {
  test('a valid ASiC-E zip: mimetype stored first, a manifest listing the contract file, CRCs right', async () => {
    await addC3()
    const c = await create(C3.code)
    const zip = Buffer.from(c.contractContainer, 'base64')
    assert.equal(zip.toString('base64'), c.contractContainer, 'canonical base64')
    const entries = unzip(zip)
    assert.equal(entries[0].name, 'mimetype')
    assert.equal(entries[0].offset, 0)
    assert.equal(entries[0].method, 0, 'mimetype stored, not deflated')
    assert.equal(entries[0].data.toString(), 'application/vnd.etsi.asic-e+zip')
    const names = entries.map((e) => e.name)
    assert.ok(names.includes('META-INF/manifest.xml'), names.join())
    const doc = entries.find((e) => e.name === `contract-${c.contractId}.txt`)
    assert.ok(doc, names.join())
    const manifest = entries.find((e) => e.name === 'META-INF/manifest.xml')!.data.toString()
    assert.match(manifest, new RegExp(`full-path="contract-${c.contractId}\\.txt"`))
    assert.match(manifest, /full-path="\/" manifest:media-type="application\/vnd\.etsi\.asic-e\+zip"/)
    const text = doc!.data.toString()
    assert.match(text, new RegExp(`Customer: Demo Customer 3 \\(${C3.code}, EE\\)`))
    assert.match(text, /Service provider: Demo Service Provider \(10000001, EE\)/)

    // And an independent reader agrees.
    const dir = mkdtempSync(join(tmpdir(), 'bdoc-'))
    try {
      const f = join(dir, 'contract.bdoc')
      writeFileSync(f, zip)
      const out = execFileSync('unzip', ['-t', f], { encoding: 'utf8' })
      assert.match(out, /No errors detected/)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('contracts: list filters (inclusive Tallinn dates, decision 415)', () => {
  /** The seed's contracts exist from 10 March; C3's is created on 12 March (00:30 Tallinn) and activated on 14 March. */
  async function timeline() {
    await addC3()
    ctx.clock.set('2026-03-11T22:30:00Z') // 12 March 00:30 in Tallinn, still 11 March in UTC
    const c = await create(C3.code)
    ctx.clock.set('2026-03-14T09:00:00Z')
    assert.equal((await call(ctx, { method: 'POST', url: `/_sim/contracts/${c.contractId}/activate` })).statusCode, 200)
    return c
  }

  test('createdAtMin / createdAtMax, each bound alone and both, inclusive', async () => {
    await timeline()
    const all = [[C1.code, 'ACTIVE'], [C2.code, 'ACTIVE'], [C3.code, 'ACTIVE']]
    assert.deepEqual(summary(await list()), all)
    assert.deepEqual(summary(await list('?createdAtMin=2026-03-12')), [[C3.code, 'ACTIVE']], 'Tallinn date, not UTC')
    assert.deepEqual(summary(await list('?createdAtMin=2026-03-13')), [])
    assert.deepEqual(summary(await list('?createdAtMax=2026-03-11')), all.slice(0, 2))
    assert.deepEqual(summary(await list('?createdAtMax=2026-03-10')), all.slice(0, 2), 'inclusive upper bound')
    assert.deepEqual(summary(await list('?createdAtMax=2026-03-09')), [])
    assert.deepEqual(summary(await list('?createdAtMin=2026-03-12&createdAtMax=2026-03-12')), [[C3.code, 'ACTIVE']])
    assert.deepEqual(summary(await list('?createdAtMin=2026-03-10&createdAtMax=2026-03-12')), all)
    assert.deepEqual(summary(await list('?createdAtMin=2026-03-13&createdAtMax=2026-03-11')), [], 'an empty range')
  })

  test('changedAtMin / changedAtMax, inclusive; no match is 200 {"customers":[]}', async () => {
    await timeline()
    assert.deepEqual(summary(await list('?changedAtMin=2026-03-14')), [[C3.code, 'ACTIVE']])
    assert.deepEqual(summary(await list('?changedAtMax=2026-03-13')), [[C1.code, 'ACTIVE'], [C2.code, 'ACTIVE']])
    assert.deepEqual(summary(await list('?changedAtMin=2026-03-14&changedAtMax=2026-03-14')), [[C3.code, 'ACTIVE']])
    const res = await call(ctx, { url: '/contracts?changedAtMin=2026-03-15', ...asSp })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(jsonValid('contracts-list.response', res.body), { customers: [] })
    // Created and changed filters combine.
    assert.deepEqual(summary(await list('?createdAtMax=2026-03-11&changedAtMin=2026-03-14')), [])
  })

  test('an invalid date is 400 BAD_REQUEST', async () => {
    for (const q of ['createdAtMin=2026-13-01', 'createdAtMax=yesterday', 'changedAtMin=2026-02-30', 'changedAtMax=20260310']) {
      jsonErr(await call(ctx, { url: `/contracts?${q}`, ...asSp }), 'BAD_REQUEST', `${q.split('=')[0]} must be a date (YYYY-MM-DD)`)
    }
  })
})

describe('contracts: life (decision 414)', () => {
  const simContracts = async () => JSON.parse((await call(ctx, { url: '/_sim/contracts' })).body).contracts as any[]

  test('activation connects the customer: the provider can then read its balance and trade FX for it', async () => {
    await addC3()
    const c = await create(C3.code)
    const forC3 = { as: SP.code, headers: { 'Client-Code': C3.code, 'Client-Country': 'EE' } }
    forbidden(await call(ctx, { url: '/messages/count', ...forC3 }), "User doesn't have valid contract")
    ctx.clock.set('2026-03-11T08:00:00Z')
    const act = await call(ctx, { method: 'POST', url: `/_sim/contracts/${c.contractId}/activate` })
    assert.equal(act.statusCode, 200)
    assert.deepEqual([JSON.parse(act.body).status, JSON.parse(act.body).startDate], ['ACTIVE', '2026-03-11'])
    const [mine] = (await list()).filter((x) => x.companyCode === C3.code)
    assert.deepEqual([mine.contracts[0].status, mine.contracts[0].startDate], ['ACTIVE', '2026-03-11'])

    const bal = await report(ctx, { kind: 'balance', iban: C3.iban }, forC3)
    assert.equal(bal.msgs[0].type, 'ACCOUNT_BALANCE')
    assert.match(bal.msgs[0].body, /<Amt Ccy="EUR">500\.00<\/Amt>/)

    await call(ctx, { method: 'PUT', url: '/_sim/fx/pricing', body: { margin: '0' } })
    const body = jsonValid('fx-trade-offer.request', { requestReference: 'C3-1', accountIBAN: C3.iban, currencyFrom: 'EUR', currencyTo: 'USD', amountFrom: 100, tenor: 'TODAY' })
    const res = await call(ctx, { method: 'POST', url: '/fx/trade-offer', body, ...forC3 })
    assert.equal(res.statusCode, 202)
    const [m] = (await jsonDrain(ctx, SP.code, forC3.headers)).filter((x) => x.requestId === res.headers['message-request-id'])
    assert.equal(jsonValid('fx-trade-offer.response', m.body).tradeOfferStatus, 'CONFIRMATION_PENDING')
  })

  test('closing ends the connection; CLOSED is listed only with a changedAt filter', async () => {
    const c2 = (await simContracts()).find((c) => c.customer.code === C2.code)
    ctx.clock.set('2026-03-12T08:00:00Z')
    const closed = await call(ctx, { method: 'POST', url: `/_sim/contracts/${c2.id}/close` })
    assert.equal(JSON.parse(closed.body).status, 'CLOSED')
    assert.deepEqual(summary(await list()), [[C1.code, 'ACTIVE']])
    assert.deepEqual(summary(await list('?changedAtMin=2026-03-12')), [[C2.code, 'CLOSED']])
    assert.deepEqual(summary(await list('?changedAtMax=2026-03-12')), [[C1.code, 'ACTIVE'], [C2.code, 'CLOSED']])
    assert.deepEqual(summary(await list('?createdAtMin=2026-03-01')), [[C1.code, 'ACTIVE']], 'createdAt alone hides CLOSED')
    const closedView = (await list('?changedAtMin=2026-03-12'))[0].contracts[0]
    assert.equal(closedView.startDate, '2026-03-10', 'a closed contract keeps its start date')
    forbidden(await call(ctx, { url: '/messages/count', as: SP.code, headers: { 'Client-Code': C2.code, 'Client-Country': 'EE' } }), "User doesn't have valid contract")
    // A new contract can be made again.
    assert.equal((await create(C2.code)).contractStatus, 'pending')
    assert.deepEqual(summary(await list()), [[C1.code, 'ACTIVE'], [C2.code, 'PENDING']])
  })

  test('a new contract beside an ACTIVE one (a modification): PENDING listed first; activating it closes the old one', async () => {
    ctx.clock.set('2026-03-12T08:00:00Z')
    const c = await create(C1.code)
    const [c1] = (await list()).filter((x) => x.companyCode === C1.code)
    assert.deepEqual(c1.contracts.map((x: any) => [x.status, x.startDate]), [['PENDING', undefined], ['ACTIVE', '2026-03-10']])
    assert.deepEqual(c1.contracts[0].services.find((s: any) => s.name === 'CREDIT_DEBIT_NOTIFICATION').ibans, [C1.iban])
    // The provider keeps acting for C1 meanwhile.
    const forC1 = { as: SP.code, headers: { 'Client-Code': C1.code, 'Client-Country': 'EE' } }
    assert.equal((await call(ctx, { url: '/messages/count', ...forC1 })).statusCode, 200)

    ctx.clock.set('2026-03-13T08:00:00Z')
    await call(ctx, { method: 'POST', url: `/_sim/contracts/${c.contractId}/activate` })
    const [after] = (await list()).filter((x) => x.companyCode === C1.code)
    assert.deepEqual(after.contracts.map((x: any) => [x.status, x.startDate]), [['ACTIVE', '2026-03-13']])
    assert.equal(after.contracts[0].id, c.contractId)
    // The closed predecessor stays hidden even with changedAt: the customer has an active contract.
    assert.deepEqual(summary(await list('?changedAtMin=2026-03-13')), [[C1.code, 'ACTIVE']])
    assert.equal((await call(ctx, { url: '/messages/count', ...forC1 })).statusCode, 200)
    assert.equal((await simContracts()).filter((x) => x.customer.code === C1.code && x.status === 'CLOSED').length, 1)
  })

  test('control plane: unknown contract 404, activating twice 409, closing twice 409', async () => {
    assert.equal((await call(ctx, { method: 'POST', url: '/_sim/contracts/00000000-0000-4000-8000-000000000000/activate' })).statusCode, 404)
    await addC3()
    const c = await create(C3.code)
    assert.equal((await call(ctx, { method: 'POST', url: `/_sim/contracts/${c.contractId}/activate` })).statusCode, 200)
    assert.equal((await call(ctx, { method: 'POST', url: `/_sim/contracts/${c.contractId}/activate` })).statusCode, 409)
    assert.equal((await call(ctx, { method: 'POST', url: `/_sim/contracts/${c.contractId}/close` })).statusCode, 200)
    assert.equal((await call(ctx, { method: 'POST', url: `/_sim/contracts/${c.contractId}/close` })).statusCode, 409)
  })
})
