// Entry point: an HTTPS server with mutual TLS. Run scripts/dev-ca.sh first for local
// certificates. Settings come from the environment (README, "Run").
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { Emulator, type Seed } from './emulator.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const env = process.env
const path = (v: string | undefined, def: string) => resolve(v ?? join(root, def))

const certs = path(env.CERTS_DIR, '.certs')
const tls = {
  key: readFileSync(env.TLS_KEY ?? join(certs, 'server.key')),
  cert: readFileSync(env.TLS_CERT ?? join(certs, 'server.crt')),
  ca: readFileSync(env.TLS_CA ?? join(certs, 'ca.crt')),
}
const seed: Seed = JSON.parse(readFileSync(path(env.SEED, 'config/dev-seed.json'), 'utf8'))
const xsdDir = path(env.XSD_DIR, 'reference/xsd')
const max = (v: string | undefined) => {
  if (v === undefined) return undefined
  if (!/^[1-9]\d*$/.test(v)) throw new Error(`a MAX_* setting must be a positive integer, not ${v}`)
  return { max: Number(v) }
}
const emulator = await Emulator.fromSeed(seed, {
  xsdDir: existsSync(xsdDir) ? xsdDir : undefined,
  strictIban: env.STRICT_IBAN !== '0',
  pain00103Until: env.PAIN_001_001_03_UNTIL,
  vibanErrors: env.VIBAN_ERRORS === 'sync' ? 'sync' : 'inbox',
  // Limits of remembered tombstones and MsgIds (decision 504); TTLs are the documented windows.
  memory: { tombstones: max(env.MAX_TOMBSTONES), msgIds: max(env.MAX_MSGIDS), processed: max(env.MAX_PROCESSED), requests: max(env.MAX_REQUESTS) },
})
if (!existsSync(xsdDir)) console.error('note: no XSDs in reference/xsd (scripts/fetch-reference.sh); pain.001 gets structural checks only')

// CONNECT_FLAVOUR=UK plays connect.lhv.com (X-Idempotency-Key, compression); default EE.
const flavour = (env.CONNECT_FLAVOUR ?? 'EE').toUpperCase()
if (flavour !== 'EE' && flavour !== 'UK') throw new Error(`CONNECT_FLAVOUR must be EE or UK, not ${flavour}`)
const app = buildApp({ emulator, https: tls, sim: env.SIM !== '0', flavour, idempotencyKeys: max(env.MAX_IDEMPOTENCY_KEYS) })
if (env.LOG) app.addHook('onResponse', async (req, reply) => console.error(`${req.method} ${req.url} ${reply.statusCode}`))
setInterval(() => { emulator.inbox.purge(); emulator.requests.purge() }, 60 * 60 * 1000).unref()
// Automatic end-of-day statements: checked every minute, sent once per finished day.
if (env.EOD_STATEMENTS !== '0') setInterval(() => emulator.reports.tick(), 60 * 1000).unref()
// SEPA Direct Debit: collections due are settled at 11:30 CET; checked every minute.
setInterval(() => { emulator.directDebit.tick().catch((e) => console.error('direct debit settlement failed:', e)) }, 60 * 1000).unref()
// Bacs (UK): mandate activation, credits, debits and refunds on the UK cut-offs; checked every minute.
setInterval(() => { emulator.bacs.tick().catch((e) => console.error('Bacs processing failed:', e)) }, 60 * 1000).unref()
// FX: SPOT deals settle in the first hour of their settlement date; checked every minute.
setInterval(() => { emulator.fx.tick().catch((e) => console.error('FX settlement failed:', e)) }, 60 * 1000).unref()
// EE webhooks: retries fall due on the clock; checked every 15 seconds.
setInterval(() => { emulator.webhooksEe.tick().catch((e) => console.error('EE webhook delivery failed:', e)) }, 15 * 1000).unref()
// UK webhooks: retries for up to 24 h, due on the clock; checked every 15 seconds.
setInterval(() => { emulator.webhooksUk.tick().catch((e) => console.error('UK webhook delivery failed:', e)) }, 15 * 1000).unref()
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => process.exit(0))
const port = Number(env.PORT ?? 8443)
await app.listen({ port, host: env.HOST ?? '127.0.0.1' })
console.error(`listening on https://${env.HOST ?? '127.0.0.1'}:${port} (mutual TLS)`)
