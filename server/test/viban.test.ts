// L3 virtual IBANs: the five /viban services, bank-side status changes, the error table,
// number formats, payments to and from VIBANs, and the published samples replayed.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { ibanChecksumOk, makeIban } from '../src/iban.js'
import { VibanSchemas } from '../src/viban/messages.js'
import { eeCheckDigit, type Viban, type VibanUser } from '../src/viban/registry.js'
import { E, type VibanError } from '../src/viban/service.js'
import { C1, C2, DE_IBAN, HAVE_REFERENCE, MIRROR_DIR, SP, XSD_DIR, balance, call, drain, pain001, report, reportError, sample, seed, setup, xsd, type Ctx } from './helpers.js'
import { parseXml } from '../src/xml.js'

let ctx: Ctx
beforeEach(async () => { ctx = await setup() })

const vx = new VibanSchemas(XSD_DIR)
const HAVE_VIBAN_XSD = vx.has('viban.open.request')
type Msg = Awaited<ReturnType<typeof drain>>[number]
const many = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])
const json = (r: { body: string }) => JSON.parse(r.body)

/** A produced VIBAN document must pass its published schema (when the mirror has it). */
async function valid(body: string, schema: string) {
  if (!HAVE_VIBAN_XSD) return
  assert.deepEqual(await vx.validate(body, schema), [], `${schema} is schema-valid:\n${body}`)
}

// --- Request builders ------------------------------------------------------------------

const PERSON = (o: { name?: string; birth?: string; birthCountry?: string; residency?: string; doc?: boolean } = {}) =>
  `<Person><Name>${o.name ?? 'Donald Duck'}</Name><BirthDate>${o.birth ?? '1908-11-29'}</BirthDate><BirthCountry>${o.birthCountry ?? 'DE'}</BirthCountry>` +
  `<Residency>${o.residency ?? 'DE'}</Residency>${o.doc === false ? '' : '<DocumentNumber>A942819</DocumentNumber>'}</Person>`
const COMPANY = (o: { name?: string; rep?: string; repBirth?: string; tax?: string } = {}) =>
  `<Company><Name>${o.name ?? 'Duck Holdings OÜ'}</Name><CountryOfOrigin>EE</CountryOfOrigin><TaxResidency>${o.tax ?? 'EE'}</TaxResidency>` +
  `<RegistrationNumber>12345678</RegistrationNumber><Representative><Name>${o.rep ?? 'Scrooge McDuck'}</Name>` +
  `<BirthDate>${o.repBirth ?? '1967-12-01'}</BirthDate><Residency>EE</Residency></Representative></Company>`
const USER = (who = PERSON(), o: { country?: string; street?: string } = {}) =>
  `<User>${who}<Address><Country>${o.country ?? 'EE'}</Country><StreetNo>${o.street ?? 'Majaka 47-10'}</StreetNo><CityCounty>Tallinn</CityCounty></Address></User>`
const tag = (name: string, v?: string) => (v === undefined ? '' : `<${name}>${v}</${name}>`)
const X = '<?xml version="1.0" encoding="UTF-8"?>'
/** An EE account nobody holds. (A DE IBAN fails the XSD's IBAN pattern first: INVALID_REQUEST.) */
const UNKNOWN = makeIban('EE', '7700771009999990')

const openXml = (o: { master?: string; ref?: string; user?: string } = {}) =>
  `${X}<VibanOpenRequest><MasterAccount>${o.master ?? C1.iban}</MasterAccount>${tag('ClientReference', o.ref)}${o.user ?? USER()}</VibanOpenRequest>`
const bulkXml = (amount: string | number, master = C1.iban) =>
  `${X}<VibanBulkRequest><MasterAccount>${master}</MasterAccount><Amount>${amount}</Amount></VibanBulkRequest>`
const modifyXml = (viban: string, o: { master?: string; ref?: string; user?: string; reason?: string } = {}) =>
  `${X}<VibanModifyRequest><MasterAccount>${o.master ?? C1.iban}</MasterAccount>${tag('ClientReference', o.ref)}<VirtualIBAN>${viban}</VirtualIBAN>` +
  `${o.user ?? USER()}${tag('ModifyReason', o.reason)}</VibanModifyRequest>`
const infoXml = (viban: string, master = C1.iban) =>
  `${X}<VibanInfoRequest><MasterAccount>${master}</MasterAccount><VirtualIBAN>${viban}</VirtualIBAN></VibanInfoRequest>`
const closeXml = (viban: string, master = C1.iban) =>
  `${X}<VibanCloseRequest><MasterAccount>${master}</MasterAccount><VirtualIBAN>${viban}</VirtualIBAN></VibanCloseRequest>`

// --- Calling ---------------------------------------------------------------------------

type Op = 'open' | 'bulk' | 'modify' | 'info' | 'close'
interface Who { as?: string; headers?: Record<string, string> }
interface Answer extends Msg { root: any; errors: { code: string; description: string; field?: string }[]; others: Msg[] }

/** POSTs a VIBAN request (202), then reads the caller's inbox: the answer and any other message. */
async function viban(op: Op, body: string, who: Who = {}): Promise<Answer> {
  const res = await call(ctx, { method: 'POST', url: `/viban/${op}`, body, as: who.as, headers: who.headers })
  assert.equal(res.statusCode, 202, res.body)
  const id = res.headers['message-request-id'] as string
  assert.match(id, /^REQ[0-9a-f]{32}$/)
  const msgs = await drain(ctx, who.as ?? C1.code, who.headers)
  const m = msgs.find((x) => x.requestId === id)
  assert.ok(m, `an answer to ${op} in the inbox`)
  assert.equal(m.type, `VIBAN_${op.toUpperCase()}`)
  const errors = many<any>(m.doc.Errors?.Error).map((e) => ({ code: e.ErrorCode, description: e.Description, ...(e.Field ? { field: e.Field } : {}) }))
  if (!m.doc.Errors) await valid(m.body, `viban.${op}.response`)
  const root = m.doc[`Viban${op[0].toUpperCase()}${op.slice(1)}Response`]
  return { ...m, root, errors, others: msgs.filter((x) => x !== m) }
}
const ok = async (op: Op, body: string, who: Who = {}) => {
  const a = await viban(op, body, who)
  assert.deepEqual(a.errors, [], `${op} succeeds:\n${a.body}`)
  return a
}
const fails = async (op: Op, body: string, ...expected: { code: string; description: string; field?: string }[]) => {
  const a = await viban(op, body)
  assert.deepEqual(a.errors, expected, a.body)
  return a
}
const open = async (o: Parameters<typeof openXml>[0] = {}, who: Who = {}) => (await ok('open', openXml(o), who)).root.VirtualIBAN as string
const bulk = async (n: number) => many<string>((await ok('bulk', bulkXml(n))).root.VirtualIBANList.VirtualIBAN)
const info = async (iban: string, master = C1.iban) => (await ok('info', infoXml(iban, master))).root
const sim = (url: string, body: object) => call(ctx, { method: 'POST', url: `/_sim/viban${url}`, body })
const bankStatus = async (iban: string, status: string) => {
  const r = await sim(`/${iban}/status`, { status })
  assert.equal(r.statusCode, 200, r.body)
  return json(r)
}
const notifications = async (as = C1.code) => (await drain(ctx, as)).filter((m) => m.type === 'VIBAN_STATUS_NOTIFICATION')

