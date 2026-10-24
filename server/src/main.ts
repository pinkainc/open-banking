// Entry point: an HTTPS server with mutual TLS. Run scripts/dev-ca.sh first for local
// certificates. Settings come from the environment (README, "Run").
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { Emulator, type Seed } from './emulator.js'
import { PgDb } from './pg/db.js'
import { PgInbox } from './pg/inbox.js'
import { PgLedger } from './pg/ledger.js'
import { PgAgencyStore } from './pg/agency.js'
import { PgAcquiringStore } from './pg/acquiring.js'
import { PgRailsPending } from './pg/rails-pending.js'
import { PgJournal } from './pg/journal.js'
import { pgKeyed } from './pg/keyed.js'
import { PgDirectory } from './pg/directory.js'
import { OpenLedgerLedger } from './ledgers/open-ledger.js'
import { HttpRails, railsCallbackApp } from './rails-http.js'
import type { Scheme } from './rails.js'

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
// DATABASE_URL: the inbox, the ledger, agency accounts and set-ups, acquiring, the payments
// waiting at the rails, the journal, keyed state and the customers and accounts in Postgres
// (decisions 900, 910, 943, 946, 948, 960, 961, 970), under STORE_NAMESPACE (the former INBOX_NAMESPACE still
// works; default "default"), so a restart keeps them; without it, in memory. DATABASE_POOL_MAX: connections
// (default 10).
const pool = max(env.DATABASE_POOL_MAX)
const db = env.DATABASE_URL ? await PgDb.connect(env.DATABASE_URL, pool) : undefined
const namespace = env.STORE_NAMESPACE ?? env.INBOX_NAMESPACE ?? 'default'
// LEDGER=open-ledger: the money on an open-ledger server (decisions 920-929), OPEN_LEDGER_URL
// (…/api/v2), the ledger `open-banking.<STORE_NAMESPACE>`; OPEN_LEDGER_KEY our ed25519
// secret (raw 32 bytes, base64), which owns that ledger, so keep it across restarts (without
// it a fresh key each start, and a restart cannot reach the old ledger); OPEN_LEDGER_TIMEOUT_MS
// per request and intent (default 10000). LEDGER=postgres needs DATABASE_URL, LEDGER=memory
// keeps the money in the process; default postgres with DATABASE_URL, else memory.
const ledgerKind = env.LEDGER ?? (db ? 'postgres' : 'memory')
if (!['open-ledger', 'postgres', 'memory'].includes(ledgerKind)) throw new Error(`LEDGER must be open-ledger, postgres or memory, not ${ledgerKind}`)
if (ledgerKind === 'postgres' && !db) throw new Error('LEDGER=postgres needs DATABASE_URL')
if (ledgerKind === 'open-ledger' && !env.OPEN_LEDGER_URL) throw new Error('LEDGER=open-ledger needs OPEN_LEDGER_URL')
if (ledgerKind === 'open-ledger' && !env.OPEN_LEDGER_KEY) console.error('warning: OPEN_LEDGER_KEY is not set; a fresh key owns a ledger a restart cannot reach')
if (env.OPEN_LEDGER_TIMEOUT_MS && !/^[1-9]\d*$/.test(env.OPEN_LEDGER_TIMEOUT_MS)) throw new Error(`OPEN_LEDGER_TIMEOUT_MS must be a positive integer, not ${env.OPEN_LEDGER_TIMEOUT_MS}`)
const timeoutMs = env.OPEN_LEDGER_TIMEOUT_MS ? Number(env.OPEN_LEDGER_TIMEOUT_MS) : undefined
// RAILS=http: payments go to an external scheme bridge (docs/rails-bridge-protocol.md,
// decisions 935-938): RAILS_URL (base, e.g. http://bridge:9000/v1), RAILS_URL_<SCHEME> per
// scheme (SEPA, INST, SWIFT, TARGET2, FAST), RAILS_SECRET the shared HMAC secret,
// RAILS_TIMEOUT_MS per request (default 10000); the bridge calls back on plain HTTP at
// RAILS_CALLBACK_HOST:RAILS_CALLBACK_PORT/rails/events (default 127.0.0.1:8444).
// Otherwise (RAILS unset or `simulator`) the simulator, steered through /_sim/rails.
const railsKind = env.RAILS ?? 'simulator'
if (railsKind !== 'http' && railsKind !== 'simulator') throw new Error(`RAILS must be http or simulator, not ${railsKind}`)
if (railsKind === 'http' && !env.RAILS_URL) throw new Error('RAILS=http needs RAILS_URL')
if (railsKind === 'http' && !env.RAILS_SECRET) throw new Error('RAILS=http needs RAILS_SECRET')
if (env.RAILS_TIMEOUT_MS && !/^[1-9]\d*$/.test(env.RAILS_TIMEOUT_MS)) throw new Error(`RAILS_TIMEOUT_MS must be a positive integer, not ${env.RAILS_TIMEOUT_MS}`)
const rails = railsKind === 'http' ? new HttpRails({
  url: env.RAILS_URL!, secret: env.RAILS_SECRET!, timeoutMs: env.RAILS_TIMEOUT_MS ? Number(env.RAILS_TIMEOUT_MS) : undefined,
  urls: Object.fromEntries((['SEPA', 'INST', 'SWIFT', 'TARGET2', 'FAST'] as Scheme[]).filter((s) => env[`RAILS_URL_${s}`]).map((s) => [s, env[`RAILS_URL_${s}`]!])),
}) : undefined
const emulator = await Emulator.fromSeed(seed, {
  rails,
  inbox: db && ((clock, bounds) => new PgInbox(db, clock, { ...bounds, namespace })),
  agency: db && ((clock, bounds) => new PgAgencyStore(db, clock, { namespace, bounds })),
  acquiring: db && ((clock, bounds) => new PgAcquiringStore(db, clock, { namespace, bounds })),
  railsPending: db && (() => new PgRailsPending(db, { namespace })),
  journal: db && (() => new PgJournal(db, { namespace })),
  keyed: db && ((clock) => pgKeyed(db, clock, namespace)),
  directory: db && ((clock) => new PgDirectory(db, clock, { namespace })),
  ledger: ledgerKind === 'open-ledger' ? new OpenLedgerLedger({ url: env.OPEN_LEDGER_URL!, namespace, secretKey: env.OPEN_LEDGER_KEY, timeoutMs })
    : ledgerKind === 'postgres' ? (clock) => new PgLedger(db!, { namespace, clock }) : undefined,
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
setInterval(() => { emulator.inbox.purge().catch((e) => console.error('inbox purge failed:', e)); emulator.requests.purge() }, 60 * 60 * 1000).unref()
// Automatic end-of-day statements: checked every minute, sent once per finished day.
if (env.EOD_STATEMENTS !== '0') setInterval(() => { emulator.reports.tick().catch((e) => console.error('end-of-day statements failed:', e)) }, 60 * 1000).unref()
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
// Shutdown: stop taking requests, let the ones in flight finish, then close the pool.
let closing = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if (closing) process.exit(1) // a second signal: now
  closing = true
  app.close().then(() => db?.close()).then(() => process.exit(0), (e) => { console.error('shutdown failed:', e); process.exit(1) })
})
const port = Number(env.PORT ?? 8443)
await app.listen({ port, host: env.HOST ?? '127.0.0.1' })
console.error(`listening on https://${env.HOST ?? '127.0.0.1'}:${port} (mutual TLS)`)
if (rails) {
  // The bridge's callbacks (HMAC-signed), started after the engine listens to the rails.
  const callbacks = railsCallbackApp(rails)
  const cbHost = env.RAILS_CALLBACK_HOST ?? '127.0.0.1'
  const cbPort = Number(env.RAILS_CALLBACK_PORT ?? 8444)
  await callbacks.listen({ port: cbPort, host: cbHost })
  console.error(`rails bridge ${env.RAILS_URL}; callbacks on http://${cbHost}:${cbPort}/rails/events`)
}
