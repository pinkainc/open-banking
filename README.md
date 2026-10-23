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
| **L0** | mTLS identity (subject `serialNumber`, CN fallback), service-provider scoping (`Client-Code` / `Client-Country`, `Filter-Service-Provider`), documented FORBIDDEN errors, `X-Bank-Code`, 413 above 5 MB, `X-Idempotency-Key` → 409; heartbeat (GET, `/mq`, POST); inbox: next / list / count / get / delete / bulk delete, `Filter-Response-Type`, 5-day expiry | done, except per-contract service grants and gzip of ≥10 MB messages | **52** (auth 16, inbox 19, heartbeat 5, http 5, real mTLS 7) |
| **L1** | `POST /payment` pain.001.001.09 and .03 (until 15.11.2026) with XSD validation; pain.002.001.10 / .03 reports with the documented group- and transaction-level error texts; camt.054.001.02 (.08 per customer) for every debit and credit, internal transfers notify both sides; automatic and requested scheme selection (INST / SEPA / TARGET2 / SWIFT) on simulated rails | done | **47** (payments 38, `/_sim` 9) |
| **L2** | account statements and balances: camt.060.001.05 / .03 → camt.053.001.08 / .02 (paged at 10 000, capped at 100 000, INTM balances) and camt.052.001.08 / .06 (intraday, DATE / DATETIME, PAYMENT_LIMITS, END_OF_DAY_BALANCE); `errStatement_*`; automatic end-of-day statement; Windows-1257 folding of free text | done; limits reported, not enforced | **52** (statements 31, balances 21) |
| **L3** | virtual IBANs: open / bulk (1–1000) / modify / info / close, all 13 documented error codes, status notifications, screening → ON_HOLD, payments to and from VIBANs booked on the master account (camt.054 carries the VIBAN) | done | **53** (viban 53) |
| **L4** | SEPA direct debit: `POST /direct-debit/collection` pain.008.001.08 → pain.002.001.10 (`DIRECT_DEBIT_OUTGOING`, ACCP then ACSC / RJCT at 11:30 CET on the TARGET2 settlement date, AM04), debtor notification pain.008 (`DIRECT_DEBIT_INCOMING_COLLECTION_NOTIFICATION`), `POST /direct-debit/incoming-collection` pain.007.001.09 refusal (cancel before the cut-off, return after it, refund within 8 weeks with camt.054 `RtrInf`), external creditors and R-transactions via `/_sim/direct-debit` | done; creditor-side pain.007 not implemented (endpoint not named, decision 309); Bacs DD is UK (S5) | **71** (creditor 45, debtor 25, real mTLS 1) |
| **L5a** | EE JSON services: FX `POST /fx/trade-offer` and `/fx/trade-offer-confirmation` (quotes valid 2 min, TODAY settled at confirmation, SPOT on T+2 TARGET2 days with the sold amount reserved, both legs booked with BkTxCd FORX in camt.054 / camt.053, documented error texts incl. the Jackson parse text); contract management `POST` / `GET /contracts` (service providers only, unsigned BDOC container, activation via `/_sim`); EE webhooks: one GENERAL_WEBHOOK subscription (subscribe / list / update / delete) and delivery of every inbox message, retried 1 min / 5 min / 30 min / 2 h (decision 421). Every JSON body is validated against `ssot/json-schemas/` in the tests | done; rates are made up, no currency holiday calendars | **67** (fx 17, fx errors 16, contracts 15, webhooks 9, webhooks over HTTP 10) |
| **L5b** | verification of payee (VoP / CoP), messages v2, signed (BDOC/ASiC-E) requests | not started | — |
| **L6** | agency accounts / indirect scheme access | not started | — |

Total: **342 tests, 342 passing**. Line coverage of `server/src` over the unit tests is
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

## `/_sim`: the emulator's control plane

Not part of the compatible API. JSON in and out, amounts as decimal strings.

| Call | Does |
| --- | --- |
| `GET /_sim/customers` | customers, accounts and balances (booked and available) |
| `POST /_sim/customers` | `{code, country, name, accounts?: [{iban, balances?}], camt054?: "02"\|"08", connected?}` → 201; 409 if it exists |
| `GET /_sim/accounts/:iban` | owner and balances |
| `POST /_sim/accounts/:iban/fund` | `{amount, currency?}`: money in, no notification |
| `POST /_sim/incoming` | `{iban, amount, currency?, scheme?: SEPA\|INST\|SWIFT\|TARGET2, debtor?, remittance?, reference?, endToEndId?}`: an incoming credit from another bank, booked and notified with camt.054 CRDT |
| `POST /_sim/rails/reject` | `{account, reason?}`: the scheme rejects payments to this account (pain.002 RJCT with the reason, reservation released) |
| `POST /_sim/rails/no-instant` | `{account}`: not reachable by SEPA Instant (requested INST is refused, automatic selection falls back to SEPA) |
| `GET /_sim/rails/sent` | what went out to the rails, with outcomes |
| `POST /_sim/rails/reset` | clears the above |

## Development

```bash
npm run check      # typecheck + all tests (fetches reference XSDs once if missing)
npm test           # tests only
npm run coverage   # c8 report in .rec/coverage/
```

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
