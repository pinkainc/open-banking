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
- [x] Route EE webhooks / EE services on the UK host by `x-bank-code: LHVEE` (decision 701, S5)
- [ ] (?) FX: one or two confirmations for TODAY, rates, error texts; contracts status codes; EE webhook retries and ownership (sandbox q35–42) → S8
- [x] VoP / CoP requester (EE XML both hosts, UK JSON VoP and CoP), `GET /test/accounts/ibans` (decisions 600–610, S4)
- [x] Messages v2 (list, metadata, processed / undelete) on the shared inbox, requests API, `/messages/test/next` (decisions 620–632, S4)
- [ ] Request log bounded by count only; bodies up to 5 MB each (decision 630)
- [ ] (?) VoP/CoP error delivery, matching rules, service grant, EE VoP via UK host; v2 archive and EE messages in v2 (sandbox q52–61) → S8
- [ ] Signed payments: `heartbeat.post` + BDOC/ASiC-E on `/payment`

## UK flavour

- [x] `X-Bank-Code` routing on the UK host (`LHVEE` → EE-only services, UK-only services 404 for LHV EE), heartbeat in UK time (decisions 700–704, S5)
- [x] `/accounts/*` (PascalCase JSON, AWS-style and bare-string errors, incoming pending / rejected, `/_sim/accounts/incoming`) (decisions 705–714, S5)
- [x] UK webhooks with X-LHV-HMAC (golden vector reproduced), 24 h retries, history, replay (decisions 720–729, S5)
- [x] Bacs: incoming credits, mandate accept / cancel, collection reject, unsolicited mandate initiation / scheme cancel / collection notification / reversal, 3-day cycle (decisions 740–749, S5)
- [ ] `CreDtTm` and other timestamps in pain/camt from the UK host are still Tallinn time (decision 704)
- [ ] Bank BIC `LHVBGB2L` only in `/accounts/*`; pain/camt keep `LHVBEE22` (decision 714)
- [ ] Content routing (pain.001 / camt.060 account decides LHV EE vs UK without the header) not modelled (decision 700)
- [ ] Bacs: unpaid collections send no message, mandate amendments not modelled, no outgoing Bacs / Faster Payments (LHV as originator)
- [ ] (?) Routing, `/accounts/*` shapes, UK webhook payload names (`regCode` vs `clientCode`), gzip + HMAC, retries, Bacs flows (sandbox q62–76) → S8

## L6 — agency / indirect scheme access → S6

- [x] Agency account synchronisation v1 + v2, RTF routing table files, CoP / VoP responder notifications (S6, decisions 800–813)
- [x] Merchant payment report `POST /acq/merchant-report` (P 13, decisions 820–826)
- [x] Payments from / to agency accounts, requester VoP / CoP over agency accounts, G PSP use cases 1–8 end to end (decisions 830–849)
- [ ] RTF for EBA STEP2 / RT1: 7 of 8 sample zips are password-protected, so the emulator only generates TARGET2 content; other schemes need the content supplied
- [x] Replay the partner-site `PAYMENT_PSP_USECASES/case1..8` samples on the EE host (S7, decisions 950–955): no case matches exactly, divergences asserted per case; sandbox q87
- [ ] Use case 7/8 camt.054: account currency and creditor bank name differ from the samples (no bank directory)
- [ ] `errMerchantReport_4` has no trigger
- [ ] (?) Agency bank codes, v2 rules, RTF content types, responder notification shapes, merchant report, agency payments on LHV UK (sandbox q77–86) → S8

## Core and conformance