// =======================================================================================

describe('VIBAN open', () => {
  test('a private person: ACTIVE at once, the request echoed (P 10)', async () => {
    const a = await ok('open', openXml({ ref: 'CUST-1' }))
    const r = a.root
    assert.equal(r.MasterAccount, C1.iban)
    assert.equal(r.ClientReference, 'CUST-1')
    assert.match(r.VirtualIBAN, /^EE\d{2}7777\d{12}$/)
    assert.deepEqual(r.User.Person, { Name: 'Donald Duck', BirthDate: '1908-11-29', BirthCountry: 'DE', Residency: 'DE', DocumentNumber: 'A942819' })
    assert.deepEqual(r.User.Address, { Country: 'EE', StreetNo: 'Majaka 47-10', CityCounty: 'Tallinn' })
    assert.equal(r.Status, 'ACTIVE')
    assert.deepEqual(a.others, [], 'a user-initiated change is not notified')
    const i = await info(r.VirtualIBAN)
    assert.equal(i.DateActivated, '2026-03-10+02:00', 'xs:date with the Tallinn offset (decision 209)')
    assert.equal(i.DateClosed, undefined)
  })

  test('a legal person, without ClientReference', async () => {
    const r = (await ok('open', openXml({ user: USER(COMPANY()) }))).root
    assert.equal(r.ClientReference, undefined)
    assert.equal(r.User.Company.Name, 'Duck Holdings OÜ')
    assert.equal(r.User.Company.Representative.Name, 'Scrooge McDuck')
    assert.equal(r.Status, 'ACTIVE')
  })

  test('each VIBAN gets its own number', async () => {
    const a = await open()
    const b = await open()
    assert.notEqual(a, b)
  })

  test('INVALID_REQUEST: not XML, wrong root, missing or doubled elements', async () => {
    await fails('open', '<VibanOpenRequest><MasterAccount>', E.request)
    await fails('open', bulkXml(1).replace(/Bulk/g, 'Other'), E.request)
    await fails('open', openXml().replace(/<User>.*<\/User>/, ''), E.request)
    await fails('open', openXml({ user: USER(PERSON() + COMPANY()) }), E.request)
    await fails('open', openXml().replace(/<Address>.*<\/Address>/, ''), E.request)
    await fails('open', openXml().replace(/<Name>Donald Duck<\/Name>/, ''), E.request)
    await fails('open', openXml().replace(/<MasterAccount>.*<\/MasterAccount>/, ''), E.request)
  })

  test('INVALID_REQUEST from the published XSD: a name with digits', { skip: HAVE_VIBAN_XSD ? false : 'no VIBAN XSDs' }, async () => {
    await fails('open', openXml({ user: USER(PERSON({ name: 'Donald 2' })) }), E.request)
  })

  test('INVALID_BIRTH_DATE: format and future, also the representative', async () => {
    await fails('open', openXml({ user: USER(PERSON({ birth: '29.11.1908' })) }), E.birthFormat)
    await fails('open', openXml({ user: USER(PERSON({ birth: '1990-02-30' })) }), E.birthFormat)
    await fails('open', openXml({ user: USER(PERSON({ birth: '2026-03-11' })) }), E.birthFuture)
    await fails('open', openXml({ user: USER(COMPANY({ repBirth: '2030-01-01' })) }), E.birthFuture)
    await ok('open', openXml({ user: USER(PERSON({ birth: '2026-03-10' })) }))
  })

  test('INVALID_COUNTRY names the field; all field errors are listed together (decision 201)', async () => {
    await fails('open', openXml({ user: USER(PERSON({ birthCountry: 'XX' })) }), E.country('BirthCountry'))
    await fails('open', openXml({ user: USER(COMPANY({ tax: 'QQ' })) }), E.country('TaxResidency'))
    await fails('open', openXml({ user: USER(PERSON(), { country: 'ZZ' }) }), E.country('Country'))
    await fails('open', openXml({ user: USER(PERSON({ residency: 'XX', birth: '1990-13-01' })) }), E.birthFormat, E.country('Residency'))
  })

  test('INVALID_ACCOUNT: unknown master account, or a VIBAN given as master', async () => {
    await fails('open', openXml({ master: UNKNOWN }), E.account)
    if (HAVE_VIBAN_XSD) await fails('open', openXml({ master: DE_IBAN }), E.request)
    const v = await open()
    await fails('open', openXml({ master: v }), E.account)
  })

  test("FORBIDDEN: another customer's master account", async () => {
    await fails('open', openXml({ master: C2.iban }), E.masterForbidden)
    await fails('open', openXml({ master: SP.iban }), E.masterForbidden)
  })

  test('MASTER_ACCOUNT_AGREEMENT_MISSING until the agreement is signed (decision 202)', async () => {
    const as = { as: C2.code }
    assert.deepEqual((await viban('open', openXml({ master: C2.iban }), as)).errors, [E.agreement])
    assert.deepEqual((await viban('bulk', bulkXml(1, C2.iban), as)).errors, [E.agreement])
    const r = await sim('/agreements', { iban: C2.iban })
    assert.deepEqual(json(r), { iban: C2.iban, active: true })
    await ok('open', openXml({ master: C2.iban }), as)
    assert.equal((await sim('/agreements', { iban: DE_IBAN })).statusCode, 404)
    assert.equal((await sim('/agreements', {})).statusCode, 400)
  })

  test('ClientReference is unique per customer, closed VIBANs included (decision 204)', async () => {
    const v = await open({ ref: 'R-1' })
    await fails('open', openXml({ ref: 'R-1' }), E.refUnique)
    await ok('close', closeXml(v))
    await fails('open', openXml({ ref: 'R-1' }), E.refUnique)
    // Another customer may use the same reference.
    const sp = { as: SP.code, headers: { 'Client-Code': SP.code, 'Client-Country': 'EE' } }
    await ok('open', openXml({ master: SP.iban, ref: 'R-1' }), sp)
  })

  test('screening: a listed holder opens ON_HOLD; the bank decision is notified (decision 206)', async () => {
    const r = await sim('/screening', { names: ['Donald Duck', 'Scrooge McDuck'] })
    assert.deepEqual(json(r), { names: ['donald duck', 'scrooge mcduck'] })
    const a = await ok('open', openXml({ ref: 'S-1', user: USER(PERSON({ name: 'DONALD  DUCK' })) }))
    assert.equal(a.root.Status, 'ON_HOLD', 'case and whitespace ignored')
    assert.deepEqual(a.others, [], 'no notification for the opening itself')
    assert.equal((await ok('open', openXml({ user: USER(COMPANY()) }))).root.Status, 'ON_HOLD', 'the representative is screened too')
    assert.equal((await info(a.root.VirtualIBAN)).DateActivated, undefined)

    await bankStatus(a.root.VirtualIBAN, 'ACTIVE')
    const [n] = await notifications()
    assert.equal(n.requestId, undefined, 'unsolicited: no Message-Request-Id')
    await valid(n.body, 'viban.status.notification')
    const s = n.doc.VibanStatusNotification
    assert.equal(s.Status, 'ACTIVE')
    assert.equal(s.MasterAccount, C1.iban)
    assert.equal(s.VirtualIBAN, a.root.VirtualIBAN)
    assert.equal(s.ClientReference, 'S-1')
    assert.equal(s.User.Person.Name, 'DONALD DUCK')
    assert.equal(s.DateActivated, '2026-03-10+02:00')

    assert.equal((await sim('/screening', { names: 'x' })).statusCode, 400)
  })

  test('TECHNICAL_ERROR on an injected fault, then back to normal', async () => {
    assert.equal((await sim('/fault', { count: 1 })).statusCode, 200)
    await fails('open', openXml(), E.technical)
    await ok('open', openXml())
    assert.equal((await sim('/fault', { count: -1 })).statusCode, 400)
  })
})

