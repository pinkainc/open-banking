# Plan do pune paritete s LHV Connectom (2026-10-23)

Ovo je plan za buduće Claude Code sesije, složen po uzoru na open-ledger
(`/Users/ms/git/minka/open-ledger/docs/2026-10-10-plan-do-paritete.md`). Cilj je da
open-banking pokrije svih 58 operacija iz `docs.lhv-connect/ssot/operations.yaml`,
svaku s testovima. Svaka sesija je jedan paket. Završava se zelenim `npm run check`,
commitom i `/wrap-up` handoffom koji imenuje sljedeći paket iz ove tablice.

Handoffi za sve sesije su u `docs/handoffs/` (`S1.md` … `S8.md`), a pravila lanca u
`docs/handoffs/README.md`.

## Razlika prema open-ledgeru

open-ledger ima pristup Minkinom sandboxu, pa je ondje istina snimka, a dokumentacija
samo hipoteza. Svaki paket završava scenarijem koji je snimljen i jednak našem serveru.
**Ovdje sandboxa nema** dok se ne dobije certifikat (upit na connect@lhv.ee, u ime
firme, odluka korisnika). Zato:

- „gotovo” ovdje znači *kako je dokumentirano*: XSD validacija, replay objavljenih
  primjera, testovi, i svaka pretpostavka zapisana u `docs/decisions.md` s brojem
  pitanja iz `docs.lhv-connect/ssot/sandbox-questions.md` ako ga ima;
- lokalni SSOT (`docs.lhv-connect/ssot/`) je završen koliko se dalo iz dokumentacije;
  preostalih 10 `uncertain` unosa i 42 sandbox pitanja (30–34 dodana u S1, 35–42 u S2) zatvara tek S8;
- nova pitanja za sandbox dopisuju se u `sandbox-questions.md` (mirror repo, lokalno,
  nikad ne pushati).

## Polazno stanje (commit `bcc23e0`)

| Mjera | Stanje |
| --- | --- |
| Operacije | 14/58 (heartbeat ×3, messages ×6, payment.initiate, notification.credit_debit, account.statement, account.balance, viban.*) |
| Razine | L0, L1, L2, L3 gotove |
| Testovi | 204/204 (`npm run check`), pokrivenost linija ~99 % (`npm run coverage`) |
| Odluke | 1–28 (L0/L1), 100–116 (L2), 200–212 (L3) |

## Plan po sesijama

Brojke operacija su kumulativne. Odluke svake sesije numeriraju se od svog bloka da
se paralelni worktreeji ne sudare.

