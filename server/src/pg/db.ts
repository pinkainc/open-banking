// One connection pool per process and database, with the schema of every Postgres store
// (the inbox, decision 900; the ledger, decision 910; agency and acquiring, decisions 943,
// 946) in place. The Pg stores take it; many of each, under their own namespaces, share it.
import pg from 'pg'

// A processed message is a row with processed_ord set (its place among the processed,
// as BoundedMap's insertion order); a pending one has it null. Times are ms since epoch;
// a null `until` never expires (Bounds without ttlMs).
const INBOX_SCHEMA = `
create sequence if not exists inbox_seq;
create table if not exists inbox_messages (
  ns              text    not null,
  id              text    not null,
  owner           text    not null,
  request_id      text,
  type            text    not null,
  client_code     text    not null,
  client_country  text    not null,
  created_at      bigint  not null,
  restored_at     bigint,
  body            bytea   not null,
  body_text       boolean not null,
  content_type    text    not null,
  seq             bigint  not null,
  processed_ord   bigint,
  processed_until bigint,
  primary key (ns, id)
);
create index if not exists inbox_messages_queue on inbox_messages (ns, created_at, seq);
create index if not exists inbox_messages_processed on inbox_messages (ns, processed_ord) where processed_ord is not null;
create table if not exists inbox_tombstones (
  ns    text   not null,
  id    text   not null,
  owner text   not null,
  until bigint,
  ord   bigint not null,
  primary key (ns, id)
);
create index if not exists inbox_tombstones_ord on inbox_tombstones (ns, ord);
`

// The ledger (decision 910). Amounts are bigint minor units, never float. A balance row
// appears with an account's first booking in a currency; `ord` keeps that order, so
// balances() lists currencies as MemoryLedger's Map does. A hold is a reservation (one per
// ref). Postings are the append-only journal: a trigger refuses update and delete.
const LEDGER_SCHEMA = `
create table if not exists ledger_balances (
  ns       text   not null,
  account  text   not null,
  currency text   not null,
  balance  bigint not null,
  ord      bigserial,
  primary key (ns, account, currency)
);
create table if not exists ledger_holds (
  ns       text   not null,
  ref      text   not null,
  account  text   not null,
  currency text   not null,
  amount   bigint not null check (amount > 0),
  primary key (ns, ref)
);
create index if not exists ledger_holds_account on ledger_holds (ns, account, currency);
create table if not exists ledger_postings (
  id       bigserial primary key,
  ns       text   not null,
  ref      text   not null,
  account  text   not null,
  currency text   not null,
  amount   bigint not null,
  at       bigint not null
);
create index if not exists ledger_postings_account on ledger_postings (ns, account, currency, id);
create or replace function ledger_postings_append_only() returns trigger language plpgsql as $$
begin raise exception 'ledger_postings is append-only'; end $$;
create or replace trigger ledger_postings_append_only before update or delete on ledger_postings
  for each row execute function ledger_postings_append_only();
-- Booking keys (decision 995): one row per booked transfer or commit, in its transaction;
-- kept as long as the postings (decision 996).
create table if not exists ledger_bookings (
  ns       text   not null,
  key      text   not null,
  ref      text   not null,
  source   text   not null,
  target   text   not null,
  currency text   not null,
  amount   bigint not null,
  at       bigint not null,
  primary key (ns, key)
);
`

// Agency accounts and set-ups (decision 943). The key `id` is what agencyKey() makes of an
// identifier (a GB account's sort code + account number, else the IBAN), so the primary key
// serves lookups by IBAN, GB IBAN and sort code + account number per entity. `ord` is the
// place of the last write (BoundedMap's order), `until` a TTL end (null: never). A set-up
// row with a null setup is a removal, remembered so a seed on a restart keeps it removed.
const AGENCY_SCHEMA = `
create sequence if not exists agency_seq;
create table if not exists agency_accounts (
  ns      text   not null,
  bank    text   not null,
  id      text   not null,
  agent   text   not null,
  account jsonb  not null,
  ord     bigint not null,
  until   bigint,
  primary key (ns, bank, id)
);
create index if not exists agency_accounts_ord on agency_accounts (ns, ord);
create index if not exists agency_accounts_agent on agency_accounts (ns, agent, ord);
create table if not exists agency_setups (
  ns    text   not null,
  agent text   not null,
  setup jsonb,
  ord   bigint not null,
  primary key (ns, agent)
);
`

// Acquiring (decision 946): merchant set-ups, card transactions (amounts as decimal strings
// of minor units in the JSON), and the per-namespace transaction reference counter.
const ACQUIRING_SCHEMA = `
create sequence if not exists acq_seq;
create table if not exists acq_merchants (
  ns       text  not null,
  customer text  not null,
  setup    jsonb not null,
  primary key (ns, customer)
);
create table if not exists acq_counters (
  ns  text   primary key,
  seq bigint not null
);
create table if not exists acq_transactions (
  ns      text   not null,
  ref     text   not null,
  account text   not null,
  tx      jsonb  not null,
  ord     bigint not null,
  until   bigint,
  primary key (ns, ref)
);
create index if not exists acq_transactions_ord on acq_transactions (ns, ord);
create index if not exists acq_transactions_account on acq_transactions (ns, account, ord);
`