describe('VIBAN bulk', () => {
  test('1 and 1000 nameless PENDING VIBANs; 0, 1001 and non-numbers are INVALID_REQUEST', async () => {
    const one = await bulk(1)
    assert.equal(one.length, 1)
    const i = await info(one[0])
    assert.equal(i.Status, 'PENDING')
    assert.equal(i.User, undefined)
    assert.equal(i.DateActivated, undefined)

    const a = await ok('bulk', bulkXml(1000))
    assert.equal(a.root.MasterAccount, C1.iban)
    const list = many<string>(a.root.VirtualIBANList.VirtualIBAN)
    assert.equal(list.length, 1000)
    assert.equal(new Set([...list, ...one]).size, 1001, 'all distinct')
    assert.ok(list.every((v) => ibanChecksumOk(v) && eeCheckDigit(v.slice(6, 19)) === Number(v[19])))

    for (const n of ['0', '1001', '-1', 'two', '1.5', '']) await fails('bulk', bulkXml(n), E.request)
  })

  test('foreign master account and agreement checks apply', async () => {
    await fails('bulk', bulkXml(1, C2.iban), E.masterForbidden)
    await fails('bulk', bulkXml(1, UNKNOWN), E.account)
  })
})

describe('VIBAN modify', () => {
  test('a nameless VIBAN gets its holder (no reason allowed while PENDING) and is activated', async () => {
    const [v] = await bulk(1)
    await fails('modify', modifyXml(v, { reason: 'why' }), E.reasonPending)
    const a = await ok('modify', modifyXml(v, { ref: 'M-1' }))
    assert.equal(a.root.Status, 'ACTIVE')
    assert.equal(a.root.ClientReference, 'M-1')
    assert.equal(a.root.VirtualIBAN, v)
    assert.equal(a.root.User.Person.Name, 'Donald Duck')
    assert.equal((await info(v)).DateActivated, '2026-03-10+02:00')
  })

  test('an active VIBAN needs a reason; the data is block-replaced', async () => {
    const v = await open({ ref: 'M-2' })
    await fails('modify', modifyXml(v), E.reasonMissing)
    ctx.clock.set('2026-07-01T10:00:00Z')
    const a = await ok('modify', modifyXml(v, { user: USER(PERSON({ name: 'Donald Mouse', doc: false }), { street: 'Uus 1' }), reason: 'Name legally changed' }))
    assert.equal(a.root.ClientReference, 'M-2', 'omitted ClientReference is kept')
    const i = await info(v)
    assert.equal(i.User.Person.Name, 'Donald Mouse')
    assert.equal(i.User.Person.DocumentNumber, undefined, 'block replace: the omitted document number is gone')
    assert.equal(i.User.Address.StreetNo, 'Uus 1')
    assert.equal(i.DateActivated, '2026-03-10+02:00', 'the first activation date stays')
  })

  test('ClientReference: set once when empty, never changed, unique', async () => {
    const v = await open({ ref: 'M-3' })
    await fails('modify', modifyXml(v, { ref: 'M-4', reason: 'x' }), E.refChange)
    await ok('modify', modifyXml(v, { ref: 'M-3', reason: 'same value' }))
    const w = await open()
    await fails('modify', modifyXml(w, { ref: 'M-3', reason: 'x' }), E.refUnique)
    assert.equal((await ok('modify', modifyXml(w, { ref: 'M-5', reason: 'x' }))).root.ClientReference, 'M-5')
  })

  test('INVALID_USER_TYPE: Person and Company do not swap', async () => {
    const v = await open()
    await fails('modify', modifyXml(v, { user: USER(COMPANY()), reason: 'x' }), E.userType)
    const c = await open({ user: USER(COMPANY()) })
    await fails('modify', modifyXml(c, { user: USER(PERSON()), reason: 'x' }), E.userType)
  })

  test('INVALID_STATUS outside ACTIVE / PENDING / ON_HOLD; ON_HOLD may be modified and is re-screened', async () => {
    const v = await open()
    await bankStatus(v, 'BLOCKED')
    await fails('modify', modifyXml(v, { reason: 'x' }), E.statusModify)
    await bankStatus(v, 'CLOSED')
    await fails('modify', modifyXml(v, { reason: 'x' }), E.statusModify)

    await sim('/screening', { names: ['Donald Duck'] })
    const h = await open()
    assert.equal((await info(h)).Status, 'ON_HOLD')
    assert.equal((await ok('modify', modifyXml(h, { user: USER(PERSON({ name: 'Daisy Duck' })), reason: 'typo' }))).root.Status, 'ACTIVE')
    assert.equal((await ok('modify', modifyXml(h, { reason: 'back' }))).root.Status, 'ON_HOLD', 'any modification re-screens')
  })

  test('INVALID_VIBAN and FORBIDDEN VirtualIBAN (decision 203)', async () => {
    await fails('modify', modifyXml('EE017777000000000000', { reason: 'x' }), E.viban)
    const sp = { as: SP.code, headers: { 'Client-Code': SP.code, 'Client-Country': 'EE' } }
    const other = (await ok('open', openXml({ master: SP.iban }), sp)).root.VirtualIBAN
    await fails('modify', modifyXml(other, { reason: 'x' }), E.vibanForbidden)
    await fails('info', infoXml(other), E.vibanForbidden)
    await fails('close', closeXml(other), E.vibanForbidden)
  })

  test('the agreement is needed for modify, not for info and close (decision 202)', async () => {
    const v = await open()
    await sim('/agreements', { iban: C1.iban, active: false })
    await fails('modify', modifyXml(v, { reason: 'x' }), E.agreement)
    await fails('open', openXml(), E.agreement)
    assert.equal((await info(v)).Status, 'ACTIVE')
    await ok('close', closeXml(v))
  })
})