| # | Paket | Sadržaj | Operacije | Odluke | Gotovo kad |
| --- | --- | --- | --- | --- | --- |
| **S1** | L4 SEPA direct debit | `dd.sepa.collection` (pain.008.001.02/.08 → pain.002.001.10), opoziv i povrat (pain.007), dužnička strana `dd.sepa.incoming_notification` i `dd.sepa.incoming_collection_refusal`, povrati u camt.054, `/_sim` za naplatu na dužnika | +3 → 17 | 300– | XSD validacija i replay `DIRECT_DEBIT*` primjera iz mirrora; testovi zeleni |
| **S2** | L5a JSON servisi (EE) | `fx.trade_offer`, `fx.trade_offer_confirmation`, `contracts.create`, `contracts.list`, EE webhookovi `webhook.ee.subscribe/list/update/delete/delivery` (jedna GENERAL_WEBHOOK pretplata, bez potpisa) | +9 → 26 | 400– | sve JSON tijela validirana `ssot/json-schemas/`; isporuka webhooka testirana lokalnim primateljem |
| **S3** | Dugovi L0–L3 + pending | `payment.oneoff`; pending plaćanja (SCA u internet banci → PDNG, odobrenje preko `/_sim`, PDNG NARR); `X-Idempotency-Key` samo na UK hostu (odluka 28); per-contract service grants (403); provjere certifikata s dokumentiranim 403 tekstovima; gzip ≥10 MB; ACWC fallback; ograničena memorija (tombstoneovi, MsgId); VIBAN u camt.053/052; `PstlAdr` banke | +1 → 27 | 500– | „Open in L0–L3” u `TODO.md` prazan ili svjesno odgođen |
| **S4** | L5b provjera primatelja + messages v2 | `vop.request.ee`, `vop.request.uk`, `cop.request`; `messages.list.v2`, `messages.processed.v2`, `requests.list.v2`, `requests.get.v2`, `messages.test.next`, `test.accounts.ibans` | +8 → 35 | 600– | v2 obitelj dijeli inbox engine s v1; VoP/CoP odgovori po shemama |
| **S5** | UK flavour | `/accounts/*` (`accounts.list`, `accounts.transaction.get`, `accounts.payments.pending_rejected`, PascalCase JSON, AWS-style greške), UK webhookovi (`webhook.subscribe/list/get/update/delete/delivery/history/replay`, X-LHV-HMAC, golden vrijednost iz mirrora), Bacs (`notification.bacs_incoming`, `dd.bacs.*` ×4), `x-bank-code: LHVEE` routing na EE servise | +17 → 52 | 700– | isti klijent radi protiv EE i UK hosta; HMAC jednak golden vrijednosti |
| **S6** | L6 agency + ostatak | `agent.account.sync` (+ v2 s VoP poljima), `agent.report.rtf`, `vop.incoming_notification`, `cop.incoming`, `acq.merchant_report` (sekcija P 13 još nije pročitana); plaćanja s agency računa; PSP use caseovi 1–8 iz mirrora kao e2e lanci | +6 → **58** | 800– | `PAYMENT_PSP_USECASES/case1..8` prolaze cijeli lanac |
| **S7** | Trajnost i jezgra | Postgres za inbox i ledger; open-ledger kao `Ledger` (SDK/HTTP); prvi pravi `Rails` bridge ili jasno sučelje za njega; ograničena memorija | — | 900– | testovi zeleni i na memory i na Postgres storeu |
| **S8** | Conformance harness *(blokirano: sandbox certifikat)* | Snimanje prema `connect.test.lhv.eu` po `sandbox-questions.md`, usporedba po uzoru na open-ledger `conformance/` s `divergences.json`; revizija odluka koje snimke riješe; zatvaranje 10 `uncertain` unosa u katalogu | — | revizije | svih 42 pitanja odgovoreno snimkom ili upisano kao odstupanje |

**Procjena: 7 sesija koje se mogu odraditi bez sandboxa, plus S8 kad stigne
certifikat.** S2 i S1 su neovisni i mogu ići paralelno u worktreejima. S5 je
najveći paket. Ako ne stane u jednu sesiju, Bacs ide u S5b.

Najrizičniji su S5 (dva sustava webhookova, drukčiji oblik JSON-a i grešaka) i S6.
Agency i PSP lanci imaju najviše implicitnog ponašanja. Ako sesija otkrije da
paket ovisi o nečemu što samo sandbox može reći, ide odluka s brojem sandbox pitanja,
a ne čekanje.

## Pravila koja vrijede za svaku sesiju

Detalji su u `docs/handoffs/README.md` i `docs/2026-10-23-orkestracija-subagenata.md`.
Ukratko:

- Posao rade Opus 5.5 subagenti, a glavna sesija orkestrira. Svaku razinu razbij na
  dva agenta: implementacija, pa testovi i spajanje na server. Context guard reže
  svakog agenta na granici `CONTEXT_GUARD_TOKENS` (300k od 2026-10-23). Effort zadaj eksplicitno.
- Agentima su zabranjeni `README.md`, `TODO.md` i ovaj plan. Orkestrator ih ažurira
  nakon mergea.
- Spec je `docs.lhv-connect/ssot/` plus mirror. Dokumentacija nije uvijek dosljedna
  (odluka 212), pa svako odstupanje ide u `decisions.md`.
- Bez Monitora koji javlja napredak. Na ~150k konteksta orkestrator zatvara sesiju.
