// S4a payee verification, requester side: the name matcher (decision 601), the EE XML
// Verification of Payee on both hosts with the published P 07 request, response and error
// samples replayed and every answer checked against verification.of.payee.xsd, the UK
// JSON VoP and CoP with the G samples and ajv against ssot/json-schemas, the simulator's
// external accounts and forced answers, and the EE TEST-only GET /test/accounts/ibans.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, describe, test } from 'node:test'
import { makeIban } from '../src/iban.js'
import { matchName } from '../src/payee/match.js'
import { C1, C2, HAVE_REFERENCE, MIRROR_DIR, call, drain, jsonDrain, jsonInvalid, jsonValid, seed, setup, xsd, type Ctx } from './helpers.js'
import { parseXml } from '../src/xml.js'

/** The ``` blocks of one language on a mirror page (path under docs/), in order. */
function blocks(page: string, lang: string): string[] {
  const p = join(MIRROR_DIR, 'docs', page)
  if (!existsSync(p)) return []
  return [...readFileSync(p, 'utf8').matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1])
}
const P07 = 'partners/07-verification-of-payee.md'
const G_VOP = 'gitbook/connect/services/verification-of-payee-services/verification-of-payee-requester.md'
const G_COP = 'gitbook/connect/services/confirmation-of-payee-services/confirmation-of-payee-requester.md'

const vopValid = async (body: string) => {
  if (!HAVE_REFERENCE) return
  const errors = await xsd.validate(body, 'verification.of.payee')
  assert.deepEqual(errors, [], body)
}