describe('VIBAN info and close', () => {
  test('close: ACTIVE, PENDING and BLOCKED become CLOSED for good; others are INVALID_STATUS', async () => {
    ctx.clock.set('2026-06-01T21:30:00Z') // 2026-06-02 00:30 in Tallinn (summer time)
    const v = await open({ ref: 'C-1' })
    const a = await ok('close', closeXml(v))
    assert.deepEqual(a.root, { VirtualIBAN: v, Status: 'CLOSED', DateClosed: '2026-06-02+03:00' })
    assert.deepEqual(a.others, [], 'no notification for a user-initiated close')
    const i = await info(v)
    assert.equal(i.Status, 'CLOSED')
    assert.equal(i.ClientReference, 'C-1')
    assert.equal(i.DateActivated, '2026-06-02+03:00')
    assert.equal(i.DateClosed, '2026-06-02+03:00')
    await fails('close', closeXml(v), E.statusClose)

    const [p] = await bulk(1)
    await ok('close', closeXml(p))
    const b = await open()
    await bankStatus(b, 'BLOCKED')
    await ok('close', closeXml(b))
    await sim('/screening', { names: ['Donald Duck'] })
    await fails('close', closeXml(await open()), E.statusClose)
  })

  test('INVALID_VIBAN, INVALID_ACCOUNT and FORBIDDEN master on info and close', async () => {
    const v = await open()
    await fails('info', infoXml('EE017777000000000000'), E.viban)
    await fails('info', infoXml(v, UNKNOWN), E.account)
    await fails('close', closeXml(v, C2.iban), E.masterForbidden)
    await fails('info', infoXml(v).replace(/<VirtualIBAN>.*<\/VirtualIBAN>/, ''), E.request)
  })
})

describe('bank-side status changes (/_sim/viban)', () => {
  test('each allowed change is notified; others are 409', async () => {
    const v = await open()
    await bankStatus(v, 'BLOCKED')
    await bankStatus(v, 'ACTIVE')
    assert.equal((await sim(`/${v}/status`, { status: 'REJECTED' })).statusCode, 409)
    await bankStatus(v, 'CLOSED')
    assert.equal((await sim(`/${v}/status`, { status: 'ACTIVE' })).statusCode, 409, 'CLOSED is final')
    const ns = await notifications()
    assert.deepEqual(ns.map((n) => n.doc.VibanStatusNotification.Status), ['BLOCKED', 'ACTIVE', 'CLOSED'])
    for (const n of ns) await valid(n.body, 'viban.status.notification')
    assert.equal(ns[2].doc.VibanStatusNotification.DateClosed, '2026-03-10+02:00')

    await sim('/screening', { names: ['Donald Duck'] })
    const h = await open()
    await bankStatus(h, 'REJECTED')
    assert.equal((await sim(`/${h}/status`, { status: 'CLOSED' })).statusCode, 409, 'REJECTED is final')
    assert.equal((await info(h)).Status, 'REJECTED')
  })

  test('a nameless VIBAN closed by the bank: the notification has no User and is schema-valid', async () => {
    const [p] = await bulk(1)
    await bankStatus(p, 'CLOSED')
    const [n] = await notifications()
    assert.equal(n.doc.VibanStatusNotification.User, undefined)
    await valid(n.body, 'viban.status.notification')
  })

  test('input checks and listing', async () => {
    const v = await open({ ref: 'L-1' })
    assert.equal((await sim(`/${v}/status`, { status: 'GONE' })).statusCode, 400)
    assert.equal((await sim('/EE017777000000000000/status', { status: 'CLOSED' })).statusCode, 404)
    const list = json(await call(ctx, { url: '/_sim/viban' })).vibans
    assert.deepEqual(list.map((x: any) => x.iban), [v])
    const one = json(await call(ctx, { url: `/_sim/viban/${v}` }))
    assert.equal(one.masterAccount, C1.iban)
    assert.equal(one.clientReference, 'L-1')
    assert.equal(one.dateActivated, '2026-03-10+02:00')
    assert.equal((await call(ctx, { url: '/_sim/viban/EE017777000000000000' })).statusCode, 404)
  })
})

describe('service providers (Client-Code)', () => {
  const asC1 = { as: SP.code, headers: { 'Client-Code': C1.code, 'Client-Country': 'EE' } }

  test("a provider manages its client's VIBANs; the answer lands in the client's inbox", async () => {
    const v = await open({ ref: 'P-1' }, asC1)
    assert.equal((await ok('info', infoXml(v), asC1)).root.ClientReference, 'P-1')
    assert.equal((await info(v)).Status, 'ACTIVE', 'the client itself sees the same VIBAN')
    const a = await viban('open', openXml({ master: SP.iban }), asC1)
    assert.deepEqual(a.errors, [E.masterForbidden], "the provider's own master is not the client's")
  })

  test('a provider without Client-Code is refused before the service runs', async () => {
    const r = await call(ctx, { method: 'POST', url: '/viban/open', body: openXml({ master: SP.iban }), as: SP.code })
    assert.equal(r.statusCode, 403)
  })
})

describe('VIBAN_ERRORS=sync (decision 200)', () => {
  const post = (op: Op, body: string) => call(ctx, { method: 'POST', url: `/viban/${op}`, body })
  const codes = (r: { body: string }) => [...r.body.matchAll(/<ErrorCode>([A-Z_]+)</g)].map((m) => m[1])

  test('business errors come back in the HTTP answer: 403 FORBIDDEN, 500 TECHNICAL_ERROR, else 400', async () => {
    ctx = await setup({ vibanErrors: 'sync' })
    let r = await post('open', openXml({ master: C2.iban }))
    assert.equal(r.statusCode, 403)
    assert.deepEqual(codes(r), ['FORBIDDEN'])
    r = await post('open', openXml({ master: UNKNOWN }))
    assert.equal(r.statusCode, 400)
    assert.match(r.body, /<Errors><Error><ErrorCode>INVALID_ACCOUNT<\/ErrorCode><Description>Account does not exist\.<\/Description><Field>MasterAccount<\/Field><\/Error><\/Errors>/)
    await sim('/fault', { count: 1 })
    assert.equal((await post('bulk', bulkXml(1))).statusCode, 500)
    assert.deepEqual(await drain(ctx), [], 'nothing in the inbox')
    r = await post('bulk', bulkXml(1))
    assert.equal(r.statusCode, 202, 'success still goes through the inbox')
    assert.equal((await drain(ctx))[0].type, 'VIBAN_BULK')
  })

  test('switchable at run time with POST /_sim/viban/errors', async () => {
    assert.deepEqual(json(await sim('/errors', { delivery: 'sync' })), { delivery: 'sync' })
    assert.equal((await post('open', openXml({ master: UNKNOWN }))).statusCode, 400)
    await sim('/errors', { delivery: 'inbox' })
    assert.equal((await post('open', openXml({ master: UNKNOWN }))).statusCode, 202)
    assert.equal((await sim('/errors', { delivery: 'mail' })).statusCode, 400)
  })
})

