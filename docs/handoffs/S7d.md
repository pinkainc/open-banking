Nastavljamo open-banking: open-source server kompatibilan s LHV Connect API-jem (model S3/MinIO, kao /Users/ms/git/minka/open-ledger).

Repoi:
- /Users/ms/git/pinkainc/open-banking (main, origin na GitHubu; wrap-up pusha main): server, TypeScript + fastify.
- /Users/ms/git/pinkainc/docs.lhv-connect (main): mirror LHV dokumentacije i ssot/. NIKAD ga ne pushati.

Pročitaj prvo: docs/handoffs/README.md (lanac i pravila), TODO.md („Still open from S7c”), docs/decisions.md (994, 999, 1002, 1005–1007, 1014).

# S7d: preostale core rupe iz S7c (gotovo 2026-10-30, `9c51eff`; odluke 1017–1023)

Polazni commit: `4cc1df6` + docs. `npm run check`: memory 857/857, Postgres 857/857, deferred 715/715, open-ledger 27/27, skipped 0. Odluke od **1017**.

Upit za sandbox poslan je LHV-u 2026-10-30 (ITalk d.o.o.). Dok certifikat ne stigne, S7d zatvara ono što S7c nije pokrio. Po jedan Opus agent na stavku, strogo jedan za drugim, pravilo „prvo reproduciraj testom (memory i Postgres), pa popravi”:

1. **Pad za vrijeme provjera datoteke:** MsgId je viđen, plan kruga još nije u outboxu, pa se datoteka gubi (1005 „Not covered”). Cilj: nakon restarta datoteka se obradi ili jasno odbije, nikad tiho izgubi, i ponovno slanje istog MsgId-a se ne obradi dvaput.
2. **Pad nakon pain.002 kruga, a prije sljedećih koraka:** vanjsko plaćanje ostaje ACSP i rezervirano, ali nikad ne ode na rails (1005). Cilj: recovery dovrši korake nakon izvještaja (rails, ručni pregled, camt.054) točno jednom.
3. **Kasniji krugovi (trenutni ishodi s railsa) nemaju plan** (1005): nakon pada izvještaj kruga čine samo stavke spremljene uz commitove, a plaćanje između `take` i commita u `#rails` se gubi. Cilj: ništa se ne gubi, svaki ishod je prijavljen jednom.
4. **Povrat plaćanja namirenih prije 1014:** nemaju zapis `payment-settled`, pa `payment.returned` odgovara `applied: false` (1014). Cilj: zapis se izvede iz knjiženja (lijeno pri povratu ili jednom pri startu), ili se svjesno odluči drukčije uz odluku.

Gotovo kad: sve četiri stavke zatvorene ili svjesno odgođene odlukom, `npm run check` zelen dvaput, TODO i README ažurirani.