const vopXml = (name: string | null, iban: string | null, extra = '') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<VerificationOfPayeeRequest>${name === null ? '' : `<Name>${name}</Name>`}${iban === null ? '' : `<IBAN>${iban}</IBAN>`}${extra}</VerificationOfPayeeRequest>`

/** POST /verification-of-payee and the one inbox message it produces. */
async function vopEe(ctx: Ctx, body: string) {
  const res = await call(ctx, { method: 'POST', url: '/verification-of-payee', body })
  assert.equal(res.statusCode, 202, res.body)
  const msgs = await drain(ctx)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].type, 'VERIFICATION_OF_PAYEE')
  assert.equal(msgs[0].requestId, res.headers['message-request-id'])
  return { res, msg: msgs[0] }
}

const IT_IBAN = 'IT76L0300203280825973665778'
const GB_BBAN = '04000412345678'
const GB_IBAN = makeIban('GB', `LHVB${GB_BBAN}`)
const GB = { code: '09876543', country: 'GB', name: 'Account Name Ltd', accounts: [GB_IBAN] }
const VIBAN = makeIban('EE', '7777000000000019')

describe('name matching (decision 601)', () => {
  test('FULL: case, diacritics and whitespace folded', () => {
    assert.equal(matchName('john  DOE', 'John Doe'), 'FULL')
    assert.equal(matchName('Juri Tamm OU', 'Jüri Tamm OÜ'), 'FULL')
    assert.equal(matchName('Account Name LTD', 'Account Name Ltd'), 'FULL')
  })
  test('CLOSE: reorder, punctuation, legal form, middle name, initials, typos', () => {
    assert.equal(matchName('Doe John', 'John Doe'), 'CLOSE')
    assert.equal(matchName('John-Doe', 'John Doe'), 'CLOSE')
    assert.equal(matchName('Account Name', 'Account Name Ltd'), 'CLOSE')
    assert.equal(matchName('John Doe', 'John Edward Doe'), 'CLOSE')
    assert.equal(matchName('J. Doe', 'John Doe'), 'CLOSE')
    assert.equal(matchName('Jonh Doe', 'John Doe'), 'CLOSE')
    assert.equal(matchName('Demo Custmer 2', 'Demo Customer 2'), 'CLOSE')
  })
  test('NONE: different names, blanks, short names with a typo', () => {
    assert.equal(matchName('Jane Smith', 'John Doe'), 'NONE')
    assert.equal(matchName('   ', 'John Doe'), 'NONE')
    assert.equal(matchName('Ab', 'Ac'), 'NONE')
    assert.equal(matchName('J. Smith', 'John Doe'), 'NONE')
  })
})

describe('EE Verification of Payee (XML)', () => {
  let ctx: Ctx
  before(async () => {
    ctx = await setup()
    ctx.emulator.viban.registry.add({
      iban: VIBAN, master: C1.iban, owner: { code: C1.code, country: 'EE' }, status: 'ACTIVE', createdAt: new Date(),
      user: { person: { Name: 'Mari Maasikas', BirthDate: '1990-01-01', Residency: 'EE' }, address: { Country: 'EE', StreetNo: 'x', CityCounty: 'Tallinn' } },
    })
  })

  test('published request: an external IBAN without data is NOT_APPLICABLE', async () => {
    const [request] = blocks(P07, 'xml')
    const { msg } = await vopEe(ctx, request ?? vopXml('John Doe', IT_IBAN))
    await vopValid(msg.body)
    assert.deepEqual(msg.doc.VerificationOfPayeeResponse, { Name: 'John Doe', IBAN: IT_IBAN, PartyNameMatch: 'NOT_APPLICABLE' })
  })

  test('published response: CLOSE_MATCH with ActualName for a simulated external holder', async () => {
    const put = await call(ctx, { method: 'PUT', url: `/_sim/payee/accounts/${IT_IBAN}`, body: { name: 'John Edward Doe' } })
    assert.equal(put.statusCode, 200, put.body)
    const samples = blocks(P07, 'xml')
    const { msg } = await vopEe(ctx, samples[0] ?? vopXml('John Doe', IT_IBAN))
    await vopValid(msg.body)
    const expected = samples[1] ? parseXml(samples[1]).VerificationOfPayeeResponse
      : { Name: 'John Doe', IBAN: IT_IBAN, PartyNameMatch: 'CLOSE_MATCH', ActualName: 'John Edward Doe' }
    assert.deepEqual(msg.doc.VerificationOfPayeeResponse, expected)
    assert.equal((await call(ctx, { method: 'DELETE', url: `/_sim/payee/accounts/${IT_IBAN}` })).statusCode, 204)
  })

  test('a customer account: FULL_MATCH, CLOSE_MATCH, NO_MATCH', async () => {
    for (const [name, match, actual] of [
      ['demo customer 2', 'FULL_MATCH', undefined], ['Customer 2 Demo', 'CLOSE_MATCH', 'Demo Customer 2'], ['Someone Else', 'NO_MATCH', undefined],
    ] as const) {
      const { msg } = await vopEe(ctx, vopXml(name, C2.iban))
      await vopValid(msg.body)
      assert.deepEqual(msg.doc.VerificationOfPayeeResponse, { Name: name, IBAN: C2.iban, PartyNameMatch: match, ...(actual ? { ActualName: actual } : {}) })
    }
  })

  test('an ACTIVE VIBAN answers with its holder, not the master account owner', async () => {
    let { msg } = await vopEe(ctx, vopXml('Mari Maasikas', VIBAN))
    assert.equal(msg.doc.VerificationOfPayeeResponse.PartyNameMatch, 'FULL_MATCH')
    ;({ msg } = await vopEe(ctx, vopXml('Demo Customer 1', VIBAN)))
    assert.equal(msg.doc.VerificationOfPayeeResponse.PartyNameMatch, 'NO_MATCH')
  })

  test('published error sample: NAME_REQUIRED and IBAN_FORMAT_INVALID in one <Errors> message', async () => {
    const samples = blocks(P07, 'xml')
    const { msg } = await vopEe(ctx, samples[2] ?? vopXml(null, '9T76L0300203280825973665778', '<Nam>John Edward Doe</Nam>'))
    const expected = samples[3] ? parseXml(samples[3]) : {
      Errors: { Error: [
        { ErrorCode: 'NAME_REQUIRED', Description: 'Name is required', Field: 'VerificationOfPayeeRequestMessage/Name' },
        { ErrorCode: 'IBAN_FORMAT_INVALID', Description: 'IBAN is invalid', Field: 'VerificationOfPayeeRequestMessage/IBAN' },
      ] },
    }
    assert.deepEqual(msg.doc, expected)
  })

  test('other request errors', async () => {
    const err = async (body: string) => {
      const { msg } = await vopEe(ctx, body)
      const e = msg.doc.Errors.Error
      return (Array.isArray(e) ? e : [e]).map((x: any) => `${x.ErrorCode}${x.Field ? ` ${x.Field}` : ''}`)
    }
    assert.deepEqual(await err('not xml'), ['INVALID_REQUEST'])
    assert.deepEqual(await err('<Other/>'), ['INVALID_REQUEST'])
    assert.deepEqual(await err(vopXml('A', C2.iban, '<Name>B</Name>')), ['INVALID_REQUEST'])
    assert.deepEqual(await err('<VerificationOfPayeeRequest/>'), ['NAME_REQUIRED VerificationOfPayeeRequestMessage/Name', 'IBAN_REQUIRED VerificationOfPayeeRequestMessage/IBAN'])
    assert.deepEqual(await err(vopXml('  ', C2.iban)), ['NAME_LENGTH_CHECK_FAILED VerificationOfPayeeRequestMessage/Name'])
    assert.deepEqual(await err(vopXml('x'.repeat(141), C2.iban)), ['NAME_LENGTH_CHECK_FAILED VerificationOfPayeeRequestMessage/Name'])
    assert.deepEqual(await err(vopXml('John', 'EE00 7700')), ['IBAN_FORMAT_INVALID VerificationOfPayeeRequestMessage/IBAN'])
    assert.deepEqual(await err(vopXml('John', C2.iban, '<BIC>bad</BIC>')), ['INVALID_REQUEST VerificationOfPayeeRequestMessage/BIC'])
    // A valid IBAN outside SEPA: no BIC can be derived (without one) and no VoP scheme (with one).
    const br = 'BR1800360305000010009795493C1'
    assert.deepEqual(await err(vopXml('John', br)), ['UNABLE_TO_CALCULATE_BIC_FROM_IBAN VerificationOfPayeeRequestMessage/IBAN'])
    const { msg } = await vopEe(ctx, vopXml('John', br, '<BIC>CEFXBRSP</BIC>'))
    assert.equal(msg.doc.VerificationOfPayeeResponse.PartyNameMatch, 'NOT_APPLICABLE')
  })

  test('a forced answer for an account', async () => {
    await call(ctx, { method: 'PUT', url: `/_sim/payee/accounts/${C2.iban}`, body: { answer: 'NOT_APPLICABLE' } })
    const { msg } = await vopEe(ctx, vopXml('Demo Customer 2', C2.iban))
    assert.equal(msg.doc.VerificationOfPayeeResponse.PartyNameMatch, 'NOT_APPLICABLE')
    const list = await call(ctx, { url: '/_sim/payee/accounts' })
    assert.deepEqual(JSON.parse(list.body), { accounts: [{ account: C2.iban, answer: 'NOT_APPLICABLE' }] })
    await call(ctx, { method: 'DELETE', url: `/_sim/payee/accounts/${C2.iban}` })
  })

  test('simulator input is checked', async () => {
    const put = (account: string, body: object) => call(ctx, { method: 'PUT', url: `/_sim/payee/accounts/${account}`, body })
    assert.equal((await put('EE00', { name: 'x' })).statusCode, 400)
    assert.equal((await put(IT_IBAN, {})).statusCode, 400)
    assert.equal((await put(IT_IBAN, { answer: 'MAYBE' })).statusCode, 400)
    assert.equal((await put(IT_IBAN, { name: 'x', category: 'OTHER' })).statusCode, 400)
    assert.equal((await put(IT_IBAN, { name: 'x', colour: 'red' })).statusCode, 400)
    assert.equal((await call(ctx, { method: 'DELETE', url: `/_sim/payee/accounts/${IT_IBAN}` })).statusCode, 404)
  })

  test('EE host: no UK JSON routes; GET /test/accounts/ibans lists the customer\'s accounts', async () => {
    assert.equal((await call(ctx, { method: 'POST', url: '/payment/vop-request', body: { Identification: C2.iban, Name: 'x' } })).statusCode, 404)
    assert.equal((await call(ctx, { method: 'POST', url: '/payment/cop-request', body: { AccountCategory: 'BUSINESS', Identification: GB_BBAN, Name: 'x' } })).statusCode, 404)
    const res = await call(ctx, { url: '/test/accounts/ibans' })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /^application\/json/)
    assert.deepEqual(JSON.parse(res.body), [C1.iban])
    assert.equal((await call(ctx, { url: '/test/accounts/ibans', as: null })).statusCode, 403)
  })
})

describe('UK host: VoP (JSON), CoP, and the EE VoP proxied', () => {
  let ctx: Ctx
  before(async () => {
    const s = seed()
    s.customers.push(GB)
    ctx = await setup({}, s, { flavour: 'UK' })
  })

  /** POST a UK JSON request; the one inbox message, schema-checked. */
  async function uk(path: string, body: unknown, type: string) {
    const res = await call(ctx, { method: 'POST', url: path, body: typeof body === 'string' ? body : body as object, contentType: 'application/json' })
    assert.equal(res.statusCode, 202, res.body)
    assert.equal(res.headers['x-bank-code'], 'LHVUK')
    const msgs = await jsonDrain(ctx)
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].type, type)
    assert.equal(msgs[0].requestId, res.headers['message-request-id'])
    const json = jsonValid('payee-check.response', msgs[0].body)
    assert.equal(json.OriginalMessageId, res.headers['message-request-id'])
    return json
  }

  test('POST /verification-of-payee is served, answered as LHV EE', async () => {
    const res = await call(ctx, { method: 'POST', url: '/verification-of-payee', body: vopXml('Account Name Ltd', GB_IBAN) })
    assert.equal(res.statusCode, 202)
    assert.equal(res.headers['x-bank-code'], 'LHVEE')
    const [m] = await drain(ctx)
    await vopValid(m.body)
    assert.equal(m.doc.VerificationOfPayeeResponse.PartyNameMatch, 'FULL_MATCH')
    assert.equal((await call(ctx, { url: '/test/accounts/ibans' })).statusCode, 404)
  })

  test('VoP: the published request, the response with the sample\'s keys', async () => {
    const [request, success, error] = blocks(G_VOP, 'json')
    const body = request ? JSON.parse(request) : { Identification: IT_IBAN, Name: 'Account Name' }
    jsonValid('vop-uk.request', body)
    let json = await uk('/payment/vop-request', body, 'VERIFICATION_OF_PAYEE')
    assert.deepEqual(json, {
      OriginalMessageId: json.OriginalMessageId, Errors: null,
      Data: { Answer: 'Rejected', Identification: body.Identification, Name: [body.Name], ReasonCode: 'NOAP', Description: json.Data.Description },
    })
    assert.match(json.Data.Description, /^We are currently unable to verify the account details/)
    await call(ctx, { method: 'PUT', url: `/_sim/payee/accounts/${body.Identification}`, body: { name: 'Account Name' } })
    json = await uk('/payment/vop-request', body, 'VERIFICATION_OF_PAYEE')
    assert.equal(json.Data.Answer, 'Confirmed')
    assert.equal(json.Data.ReasonCode, 'MTCH')
    if (success) {
      const sample = JSON.parse(success)
      assert.deepEqual(Object.keys(json).sort(), Object.keys(sample).sort())
      assert.ok(Array.isArray(sample.Data.Name) && Array.isArray(json.Data.Name))
      const keys = Object.keys(sample.Data).filter((k) => k !== 'ActualName').sort()
      assert.deepEqual(Object.keys(json.Data).sort(), keys)
    }
    if (error) assert.deepEqual(Object.keys(JSON.parse(error)).sort(), ['Data', 'Errors', 'OriginalMessageId'])
    await call(ctx, { method: 'DELETE', url: `/_sim/payee/accounts/${body.Identification}` })
  })

  test('VoP: CMTC names the account, NMTC, a forced TECH', async () => {
    let json = await uk('/payment/vop-request', { Identification: GB_IBAN, Name: 'Account Nmae Ltd' }, 'VERIFICATION_OF_PAYEE')
    assert.equal(json.Data.ReasonCode, 'CMTC')
    assert.equal(json.Data.ActualName, 'Account Name Ltd')
    assert.equal(json.Data.Description, 'The name is a close match. The actual name on the account is Account Name Ltd.')
    json = await uk('/payment/vop-request', { Identification: GB_IBAN, Name: 'Other Company' }, 'VERIFICATION_OF_PAYEE')
    assert.deepEqual([json.Data.Answer, json.Data.ReasonCode, json.Data.ActualName], ['Rejected', 'NMTC', undefined])
    await call(ctx, { method: 'PUT', url: `/_sim/payee/accounts/${GB_IBAN}`, body: { answer: 'TECH' } })
    json = await uk('/payment/vop-request', { Identification: GB_IBAN, Name: 'Account Name Ltd' }, 'VERIFICATION_OF_PAYEE')
    assert.equal(json.Data.ReasonCode, 'TECH')
    await call(ctx, { method: 'DELETE', url: `/_sim/payee/accounts/${GB_IBAN}` })
  })

  test('VoP: request errors arrive as Errors with Data null', async () => {
    for (const [body, messages] of [
      [{ Name: 'x' }, ['Identification is mandatory']],
      [{ Identification: GB_BBAN, Name: '' }, ['Identification must be a valid IBAN', 'Name is mandatory']],
      ['{"Identification": ', undefined],
      ['[1]', ['The request body must be a JSON object']],
    ] as const) {
      // The schema only knows the fields are required strings.
      if (typeof body === 'object' && !('Identification' in body)) jsonInvalid('vop-uk.request', body)
      const json = await uk('/payment/vop-request', body, 'VERIFICATION_OF_PAYEE')
      assert.equal(json.Data, null)
      assert.ok(json.Errors.every((e: any) => e.ErrorCode === 'INVALID_REQUEST'))
      if (messages) assert.deepEqual(json.Errors.map((e: any) => e.ErrorMessage), messages)
      else assert.match(json.Errors[0].ErrorMessage, /^JSON parse error/)
    }
  })

  test('CoP: the published requests against a business account', async () => {
    const samples = blocks(G_COP, 'json')
    const business = samples[0] ? JSON.parse(samples[0]) : { AccountCategory: 'BUSINESS', Identification: '12345687654321', Name: 'Account Name LTD', SecondaryIdentification: 'secondaryIdentification' }
    jsonValid('cop.request', business)
    let json = await uk('/payment/cop-request', business, 'CONFIRMATION_OF_PAYEE')
    assert.equal(json.Data.ReasonCode, 'AC01')
    // The same request for the seeded LHV UK account.
    json = await uk('/payment/cop-request', { ...business, Identification: GB_BBAN }, 'CONFIRMATION_OF_PAYEE')
    assert.deepEqual(json.Data, {
      Answer: 'Confirmed', Identification: GB_BBAN, Name: [business.Name], ReasonCode: 'ACCP',
      Description: "It's a match. The account name and details match those on record.",
    })
    const personal = { AccountCategory: 'PERSONAL', Identification: GB_BBAN, Name: 'Account Name', SecondaryIdentification: 'secondaryIdentification' }
    jsonValid('cop.request', personal)
    json = await uk('/payment/cop-request', personal, 'CONFIRMATION_OF_PAYEE')
    assert.equal(json.Data.ReasonCode, 'BAMM')
    assert.equal(json.Data.ActualName, 'Account Name Ltd')
    json = await uk('/payment/cop-request', { ...personal, Name: 'Account Name Ltd' }, 'CONFIRMATION_OF_PAYEE')
    assert.deepEqual([json.Data.ReasonCode, json.Data.ActualName], ['BANM', undefined])
    json = await uk('/payment/cop-request', { ...business, Identification: GB_BBAN, Name: 'Acount Name' }, 'CONFIRMATION_OF_PAYEE')
    assert.deepEqual([json.Data.Answer, json.Data.ReasonCode, json.Data.ActualName], ['Rejected', 'MBAM', 'Account Name Ltd'])
    json = await uk('/payment/cop-request', { ...business, Identification: GB_BBAN, Name: 'Nobody' }, 'CONFIRMATION_OF_PAYEE')
    assert.equal(json.Data.ReasonCode, 'ANNM')
  })

  test('CoP: a personal account at another bank, forced answers, errors', async () => {
    const other = '20000098765432'
    await call(ctx, { method: 'PUT', url: `/_sim/payee/accounts/${other}`, body: { name: 'Jane Doe', category: 'PERSONAL' } })
    const req = (o: object) => ({ AccountCategory: 'PERSONAL', Identification: other, Name: 'Jane Doe', ...o })
    assert.equal((await uk('/payment/cop-request', req({}), 'CONFIRMATION_OF_PAYEE')).Data.ReasonCode, 'ACCP')
    assert.equal((await uk('/payment/cop-request', req({ AccountCategory: 'BUSINESS' }), 'CONFIRMATION_OF_PAYEE')).Data.ReasonCode, 'PANM')
    const pamm = await uk('/payment/cop-request', req({ AccountCategory: 'BUSINESS', Name: 'Doe Jane' }), 'CONFIRMATION_OF_PAYEE')
    assert.deepEqual([pamm.Data.ReasonCode, pamm.Data.ActualName], ['PAMM', 'Jane Doe'])
    await call(ctx, { method: 'PUT', url: `/_sim/payee/accounts/${other}`, body: { name: 'Jane Doe', answer: 'CASS' } })
    const cass = await uk('/payment/cop-request', req({}), 'CONFIRMATION_OF_PAYEE')
    assert.deepEqual([cass.Data.Answer, cass.Data.ReasonCode], ['Rejected', 'CASS'])
    // A GB IBAN entry answers CoP for its BBAN, and a BBAN entry UK VoP for the IBAN.
    const otherIban = makeIban('GB', `ABCD${other}`)
    await call(ctx, { method: 'DELETE', url: `/_sim/payee/accounts/${other}` })
    await call(ctx, { method: 'PUT', url: `/_sim/payee/accounts/${otherIban}`, body: { answer: 'OPTO' } })
    assert.equal((await uk('/payment/cop-request', req({}), 'CONFIRMATION_OF_PAYEE')).Data.ReasonCode, 'OPTO')
    await call(ctx, { method: 'DELETE', url: `/_sim/payee/accounts/${otherIban}` })
    await call(ctx, { method: 'PUT', url: `/_sim/payee/accounts/${other}`, body: { name: 'Jane Doe' } })
    assert.equal((await uk('/payment/vop-request', { Identification: otherIban, Name: 'Jane Doe' }, 'VERIFICATION_OF_PAYEE')).Data.ReasonCode, 'MTCH')
    const bad = { AccountCategory: 'OTHER', Identification: '12-34-56', Name: 'x', SecondaryIdentification: 5 }
    jsonInvalid('cop.request', bad)
    const json = await uk('/payment/cop-request', bad, 'CONFIRMATION_OF_PAYEE')
    assert.deepEqual(json.Errors.map((e: any) => e.ErrorMessage), [
      'AccountCategory must be PERSONAL or BUSINESS', 'Identification must be a sort code and account number (14 digits)', 'SecondaryIdentification must be a string',
    ])
    assert.equal(json.Data, null)
  })
})
