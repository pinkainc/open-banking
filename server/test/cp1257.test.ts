// Windows-1257 folding of free text (P 02 / G "Language and Code Pages", decision 526):
// the function itself, and what payments echo in pain.002, book in camt.054 and hand to
// the rails. Produced messages are validated against the published XSDs.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { codePage, fold, inCp1257 } from '../src/cp1257.js'
import { many } from '../src/xml.js'
import { C1, C2, DE_IBAN, HAVE_REFERENCE, call, drain, pain001, setup, xsd, type Ctx } from './helpers.js'

describe('fold', () => {
  test('the documented example: Cyrillic becomes one ? per letter', () => {
    assert.equal(fold('Payment description - описание платежа.', 'DE'), 'Payment description - ???????? ???????.')
    assert.equal(codePage('описание'), '????????')
  })
  test('replacements for every receiver country', () => {
    for (const country of ['EE', 'GB', 'DE', undefined]) {
      assert.equal(fold('a\\b[c]d}e_f~g`h’i', country), "a/b(c)d)e-f-g'h'i", String(country))
      assert.equal(fold('ĘĒÉĖ ęēéė ĆČ ćč Ģģ Įį Īī Ķķ ĻŁ ļł ŃŅ ńņ € ĄĀÅ æąāå ÓŌØ óōø ŪŲ ūų Ś śß ŹŻ źż', country),
        'EEEE eeee CC cc Gg Ii Ii Kk LL ll NN nn E AAA aaaa OOO ooo UU uu S ss ZZ zz')
      assert.equal(fold('a b', country), 'a b')
    }
  })
  test('replacements by receiver BIC country: ISO and EE, ISO and GB', () => {
    const text = '{x}; ÄäÕÖõöÜüŠšŽž'
    assert.equal(fold(text, 'EE'), '(x)č ÄäÕÖõöÜüŠšŽž')
    assert.equal(fold(text, 'GB'), '{x); AaOOooUuSsZz')
    assert.equal(fold(text, 'FR'), '(x)č AaOOooUuSsZz')
    assert.equal(fold(text), fold(text, 'FR'), 'unknown country counts as ISO')
  })
  test('what Windows-1257 lacks becomes ?, one per code point; what it has stays', () => {
    assert.equal(fold('Ωmega 😀 Ñ ç', 'EE'), '?mega ? ? ?')
    assert.equal(fold('Æ Ø ø © ½ ×', 'GB'), 'Æ O o © ½ ×')
    assert.equal(fold('line\nbreak\ttab', 'EE'), 'line\nbreak\ttab')
    assert.ok(inCp1257('ž') && inCp1257('€') && !inCp1257('Ñ') && !inCp1257('\u0081'))
    assert.equal(fold(undefined), undefined)
  })
})

describe('payments keep folded text', () => {
  type Msg = Awaited<ReturnType<typeof drain>>[number]
  async function messages(ctx: Ctx, as = C1.code) {
    const msgs = await drain(ctx, as)
    if (HAVE_REFERENCE) {
      for (const m of msgs) {
        const ns = /xmlns="urn:iso:std:iso:20022:tech:xsd:([^"]+)"/.exec(m.body)?.[1]
        if (ns && xsd.has(ns)) assert.deepEqual(await xsd.validate(m.body, ns), [], `${ns} is schema-valid:\n${m.body}`)
      }
    }
    return msgs
  }
  const tx = (m: Msg) => many(m.doc.Document.CstmrPmtStsRpt.OrgnlPmtInfAndSts).flatMap((b: any) => many(b.TxInfAndSts))[0]
  const ntry = (m: Msg) => m.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn.Ntry.NtryDtls.TxDtls

  test('internal (EE): names in pain.002, remittance and names in both camt.054', async () => {
    const ctx = await setup()
    await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ debtorName: 'Demo Customer 1 – Ω', txs: [{ amount: '1.00', creditorName: 'Łukasz Żółć; Pärt', ustrd: 'Arve [12] — описание' }] }]) })
    const msgs = await messages(ctx)
    const r = tx(msgs.find((m) => m.type === 'PAYMENT')!)
    assert.equal(r.OrgnlTxRef.Cdtr.Pty.Nm, 'Lukasz Zolcč Pärt')
    assert.equal(r.OrgnlTxRef.Dbtr.Pty.Nm, 'Demo Customer 1 – ?')
    const dbit = ntry(msgs.find((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION')!)
    assert.equal(dbit.RmtInf.Ustrd, 'Arve (12) — ????????')
    assert.match(JSON.stringify(dbit.RltdPties), /Lukasz Zolcč Pärt/)
    const crdt = ntry((await messages(ctx, C2.code)).find((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION')!)
    assert.equal(crdt.RmtInf.Ustrd, 'Arve (12) — ????????')
    assert.match(JSON.stringify(crdt.RltdPties), /Demo Customer 1 – \?/)
  })

  test('external (DE, ISO): the rails get the folded text', async () => {
    const ctx = await setup()
    await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '1.00', creditorIban: DE_IBAN, creditorName: 'Jürgen Šmit', ustrd: 'Rechnung {7}; Grüße' }] }]) })
    const msgs = await messages(ctx)
    assert.equal(tx(msgs.find((m) => m.type === 'PAYMENT')!).OrgnlTxRef.Cdtr.Pty.Nm, 'Jurgen Smit')
    const sent = (await call(ctx, { url: '/_sim/rails/sent' })).json().payments[0]
    assert.deepEqual([sent.creditor.name, sent.remittance], ['Jurgen Smit', 'Rechnung (7)č Gruse'])
    assert.equal(ntry(msgs.find((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION')!).RmtInf.Ustrd, 'Rechnung (7)č Gruse')
  })

  test('a GB BIC decides the zone over the IBAN country', async () => {
    const ctx = await setup()
    const xml = pain001([{ txs: [{ amount: '1.00', creditorIban: DE_IBAN, creditorName: 'Größe {GB}', ustrd: 'x;y' }] }])
      .replace('<Cdtr>', '<CdtrAgt><FinInstnId><BICFI>BARCGB22</BICFI></FinInstnId></CdtrAgt><Cdtr>')
    await call(ctx, { method: 'POST', url: '/payment', body: xml })
    await messages(ctx)
    const sent = (await call(ctx, { url: '/_sim/rails/sent' })).json().payments[0]
    assert.deepEqual([sent.creditor.name, sent.remittance], ['Grose {GB)', 'x;y'])
  })

  test('incoming credits: the code page only', async () => {
    const ctx = await setup()
    await call(ctx, { method: 'POST', url: '/_sim/incoming', body: { iban: C1.iban, amount: '1.00', debtor: { name: 'Ñandú Ärzte' }, remittance: 'Счёт {1}' } })
    const n = ntry((await messages(ctx)).find((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION')!)
    assert.equal(n.RmtInf.Ustrd, '???? {1}')
    assert.match(JSON.stringify(n.RltdPties), /\?and\? Ärzte/)
  })
})
