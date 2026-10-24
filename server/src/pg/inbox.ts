// The message box in Postgres (decision 900): the same semantics as MemoryInbox, so many
// emulator processes can share one queue and a restart keeps it.
//
// - Rows carry a namespace (decision 902): every emulator (every test) has its own, so many
//   share one database without seeing each other's messages. Two PgInbox on one namespace
//   are one queue.
// - Times are milliseconds from the injected clock, never Postgres now() (decision 903),
//   so simulated time in tests moves expiry, archive and tombstones as it does in memory.
// - A body is bytea plus a flag that it was a string (decision 901): RTF zips are binary,
//   XML and JSON come back as the same string.
// - Tombstones and processed messages keep their bounds (decisions 504, 621, 904): a TTL
//   from when they were set and a maximum count, the oldest dropped first.
// - Single-statement reads run as one statement; everything that reads and then writes runs
//   in a short transaction holding pg_advisory_xact_lock on the namespace (decision 905).
//   An inbox write moves no money, so no ledger-wide lock and no gate as open-ledger has.
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { PgDb } from './db.js'
import { DEFAULT_BOUNDS, type Bounds } from '../bounded.js'
import type { Clock } from '../clock.js'
import { keyOf } from '../directory.js'
import { responseId } from '../ids.js'
import { ARCHIVE_MS, RETENTION_MS, type Entry, type InboxStore, type Message, type NewMessage, type ProcessedRefusal, type Scope } from '../inbox.js'

type Q = pg.Pool | pg.PoolClient
type Row = Record<string, any>

/** The pool PgInbox takes; the name before the ledger joined it (decision 910). */
export { PgDb as PgInboxDb } from './db.js'

export interface PgInboxOptions {
  /** Whose rows these are; default a random one (a fresh, empty inbox). */
  namespace?: string
  retentionMs?: number
  tombstones?: Bounds
  processed?: Bounds
}

const COLS = 'id, request_id, type, client_code, client_country, created_at, restored_at, body, body_text, content_type, seq, owner'

export class PgInbox implements InboxStore {
  readonly namespace: string
  #listeners: ((m: Message) => void)[] = []
  #retentionMs: number
  #gone: Bounds
  #processed: Bounds