- [x] Postgres for inbox (bytea bodies) and ledger, whole suite green on memory and Postgres (S7, decisions 900–918)
- [x] open-ledger as the `Ledger` over HTTP, ledger contract + e2e payment against a real open-ledger in `npm run check` (S7, 920–928)
- [x] `Rails` with asynchronous outcomes and scheme credits; `HttpRails` bridge client + protocol doc, pending rails payments survive a restart (S7, 930–938, 948)
- [x] Agency, acquiring, statements journal, payment engine state (duplicates, parked, limits), SEPA DD MsgIds in Postgres (S7, 940–947, 960–966)
- [x] Remaining business state in Postgres: customers and accounts, DD collections, Bacs, FX, contracts, VIBANs, webhooks, UK account reports, request log, idempotency keys, payee sim (S7b, 970–989)
- [x] Ledger outbox (906, 916) and idempotent bookings by key (S7b, 990–999)
- [x] After a crash a file round's pain.002 and parked-payment decision reports are resent once; a DD rejection report kept in the outbox (S7c, 1005–1007)
- [x] Two emulators writing the same VIBAN, FX pricing, webhook config or `/_sim/viban` fault: compare-and-set / `updateKeyed` / `claimName`; pg-contracts flake fixed (S7c, 1008–1013)
- [x] Returns of our own payments as rails `payment.returned` (camt.054 per LHV return sample), recall-return camt.054 with the VIBAN/agency party (S7c, 1014–1016, sandbox question 90)
- [ ] Still open from S7c: a crash during a file's checks loses the file (MsgId seen, nothing planned); a crash after a round's report and before rails leaves an external payment ACSP and reserved; later rounds (immediate rails outcomes) have no plan; payments settled before 1014 cannot be returned (1005, 1014)
- [x] Rails: DD returns and recalls (camt.056), reconciliation `GET /payments/{ref}` after a timeout, first stored outcome wins (S7b, 1000–1003)
- [x] `OPEN_BANKING_STORE=deferred` is the fourth step of `npm run check` (S7b, 1004)
- [ ] Conformance harness: record exchanges against connect.test.lhv.eu once a sandbox certificate exists, divergences file → S8
  - 2026-10-25: Gmail draft to connect@lhv.ee ready (subject "Request for LHV Connect TEST sandbox access": services, two test customers, light manual use, asks for sandbox terms); waits for company name, registry code, country, role and phone, then the user sends it
  - 2026-10-30: sent to connect@lhv.ee from stepanic.matija@gmail.com with ITalk d.o.o. details (MBS 081042440, HR54872935051); waiting for the reply

## Za pregled ujutro

Sve noćne odluke 500–968 korisnik je potvrdio 2026-10-24 (937 i 925 izričito, kako su zapisane); oznaka u `docs/decisions.md` je sad „(noćni rad, potvrđeno 2026-10-24)”. Novi noćni rad dodaje stavke ovdje.

Odluke iz noćnog rada S3 (2026-10-24), sve označene „(noćni rad, potvrđeno 2026-10-24)” u `docs/decisions.md`:

- [x] 500 host flavour (EE default, `CONNECT_FLAVOUR`)
- [x] 501 service grants: seed `services` (bez polja = sve usluge), provodi se samo za HEARTBEAT, ACCOUNT_STATEMENT, ACCOUNT_BALANCE, PAYMENTS_WITHOUT_SIGNATURE
- [x] 502 certifikati: seed `certificates` (SHA-256), mijenja odluku 2 (TLS greške samo zbog datuma dolaze do aplikacije)
- [x] 503 kompresija samo na UK hostu; `/messages/test/next?mockLargeMessage=true` već postoji (dio `messages.test.next` iz S4)
- [x] 504 granice memorije (5 d / 24 h / 100k / 200k MsgId bez vremenskog limita)
- [x] 521–522 pending i ručni pregled (seed `payments: DIRECT|PENDING`)
- [x] 523 ACWC fallback
- [x] 524 limiti se sad **provode** (mijenja odluku 109 „samo se javljaju”)
- [x] 525 duplikat = isti InstrId + računi + valuta + iznos (PAYMENT_MULTI ponavlja InstrId)
- [x] 526 cp1257 doslovno po dokumentaciji, uključujući `;` → `č`
- [x] 527 DD: klijent bez `directDebit` polja više ne može slati naplate ni primati obavijest (zamjenjuje 310)
- [x] 551 VIBAN kao vlastita strana u camt.053 mastera; 553 adresa banke po zemlji BIC-a

Odluke iz noćnog rada S4 (2026-10-24), označene „(noćni rad, potvrđeno 2026-10-24)”:

