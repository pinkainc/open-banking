// The ledger on an open-ledger server (decisions 920-929): open-ledger
// (github.com/minka/open-ledger) speaks the Minka Ledger API, and this client talks to it
// over plain HTTP with node:crypto, no SDK.
//
// - Auth (decision 923): every request carries an EdDSA JWT signed by our ed25519 key
//   (`kid` = the raw public key); every record we create carries our proof
//   (sha256 of the canonical JSON, then ed25519 over sha256(hash + JCS(custom))).
// - One open-ledger ledger per namespace (decision 924), `open-banking.<namespace>`, made on
//   first use; one symbol per currency (lower case, factor 100).
// - Accounts are wallets `a.<account>`, the name encoded (decision 921): [A-Za-z0-9-] kept,
//   every other byte `_hh`. open-ledger refuses a debit below a wallet's `minBalance`
//   (default 0), which is our InsufficientFunds; a system account ('@…', decision 922) gets
//   a `minBalance` limit of -(2^53-1) per currency before its first booking in it.
// - reserve / commit / release (decision 920): a reservation is an intent moving the amount
//   to the account's hold wallet `h.<account>`; commit moves it from there to the
//   destination, release back. Both are the one settle intent `s.<ref>.<n>`, so a
//   reservation is settled at most once: the second one meets a duplicate handle. A
//   failed (rejected) reserve or transfer and a settled reservation free the ref, and the
//   next one uses `o.<ref>.<n+1>`; a completed transfer is the booking of its key, and a
//   transfer of that key again is a repeat (decision 997: a transfer's handles are
//   `o.<key>.<n>`, the key its ref unless given). balance = wallet + hold wallet; available =
//   the wallet.
// - Intents are processed asynchronously: every call waits for completed or rejected and
//   fails after `timeoutMs`.
// - Limits: amounts are JSON numbers on open-ledger, so at most 2^53-1 minor units
//   (RangeError beyond); currencies of an account come in symbol order, as open-ledger lists
//   balances (decision 925).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { InsufficientFunds, isSystemAccount, sameTerms, type Booked, type Ledger, type Posting, type Transfer } from '../ledger.js'
import { MemoryOutbox, type OutboxItem, type OutboxStore } from '../outbox.js'

export interface OpenLedgerOptions {
  /** The server, e.g. http://127.0.0.1:4620/api/v2 (a trailing /api/v2 is added when missing). */
  url: string
  /** Whose ledger this is: the open-ledger ledger `open-banking.<namespace>`; default "default". */
  namespace?: string
  /** Our ed25519 secret key, raw 32 bytes in base64; default a fresh one (a new ledger per run). */
  secretKey?: string
  /** How long a request or an intent may take; default 10 s. */
  timeoutMs?: number
  /** Where the items of bookings wait as intents (decision 992); default in memory. */
  outbox?: OutboxStore
}

/** An answer from open-ledger that is not what we asked for. */
export class OpenLedgerError extends Error {
  constructor(readonly status: number, readonly reason: string, detail: string) { super(`open-ledger ${status} ${reason}: ${detail}`) }
}

const MAX = BigInt(Number.MAX_SAFE_INTEGER)
/** A booking open-ledger (or we) turned down: nothing was booked. A timeout, a 5xx or a transport error may have booked. */
const refused = (e: unknown) => e instanceof InsufficientFunds || e instanceof RangeError
  || (e instanceof OpenLedgerError && e.status < 500)
  || (e instanceof Error && /^(no reservation |reservation .* exists$|amount must be positive$)/.test(e.message))
const FINAL = new Set(['completed', 'rejected', 'failed', 'aborted', 'expired'])
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_LEN = 12

/** JCS for the values we send (strings, integers, objects, arrays). */
const canonical = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const b64u = (s: string | Buffer) => Buffer.from(s).toString('base64url')

/** A handle open-ledger takes for any name: [A-Za-z0-9-] kept, every other UTF-8 byte `_hh`. */
export const encodeHandle = (name: string) =>
  name.replace(/[^A-Za-z0-9-]/gu, (c) => [...Buffer.from(c, 'utf8')].map((b) => `_${b.toString(16).padStart(2, '0')}`).join(''))