describe('VIBAN numbers (decision 205)', () => {
  test('EE: bank code 77, account 77…, 7-3-1 national check digit, mod-97 IBAN check', async () => {
    for (const v of await bulk(20)) {
      assert.match(v, /^EE\d{2}777700000000\d{4}$/)
      assert.ok(ibanChecksumOk(v), v)
      assert.equal(eeCheckDigit(v.slice(6, 19)), Number(v[19]), v)
    }
  })

  test('the published VIBAN and master numbers pass the same checks', () => {
    for (const v of ['EE867777000202527783', 'EE717777000200014007', 'EE507777000200014094', 'EE467777000010897825', 'EE837700771001625166']) {
      assert.ok(ibanChecksumOk(v), v)
      assert.equal(eeCheckDigit(v.slice(6, 19)), Number(v[19]), v)
    }
    // The bulk sample's master differs from the others only in the IBAN check digits, which are wrong.
    assert.equal(ibanChecksumOk('EE737700771001625166'), false)
  })

  test("GB: the master's bank and sort code, an account number starting 7", async () => {
    const gb = makeIban('GB', 'LHVB04000312345678')
    const s = seed()
    s.customers.push({ code: '20000001', country: 'GB', name: 'UK Provider Ltd', accounts: [{ iban: gb, balances: { GBP: '10.00' }, viban: true }] })
    ctx = await setup({}, s)
    const who = { as: '20000001' }
    const a = await ok('open', openXml({ master: gb, user: USER(COMPANY({ name: 'UK Ltd' }), { country: 'GB' }) }), who)
    const v = a.root.VirtualIBAN as string
    assert.match(v, /^GB\d{2}LHVB0400037\d{7}$/)
    assert.ok(ibanChecksumOk(v))
    const list = many<string>((await ok('bulk', bulkXml(3, gb), who)).root.VirtualIBANList.VirtualIBAN)
    assert.ok(list.every((x) => /^GB\d{2}LHVB0400037\d{7}$/.test(x) && ibanChecksumOk(x)))
  })
})

// --- Payments ------------------------------------------------------------------------

/** The entries of the camt.054 notifications in a set of messages. */
function entries(msgs: Msg[]) {
  return msgs.filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION').map((m) => {
    const n = m.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn
    const e = n.Ntry
    const p = e.NtryDtls.TxDtls.RltdPties ?? {}
    return {
      body: m.body, ns: /tech:xsd:(camt\.054\.001\.\d\d)/.exec(m.body)?.[1] ?? '', account: n.Acct.Id.IBAN, ind: e.CdtDbtInd, amount: e.Amt['#text'],
      dbtr: p.Dbtr?.Nm ?? p.Dbtr?.Pty?.Nm, dbtrCtry: p.Dbtr?.PstlAdr?.Ctry ?? p.Dbtr?.Pty?.PstlAdr?.Ctry, dbtrAcct: p.DbtrAcct?.Id?.IBAN,
      cdtr: p.Cdtr?.Nm ?? p.Cdtr?.Pty?.Nm, cdtrCtry: p.Cdtr?.PstlAdr?.Ctry ?? p.Cdtr?.Pty?.PstlAdr?.Ctry, cdtrAcct: p.CdtrAcct?.Id?.IBAN,
    }
  })
}
async function camtValid(es: ReturnType<typeof entries>) {
  if (!HAVE_REFERENCE) return
  for (const e of es) assert.deepEqual(await xsd.validate(e.body, e.ns), [], e.body)
}
/** The entries of the master's camt.053 for today (camt.060.001.05 → 08, .03 → 02; schema-checked by drain). */
async function statementEntries(version: '05' | '03', iban = C1.iban) {
  const { msgs } = await report(ctx, { version, kind: 'statement', iban })
  return msgs.flatMap((m) => many<any>(m.doc.Document.BkToCstmrStmt.Stmt)).flatMap((st) => many<any>(st.Ntry).map((e) => ({
    acct: st.Acct.Id.IBAN, ind: e.CdtDbtInd, ref: e.AcctSvcrRef, pties: e.NtryDtls.TxDtls.RltdPties ?? {},
  })))
}
const incoming = (iban: string, amount = '25.00') =>
  call(ctx, { method: 'POST', url: '/_sim/incoming', body: { iban, amount, debtor: { name: 'Outside Payer', iban: DE_IBAN } } })

/** Pays a pain.001 and returns the transaction statuses / reasons of its pain.002 and the caller's camt.054 entries. */
async function pay(xml: string, as = C1.code) {
  const res = await call(ctx, { method: 'POST', url: '/payment', body: xml, as })
  assert.equal(res.statusCode, 202, res.body)
  const msgs = await drain(ctx, as)
  const reports = msgs.filter((m) => m.type === 'PAYMENT').map((m) => m.body)
  const sts = reports.flatMap((b) => [...b.matchAll(/<(?:GrpSts|TxSts)>([A-Z]+)</g)].map((x) => x[1]))
  const reasons = reports.flatMap((b) => [...b.matchAll(/<AddtlInf>([^<]+)</g)].map((x) => x[1]))
  return { sts, reasons, entries: entries(msgs), reports }
}

