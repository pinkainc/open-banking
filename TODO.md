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
- [x] Host flavour EE / UK; `X-Idempotency-Key` only on the UK host (decision 500, S3)
- [x] Per-contract service grants, 403 "User has not been granted the requested service" for the four documented service names (decision 501, S3)
- [ ] Service names for VIBAN, DD, FX, VoP, contracts, webhooks are undocumented, so those routes are not gated (sandbox q43) → S8
- [x] Certificate validity checks with their documented 403 texts (decision 502, S3); SK/OCSP texts not produced
- [x] gzip/deflate of messages ≥10 MB on the UK host, 500 without `Accept-Encoding` (decision 503, S3)
- [x] Bounded memory: tombstones, MsgIds, idempotency keys (decision 504, S3)
- [ ] (?) Repeat DELETE, bulk statuses, heartbeat/mq type, idempotency and 413 on the EE host (`ssot/sandbox-questions.md`) → S8

## L1 — payments core

- [x] `POST /payment` pain.001.001.09 / .03, XSD validation, pain.002 group and transaction errors, camt.054 for every debit and credit, scheme selection on simulated rails
- [x] `payment.oneoff`: removed by LHV on 06.01.2026, stays 404 (decision 520, S3)
- [x] Pending payments (SCA → PDNG, `/_sim/payments/pending`), manual review (decisions 521, 522, S3)
- [x] ACWC instant → SEPA fallback, `/_sim/rails/instant-failure` (decision 523, S3)
- [x] Code page 1257 folding in pain.002 / camt.054 / rails (decision 526, S3)
- [ ] Folding for direct debit and VIBAN texts
- [x] Duplicate payments (InstrId + accounts + amount), limits enforced (decisions 524, 525, S3)
- [ ] camt.052 PAYMENT_LIMITS counts only booked debits; enforcement also counts accepted, unbooked ones
- [ ] PSP use-case samples (`PAYMENT_PSP_USECASES/case1..8`) once agency accounts exist; `PAYMENT_SWIFT_*` with their own expectations → S6

## L2 — account information

- [x] camt.060 → camt.053.001.08 / .02 and camt.052.001.08 / .06, paging, INTM, `errStatement_*`, automatic end-of-day statement (decisions 100–116)
- [x] camt.053.001.02 / camt.052.001.06 validated with the ISO 20022 schemas (decision 550, S3)
- [x] Bank `PstlAdr` in camt.053 (decision 553, S3)
- [ ] Bank `PstlAdr` in camt.054; UK flavour does not switch the bank BIC to `LHVBGB2L`
- [ ] (?) Are statement business errors inbox messages (decision 100, sandbox question 11)? How do INTM balances look? → S8

## L3 — virtual IBANs

- [x] open / bulk / modify / info / close, 13 error codes, status notifications, payments to and from VIBANs (decisions 200–212)
- [x] VIBAN in the master account's camt.053, not in camt.052 (decisions 551, 552, S3)
- [ ] (?) VIBAN business errors: HTTP 4xx or inbox message (decision 200)? → S8

## L4 — SEPA direct debit

- [x] `dd.sepa.collection` pain.008.001.08 → pain.002, `dd.sepa.incoming_notification`, `dd.sepa.incoming_collection_refusal` (pain.007), refunds in camt.054, TARGET2 calendar, `/_sim/direct-debit` (decisions 300–318)
- [x] Statements (camt.053) carry each booking's own BkTxCd, so direct debits show PMNT/IDDT/ESDD and PMNT/RDDT/ESDD (done in S2)
- [x] DD agreement and debtor notification per customer (decision 527, S3)
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

## Za pregled ujutro

Odluke iz noćnog rada S3 (2026-10-24), sve označene „(noćni rad, potvrditi)” u `docs/decisions.md`:

- [ ] 500 host flavour (EE default, `CONNECT_FLAVOUR`)
- [ ] 501 service grants: seed `services` (bez polja = sve usluge), provodi se samo za HEARTBEAT, ACCOUNT_STATEMENT, ACCOUNT_BALANCE, PAYMENTS_WITHOUT_SIGNATURE
- [ ] 502 certifikati: seed `certificates` (SHA-256), mijenja odluku 2 (TLS greške samo zbog datuma dolaze do aplikacije)
- [ ] 503 kompresija samo na UK hostu; `/messages/test/next?mockLargeMessage=true` već postoji (dio `messages.test.next` iz S4)
- [ ] 504 granice memorije (5 d / 24 h / 100k / 200k MsgId bez vremenskog limita)
- [ ] 521–522 pending i ručni pregled (seed `payments: DIRECT|PENDING`)
- [ ] 523 ACWC fallback
- [ ] 524 limiti se sad **provode** (mijenja odluku 109 „samo se javljaju”)
- [ ] 525 duplikat = isti InstrId + računi + valuta + iznos (PAYMENT_MULTI ponavlja InstrId)
- [ ] 526 cp1257 doslovno po dokumentaciji, uključujući `;` → `č`
- [ ] 527 DD: klijent bez `directDebit` polja više ne može slati naplate ni primati obavijest (zamjenjuje 310)
- [ ] 551 VIBAN kao vlastita strana u camt.053 mastera; 553 adresa banke po zemlji BIC-a