- [x] 601 pravila usporedbe imena (FULL / CLOSE) u `payee/match.ts`
- [x] 602 vlasnik računa: klijenti su uvijek BUSINESS, ACTIVE VIBAN odgovara imenom vlasnika; nepoznat račun NOT_APPLICABLE / NOAP / AC01
- [x] 603 greške EE VoP zahtjeva idu u inbox kao `<Errors>` (kao odluka 200), ne kao HTTP 4xx
- [x] 604–606 oblik UK VoP/CoP odgovora po G primjerima, greške u inboxu s `Data: null`, CoP ishod po kategoriji
- [x] 608 oblik `GET /test/accounts/ibans` (JSON polje IBAN-ova klijenta)
- [x] 609 VoP/CoP bez service granta
- [x] 620 v2 samo na UK hostu, jedno stanje za v1 i v2
- [x] 621 obrađene poruke čuvaju se tjedan dana od nastanka; **ponovljeni v1 DELETE sad daje 200 do 7 dana** (mijenja ponašanje iz 504)
- [x] 622–624 parametri `/v2/messages`, metapodaci, validacija PATCH-a
- [x] 630, 632 dnevnik zahtjeva (5 d / 10 000), datumi `/v2/requests` po UK kalendaru

Odluke iz noćnog rada S5 (2026-10-24), označene „(noćni rad, potvrđeno 2026-10-24)”:

- [x] 700–702 routing: `X-Bank-Code` bira entitet samo na UK hostu; EE-only servisi (FX, ugovori, SEPA DD, `POST /heartbeat`, EE webhookovi) na UK hostu **bez `LHVEE` sad daju 404** (dosad su radili); UK-only servisi 404 za LHV EE
- [x] 706–709 `/accounts/*`: oblik liste i straničenje, samo GB računi klijenta, AWS `{"Message"}` samo za identitet (inače goli JSON string), `TransactionId` i ime polja `VirtualAccount` su pretpostavka
- [x] 711, 713 odakle dolaze dolazni pending / rejected; parametri `/accounts/{acc}/payments` (`size` > 100 → 400)
- [x] 720 UK webhook konfiguracije: jedna po messageType po klijentu, tajna samo na POST/PUT, PUT bez tajne je rotira, konfiguracija pružatelja pokriva povezane klijente
- [x] 721 polja payloada: zadano `regCode`/`regCodeIssuer` (svi JSON primjeri), a golden HMAC vektor daje tek `clientCode`/`clientCountry` (opcija); dokumentacija je proturječna
- [x] 723, 725–728 retry raspored (12 pokušaja u 24 h), HMAC nad nekomprimiranim JSON-om, povijest 7 d / 10 000, greške JSON (403 ostaje XML), replay 200/400
- [x] 740–742 Bacs samo na UK hostu, bez gatea; kalendar Engleske i Walesa; dolazni kredit Pending pa knjižen 3. dan u 06:00
- [x] 743, 746 naplate: odbijena naplata se i dalje tereti (G use case 5), retry 11:30/15:00/18:30, mapiranje kodova
- [x] 744 mandati: G primjer koristi `Accptd` „0” za prihvat (obrnuto od XSD booleana) — mi tako čitamo
- [x] 745, 747, 749 sinkroni 400 `<Errors>` za loše dokumente; pravila otkaza i reversala; granice memorije Bacsa

Odluke iz noćnog rada S6 (2026-10-24), označene „(noćni rad, potvrđeno 2026-10-24)”:

- [x] 801–802 agency set-up po klijentu (ugovor, rasponi sort codea / IBAN prefiksa s master računom), bez ugovora sinkroni 403
- [x] 803–804 v1 sinkronizacija: jedan loš unos odbija cijeli batch; bez BankCodes računi idu u LHV EE; UK kod na EE hostu → INVALID_REQUEST
- [x] 806 v2 pravila (Name + AccountCategory obavezni uz responder, prazan Status)
- [x] 808–809 CoP / VoP responder: odgovor iz sinkroniziranih računa, notifikacija samo ako je uključena
- [x] 811 RTF: RT1 gzip, TARGET2 generiran, ostale sheme trebaju sadržaj izvana
- [x] 820–822, 825–826 merchant report: format, greške, period, sadržaj po primjeru umjesto po tablici P 13, prazan izvještaj
- [x] 831, 834–835 agency plaćanja: ime i adresa dužnika obavezni, INST_RESTRICTED, dolazni krediti na master račun
- [x] 840–841 GBP na UK račun ide Faster Paymentsom (`FAST`); Ultimate Debtor / Creditor sad u camt.054
- [x] **Promjena izlaza:** pain.002 više nema `OrgnlEndToEndId` (G: „Not used”); adresa VIBAN vlasnika u camt.054 sad samo ulica

