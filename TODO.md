# TODO

Working list, kept in the repo so progress survives between sessions. Checked items are
done and verified (tests green in `npm run check`). Decisions go into
[docs/decisions.md](docs/decisions.md).

Plan to full parity, session by session: [docs/2026-10-23-plan-do-paritete.md](docs/2026-10-23-plan-do-paritete.md);
handoff per session in [docs/handoffs/](docs/handoffs/) (chain rules and status in its README).
How L0–L3 were built: [docs/2026-10-23-orkestracija-subagenata.md](docs/2026-10-23-orkestracija-subagenata.md).

Legend: `[x]` done · `[ ]` open · `[~]` in progress · `(?)` needs a sandbox recording first ·
`→ Sn` planned session

## L0 — transport, identity, inbox

- [x] mTLS identity, service-provider scoping, heartbeat (GET, `/mq`, POST), inbox (next / list / count / get / delete / bulk delete), `Filter-Response-Type`, 5-day expiry
- [x] Spec fixes from the docs mirror: messages-API 404/400 as JSON, DELETE of a never-existing id 404, bulk delete 200/207/400, empty list 204, `X-Bank-Code`, 413 above 5 MB, `X-Idempotency-Key` 409, heartbeat `AuthorizedUser` = certificate holder (decisions 8, 9, 11, 25–28)
- [ ] `X-Idempotency-Key` (decision 28) is documented only for the UK host; the EE host detects duplicates by pain.001 `MsgId` alone (mirror `ssot/ee-vs-uk.md`). Scope it per host → S3
- [ ] Per-contract service grants: 403 "User has not been granted the requested service" (services list per customer in the seed) → S3
- [ ] Certificate validity checks with their documented 403 texts (not yet valid, expired, "User authentication certificate is different than expected") → S3
- [ ] gzip/deflate of inbox messages ≥10 MB (`Accept-Encoding`), 500 without it → S3
- [ ] Bounded memory: inbox tombstones and remembered MsgIds / idempotency keys grow without limit → S3
- [ ] (?) Repeat DELETE, bulk statuses, heartbeat/mq type, idempotency and 413 on the EE host (`ssot/sandbox-questions.md`) → S8

## L1 — payments core

- [x] `POST /payment` pain.001.001.09 / .03, XSD validation, pain.002 group and transaction errors, camt.054 for every debit and credit, scheme selection on simulated rails
- [ ] `payment.oneoff` → S3
- [ ] Pending payments (SCA in the internet bank → PDNG, approve via `/_sim`), manual review (PDNG NARR) → S3
- [ ] ACWC "Payment processed as European payment" when an automatic instant payment falls back to SEPA after being attempted → S3
- [ ] Code page 1257 folding of free text echoed into pain.002 / camt.054 → S3
- [ ] Duplicate-payment detection (InstrId), daily/monthly limits enforced (10k / 100k / 15k instant) → S3
- [ ] PSP use-case samples (`PAYMENT_PSP_USECASES/case1..8`) once agency accounts exist; `PAYMENT_SWIFT_*` with their own expectations → S6

## L2 — account information

- [x] camt.060 → camt.053.001.08 / .02 and camt.052.001.08 / .06, paging, INTM, `errStatement_*`, automatic end-of-day statement (decisions 100–116)
- [ ] Real XSD validation of camt.053.001.02 and camt.052.001.06 with the public ISO 20022 schemas → S3
- [ ] Bank postal address (`PstlAdr`) in statements → S3
- [ ] (?) Are statement business errors inbox messages (decision 100, sandbox question 11)? How do INTM balances look? → S8

## L3 — virtual IBANs

- [x] open / bulk / modify / info / close, 13 error codes, status notifications, payments to and from VIBANs (decisions 200–212)
- [ ] VIBAN shown in camt.053 / camt.052 of the master account (samples camt.060 and camt.053A in `PAYMENT_VIBAN_SEPA`) → S3
- [ ] (?) VIBAN business errors: HTTP 4xx or inbox message (decision 200)? → S8

## L4 — SEPA direct debit

- [x] `dd.sepa.collection` pain.008.001.08 → pain.002, `dd.sepa.incoming_notification`, `dd.sepa.incoming_collection_refusal` (pain.007), refunds in camt.054, TARGET2 calendar, `/_sim/direct-debit` (decisions 300–318)
- [x] Statements (camt.053) carry each booking's own BkTxCd, so direct debits show PMNT/IDDT/ESDD and PMNT/RDDT/ESDD (done in S2)
- [ ] DD agreement per customer, debtor notification enabled by the account manager (decision 310) → S3
- [ ] (?) Creditor-side pain.007 endpoint (decision 309, sandbox q27); refusal texts, cancel notification, BkTxCd, refusal between cut-off and settlement (q30–34) → S8

## L5 — value-added services

- [x] FX trade offers and confirmations (TODAY / SPOT on the ledger), contract management, EE webhooks with delivery and retries; every JSON body schema-validated (decisions 400–424)
- [ ] FX: currency holiday calendars, TODAY cut-off, zero-decimal currencies (JPY); `contractStatus: failed` never produced; 10 s webhook delivery timeout untested
- [ ] Route EE webhooks / EE services on the UK host by `x-bank-code: LHVEE` → S5
- [ ] (?) FX: one or two confirmations for TODAY, rates, error texts; contracts status codes; EE webhook retries and ownership (sandbox q35–42) → S8
- [ ] VoP / CoP requester, messages v2, requests API → S4
- [ ] Signed payments: `heartbeat.post` + BDOC/ASiC-E on `/payment`

## UK flavour → S5

- [ ] `/accounts/*` (PascalCase JSON, AWS-style error bodies), `x-bank-code: LHVEE` routing to EE services
- [ ] UK webhooks with X-LHV-HMAC (golden value in the mirror), history, replay
- [ ] Bacs: incoming notification, mandates, collection reject

## L6 — agency / indirect scheme access → S6

- [ ] Agency account synchronisation (+ v2), routing tables, VoP / CoP responder roles, merchant report

## Core and conformance

- [ ] Persistence (Postgres) for inbox and ledger; open-ledger as the backing `Ledger`; real rails bridges behind `Rails` → S7
- [ ] Conformance harness: record exchanges against connect.test.lhv.eu once a sandbox certificate exists, divergences file → S8