describe('payments to a VIBAN (decision 207)', () => {
  test('an incoming credit is booked on the master; camt.054 shows the VIBAN as creditor', async () => {
    const v = await open({ user: USER(COMPANY({ name: 'Company of John' }), { country: 'GB' }) })
    const before = await balance(ctx, C1.iban)
    const r = json(await incoming(v))
    assert.equal(r.masterAccount, C1.iban)
    assert.ok(r.accountServicerReference)
    assert.equal(await balance(ctx, C1.iban), (Number(before) + 25).toFixed(2))
    const [e] = entries(await drain(ctx))
    assert.deepEqual({ account: e.account, ind: e.ind, amount: e.amount, cdtr: e.cdtr, cdtrCtry: e.cdtrCtry, cdtrAcct: e.cdtrAcct, dbtr: e.dbtr, dbtrAcct: e.dbtrAcct },
      { account: C1.iban, ind: 'CRDT', amount: '25.00', cdtr: 'Company of John', cdtrCtry: 'GB', cdtrAcct: v, dbtr: 'Outside Payer', dbtrAcct: DE_IBAN })
    await camtValid([e])
  })

  test('camt.054.001.08 customers get the VIBAN party wrapped in Pty, schema-valid both ways', async () => {
    const s = seed()
    s.customers[0].camt054 = '08'
    ctx = await setup({}, s)
    const v = await open({ user: USER(COMPANY({ name: 'Company of John' }), { country: 'GB' }) })
    await incoming(v)
    const [c] = entries(await drain(ctx))
    const r = await pay(pain001([{ debtorIban: v, debtorName: 'Company of John', txs: [{ amount: '5.00' }] }]))
    const [d] = r.entries
    const es = [c, d]
    assert.deepEqual(es.map((e) => e.ns), ['camt.054.001.08', 'camt.054.001.08'])
    assert.deepEqual([c.cdtr, c.cdtrCtry, c.cdtrAcct], ['Company of John', 'GB', v])
    assert.deepEqual([d.dbtr, d.dbtrCtry, d.dbtrAcct], ['Company of John', 'GB', v])
    assert.ok(/<Dbtr><Pty><Nm>Company of John<\/Nm>/.test(d.body.replace(/\s+</g, '<')))
    await camtValid(es)
  })

  test('to a VIBAN that is not ACTIVE: returned (AC04 closed for good, AC06 for now), nothing booked', async () => {
    const before = await balance(ctx, C1.iban)
    const [pending] = await bulk(1)
    const closed = await open()
    await ok('close', closeXml(closed))
    const blocked = await open()
    await bankStatus(blocked, 'BLOCKED')
    await sim('/screening', { names: ['Donald Duck'] })
    const held = await open()
    const rejected = await open()
    await bankStatus(rejected, 'REJECTED')
    await drain(ctx)
    for (const [v, reason, description] of [
      [pending, 'AC06', 'Account temporarily closed.'], [held, 'AC06', 'Account temporarily closed.'], [blocked, 'AC06', 'Account temporarily closed.'],
      [closed, 'AC04', 'Creditor account is closed.'], [rejected, 'AC04', 'Creditor account is closed.'],
    ]) {
      const r = json(await incoming(v))
      assert.equal(r.returned, true, v)
      assert.equal(r.reason, reason)
      assert.equal(r.description, description)
    }
    assert.equal(await balance(ctx, C1.iban), before)
    assert.deepEqual(await drain(ctx), [])
  })

  test('an internal pain.001 to a VIBAN credits the master; to an inactive one it is rejected', async () => {
    const v = await open()
    const c2 = await pay(pain001([{ debtorIban: C2.iban, debtorName: 'Demo Customer 2', txs: [{ amount: '10.00', creditorIban: v, creditorName: 'Donald Duck' }] }]), C2.code)
    assert.ok(c2.sts.every((s) => s === 'ACSC'), c2.sts.join())
    assert.equal(await balance(ctx, C2.iban), '90.00')
    assert.equal(await balance(ctx, C1.iban), '10010.00')
    const [e] = entries(await drain(ctx))
    assert.equal(e.account, C1.iban)
    assert.equal(e.cdtrAcct, v)
    assert.equal(e.cdtr, 'Donald Duck')
    await camtValid([e])

    await bankStatus(v, 'BLOCKED')
    let r = await pay(pain001([{ debtorIban: C2.iban, debtorName: 'Demo Customer 2', txs: [{ amount: '1.00', creditorIban: v }] }]), C2.code)
    assert.ok(r.sts.includes('RJCT'))
    assert.deepEqual(r.reasons, ['Account temporarily closed.'])
    await bankStatus(v, 'CLOSED')
    r = await pay(pain001([{ debtorIban: C2.iban, debtorName: 'Demo Customer 2', txs: [{ amount: '1.00', creditorIban: v }] }]), C2.code)
    assert.deepEqual(r.reasons, ['Creditor account is closed.'])
    assert.equal(await balance(ctx, C2.iban), '90.00')
  })
})