Odluke iz noćnog rada S7 (2026-10-24), označene „(noćni rad, potvrđeno 2026-10-24)”:

- [x] 900–907 inbox u Postgresu: async sučelje, `bytea` + oznaka stringa, `ns` stupac, vrijeme iz injektiranog sata, granice u tablicama, bez zajedničke transakcije s ledgerom
- [x] 910–918 ledger u Postgresu: zaključavanje samo kod tereta (911, commit/release bez locka), prekidač testova, **popravak MemoryLedgera kod paralelnih rezervacija (913)**, seed se ne financira ponovno nakon restarta (914), ograničeni logovi (915)
- [x] 920–928 open-ledger kao `Ledger`: hold wallet po računu, imena walleta, `@` računi s limitom -(2^53-1), ključ `OPEN_LEDGER_KEY`, iznosi do 2^53-1 i abecedni redoslijed valuta (925)
- [x] 930–938 asinkroni `Rails`, odgođeni simulator, `HttpRails` protokol, ponašanje kod pada bridgea (936), **SEPA nakon INST pada nosi isti ref (937): bridge ključ ref + shema**
- [x] 940–949 agency i acquiring storeovi, seed se piše samo ako stanja nema (941), jedna sinkronizacija po procesu (942), pending rails plaćanja preživljavaju restart (948)
- [x] 950–955 partner PSP primjeri: **camt.054 sad nosi `PstlAdr` banke pod `Svcr` (950), `NOTPROVIDED` se ne ponavlja (951)**; razlike potvrđene u testu
- [x] 960–967 journal, keyed store, stanje payment enginea i DD MsgId u Postgresu; **knjiženje sad ide u journal prije izlaska iz in-flight limita (963)**
- [x] Umetnut paket **S7b** (ostatak trajnog stanja) prije S8, jer S7 nije stigao sve poslovno stanje (odluka 967) (potvrđeno)

Promjene ponašanja iz S7b (2026-10-24, korisnik budan, paket odobren; pogledati):

- [ ] 989 ponovljeni `X-Idempotency-Key` dok je prvi zahtjev još u obradi sad je 409, i na drugom emulatoru; ključ se vraća za odgovor ≥ 300
- [ ] 987 prvi pokušaj UK webhooka čeka da se zahtjev upiše u request log (do 5 s)
- [ ] 1002 `POST` prema bridgeu koji istekne više nije odmah RJCT nego ACSP i rekonsilijacija; bridge nakon 404 mora odbiti zakašnjeli `POST`
- [ ] 1001 opoziv (camt.056): DUPL / TECH / FRAD vraćaju se odmah, inače NOOR / ARDT / AM04 / NOAS

Promjene ponašanja iz S7c (2026-10-25, autonomno, paket odobren; pogledati):

- [ ] 1005 krug datoteke: sve transakcije se prvo provjere, plan kruga ide u outbox prije knjiženja; recovery dovrši prekinuti krug, timer ostavlja krugove 10 min
- [ ] 1006 ref naveden dvaput u jednoj odluci o parkiranim plaćanjima odlučuje se jednom
- [ ] 1009 VIBAN clientReference jedinstven preko emulatora (`viban-client-refs`); gubitnik dobiva „must be unique”
- [ ] 1011–1012 UK webhook: jedan config po vlasniku i tipu (400 za zauzet tip), `update` spaja polja; EE subscribe na isti URL daje istu pretplatu
- [ ] 1014 povrat vlastitog plaćanja: camt.054 po LHV uzorku „Credit Notification (Return)” (RvslInd, PMNT/RCDT/OTHR, RtrInf NARR + kod + `ORIG:<ref>`), ne ISO PMNT/ICDT/RRTN; djelomičan povrat dopušten, jedan po plaćanju; returnRef i MsgId nisu u camt.054