/** A fresh secret key for OpenLedgerOptions.secretKey. */
export function generateSecretKey(): string {
  const der = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' })
  return der.subarray(PKCS8.length).toString('base64')
}

type Intent = { data: { handle: string; claims: any[]; custom?: Record<string, any> }; meta: { status: string; moment?: string; proofs: { custom?: Record<string, any> }[] } }

export class OpenLedgerLedger implements Ledger {
  readonly ledger: string
  readonly #base: string
  readonly #key: ReturnType<typeof createPrivateKey>
  readonly #public: string
  readonly #timeout: number
  /** Things made once per process (ledger, symbols, wallets, limits): name → its creation. */
  #made = new Map<string, Promise<void>>()
  /** The items of bookings: written as intents before the booking, which names them (decision 992). */
  readonly outbox: OutboxStore

  constructor(o: OpenLedgerOptions) {
    this.#base = o.url.replace(/\/+$/, '').replace(/(?<!\/api\/v2)$/, '/api/v2')
    this.ledger = `open-banking.${encodeHandle(o.namespace ?? 'default')}`
    this.#key = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(o.secretKey ?? generateSecretKey(), 'base64')]), format: 'der', type: 'pkcs8' })
    this.#public = createPublicKey(this.#key).export({ format: 'der', type: 'spki' }).subarray(SPKI_LEN).toString('base64')
    this.#timeout = o.timeoutMs ?? 10_000
    this.outbox = o.outbox ?? new MemoryOutbox()
  }

