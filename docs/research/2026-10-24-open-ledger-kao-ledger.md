# open-ledger kao `Ledger` (korak C)

Zaključak: `OpenLedgerLedger` (`server/src/ledgers/open-ledger.ts`) razgovara s open-ledger
serverom preko čistog HTTP-a i `node:crypto`, bez `@minka/ledger-sdk` (u open-ledgeru je
samo devDependency; JWT i potpis su ~40 redaka, a naš popis ovisnosti ostaje isti).
Rezervacija je prijenos na hold wallet računa, ne open-ledgerov `reserved` saldo.
Odluke 920–928 u `docs/decisions.md`.

Izvori: open-ledger `server/src/app.ts` (autentikacija, rute), `crypto.ts`, `access.ts`,
`core.ts` (`checkLimits`, prepare/commit), `conformance/scenarios/common.ts` i `l3.ts`
(limiti, overdraft), plus pokusi na živom serveru (`PORT=… npx tsx server/src/main.ts`).

## Autentikacija i potpis

- Svaki zahtjev: `Authorization: Bearer <JWT>`, `alg: EdDSA`, `kid` = sirovi ed25519 javni
  ključ (base64). Payload `iss`/`sub: signer:<pub>`/`aud: <ledger>`/`iat`/`exp`. Server
  provjerava `jwtVerify(token, publicKeyObject(kid))`; `hsh` (vezanje tokena na zahtjev)
  nije obavezan, prazan ili izostavljen ne veže ništa.
- Zahtjevi unutar ledgera nose `x-ledger: <handle>`.
- Zapis: `{ data, hash, meta: { proofs: [proof] } }`, `hash = sha256(JCS(data))`,
  `digest = sha256(hash + JCS(custom))`, `result = ed25519(digest bajtovi)` u base64,
  `method: ed25519-v2`, `custom: { moment, status: 'created' }`.
- Ključevi: sirovih 32 bajta u base64 (`ed25519-raw`); u node:crypto kroz PKCS#8/SPKI DER
  prefikse kao u open-ledger `crypto.ts`.

## Ledger, simboli, walleti, intenti, salda

- Ledger: `POST /ledgers` (bez `x-ledger`), `{ handle, signer: 'system', config:
  { 'access.strategy': 'record-based' }, access }`. Duplikat je 409 `record.duplicated`.
- Pristup: pravilo na razini ledgera bez `record` pokriva samo ledger (access.ts, "scope"),
  pa treba `record: 'any'`. Pravilo `signer` vrijedi samo za mutacije (dokazi), čitanja
  traže `bearer: { $signer: { public } }`. Naš ledger i svaki zapis daju `any` samo našem
  ključu, oba oblika; drugi ključ dobije 403 (provjereno testom).
- Simbol: `POST /symbols { handle: 'eur', factor: 100 }`. Wallet: `POST /wallets { handle }`.
- Intent: `POST /intents { handle, claims, custom }`, claim
  `{ action: 'transfer', source: { handle }, target: { handle }, symbol: { handle }, amount }`.
  Odgovor 201, obrada je asinkrona: `meta.status` ide do `completed` ili `rejected`;
  razlog odbijanja je u zadnjem dokazu (`custom.reason`, npr. `core.limit-exceeded`,
  `core.routing-failed` za nepostojeći wallet). Duplikat handlea je 409.
- Salda: `GET /wallets/<h>/balances`, retci `{ symbol, schema: 'available'|'reserved', amount }`
  poredani po simbolu; nepoznat wallet je 404. Iznosi su JSON brojevi, najviše 2^53-1
  (schema `amount.maximum`), aritmetika u serveru je `number`.
- Lista intenata: `GET /intents?page.index=&page.limit=`, najnoviji prvi.

## Overdraft i sistemski računi

open-ledger odbija debit ispod `minBalance` walleta, zadano 0 → `core.limit-exceeded`, što
mapiramo u `InsufficientFunds`. Sistemski račun (`@…`) smije u minus: prije prvog knjiženja u
valuti dobije limit intent `{ action: 'limit', metric: 'minBalance', wallet, symbol, amount:
-(2^53-1) }` (l3: "overdraft within limit"). `issue`/`destroy` bi novac stvarali ni iz čega,
ali tada saldo `@funding` ne bi postojao, pa nisu korišteni.

## reserve / commit / release

- (a) hold walleti: reserve = intent račun → `h.<račun>`; commit = `h.<račun>` → odredište;
  release = `h.<račun>` → račun. Svaki korak je jedan dovršen intent, open-ledger sam
  serijalizira provjeru limita (20 paralelnih rezervacija na 500: točno 5 prođe).
- (b) open-ledgerov `reserved` saldo postoji samo dok intent visi u prepare fazi, a to je
  moguće samo s bridgeom koji odgađa odgovor. Trebao bi nam vlastiti bridge HTTP server, a
  odredište se ionako zna tek pri commitu (drugi intent). Složenije, ništa ne dobivamo.

Izabrano (a). Saldo = wallet + njegov hold wallet; raspoloživo = wallet. Commit i release
dijele handle `s.<ref>.<n>`, pa rezervacija može biti namirena samo jednom (drugi pokušaj
dobije 409). Odbijeni intent zauzme handle, a ugovor dopušta ponoviti ref nakon
`InsufficientFunds`, zato je otvarajući intent `o.<ref>.<n>`: zauzet handle se preskače ako je
odbijen, ako je bio transfer ili ako je rezervacija namirena; inače "reservation exists".

## Ograničenja (odluka 925)

- Iznosi iznad 2^53-1 minor jedinica: `RangeError` umjesto zaokruživanja.
- Valute računa idu po simbolu (EUR, GBP, USD), ne po redu prvog knjiženja: open-ledger ga
  ne pamti.
- `postings()` čita sve intente (O(n)); za dijagnostiku i testove, ne za vruću putanju.
