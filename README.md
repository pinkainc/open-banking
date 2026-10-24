# open-banking

An open-source bank server compatible with the LHV Connect API: corporate clients and
service providers talk to it over mutual TLS exactly as they would to the bank —
heartbeat, the message inbox, pain.001 payment initiation answered with pain.002 status
reports and camt.054 notifications — so existing integrations run against it unchanged.

The model is S3. Amazon's implementation is closed, but its API is the contract, and
MinIO, Ceph and R2 implement that contract with their own internals. The bank's Connect
platform is a black box in the same way: what is public is the API its clients speak
(endpoints, headers, ISO 20022 messages, error texts). Everything behind that API here —
directory, ledger, inbox, payment engine, rails — is our own design. Today it runs as a
local emulator with simulated payment schemes; the `Ledger` and `Rails` interfaces are
where a real ledger and real scheme bridges plug in.

## How compatibility is established

**Now: the published documentation.** A local mirror of both upstream documentation
sites (the classic partners page and the GitBook hub, with the published XSDs and
sample XML) is kept next to this repo in `../docs.lhv-connect`, together with a
hand-written catalog of every operation, header, error text and message version. The
server follows that catalog. The test suite uses the mirror by path, never by copy:

- every pain.002.001.10 and camt.054 the server produces is validated against the
  bank's published XSDs;
- the published payment samples (`PAYMENT_INTERNAL`, `PAYMENT_SEPA`,
  `PAYMENT_SEPA_INST`, `PAYMENT_MULTI`) are replayed, and the answers must carry the
  same group and transaction statuses and the same scheme selection as the published
  responses;
- where the documentation is silent or contradicts itself, the choice is written down
  in [`docs/decisions.md`](docs/decisions.md) (77 entries), each with its reason.

**Next: recordings of the reference sandbox.** Once a sandbox certificate exists, a
script of questions only the sandbox can answer (repeat DELETE status, bulk-delete
statuses, heartbeat/mq response type, idempotency on the EE host, 413 on the EE host,
…) is recorded verbatim, and the server is then judged against those recordings the
way open-ledger (our Minka-compatible ledger) is judged against Minka's sandbox, with a
divergences file for the places where we answer differently on purpose. Where docs
and sandbox disagree, the sandbox wins.

## Status

Levels follow the implementation ladder of the docs mirror (`ssot/levels.md`).
Test counts are `node:test` cases in `server/test/`, all green (`npm run check`).

