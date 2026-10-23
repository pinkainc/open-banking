# Handoffi za sesije S1–S8

Plan je u `docs/2026-10-23-plan-do-paritete.md`. Svaka sesija ima svoj handoff `SN.md`.
Korisnik nakon `/clear` kaže „nastavi zadnji handoff” ili zalijepi prompt iz clipboarda.

## Lanac

1. Sesija N počinje iz `docs/handoffs/SN.md`.
2. Sesija N radi svoj paket po pravilima ispod.
3. Na kraju sesija N:
   - označi `SN` kao gotov u tablici „Stanje lanca” ispod (commit, operacije, testovi,
     kratka napomena);
   - **ako je naučila nešto što mijenja neki od sljedećih paketa, uredi `S(N+1).md`**, a po
     potrebi i kasnije handoffe i plan. Nedovršeni dio paketa N ide na **vrh** `S(N+1).md`;
   - u `S(N+1).md` upiše polazni commit i brojke;
   - pozove `/wrap-up`. Handoff prompt za clipboard i `~/.claude/handoffs/open-banking/` je
     sadržaj `docs/handoffs/S(N+1).md`.
4. Ako sesija ostane bez konteksta usred paketa, nastavak je opet `SN` s popisom onoga što
   je ostalo na vrhu datoteke. Broj se ne povećava.
5. S8 je blokiran dok ne postoji sandbox certifikat. Ako je S7 gotov, a certifikata nema,
   lanac staje. Tada se samo osvježe „Gdje smo” u planu i `README.md`.

Handoff se smije mijenjati samo prema naprijed: gotovi `SN` se ne prepisuju, služe kao
povijest.

## Stanje lanca

| Sesija | Paket | Stanje | Commit | Operacije | Testovi | Napomena |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | L4 SEPA direct debit | gotovo | 18f7fee | 17/58 | 274 | odluke 300–318, sandbox pitanja 30–34; vjerovnikov pain.007 nije implementiran (odluka 309) |
| S2 | L5a JSON servisi (EE) | čeka | | | | može paralelno sa S1 |
| S3 | Dugovi L0–L3 + pending | čeka | | | | |
| S4 | VoP/CoP + messages v2 | čeka | | | | |
| S5 | UK flavour | čeka | | | | |
| S6 | L6 agency + ostatak | čeka | | | | |
| S7 | Trajnost i jezgra | čeka | | | | |
| S8 | Conformance harness | blokirano | | | | treba sandbox certifikat |

## Zajednička pravila (vrijede u svakoj sesiji)

- **Polazak:** `npm run check` i potvrda u jednoj rečenici da je zeleno. Ako nije
  zeleno, prvo to popravi. Repo još nema remote, pa nema ni `git pull`.
- **Orkestracija:** posao rade Opus 5.5 subagenti (`model: "opus"`), glavna sesija
  orkestrira. Svaku razinu razbij na dva agenta: (a) implementacija modula, (b) testovi i
  spajanje na server. Context guard ih reže na granici iz `CONTEXT_GUARD_TOKENS` (300k od 2026-10-23, prije 180k). Effort uvijek zadaj eksplicitno
  (`high` za kod, `medium` za čitanje). Agent koji stane commita i ostavi popis; nastavak
  ide kroz novog agenta kojem se da hash commita.
- **Paralelne razine** idu u zasebne worktreeje (`isolation: "worktree"`), a odluke se
  numeriraju po blokovima iz plana. U worktreeju prvo `npm ci`. Mirror se nalazi
  penjanjem prema gore (odluka 210) ili preko `LHV_DOCS_DIR`.
- **Agentima zabrani** `README.md`, `TODO.md`, plan i handoffe. Orkestrator ih ažurira
  nakon mergea.
- **Spec:** `../docs.lhv-connect/ssot/` (operations.yaml, json-schemas/, headers-and-errors.md,
  messages.md, ee-vs-uk.md, levels.md, sandbox-questions.md) i mirror. Taj repo se nikad
  ne pusha, jer je tekst LHV-ov.
- **Dokumentacija je jedina referenca dok nema sandboxa.** Svaka pretpostavka ide u
  `docs/decisions.md` s razlogom i brojem sandbox pitanja. Nova pitanja se dopisuju u
  `sandbox-questions.md`.
- **Testovi:** svaka poruka koju server proizvodi validira se XSD-om iz mirrora. Objavljeni
  primjeri se replayaju. Bez tiho preskočenih testova (`skipped 0`).
- **Autonomno:** ne pitaj korisnika, odluči sam i zapiši odluku. Svaki zeleni korak
  commitaj na `main`. Nepovratne vanjske akcije (remote, objava, mail LHV-u) ostavi
  korisniku.
- **Token budget:** bez Monitora koji javlja napredak. Duge jobove pokreni s
  `run_in_background` i javi se tek na kraju. Najviše 2–3 agenta paralelno. Oko 150k
  konteksta orkestratora zatvori sesiju po koraku 3.
- Svako istraživanje zapiši u `docs/research/YYYY-MM-DD-*.md`.