describe('payments from a VIBAN (decision 208)', () => {
  test('debited from the master; camt.054 shows the holder and the VIBAN as debtor', async () => {
    const v = await open({ user: USER(COMPANY({ name: 'Company of John' }), { country: 'GB' }) })
    const r = await pay(pain001([{ debtorIban: v, debtorName: 'company  of JOHN', txs: [{ amount: '5.00' }] }]))
    assert.ok(r.sts.length && r.sts.every((s) => s === 'ACSC'), r.sts.join())
    assert.equal(await balance(ctx, C1.iban), '9995.00')
    assert.equal(await balance(ctx, C2.iban), '105.00')
    const [e] = r.entries
    assert.deepEqual({ account: e.account, ind: e.ind, dbtr: e.dbtr, dbtrCtry: e.dbtrCtry, dbtrAcct: e.dbtrAcct, cdtrAcct: e.cdtrAcct },
      { account: C1.iban, ind: 'DBIT', dbtr: 'Company of John', dbtrCtry: 'GB', dbtrAcct: v, cdtrAcct: C2.iban })
    await camtValid(r.entries)
    const [c] = entries(await drain(ctx, C2.code))
    assert.deepEqual([c.account, c.ind, c.dbtrAcct], [C2.iban, 'CRDT', v], 'the creditor sees the VIBAN, not the master')
    await camtValid([c])
  })

  test("the master's camt.053 shows the VIBAN as own side: holder name without Id, the VIBAN as account (decision 551)", async () => {
    const v = await open({ user: USER(COMPANY({ name: 'Company of John' }), { country: 'GB' }) })
    const credit = json(await incoming(v)).accountServicerReference
    const r = await pay(pain001([{ debtorIban: v, debtorName: 'Company of John', txs: [{ amount: '5.00' }] }]))
    assert.ok(r.sts.every((x) => x === 'ACSC'), r.sts.join())
    await pay(pain001([{ debtorIban: C1.iban, debtorName: 'Demo Customer 1', txs: [{ amount: '1.00' }] }]))
    const v8 = await statementEntries('05')
    const viaV = (es: typeof v8) => es.filter((e) => e.ref === credit || e.pties.DbtrAcct?.Id?.IBAN === v)
    // v08: Pty with the holder's name and address (country and address line, as in camt.054).
    assert.deepEqual(viaV(v8).map((e) => [e.acct, e.ind, e.ind === 'CRDT' ? e.pties.Cdtr : e.pties.Dbtr, e.ind === 'CRDT' ? e.pties.CdtrAcct.Id.IBAN : e.pties.DbtrAcct.Id.IBAN]), [
      [C1.iban, 'CRDT', { Pty: { Nm: 'Company of John', PstlAdr: { Ctry: 'GB', AdrLine: viaV(v8)[0].pties.Cdtr.Pty.PstlAdr.AdrLine } } }, v],
      [C1.iban, 'DBIT', { Pty: { Nm: 'Company of John', PstlAdr: { Ctry: 'GB', AdrLine: viaV(v8)[1].pties.Dbtr.Pty.PstlAdr.AdrLine } } }, v],
    ])
    assert.equal(viaV(v8)[0].pties.Dbtr.Pty.Nm, 'Outside Payer', 'the counterparty is unchanged')
    // v02: the name alone, as the published 053A.
    const v2 = await statementEntries('03')
    assert.deepEqual(viaV(v2).map((e) => [e.ind, e.ind === 'CRDT' ? e.pties.Cdtr : e.pties.Dbtr]), [['CRDT', { Nm: 'Company of John' }], ['DBIT', { Nm: 'Company of John' }]])
    // A payment from the master itself keeps the owner with its Id and the master IBAN.
    const own = v2.find((e) => e.ind === 'DBIT' && e.pties.DbtrAcct?.Id?.IBAN === C1.iban)!
    assert.deepEqual(own.pties.Dbtr, { Nm: 'Demo Customer 1', Id: { OrgId: { Othr: { Id: C1.code } } } })
    // camt.052: balances only, the VIBAN is never named; a request for the VIBAN itself is refused (decision 552).
    for (const version of ['05', '03'] as const) {
      const [m] = (await report(ctx, { version, kind: 'balance' })).msgs
      assert.ok(m.doc.Document.BkToCstmrAcctRpt && !m.body.includes(v))
      assert.ok(reportError((await report(ctx, { version, kind: 'balance', iban: v })).msgs[0]))
    }
  })

  test('rejected when the name differs from the holder or the VIBAN is not ACTIVE', async () => {
    const v = await open()
    let r = await pay(pain001([{ debtorIban: v, debtorName: 'Mickey Mouse', txs: [{ amount: '5.00' }] }]))
    assert.ok(r.sts.includes('RJCT'))
    assert.deepEqual(r.reasons, ['Invalid debtor’s name.'])
    await bankStatus(v, 'BLOCKED')
    r = await pay(pain001([{ debtorIban: v, debtorName: 'Donald Duck', txs: [{ amount: '5.00' }] }]))
    assert.deepEqual(r.reasons, ['Debtor’s account not active.'])
    const [p] = await bulk(1)
    r = await pay(pain001([{ debtorIban: p, debtorName: 'Donald Duck', txs: [{ amount: '5.00' }] }]))
    assert.deepEqual(r.reasons, ['Debtor’s account not active.'], 'a nameless VIBAN cannot pay')
    assert.equal(await balance(ctx, C1.iban), '10000.00')
  })

  test("another customer cannot pay from someone's VIBAN", async () => {
    const v = await open()
    const r = await pay(pain001([{ debtorIban: v, debtorName: 'Donald Duck', txs: [{ amount: '5.00', creditorIban: C2.iban }] }]), C2.code)
    assert.ok(r.sts.includes('RJCT'), r.sts.join())
    assert.equal(await balance(ctx, C1.iban), '10000.00')
  })
})

// --- Published samples -----------------------------------------------------------------

const DOC = join(MIRROR_DIR, 'docs/partners/10-virtual-iban-services.md')
const HAVE_DOC = existsSync(DOC)