| Level | Scope | State | Tests |
| --- | --- | --- | --- |
| **L0** | mTLS identity (subject `serialNumber`, CN fallback), service-provider scoping (`Client-Code` / `Client-Country`, `Filter-Service-Provider`), documented FORBIDDEN errors, `X-Bank-Code`, 413 above 5 MB, `X-Idempotency-Key` → 409; heartbeat (GET, `/mq`, POST); inbox: next / list / count / get / delete / bulk delete, `Filter-Response-Type`, 5-day expiry ; host flavour EE / UK (`CONNECT_FLAVOUR`, `X-Idempotency-Key` on UK only), per-contract service grants, certificate validity / fingerprint 403s, gzip / deflate of ≥10 MB messages (UK host), bounded tombstones / MsgIds / idempotency keys | done | **~87** (auth 16, grants 5, certificates 7, inbox 19, heartbeat 5, http 6, compression 6, bounded 10, real mTLS 12) |
| **L1** | `POST /payment` pain.001.001.09 and .03 (until 15.11.2026) with XSD validation; pain.002.001.10 / .03 reports with the documented group- and transaction-level error texts; camt.054.001.02 (.08 per customer) for every debit and credit, internal transfers notify both sides; automatic and requested scheme selection (INST / SEPA / TARGET2 / SWIFT) on simulated rails; pending payments (SCA → PDNG, `/_sim/payments/pending`), manual review (PDNG "In manual review"), ACWC instant → SEPA fallback, Connect daily / monthly / instant limits enforced, duplicate payments, Windows-1257 folding; `payment.oneoff` deliberately 404 (removed 06.01.2026, decision 520) | done | **~77** (payments 36, flows 24, cp1257 8, `/_sim` 9) |
| **L2** | account statements and balances: camt.060.001.05 / .03 → camt.053.001.08 / .02 (paged at 10 000, capped at 100 000, INTM balances) and camt.052.001.08 / .06 (intraday, DATE / DATETIME, PAYMENT_LIMITS, END_OF_DAY_BALANCE); `errStatement_*`; automatic end-of-day statement; bank `PstlAdr` under `Svcr`; .02 / .06 validated against the public ISO 20022 schemas | done | **~55** (statements 34, balances 21) |
| **L3** | virtual IBANs: open / bulk (1–1000) / modify / info / close, all 13 documented error codes, status notifications, screening → ON_HOLD, payments to and from VIBANs booked on the master account (camt.054 carries the VIBAN, the master's camt.053 shows the VIBAN as its own side) | done | **~51** (viban 51) |
| **L4** | SEPA direct debit: `POST /direct-debit/collection` pain.008.001.08 → pain.002.001.10 (`DIRECT_DEBIT_OUTGOING`, ACCP then ACSC / RJCT at 11:30 CET on the TARGET2 settlement date, AM04), debtor notification pain.008 (`DIRECT_DEBIT_INCOMING_COLLECTION_NOTIFICATION`), `POST /direct-debit/incoming-collection` pain.007.001.09 refusal (cancel before the cut-off, return after it, refund within 8 weeks with camt.054 `RtrInf`), external creditors and R-transactions via `/_sim/direct-debit`; DD agreement and debtor notification per customer (decision 527) | done; creditor-side pain.007 not implemented (endpoint not named, decision 309); Bacs DD is UK (S5) | **71** (creditor 45, debtor 25, real mTLS 1) |
| **L5a** | EE JSON services: FX `POST /fx/trade-offer` and `/fx/trade-offer-confirmation` (quotes valid 2 min, TODAY settled at confirmation, SPOT on T+2 TARGET2 days with the sold amount reserved, both legs booked with BkTxCd FORX in camt.054 / camt.053, documented error texts incl. the Jackson parse text); contract management `POST` / `GET /contracts` (service providers only, unsigned BDOC container, activation via `/_sim`); EE webhooks: one GENERAL_WEBHOOK subscription (subscribe / list / update / delete) and delivery of every inbox message, retried 1 min / 5 min / 30 min / 2 h (decision 421). Every JSON body is validated against `ssot/json-schemas/` in the tests | done; rates are made up, no currency holiday calendars | **67** (fx 17, fx errors 16, contracts 15, webhooks 9, webhooks over HTTP 10) |
| **L5b** | verification of payee requester: EE XML `POST /verification-of-payee` (both hosts, answers XSD-valid), UK JSON `/payment/vop-request` and `/payment/cop-request` (name matcher, CoP by account category, `/_sim/payee/accounts` for other banks), EE TEST `GET /test/accounts/ibans`; messages v2 on the UK host (`GET /v2/messages` with pages, `includeProcessed`, metadata; `PATCH /v2/messages/processed` with undelete and a week's archive) sharing the v1 inbox; requests API (`GET /v2/requests`, `/v2/requests/{id}` with the body as submitted); `GET /messages/test/next`. Signed (BDOC/ASiC-E) requests not started | partly (S4) | **~54** (payee 18, messages v2 35) |
| **UK** | LHV UK host (`CONNECT_FLAVOUR=UK`): `X-Bank-Code` routing (`LHVEE` reaches the EE-only services FX, contracts, SEPA DD, `POST /heartbeat`, EE webhooks; without it they are 404; UK-only services 404 for LHV EE; one table in `server/src/routing.ts`), heartbeat in UK time; `/accounts/list`, `/accounts/{acc}/transactions/{ref}`, `/accounts/{acc}/payments` (PascalCase JSON, AWS-style and bare-string errors, incoming pending / rejected); UK webhooks (`/notifications/subscription[/{ref}]`, `/history`, `/replay`) signed with `X-LHV-HMAC` (golden vector of the docs reproduced), retries for 24 h; Bacs: incoming credits (`BACS_INCOMING`), mandate accept / cancel (pain.012 / pain.011), collection reject (pain.002), unsolicited mandate initiation, scheme cancel, collection notification, reversal, on the England and Wales 3-day cycle | done (S5); `CreDtTm` in pain/camt still Tallinn time, bank BIC `LHVBGB2L` only in `/accounts/*`, no content routing by account | **72** (routing 9, accounts 15, webhooks 29, webhooks over HTTP 2, Bacs 17) |
| **L6** | indirect scheme access: agency account sync v1 `POST /agent/account/synchronize` (XML, bank codes LHVEE / LHVUK) and v2 `POST /v2/agent/account/synchronize` (JSON, UK, OK / PARTIAL / FAILED per account), agent set-ups with ranges and master accounts (`/_sim/agency`), RTF routing table files (`AGENT_REPORT`), CoP / VoP responder notifications (`CONFIRMATION_OF_PAYEE_INCOMING`, `VERIFICATION_OF_PAYEE_INCOMING_NOTIFICATION`) answered from synced accounts; payments from agency accounts (IBAN or `Othr/Id`, name and address mandatory) and credits to them booked on the master account (CLOSED → AC04, INST_RESTRICTED refuses SEPA Instant); requester VoP / CoP find agency accounts; G PSP use cases 1–8 as end-to-end chains (pain.001 → ACSP → ACSC → camt.054) on the UK host, GBP to UK accounts by Faster Payments; card acquiring `POST /acq/merchant-report` (P 13, camt.054 report as `ACQ_REPORT`, transactions via `/_sim/acq`) | done (S6); 7 of 8 RTF samples are password-protected; partner-site `PAYMENT_PSP_USECASES` case1..8 replayed on the EE host with asserted divergences (decisions 950–955) | **~55** (agency 27, agency payments ~8, PSP use cases 5 + 8, acquiring ~7) |
| **Core** | durability and backends: every store behind an async interface; Postgres (`DATABASE_URL`) for the inbox (binary bodies as `bytea`), the ledger (balances, holds, append-only postings, advisory lock per debited account), agency and acquiring state, the statements journal, payment duplicate checks, parked payments, limits and pending rails payments, customers and accounts, SEPA DD collections, Bacs, FX, contracts, VIBANs, webhooks, UK account reports, the request log, idempotency keys and the payee simulator, all per `STORE_NAMESPACE` and restart-safe; a ledger outbox (a booking's camt.054 and statement entry saved in the booking's transaction, recovered at start) and idempotent bookings by key; open-ledger as the `Ledger` over HTTP (`LEDGER=open-ledger`, hold wallet per account); `Rails` with asynchronous outcomes and incoming credits, `HttpRails` bridge client with HMAC callbacks, DD returns, recalls (camt.056) and reconciliation after a timeout ([protocol](docs/rails-bridge-protocol.md)) | done (S7 + S7b, decisions 900–1004); after a crash a file round's pain.002 is not resent (999) | **~210** (pg inbox, pg ledger, ledger contract on 3 backends, rails async, rails http, pg per area, pg outbox, pg bookings) |

Total: **817 tests, 817 passing on the memory store and 817 on Postgres, 690 on the deferred store, plus 27 against a real open-ledger** (per-level counts are approximate since S3). Line coverage of `server/src` over the unit tests is
about 99.5 % (`npm run coverage`, c8 through tsx source maps, so treat it as approximate).
Not yet compared against the real sandbox: everything above is "as documented", not
"as recorded".

## Quick start

Node 20 or newer and `openssl`.

```bash
npm install
npm run dev-ca            # throwaway CA, server cert, client certs in .certs/
npm start                 # https://127.0.0.1:8443, mutual TLS
```

`scripts/dev-ca.sh` issues one client certificate per demo customer of
`config/dev-seed.json`; the subject `serialNumber` carries the registration code, which
is how the server tells clients apart:

| Certificate | Registration code | Who |
| --- | --- | --- |
| `client1` | 12340001 | Demo Customer 1, `EE337700771001260958` (EUR 10 000, USD 500, GBP 500) |
| `client2` | 12340002 | Demo Customer 2, `EE267700771001260987` (EUR 100) |
| `provider` | 10000001 | a service provider connected to both customers |
| `stranger` | 99999999 | trusted CA, unknown customer → 403 |

More: `scripts/dev-ca.sh client acme 55500001`, then create the customer through `/_sim`.

```bash
C="--cacert .certs/ca.crt --cert .certs/client1.crt --key .certs/client1.key"
URL=https://localhost:8443

curl $C $URL/heartbeat
curl $C -i $URL/heartbeat/mq                       # 202 + Message-Request-Id
curl $C -i $URL/messages/next                      # the HEARTBEAT message
curl $C -X DELETE $URL/messages/RES…               # confirm it
curl $C "$URL/messages?limit=100"; curl $C $URL/messages/count

# A payment (pain.001.001.09) to the other demo customer:
curl $C -i -H 'Content-Type: application/xml' --data-binary @payment.xml $URL/payment
curl $C -i $URL/messages/next                      # pain.002 ACSC, then camt.054 DBIT

# As the service provider, acting for customer 1:
P="--cacert .certs/ca.crt --cert .certs/provider.crt --key .certs/provider.key"
curl $P -H 'Client-Code: 12340001' -H 'Client-Country: EE' $URL/messages/count
```

The published samples work as payment files as they are; they use placeholder
creditor IBANs, so start with `STRICT_IBAN=0` for them.

### Settings (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | `8443`, `127.0.0.1` | listen address |
| `CERTS_DIR` | `.certs` | where `server.key`, `server.crt`, `ca.crt` are (or `TLS_KEY`, `TLS_CERT`, `TLS_CA`) |
| `SEED` | `config/dev-seed.json` | customers, accounts, balances, provider connections |
| `XSD_DIR` | `reference/xsd` | the bank's XSDs; without them pain.001 gets structural checks only. `npm run fetch-reference` downloads them (pinned checksums), or point it at the docs mirror's `_raw/partners/assets/files/XSD` |
| `STRICT_IBAN` | on | `0` skips creditor IBAN check digits |
| `PAIN_001_001_03_UNTIL` | `2026-11-15` | first day pain.001.001.03 is refused |
| `SIM` | on | `0` removes the `/_sim` control plane |
| `LOG` | off | one line per request on stderr |
| `CONNECT_FLAVOUR` | `EE` | `UK` makes the server behave as connect.lhv.eu (`X-Idempotency-Key`, compression of ≥10 MB messages, default `X-Bank-Code`) |
| `MAX_TOMBSTONES`, `MAX_MSGIDS`, `MAX_IDEMPOTENCY_KEYS` | 100000, 200000, 100000 | caps on what is remembered (decision 504) |
| `MAX_PROCESSED`, `MAX_REQUESTS` | 10000, 10000 (7 d, 5 d) | caps on processed (v2) messages and the request log behind `/v2/requests` |
| `DATABASE_URL` | unset | Postgres for the inbox, ledger and the durable stores; unset = memory |
| `STORE_NAMESPACE` (old: `INBOX_NAMESPACE`) | `default` | rows of this server instance; several instances may share one database |
| `DATABASE_POOL_MAX` | 10 | Postgres pool size |
| `LEDGER` | `postgres` with `DATABASE_URL`, else `memory` | `open-ledger` books on an open-ledger server |
| `OPEN_LEDGER_URL`, `OPEN_LEDGER_KEY`, `OPEN_LEDGER_TIMEOUT_MS` | —, fresh key with a warning, 10000 | open-ledger API (`/api/v2` added), our ed25519 secret (32 bytes, base64; keep it, the ledger is only reachable with it) |
| `RAILS` | `simulator` | `http` hands payments to an external scheme bridge |
| `RAILS_URL`, `RAILS_URL_<SCHEME>`, `RAILS_SECRET`, `RAILS_TIMEOUT_MS` | —, —, —, 10000 | bridge base URL (per scheme: SEPA, INST, SWIFT, TARGET2, FAST), shared HMAC secret |
| `RAILS_CALLBACK_HOST`, `RAILS_CALLBACK_PORT` | `127.0.0.1`, 8444 | plain-HTTP listener for the bridge's `POST /rails/events` |

## `/_sim`: the emulator's control plane

Not part of the compatible API. JSON in and out, amounts as decimal strings.

| Call | Does |
| --- | --- |
| `GET /_sim/customers` | customers, accounts and balances (booked and available) |
| `POST /_sim/customers` | `{code, country, name, accounts?: [{iban, balances?}], camt054?: "02"\|"08", connected?}` → 201; 409 if it exists |
| `PATCH /_sim/customers/:country/:code` | `{payments?: "DIRECT"\|"PENDING", directDebit?: {agreement?, debtorNotification?}}`: what an account manager would switch (decisions 521, 527) |
| `GET /_sim/payments/pending` | payments waiting for SCA in the internet bank or in manual review |
| `POST /_sim/payments/pending/approve` | `{refs: [AcctSvcrRef]}` |
| `POST /_sim/payments/pending/reject` | `{refs, reason?}`: RJCT "Requested by customer." unless a reason is given |
| `GET /_sim/accounts/:iban` | owner and balances |
| `POST /_sim/accounts/:iban/fund` | `{amount, currency?}`: money in, no notification |
| `POST /_sim/incoming` | `{iban, amount, currency?, scheme?: SEPA\|INST\|SWIFT\|TARGET2, debtor?, remittance?, reference?, endToEndId?}`: an incoming credit from another bank, booked and notified with camt.054 CRDT |
| `POST /_sim/rails/reject` | `{account, reason?}`: the scheme rejects payments to this account (pain.002 RJCT with the reason, reservation released) |
| `POST /_sim/rails/no-instant` | `{account}`: not reachable by SEPA Instant (requested INST is refused, automatic selection falls back to SEPA) |
| `POST /_sim/rails/instant-failure` | `{account}`: SEPA Instant attempts fail at the rails (automatic → ACWC and SEPA, requested INST → RJCT) |
| `GET /_sim/rails/sent` | what went out to the rails, with outcomes |
| `POST /_sim/rails/reset` | clears the above |
| `POST /_sim/accounts/incoming` | UK host: hold an incoming payment as Pending, then `…/{ref}/approve` or `…/{ref}/reject` (decision 712) |
| `/_sim/webhooks/uk` | UK host: inspect and drive UK webhook deliveries (decision 729) |
| `/_sim/bacs/…` | UK host: incoming Bacs credit, mandate initiation, collection, scheme cancel, reversal (decisions 740–747) |

## Development

```bash
npm run check      # typecheck + all tests twice (memory, then project Postgres) + open-ledger ledger tests if ../../minka/open-ledger exists
npm test           # tests only
npm run coverage   # c8 report in .rec/coverage/
```

`npm run check` starts a project-local Postgres (`scripts/dev-db.sh`, Homebrew postgresql@17, data in `.rec/pgdata`, port 5441) and gives each run a fresh database. `OPEN_BANKING_STORE=postgres npm test` runs the suite on Postgres by hand; `OPEN_BANKING_STORE=deferred` delays every store call 1–7 ms to catch missing awaits; `npm run check` runs it alongside the other two (~1 min 40 s in all).

Tests read the bank's XSDs and samples from the docs mirror (`LHV_DOCS_DIR`, default
`../docs.lhv-connect`) or from `reference/` (`npm run fetch-reference`); tests that
need them skip with a message when neither is there.

Layout: `server/src/app.ts` (HTTP surface), `auth.ts` (certificate → customer,
provider headers), `inbox.ts`, `payments/` (pain.001 reader, engine, pain.002 and
camt.054 writers, XSD validation), `ledger.ts` and `rails.ts` (interfaces with in-memory
and simulated implementations), `sim.ts`. [`TODO.md`](TODO.md) has what comes next.

`docs/research/` holds background research (who uses the API, whether a compatible
server makes sense); it is notes, not specification.

## Legal

This repository contains only our own code and our own descriptions of the API. The
bank's documentation, XSDs and sample files are not included: the docs mirror is an
internal reference kept outside this repository and is not redistributed, and the XSDs
are fetched from the bank's public site on demand, never committed. Reimplementing a
public interface is lawful in the EU: the Court of Justice held in *SAS Institute v
World Programming* (C-406/10, 2012) that the functionality of a program, its
programming language and its data file formats are not protected by copyright. Names
of the bank and its products are used only to say what this server is compatible
with; this project is not affiliated with or endorsed by the bank.

License: MIT.
