// Two emulators on one namespace writing the same thing at once (decisions 1008-1012): a
// read-modify-write of a VIBAN, the /_sim/viban fault count, the FX pricing settings and a
// UK webhook configuration loses neither write, a VIBAN clientReference, a UK webhook
// message type and an EE subscription URL are taken once, and a seeded contract listed by
// both at once is listed by both. Run against memory keyed stores
// shared by both emulators, each call 1-7 ms late at random (decision 960), and against
// Postgres when DATABASE_URL is set.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { EmulatorOptions } from '../src/emulator.js'
import { MemoryKeyed, type KeyedStore } from '../src/keyed.js'
import { C1, call, deferred, drain, postgresStore, setup, type Ctx } from './helpers.js'

/** Memory keyed stores shared by every emulator built from these options, each deferred. */
function sharedKeyed(): EmulatorOptions {
  const kinds = new Map<string, KeyedStore<unknown>>()
  return {
    keyed: (clock) => <V>(kind: string, bounds: { max: number; ttlMs?: number }) => {
      if (!kinds.has(kind)) kinds.set(kind, deferred(new MemoryKeyed<unknown>(clock, bounds)))
      return kinds.get(kind) as KeyedStore<V>
    },
  }
}

const STORES: [string, () => Promise<EmulatorOptions>][] = [['shared deferred memory', async () => sharedKeyed()]]
if (process.env.DATABASE_URL) STORES.push(['postgres', () => postgresStore()])

const X = '<?xml version="1.0" encoding="UTF-8"?>'
const USER = (name = 'Donald Duck') => `<User><Person><Name>${name}</Name><BirthDate>1908-11-29</BirthDate><BirthCountry>DE</BirthCountry><Residency>DE</Residency>` +
  '<DocumentNumber>A942819</DocumentNumber></Person><Address><Country>EE</Country><StreetNo>Majaka 47-10</StreetNo><CityCounty>Tallinn</CityCounty></Address></User>'
const tag = (t: string, v?: string) => (v === undefined ? '' : `<${t}>${v}</${t}>`)
const openXml = (ref?: string) => `${X}<VibanOpenRequest><MasterAccount>${C1.iban}</MasterAccount>${tag('ClientReference', ref)}${USER()}</VibanOpenRequest>`
const infoXml = (v: string) => `${X}<VibanInfoRequest><MasterAccount>${C1.iban}</MasterAccount><VirtualIBAN>${v}</VirtualIBAN></VibanInfoRequest>`
const closeXml = (v: string) => `${X}<VibanCloseRequest><MasterAccount>${C1.iban}</MasterAccount><VirtualIBAN>${v}</VirtualIBAN></VibanCloseRequest>`
const modifyXml = (v: string, ref: string) =>
  `${X}<VibanModifyRequest><MasterAccount>${C1.iban}</MasterAccount>${tag('ClientReference', ref)}<VirtualIBAN>${v}</VirtualIBAN>${USER('Daisy Duck')}<ModifyReason>moved</ModifyReason></VibanModifyRequest>`

/** Sends VIBAN requests at once, each [emulator, op, body], and answers their documents in order. */
async function vibans(sent: [Ctx, string, string][]): Promise<any[]> {
  const res = await Promise.all(sent.map(([ctx, op, body]) => call(ctx, { method: 'POST', url: `/viban/${op}`, body, as: C1.code })))
  for (const r of res) assert.equal(r.statusCode, 202, r.body)
  // Postgres shares the inbox, memory gives each emulator its own: read both.
  const all = [...new Set(sent.map(([ctx]) => ctx))]
  const msgs = (await Promise.all(all.map((ctx) => drain(ctx)))).flat()
  return res.map((r) => {
    const m = msgs.find((x) => x.requestId === r.headers['message-request-id'])
    assert.ok(m, 'an answer')
    return m.doc
  })
}
const errorCode = (doc: any): string | undefined => {
  const e = doc.Errors?.Error
  return e === undefined ? undefined : String((Array.isArray(e) ? e[0] : e).ErrorCode ?? JSON.stringify(e))
}