  constructor(private db: PgDb, private clock: Clock, o: PgInboxOptions = {}) {
    this.namespace = o.namespace ?? randomUUID()
    this.#retentionMs = o.retentionMs ?? RETENTION_MS
    this.#gone = o.tombstones ?? DEFAULT_BOUNDS.tombstones
    this.#processed = o.processed ?? DEFAULT_BOUNDS.processed
    for (const b of [this.#gone, this.#processed]) if (!(b.max >= 1)) throw new Error(`bounds.max must be at least 1, not ${b.max}`)
  }

  #now() { return this.clock.now().getTime() }
  #until(b: Bounds, now: number) { return b.ttlMs === undefined ? null : now + b.ttlMs }

  #message(r: Row): Message {
    const m: Message = {
      id: r.id, type: r.type, clientCode: r.client_code, clientCountry: r.client_country,
      createdAt: new Date(Number(r.created_at)), body: r.body_text ? (r.body as Buffer).toString('utf8') : r.body as Buffer,
      contentType: r.content_type, seq: Number(r.seq), requestId: r.request_id ?? undefined,
    }
    if (r.restored_at !== null) m.restoredAt = new Date(Number(r.restored_at))
    return m
  }

  async #tx<T>(fn: (q: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.db.pool.connect()
    try {
      await c.query('begin')
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [`inbox:${this.namespace}`])
      const out = await fn(c)
      await c.query('commit')
      return out
    } catch (e) {
      await c.query('rollback')
      throw e
    } finally {
      c.release()
    }
  }

  async tombstones() {
    const { rows } = await this.db.pool.query('select count(*)::int as n from inbox_tombstones where ns = $1', [this.namespace])
    return rows[0].n as number
  }

  async processedKept() {
    const { rows } = await this.db.pool.query('select count(*)::int as n from inbox_messages where ns = $1 and processed_ord is not null', [this.namespace])
    return rows[0].n as number
  }

  onAdd(listener: (m: Message) => void) { this.#listeners.push(listener) }

  async add(m: NewMessage): Promise<Message> {
    const msg: Message = {
      id: responseId(), requestId: m.requestId, type: m.type, clientCode: m.customer.code, clientCountry: m.customer.country,
      createdAt: this.clock.now(), body: m.body, contentType: m.contentType ?? 'application/xml', seq: 0,
    }
    const text = typeof m.body === 'string'
    const { rows } = await this.db.pool.query(
      `insert into inbox_messages (ns, id, owner, request_id, type, client_code, client_country, created_at, body, body_text, content_type, seq)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, nextval('inbox_seq')) returning seq`,
      [this.namespace, msg.id, keyOf(m.customer), msg.requestId ?? null, msg.type, msg.clientCode, msg.clientCountry,
        msg.createdAt.getTime(), text ? Buffer.from(m.body as string, 'utf8') : m.body, text, msg.contentType])
    msg.seq = Number(rows[0].seq)
    for (const l of this.#listeners) l(msg)
    return msg
  }

  // --- reads ----------------------------------------------------------------------------

  /** Pending, in scope, not expired: `where` for inbox_messages, parameters from $2 on. */
  #scoped(s: Scope, now: number) {
    return {
      where: 'ns = $1 and processed_ord is null and owner = any($2) and ($3::text is null or type = $3) and coalesce(restored_at, created_at) >= $4',
      params: [this.namespace, [...s.customers], s.type ?? null, now - this.#retentionMs] as unknown[],
    }
  }

  async #list(q: Q, s: Scope, limit?: number): Promise<Message[]> {
    const w = this.#scoped(s, this.#now())
    const { rows } = await q.query(`select ${COLS} from inbox_messages where ${w.where} order by created_at, seq limit $5`,
      [...w.params, limit === undefined || limit === Infinity ? null : limit])
    return rows.map((r) => this.#message(r))
  }

  list(s: Scope, limit?: number) { return this.#list(this.db.pool, s, limit) }
  async next(s: Scope) { return (await this.#list(this.db.pool, s, 1))[0] }

  async count(s: Scope) {
    const w = this.#scoped(s, this.#now())
    const { rows } = await this.db.pool.query(`select count(*)::int as n from inbox_messages where ${w.where}`, w.params)
    return rows[0].n as number
  }

  async get(s: Scope, id: string) {
    const r = await this.#pendingRow(this.db.pool, id)
    return r && s.customers.has(r.owner) && !this.#expired(r) ? this.#message(r) : undefined
  }

  #expired(r: Row) { return this.#now() - Number(r.restored_at ?? r.created_at) > this.#retentionMs }
  #archived(r: Row) { return this.#now() - Number(r.created_at) >= ARCHIVE_MS }

  async #pendingRow(q: Q, id: string): Promise<Row | undefined> {
    const { rows } = await q.query(`select ${COLS} from inbox_messages where ns = $1 and id = $2 and processed_ord is null`, [this.namespace, id])
    return rows[0]
  }

  /** A pending message of the caller (any type), unless expired. */
  async #pending(q: Q, s: Scope, id: string) {
    const r = await this.#pendingRow(q, id)
    return r && s.customers.has(r.owner) && !this.#expired(r) ? r : undefined
  }

  /** A processed message of the caller that is not archived yet (BoundedMap.get, then the archive). */
  async #kept(q: Q, s: Scope, id: string): Promise<Row | undefined> {
    const { rows } = await q.query(`select ${COLS}, processed_until from inbox_messages where ns = $1 and id = $2 and processed_ord is not null`, [this.namespace, id])
    const r = rows[0]
    if (!r) return undefined
    if (r.processed_until !== null && Number(r.processed_until) <= this.#now()) { await this.#drop(q, id); return undefined }
    if (!s.customers.has(r.owner)) return undefined
    if (this.#archived(r)) { await this.#drop(q, id); return undefined }
    return r
  }

  async #drop(q: Q, id: string) {
    await q.query('delete from inbox_messages where ns = $1 and id = $2', [this.namespace, id])
  }

  /** The owner of a tombstone still remembered (an expired one is forgotten on the way). */
  async #goneOwner(q: Q, id: string): Promise<string | undefined> {
    const { rows } = await q.query('select owner, until from inbox_tombstones where ns = $1 and id = $2', [this.namespace, id])
    const r = rows[0]
    if (!r) return undefined
    if (r.until !== null && Number(r.until) <= this.#now()) {
      await q.query('delete from inbox_tombstones where ns = $1 and id = $2', [this.namespace, id])
      return undefined
    }
    return r.owner
  }

  // --- writes (inside #tx) --------------------------------------------------------------

  /** Tombstones for these ids (newest last), then the bounds: expired ones and those beyond max go. */
  async #bury(q: Q, gone: { id: string; owner: string }[]) {
    if (!gone.length) return
    const now = this.#now()
    for (const g of gone) {
      await q.query(`insert into inbox_tombstones (ns, id, owner, until, ord) values ($1, $2, $3, $4, nextval('inbox_seq'))
        on conflict (ns, id) do update set owner = excluded.owner, until = excluded.until, ord = excluded.ord`,
      [this.namespace, g.id, g.owner, this.#until(this.#gone, now)])
    }
    await q.query('delete from inbox_tombstones where ns = $1 and until <= $2', [this.namespace, now])
    await q.query(`delete from inbox_tombstones where ns = $1 and id in
      (select id from inbox_tombstones where ns = $1 order by ord desc offset $2)`, [this.namespace, this.#gone.max])
  }

  /** Out of the queue with a tombstone; nothing kept. */
  async #remove(q: Q, r: Row) {
    await this.#drop(q, r.id)
    await this.#bury(q, [{ id: r.id, owner: r.owner }])
  }

  /** Confirmed: out of the queue, kept as processed until archived (then the processed bounds). */
  async #confirm(q: Q, r: Row) {
    await this.#bury(q, [{ id: r.id, owner: r.owner }])
    if (this.#archived(r)) return this.#drop(q, r.id)
    const now = this.#now()
    await q.query(`update inbox_messages set processed_ord = nextval('inbox_seq'), processed_until = $3 where ns = $1 and id = $2`,
      [this.namespace, r.id, this.#until(this.#processed, now)])
    await this.#trimProcessed(q, now)
  }

  async #trimProcessed(q: Q, now: number) {
    await q.query('delete from inbox_messages where ns = $1 and processed_ord is not null and processed_until <= $2', [this.namespace, now])
    await q.query(`delete from inbox_messages where ns = $1 and id in
      (select id from inbox_messages where ns = $1 and processed_ord is not null order by processed_ord desc offset $2)`, [this.namespace, this.#processed.max])
  }

  delete(s: Scope, id: string): Promise<'deleted' | 'unknown'> {
    return this.#tx(async (q) => {
      const r = await this.#pendingRow(q, id)
      if (r && s.customers.has(r.owner)) { await (this.#expired(r) ? this.#remove(q, r) : this.#confirm(q, r)); return 'deleted' }
      const owner = await this.#goneOwner(q, id)
      return (await this.#kept(q, s, id)) || (owner !== undefined && s.customers.has(owner)) ? 'deleted' : 'unknown'
    })
  }

  purge(): Promise<number> {
    return this.#tx(async (q) => {
      const now = this.#now()
      const { rows } = await q.query(`delete from inbox_messages where ns = $1 and processed_ord is null and coalesce(restored_at, created_at) < $2
        returning id, owner, created_at, seq`, [this.namespace, now - this.#retentionMs])
      rows.sort((a, b) => Number(a.created_at) - Number(b.created_at) || Number(a.seq) - Number(b.seq))
      await this.#bury(q, rows.map((r) => ({ id: r.id, owner: r.owner })))
      await q.query('delete from inbox_messages where ns = $1 and processed_ord is not null and created_at <= $2', [this.namespace, now - ARCHIVE_MS])
      await q.query('delete from inbox_messages where ns = $1 and processed_ord is not null and processed_until <= $2', [this.namespace, now])
      await q.query('delete from inbox_tombstones where ns = $1 and until <= $2', [this.namespace, now])
      return rows.length
    })
  }

  entries(s: Scope, o: { includeProcessed?: boolean; requestId?: string } = {}): Promise<Entry[]> {
    const want = (m: Message) => (!s.type || m.type === s.type) && (o.requestId === undefined || m.requestId === o.requestId)
    const read = async (q: Q) => {
      const out: Entry[] = (await this.#list(q, s)).filter(want).map((message) => ({ message, processed: false }))
      if (!o.includeProcessed) return out
      const { rows } = await q.query(`select id from inbox_messages where ns = $1 and processed_ord is not null
        and (processed_until is null or processed_until > $2) order by processed_ord`, [this.namespace, this.#now()])
      for (const { id } of rows) {
        const r = await this.#kept(q, s, id)
        if (r) { const m = this.#message(r); if (want(m)) out.push({ message: m, processed: true }) }
      }
      out.sort((a, b) => a.message.createdAt.getTime() - b.message.createdAt.getTime() || a.message.seq - b.message.seq)
      return out
    }
    // With processed messages an archived one is dropped on the way: a transaction then.
    return o.includeProcessed ? this.#tx(read) : read(this.db.pool)
  }

  setProcessed(s: Scope, changes: { id: string; processed: boolean }[]): Promise<ProcessedRefusal | undefined> {
    return this.#tx(async (q) => {
      for (const { id, processed } of changes) {
        if ((await this.#pending(q, s, id)) || (await this.#kept(q, s, id))) continue
        const owner = await this.#goneOwner(q, id)
        const gone = owner !== undefined && s.customers.has(owner)
        if (processed && gone) continue
        return { id, reason: gone ? 'archived' as const : 'unknown' as const }
      }
      for (const { id, processed } of changes) {
        const pending = await this.#pending(q, s, id)
        if (processed) { if (pending) await this.#confirm(q, pending); continue }
        if (!(await this.#kept(q, s, id))) continue
        await q.query('delete from inbox_tombstones where ns = $1 and id = $2', [this.namespace, id])
        await q.query('update inbox_messages set processed_ord = null, processed_until = null, restored_at = $3 where ns = $1 and id = $2',
          [this.namespace, id, this.#now()])
      }
      return undefined
    })
  }
}