/** The XML samples of P 10 by "<op>/<request|response>/<variant>", e.g. "open/request/private person". */
function docSamples(): Map<string, string> {
  const out = new Map<string, string>()
  let op = '', part = '', variant = ''
  const lines = readFileSync(DOC, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    let m: RegExpExecArray | null
    if ((m = /^### Virtual IBAN (\w+)/.exec(l))) { op = m[1].toLowerCase(); part = 'response'; variant = '' }
    else if ((m = /^#### (Request|Response)/.exec(l))) { part = m[1].toLowerCase(); variant = '' }
    else if ((m = /^###### (.+)/.exec(l))) variant = m[1].trim().toLowerCase()
    else if (l.startsWith('```xml')) {
      const end = lines.indexOf('```', i + 1)
      out.set(`${op}/${part}/${variant}`, lines.slice(i + 1, end).join('\n'))
      i = end
    }
  }
  return out
}
/** Element paths in document order: the shape both sides must share. */
const shape = (xml: string) => {
  const out: string[] = []
  const stack: string[] = []
  for (const m of xml.replace(/<\?[^>]*\?>/g, '').matchAll(/<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g)) {
    if (m[1]) stack.pop()
    else { stack.push(m[2]); out.push(stack.join('/')); if (m[3]) stack.pop() }
  }
  return out
}

describe('published samples (P 10)', { skip: HAVE_DOC ? false : 'docs mirror not available' }, () => {
  const MASTER = 'EE837700771001625166'
  const PSP = '12340009'
  const S = HAVE_DOC ? docSamples() : new Map<string, string>()
  const who = { as: PSP }
  beforeEach(async () => {
    const s = seed()
    s.customers.push({ code: PSP, country: 'EE', name: 'Sample PSP', accounts: [{ iban: MASTER, balances: { EUR: '100.00' }, viban: true }] })
    ctx = await setup({}, s)
  })
  /** Puts a published VIBAN under the sample master, as the open sample of that variant would have. */
  const register = async (iban: string, variant: string, status: Viban['status'] = 'ACTIVE') => {
    const a = await ok('open', S.get(`open/request/${variant}`)!, who)
    const v = ctx.emulator.viban.registry.get(a.root.VirtualIBAN)!
    ctx.emulator.viban.registry.add({ ...v, iban, status })
    v.clientReference = undefined // the generated one gives its reference to the published number
  }

  test('the document has every request and response sample', () => {
    for (const k of ['open/request/private person', 'open/request/legal person', 'open/response/private person', 'open/response/legal person',
      'bulk/request/', 'bulk/response/', 'modify/request/private person', 'modify/request/legal person', 'modify/response/private person',
      'info/request/', 'info/response/private person', 'info/response/legal person', 'close/request/', 'close/response/',
      'status/response/private person', 'status/response/legal person']) assert.ok(S.has(k), k)
  })

  for (const variant of ['private person', 'legal person']) {
    test(`open, ${variant}: the published response, but our VIBAN number`, async () => {
      const a = await ok('open', S.get(`open/request/${variant}`)!, who)
      const want = S.get(`open/response/${variant}`)!
      assert.deepEqual(shape(a.body), shape(want))
      const strip = (x: string) => x.replace(/<VirtualIBAN>[^<]*<\/VirtualIBAN>/, '').replace(/<\?[^>]*\?>/, '').replace(/>\s+</g, '><').trim()
      assert.equal(strip(a.body), strip(want))
    })

    test(`modify and info, ${variant}: accepted, the published response shape`, async () => {
      await register('EE717777000200014007', variant)
      const m = await ok('modify', S.get(`modify/request/${variant}`)!, who)
      assert.deepEqual(shape(m.body), shape(S.get(`modify/response/${variant}`)!))
      assert.equal(m.root.Status, 'ACTIVE')
      await ok('close', S.get('close/request/')!, who)
      const i = await ok('info', S.get('info/request/')!, who)
      assert.deepEqual(shape(i.body), shape(S.get(`info/response/${variant}`)!), 'with DateActivated and DateClosed')
    })

    test(`status notification, ${variant}: the published shape`, async () => {
      await register('EE717777000200014007', variant, 'ON_HOLD')
      ctx.emulator.viban.registry.get('EE717777000200014007')!.clientReference = '12345678'
      await bankStatus('EE717777000200014007', 'ACTIVE')
      await bankStatus('EE717777000200014007', 'CLOSED')
      const ns = await notifications(PSP)
      assert.deepEqual(shape(ns[1].body), shape(S.get(`status/response/${variant}`)!))
      for (const n of ns) await valid(n.body, 'viban.status.notification')
    })
  }

  test('bulk: the published response shape (the sample master, whose IBAN check digits are wrong, is replaced)', async () => {
    const a = await ok('bulk', S.get('bulk/request/')!.replace('EE737700771001625166', MASTER), who)
    assert.deepEqual(shape(a.body), shape(S.get('bulk/response/')!))
    assert.deepEqual((await viban('bulk', S.get('bulk/request/')!, who)).errors, [E.account], 'as published: no such account')
  })

  test('close: the published response', async () => {
    await register('EE717777000200014007', 'private person')
    const a = await ok('close', S.get('close/request/')!, who)
    const want = S.get('close/response/')!
    assert.deepEqual(shape(a.body), shape(want))
    assert.equal(a.root.VirtualIBAN, 'EE717777000200014007')
  })

  test('every published request is schema-valid', { skip: HAVE_VIBAN_XSD ? false : 'no VIBAN XSDs' }, async () => {
    for (const [k, xml] of S) {
      const [op, part] = k.split('/')
      const schema = op === 'status' ? 'viban.status.notification' : `viban.${op}.${part}`
      assert.deepEqual(await vx.validate(xml, schema), [], k)
    }
  })

  test('the error table matches ours code for code, description for description', () => {
    const text = readFileSync(DOC, 'utf8')
    const table = text.slice(text.indexOf('### Virtual IBAN Error Codes'))
    const ours: VibanError[] = Object.values(E).map((e) => (typeof e === 'function' ? e('Country') : e))
    let rows = 0
    for (const m of table.matchAll(/^\| ‘([A-Z_]+)’ \| ([^|]+) \| ([^|]+) \|$/gm)) {
      const fields = [...m[3].matchAll(/<(\w+)>/g)].map((f) => f[1])
      for (const d of m[2].trim().split(/(?<=\.)(?=[A-Z])/)) {
        rows++
        const e = ours.find((o) => o.code === m[1] && o.description === d)
        assert.ok(e, `${m[1]} "${d}"`)
        if (fields.length && e.code !== 'INVALID_COUNTRY') assert.ok(fields.includes(e.field!), `${m[1]} field ${e.field}`)
      }
    }
    assert.equal(rows, 17)
  })
})

describe('PAYMENT_VIBAN_SEPA sample', { skip: sample('PAYMENT_VIBAN_SEPA', 'PAYMENT_PAIN.001.xml') ? false : 'docs mirror not available' }, () => {
  test('a SEPA payment from a VIBAN: same statuses, camt.054 parties as published', async () => {
    const xml = sample('PAYMENT_VIBAN_SEPA', 'PAYMENT_PAIN.001.xml')!
    ctx = await setup({ strictIban: false })
    const VIBAN = 'EE467777000010897825'
    const user: VibanUser = {
      company: { Name: 'Company of John', CountryOfOrigin: 'GB', TaxResidency: 'GB', RegistrationNumber: '0000', Representative: { Name: 'John', BirthDate: '1980-09-24', Residency: 'GB' } },
      address: { Country: 'GB', StreetNo: 'ADDRESS', CityCounty: 'London' },
    }
    ctx.emulator.viban.registry.add({ iban: VIBAN, master: C1.iban, owner: { code: C1.code, country: 'EE' }, status: 'ACTIVE', user, createdAt: new Date() })
    await call(ctx, { method: 'POST', url: '/_sim/rails/no-instant', body: { account: 'ES0000000000000000000000' } })
    const r = await pay(xml)
    const statuses = (doc: string) => [...doc.matchAll(/<(GrpSts|TxSts)>([A-Z]+)</g)].map((m) => `${m[1]}=${m[2]}`)
    assert.deepEqual(statuses(r.reports[0]), statuses(sample('PAYMENT_VIBAN_SEPA', 'PAYMENT_PAIN.002A.xml')!))
    assert.ok(statuses(sample('PAYMENT_VIBAN_SEPA', 'PAYMENT_PAIN.002B.xml')!).every((s) => r.reports.slice(1).some((b) => statuses(b).includes(s))))
    assert.equal(await balance(ctx, C1.iban), '9999.00')
    const [e] = r.entries
    const want = entries([{ type: 'CREDIT_DEBIT_NOTIFICATION', id: '', body: '', doc: (await import('../src/xml.js')).parseXml(sample('PAYMENT_VIBAN_SEPA', 'CREDIT_DEBIT_NOTIFICATION_CAMT.054A.xml')!) }])[0]
    for (const k of ['ind', 'amount', 'dbtr', 'dbtrCtry', 'dbtrAcct', 'cdtr', 'cdtrAcct'] as const) assert.equal(e[k], want[k], k)
    assert.equal(e.account, C1.iban, 'the master account, as the published Acct is the master')
    await camtValid(r.entries)
    // The master's camt.053.001.02 (the sample's camt.060 asks for it) shows the parties as ACCOUNT_STATEMENT_CAMT.053A.
    const [st] = (await statementEntries('03')).filter((x) => x.ind === 'DBIT')
    const pub = parseXml(sample('PAYMENT_VIBAN_SEPA', 'ACCOUNT_STATEMENT_CAMT.053A.xml')!).Document.BkToCstmrStmt.Stmt
    assert.equal(st.acct, C1.iban, 'the master: C1 stands in for the sample master')
    assert.deepEqual(st.pties, pub.Ntry.NtryDtls.TxDtls.RltdPties)
  })
})