// Payments waiting at the rails for their outcome (decision 948): the engine's record as JSON.
const RAILS_SCHEMA = `
create sequence if not exists rails_pending_seq;
create table if not exists rails_pending (
  ns     text   not null,
  ref    text   not null,
  scheme text   not null,
  record jsonb  not null,
  ord    bigint not null,
  primary key (ns, ref)
);
`

/** Serialises schema creation between processes connecting at once (as open-ledger's 815). */
// The statements journal (decision 960): every booking, whole as JSON, with the columns
// statements filter and sum on. Append-only like the ledger's postings.
const JOURNAL_SCHEMA = `
create sequence if not exists journal_seq;
create table if not exists journal_entries (
  ns        text   not null,
  seq       bigint not null,
  account   text   not null,
  booked_at bigint not null,
  direction text   not null,
  currency  text   not null,
  amount    bigint not null,
  entry     jsonb  not null,
  primary key (ns, seq)
);
create index if not exists journal_entries_account on journal_entries (ns, account, booked_at, seq);
alter table journal_entries add column if not exists entry_key text;
create unique index if not exists journal_entries_key on journal_entries (ns, entry_key) where entry_key is not null;
create index if not exists journal_entries_ref on journal_entries (ns, (entry->>'servicerRef'));
`

// The ledger's outbox (decision 990): items that report a booking, written in the booking's
// transaction (an intent before an open-ledger booking, decision 992); delivered and removed
// by the process. The message keys that make the delivery exactly once into the inbox and
// the journal (decision 991) are columns of theirs.
const OUTBOX_SCHEMA = `
create sequence if not exists outbox_seq;
create table if not exists outbox_items (
  ns      text   not null,
  key     text   not null,
  kind    text   not null,
  payload jsonb  not null,
  at      bigint not null,
  intent  text,
  ord     bigint not null,
  primary key (ns, key)
);
create index if not exists outbox_items_ord on outbox_items (ns, ord);
alter table inbox_messages add column if not exists msg_key text;
create unique index if not exists inbox_messages_key on inbox_messages (ns, msg_key) where msg_key is not null;
`

// Remembered business state (decision 961): one table for every KeyedStore kind. `ord`
// is the insertion order, `until` the expiry (ms; null: none).
const KEYED_SCHEMA = `
create sequence if not exists keyed_seq;
create table if not exists keyed_entries (
  ns    text   not null,
  kind  text   not null,
  key   text   not null,
  value jsonb  not null,
  ord   bigint not null,
  until bigint,
  primary key (ns, kind, key)
);
create index if not exists keyed_entries_ord on keyed_entries (ns, kind, ord);
`

// Customers and their accounts (decision 973). The customer JSON holds everything but the
// accounts; `ord` (dir_seq) is the order of first addition, of customers and of accounts.
const DIRECTORY_SCHEMA = `
create sequence if not exists dir_seq;
create table if not exists dir_customers (
  ns       text   not null,
  key      text   not null,
  code     text   not null,
  customer jsonb  not null,
  ord      bigint not null,
  primary key (ns, key)
);
create index if not exists dir_customers_code on dir_customers (ns, code);
create table if not exists dir_accounts (
  ns    text   not null,
  iban  text   not null,
  owner text   not null,
  info  jsonb  not null,
  ord   bigint not null,
  primary key (ns, iban)
);
create index if not exists dir_accounts_owner on dir_accounts (ns, owner, ord);
`

const SCHEMA_LOCK = 4410

/** Statements one by one: `create index if not exists` locks its table even when the index exists. */
function statements(sql: string): string[] {
  // A function body ($$ … $$) holds semicolons of its own.
  const out: string[] = []
  let cur = ''
  for (const part of sql.split('$$').map((p, i) => [p, i % 2 === 1] as const)) {
    if (part[1]) { cur += `$$${part[0]}$$`; continue }
    const pieces = part[0].split(';')
    cur += pieces[0]
    for (const p of pieces.slice(1)) { if (cur.trim()) out.push(cur); cur = p }
  }
  if (cur.trim()) out.push(cur)
  return out
}

/** A connection pool with the schema in place; one per process and database is enough. */
export class PgDb {
  private constructor(readonly pool: pg.Pool) {}

  static async connect(url: string, o: { max?: number } = {}): Promise<PgDb> {
    // allowExitOnIdle: a process (a test file) ends when its work is done, without close().
    const pool = new pg.Pool({ connectionString: url, max: o.max ?? 10, allowExitOnIdle: true })
    const c = await pool.connect()
    try {
      await c.query('select pg_advisory_lock($1)', [SCHEMA_LOCK])
      for (const s of [INBOX_SCHEMA, LEDGER_SCHEMA, AGENCY_SCHEMA, ACQUIRING_SCHEMA, RAILS_SCHEMA, JOURNAL_SCHEMA, KEYED_SCHEMA, DIRECTORY_SCHEMA, OUTBOX_SCHEMA].flatMap(statements)) await c.query(s)
    } finally {
      await c.query('select pg_advisory_unlock($1)', [SCHEMA_LOCK])
      c.release()
    }
    return new PgDb(pool)
  }

  close() { return this.pool.end() }
}