  /** Our public key (base64, raw), the owner of the ledger and every record in it. */
  get publicKey() { return this.#public }

  // ---- the Ledger interface ----------------------------------------------------------

  async available(account: string, currency: string) {
    return (await this.#rows(wallet(account)))[sym(currency)]?.available ?? 0n
  }

  async balances(account: string) {
    const [own, held] = await Promise.all([this.#rows(wallet(account)), this.#rows(hold(account))])
    const out: Record<string, { balance: bigint; available: bigint }> = {}
    for (const [s, r] of Object.entries(own)) {
      const h = held[s] ? held[s].available + held[s].reserved : 0n
      out[s.toUpperCase()] = { balance: r.available + r.reserved + h, available: r.available }
    }
    return out
  }

  async reserve(r: { ref: string; account: string; amount: bigint; currency: string }) {
    await this.#open(r.ref, 'reserve', r.account, hold(r.account), r.amount, r.currency, { account: r.account })
  }

  async commit(ref: string, to: string, outbox: OutboxItem[] = []): Promise<Booked> {
    return this.#withIntent(ref, outbox, async (mark) => {
      const s = await this.#settle(ref, 'commit', to, mark)
      if (s === true) return { ref, repeat: false }
      // No open reservation: a repeat when the last settle of the ref was a commit (decision 997).
      if (s?.meta.status === 'completed' && s.data.custom?.kind === 'commit') {
        const c = s.data.custom
        return sameTerms(ref, { ref, from: c.from, to: c.to, amount: BigInt(s.data.claims[0].amount), currency: String(s.data.claims[0].symbol.handle).toUpperCase() }, { to })
      }
      throw new Error(`no reservation ${ref}`)
    })
  }

  async release(ref: string) { await this.#settle(ref, 'release') }

  async transfer(t: Transfer, outbox: OutboxItem[] = []): Promise<Booked> {
    const key = t.key ?? t.ref
    return this.#withIntent(key, outbox, (mark) =>
      this.#open(t.ref, 'transfer', t.from, wallet(t.to), t.amount, t.currency, { from: t.from, to: t.to, ...(key !== t.ref ? { key } : {}), ...mark }, t.to, key))
  }

  /**
   * Whether the booking of an intent item happened: a completed transfer or commit of its
   * key (the handle base: a transfer's key, default its ref; a commit's ref) whose custom
   * data names the intent's batch.
   */
  async booked(intent: string): Promise<boolean> {
    const at = intent.indexOf(':')
    const batch = intent.slice(0, at)
    const ref = encodeHandle(intent.slice(at + 1))
    for (let n = 0; ; n++) {
      const open = await this.#read(`o.${ref}.${n}`)
      if (!open) return false
      if (open.meta.status === 'completed' && open.data.custom?.outbox === batch) return true
      const settled = await this.#read(`s.${ref}.${n}`)
      if (settled?.meta.status === 'completed' && settled.data.custom?.outbox === batch) return true
    }
  }

  /**
   * Outbox after intent (decision 992): the items are stored first, marked with a batch the
   * booking's intent carries in its custom data; a refused booking takes them back. Any
   * other failure (a timeout) leaves them for recover(), which asks booked().
   */
  async #withIntent(key: string, items: OutboxItem[], book: (mark: { outbox?: string }) => Promise<Booked>): Promise<Booked> {
    if (!items.length) return book({})
    const batch = randomUUID()
    const marked = items.map((i) => ({ ...i, intent: `${batch}:${key}` }))
    await this.outbox.put(marked)
    let b: Booked
    try {
      b = await book({ outbox: batch })
    } catch (e) {
      if (refused(e)) await this.outbox.remove(marked.map((i) => i.key))
      throw e
    }
    // A repeat books nothing and keeps none of its items (decision 995).
    if (b.repeat) await this.outbox.remove(marked.map((i) => i.key))
    return b
  }

  /** Bookings (completed transfers and commits) as postings, oldest first: the journal open-ledger keeps. */
  async postings(): Promise<Posting[]> {
    const out: Posting[] = []
    const intents: Intent[] = []
    for (let page = 0; ; page++) {
      const r = await this.#call('GET', `/intents?page.index=${page}&page.limit=100`)
      intents.push(...r.data)
      if (r.data.length < 100) break
    }
    for (const i of intents.reverse()) {
      const c = i.data.custom
      if (i.meta.status !== 'completed' || !c?.ref || (c.kind !== 'transfer' && c.kind !== 'commit')) continue
      const claim = i.data.claims[0]
      const amount = BigInt(claim.amount)
      const currency = String(claim.symbol.handle).toUpperCase()
      const at = Date.parse(i.meta.moment ?? '') || 0
      out.push({ ref: c.ref, account: c.from, currency, amount: -amount, at }, { ref: c.ref, account: c.to, currency, amount, at })
    }
    return out
  }

  // ---- reservations ------------------------------------------------------------------

  /**
   * A reserve or transfer under the first free `o.<key>.<n>` (key: a transfer's booking key,
   * else the ref): an existing one blocks the ref unless it was rejected or is a settled
   * reservation; a completed transfer there is the booking of the key, so a transfer is a
   * repeat (decision 997).
   */
  async #open(ref: string, kind: 'reserve' | 'transfer', from: string, target: string, amount: bigint, currency: string, custom: Record<string, string>, to?: string, key = ref): Promise<Booked> {
    if (amount <= 0n) throw new Error('amount must be positive')
    if (amount > MAX) throw new RangeError(`amount ${amount} is beyond 2^53-1, the most open-ledger books`)
    const s = sym(currency)
    await Promise.all([this.#wallet(from, s), to === undefined ? this.#hold(from) : this.#wallet(to, s)])
    const claims = [{ action: 'transfer', source: { handle: wallet(from) }, target: { handle: target }, symbol: { handle: s }, amount: Number(amount) }]
    for (let n = 0; ; n++) {
      const handle = `o.${encodeHandle(key)}.${n}`
      const made = await this.#intent(handle, claims, { ref, kind, n: String(n), ...custom })
      if (made) {
        if (made.meta.status === 'completed') return { ref, repeat: false }
        const reason = rejection(made)
        if (reason.reason === 'core.limit-exceeded') throw new InsufficientFunds()
        throw new OpenLedgerError(422, reason.reason ?? made.meta.status, reason.detail ?? `intent ${handle} ${made.meta.status}`)
      }
      const old = await this.#read(handle)
      if (!old || old.meta.status === 'rejected') continue
      const c = old.data.custom
      if (c?.kind === 'transfer') {
        if (kind === 'reserve' || old.meta.status !== 'completed') continue
        const o = old.data.claims[0]
        return sameTerms(key, { ref: c.ref, from: c.from, to: c.to, amount: BigInt(o.amount), currency: String(o.symbol.handle).toUpperCase() }, { from: custom.from, to: custom.to, amount, currency })
      }
      if (old.meta.status === 'completed' && (await this.#read(`s.${encodeHandle(key)}.${n}`))?.meta.status === 'completed') continue
      throw new Error(`reservation ${ref} exists`)
    }
  }

  /** Commit (to `to`) or release the open reservation of ref: true, or when there is none the last settle intent of the ref (undefined: none). */
  async #settle(ref: string, kind: 'commit' | 'release', to?: string, mark: { outbox?: string } = {}): Promise<true | Intent | undefined> {
    let last: Intent | undefined
    for (let n = 0; ; n++) {
      const open = await this.#read(`o.${encodeHandle(ref)}.${n}`)
      if (!open) return last
      if (open.meta.status !== 'completed' || open.data.custom?.kind !== 'reserve') continue
      const c = open.data.claims[0]
      const account = open.data.custom.account as string
      const target = kind === 'commit' ? wallet(to!) : wallet(account)
      if (kind === 'commit') await this.#wallet(to!, c.symbol.handle)
      const claims = [{ action: 'transfer', source: { handle: hold(account) }, target: { handle: target }, symbol: c.symbol, amount: c.amount }]
      const handle = `s.${encodeHandle(ref)}.${n}`
      const made = await this.#intent(handle, claims, { ref, kind, n: String(n), from: account, to: kind === 'commit' ? to! : account, ...mark })
      if (!made) { last = await this.#read(handle); continue } // settled before
      if (made.meta.status !== 'completed') {
        const r = rejection(made)
        throw new OpenLedgerError(422, r.reason ?? made.meta.status, r.detail ?? `intent ${handle} ${made.meta.status}`)
      }
      return true
    }
  }

  // ---- records -----------------------------------------------------------------------

  /** Creates an intent and waits for it; undefined when the handle is taken. */
  async #intent(handle: string, claims: unknown[], custom?: Record<string, string>): Promise<Intent | undefined> {
    const r = await this.#create('intents', { handle, claims, ...(custom ? { custom } : {}) })
    if (!r) return undefined
    return this.#final(handle, r)
  }

  async #final(handle: string, first: Intent): Promise<Intent> {
    const until = Date.now() + this.#timeout
    let i = first
    for (let wait = 2; !FINAL.has(i.meta.status); wait = Math.min(wait * 2, 100)) {
      if (Date.now() > until) throw new Error(`open-ledger: intent ${handle} still ${i.meta.status} after ${this.#timeout} ms`)
      await new Promise((r) => setTimeout(r, wait))
      i = await this.#call('GET', `/intents/${encodeURIComponent(handle)}`)
    }
    return i
  }

  /** An intent, waited for when not final; undefined when there is none. */
  async #read(handle: string): Promise<Intent | undefined> {
    const r = await this.#call('GET', `/intents/${encodeURIComponent(handle)}`, undefined, [404])
    return r === undefined ? undefined : this.#final(handle, r)
  }

  /** Balance rows of a wallet by symbol; nothing for a wallet open-ledger does not know. */
  async #rows(handle: string) {
    const out: Record<string, { available: bigint; reserved: bigint }> = {}
    await this.#ready()
    const r = await this.#call('GET', `/wallets/${encodeURIComponent(handle)}/balances?page.limit=1000`, undefined, [404])
    for (const row of r?.data ?? []) {
      const d = row.data as { symbol: string; schema: string; amount: number }
      if (d.schema !== 'available' && d.schema !== 'reserved') continue
      ;(out[d.symbol] ??= { available: 0n, reserved: 0n })[d.schema as 'available'] += BigInt(d.amount)
    }
    return out
  }

  #once(key: string, make: () => Promise<void>): Promise<void> {
    let p = this.#made.get(key)
    if (!p) {
      p = make()
      this.#made.set(key, p)
      p.catch(() => this.#made.delete(key))
    }
    return p
  }

  /** The ledger, made on first use (an existing one is ours: same key, decision 923). */
  #ready() {
    return this.#once('', async () => {
      await this.#create('ledgers', { handle: this.ledger, signer: 'system', config: { 'access.strategy': 'record-based' }, access: this.#mine('any') }, false)
    })
  }

  #symbol(s: string) {
    return this.#once(`s|${s}`, async () => { await this.#ready(); await this.#create('symbols', { handle: s, factor: 100 }) })
  }

  /** The account's wallet, with the open limit of a system account in this currency. */
  async #wallet(account: string, s: string) {
    const h = wallet(account)
    await Promise.all([this.#symbol(s), this.#once(`w|${h}`, async () => { await this.#ready(); await this.#create('wallets', { handle: h }) })])
    if (isSystemAccount(account)) await this.#once(`l|${h}|${s}`, async () => {
      const limit = `l.${h}.${s}`
      const claims = [{ action: 'limit', metric: 'minBalance', wallet: { handle: h }, symbol: { handle: s }, amount: -Number.MAX_SAFE_INTEGER }]
      const made = (await this.#intent(limit, claims)) ?? (await this.#read(limit))
      if (made?.meta.status !== 'completed') throw new OpenLedgerError(422, made?.meta.status ?? 'missing', `limit ${limit} not set`)
    })
  }

  #hold(account: string) {
    const h = hold(account)
    return this.#once(`w|${h}`, async () => { await this.#ready(); await this.#create('wallets', { handle: h }) })
  }

  /** Creates a record we own; undefined when its handle is taken. */
  async #create(kind: string, data: Record<string, unknown>, inLedger = true) {
    const body = this.#signed({ access: this.#mine(), ...data })
    return this.#call('POST', `/${kind}`, body, [409], inLedger)
  }

  /** Access rules granting everything to our key only: signed records (signer) and our token (bearer, reads). */
  #mine(record?: string) {
    const scope = record ? { record } : {}
    return [{ action: 'any', ...scope, signer: { public: this.#public } }, { action: 'any', ...scope, bearer: { $signer: { public: this.#public } } }]
  }

  #signed(data: Record<string, unknown>) {
    const hash = sha256(canonical(data))
    const custom = { moment: new Date().toISOString(), status: 'created' }
    const digest = sha256(hash + canonical(custom))
    const result = sign(null, Buffer.from(digest, 'hex'), this.#key).toString('base64')
    return { data, hash, meta: { proofs: [{ method: 'ed25519-v2', public: this.#public, digest, result, custom }] } }
  }

  #token() {
    const now = Math.floor(Date.now() / 1000)
    const h = b64u(JSON.stringify({ alg: 'EdDSA', kid: this.#public, typ: 'JWT' }))
    const p = b64u(JSON.stringify({ iss: this.#public, sub: `signer:${this.#public}`, aud: this.ledger, iat: now, exp: now + 300 }))
    return `${h}.${p}.${b64u(sign(null, Buffer.from(`${h}.${p}`), this.#key))}`
  }

  /** One request; a status in `none` answers undefined, any other non-2xx throws. */
  async #call(method: string, path: string, body?: unknown, none: number[] = [], inLedger = true): Promise<any> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token()}` }
    if (inLedger) headers['x-ledger'] = this.ledger
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(this.#base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.#timeout) })
    const text = await res.text()
    if (none.includes(res.status)) return undefined
    let json: any
    try { json = JSON.parse(text) } catch { json = undefined }
    if (!res.ok) throw new OpenLedgerError(res.status, json?.data?.reason ?? 'error', json?.data?.detail ?? text.slice(0, 200))
    return json
  }
}

const wallet = (account: string) => `a.${encodeHandle(account)}`
const hold = (account: string) => `h.${encodeHandle(account)}`
const sym = (currency: string) => currency.toLowerCase()

/** Why an intent did not complete: the last proof that names a reason. */
function rejection(i: Intent): { reason?: string; detail?: string } {
  const p = [...i.meta.proofs].reverse().find((p) => p.custom?.reason)
  return { reason: p?.custom?.reason, detail: p?.custom?.detail }
}