for (const [name, make] of STORES) {
  describe(`two emulators writing at once (${name})`, () => {
    const two = async (appOpts = {}) => {
      const opts = await make()
      return [await setup(opts, undefined, appOpts), await setup(opts, undefined, appOpts)] as const
    }

    test('a VIBAN modified on one and closed on the other at once: neither write is lost (decision 1009)', async () => {
      const [a, b] = await two()
      const opened = await vibans(Array.from({ length: 6 }, () => [a, 'open', openXml()] as [Ctx, string, string]))
      const ibans = opened.map((d) => d.VibanOpenResponse.VirtualIBAN as string)
      const answers = await vibans(ibans.flatMap((v, i) => [[a, 'modify', modifyXml(v, `M-${i}`)], [b, 'close', closeXml(v)]] as [Ctx, string, string][]))
      for (const [i, v] of ibans.entries()) {
        const [modified, closed] = [answers[2 * i], answers[2 * i + 1]]
        assert.ok(closed.VibanCloseResponse, JSON.stringify(closed))
        const now = (await call(a, { url: `/_sim/viban/${v}` })).json()
        assert.equal(now.status, 'CLOSED', `${v}: the close is not lost`)
        if (modified.VibanModifyResponse) assert.equal(now.clientReference, `M-${i}`, `${v}: the modify answered is not lost`)
        else assert.ok(modified.Errors, JSON.stringify(modified))
      }
    })

    test('one clientReference opened on both at once: one VIBAN, the other refused (decision 1009)', async () => {
      const [a, b] = await two()
      for (const ref of ['R-1', 'R-2', 'R-3']) {
        const [x, y] = await vibans([[a, 'open', openXml(ref)], [b, 'open', openXml(ref)]])
        assert.equal([x, y].filter((d) => d.VibanOpenResponse).length, 1, `${ref}: ${JSON.stringify([x, y])}`)
        const listed = (await call(a, { url: '/_sim/viban' })).json().vibans.filter((v: any) => v.clientReference === ref)
        assert.equal(listed.length, 1, `${ref}: one VIBAN`)
      }
    })

    test('one /_sim/viban fault used by two emulators at once fails one request (decision 1010)', async () => {
      const [a, b] = await two()
      const [{ VibanOpenResponse: { VirtualIBAN: v } }] = await vibans([[a, 'open', openXml()]])
      for (let i = 0; i < 3; i++) {
        assert.equal((await call(a, { method: 'POST', url: '/_sim/viban/fault', body: { count: 1 } })).statusCode, 200)
        const docs = await vibans([[a, 'info', infoXml(v)], [b, 'info', infoXml(v)]])
        assert.equal(docs.filter((d) => d.Errors).length, 1, JSON.stringify(docs))
      }
    })

    test('FX pricing changed in two parts at once keeps both (decision 1011)', async () => {
      const [a, b] = await two()
      for (let i = 1; i <= 3; i++) {
        const [r1, r2] = await Promise.all([
          call(a, { method: 'PUT', url: '/_sim/fx/pricing', body: { margin: `0.00${i}` } }),
          call(b, { method: 'PUT', url: '/_sim/fx/pricing', body: { rates: { USD: `1.1${i}` } } }),
        ])
        assert.equal(r1.statusCode, 200, r1.body)
        assert.equal(r2.statusCode, 200, r2.body)
        const p = (await call(a, { url: '/_sim/fx/pricing' })).json()
        assert.equal(p.margin, Number(`0.00${i}`), 'the margin is not lost')
        assert.equal(p.rates.USD, Number(`1.1${i}`), 'the rate is not lost')
      }
    })

    test('a UK webhook configuration edited on both at once keeps both edits; one message type made once (decision 1012)', async () => {
      const [a, b] = await two({ flavour: 'UK' })
      const owner = { code: C1.code, country: C1.country }
      const made = await Promise.all([a, b, a, b].map((ctx) => ctx.emulator.webhooksUk.create(owner, { messageType: 'PAYMENT_STATUS', requestUrl: 'https://x.test/1', active: true })))
      assert.equal(made.filter((c) => c).length, 1, 'one configuration of the type')
      assert.equal((await a.emulator.webhooksUk.list(owner)).length, 1)
      const cfg = made.find((c) => c)!
      for (let i = 0; i < 3; i++) {
        await Promise.all([
          a.emulator.webhooksUk.update(cfg, { requestUrl: `https://x.test/u${i}`, sharedSecret: 's'.repeat(32) }),
          b.emulator.webhooksUk.update(cfg, { compressionEnabled: i % 2 === 0, sharedSecret: 's'.repeat(32) }),
        ])
        const now = (await a.emulator.webhooksUk.get(owner, cfg.subscriptionReference))!
        assert.equal(now.requestUrl, `https://x.test/u${i}`, 'the URL is not lost')
        assert.equal(now.compressionEnabled, i % 2 === 0, 'the compression flag is not lost')
      }
    })

    test('the contracts of seeded connections listed by both at once: both list them, made once (decision 1013)', async () => {
      for (let i = 0; i < 5; i++) {
        const [a, b] = await two()
        const lists = await Promise.all([a, b].map(async (ctx) => (await call(ctx, { url: '/_sim/contracts' })).json().contracts as { id: string }[]))
        const after = (await call(a, { url: '/_sim/contracts' })).json().contracts as { id: string }[]
        assert.ok(after.length > 0, 'a seeded connection')
        assert.deepEqual(lists.map((l) => l.map((c) => c.id).sort()), [after.map((c) => c.id).sort(), after.map((c) => c.id).sort()])
      }
    })

    test('an EE subscription to one URL made on both at once is one subscription (decision 1012)', async () => {
      const [a, b] = await two()
      const owner = { code: C1.code, country: C1.country }
      const subs = await Promise.all([a, b, a, b].map((ctx) => ctx.emulator.webhooksEe.subscribe(owner, 'https://x.test/ee')))
      assert.equal(new Set(subs.map((s) => s.subscriptionReference)).size, 1)
      assert.equal((await a.emulator.webhooksEe.list(owner)).length, 1)
    })
  })
}
