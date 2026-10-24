Nastavljamo open-banking: open-source server kompatibilan s LHV Connect API-jem (model S3/MinIO, kao /Users/ms/git/minka/open-ledger).

Repoi:
- /Users/ms/git/pinkainc/open-banking (main, origin na GitHubu; wrap-up pusha main): server, TypeScript + fastify.
- /Users/ms/git/pinkainc/docs.lhv-connect (main): mirror LHV dokumentacije i ssot/. NIKAD ga ne pushati.
- /Users/ms/git/minka/open-ledger: samo čitati i pokretati (treći korak `npm run check`).

Pročitaj prvo: docs/handoffs/README.md (lanac i pravila), docs/2026-10-23-plan-do-paritete.md, TODO.md („Core and conformance” i „Za pregled ujutro”), docs/2026-10-23-orkestracija-subagenata.md (poglavlje S7), docs/decisions.md (sekcije S7, posebno 949, 967, 968).

# S7b: ostatak trajnog stanja

Polazni commit: 9ce3088 (S7 kod) plus docs commit nakon njega. `npm run check` prolazi: memory 745/745, Postgres 745/745, open-ledger 21/21, skipped 0 (~1 min). Katalog 57/58.

Umetnut u noćnom radu S7 (odluka 968, potvrditi). S7 je stavio iza async sučelja s Postgres implementacijom: inbox, ledger, agency, acquiring, statements journal, stanje payment enginea (duplikati, parkirana plaćanja, limiti, pending rails), SEPA DD MsgId. Uzorak: `server/src/pg/db.ts` (jedan pool, shema pod advisory lockom), `pg/inbox.ts`, `pg/ledger.ts`, `pg/agency.ts`, `pg/keyed.ts` (`KeyedStore` za sitno stanje, odluka 961), namespace stupac, vrijeme iz injektiranog sata kao ms integer, read-then-write u kratkoj transakciji pod namespace lockom; memory implementacija ponašanjem identična.

Paket (redom, svaki komad commit kad je zelen):
1. Direktorij klijenata i računa (~250 linija, najširi refaktor jer su svi pozivatelji sinkroni). Bez njega parkirana plaćanja klijenata koje seed ne vraća ne mogu se odlučiti nakon restarta.
2. SEPA DD naplate koje čekaju namiru (~150): nakon restarta se gube, a rezervacije u ledgeru ostaju.
3. Bacs (~250), FX ponude (~120), ugovori (~120), VIBAN-i i VIBAN ugovori (~180), webhook pretplate, konfiguracije i povijest (~200), UK account report stanje (~150), request log (~80), HTTP idempotency ključevi (~40, `KeyedStore`), payee sim računi (~60).
4. Outbox za ledger + inbox (odluke 906, 916): knjiženje i poruka u istoj Postgres transakciji ili outbox tablica koju proces isporučuje; danas pad između njih gubi poruku (nikad novac).
5. `Rails`: DD povrati nakon namire i opozivi (camt.056) u sučelju (933); rekonsilijacija `GET /payments/{ref}` nakon timeouta (936).
6. Po želji: `OPEN_BANKING_STORE=deferred` (detektor propuštenih awaita, nasumično 1–7 ms) kao četvrti korak `npm run check` ako ne produži check previše.

Zamke iz S7:
- Propušteni `await` se na memory storeu nikad ne vidi. Prije Postgresa pusti suite s `OPEN_BANKING_STORE=deferred`; fiksna kašnjenja ne hvataju propušteni await na pisanju (redoslijed timera), nasumična hvataju.
- Seed se nakon restarta smije pisati samo ako stanja nema (odluke 914, 941, 962), inače se salda i set-upovi dupliraju ili gaze promjene iz `/_sim`.
- Dva procesa na istom namespaceu: što čita pa piše mora biti pod namespace lockom (942 je poznata iznimka za agency sync).

Gotovo kad: restart emulatora na istom namespaceu ne gubi poslovno stanje (Pg test po području), testovi zeleni na oba storea i open-ledger koraku, odluke od 970.

Noćne odluke S7 (900–968) čekaju potvrdu u TODO.md „Za pregled ujutro”. Nakon S7b slijedi S8 (blokiran: sandbox certifikat).
