// The emulator's control plane, mounted at /_sim. Not part of the Connect API: it sets
// up customers and money, injects incoming payments and steers the simulated rails.
// Bodies and answers are JSON; amounts are decimal strings ("12.50").
import type { FastifyInstance } from 'fastify'
import type { CustomerInput } from './directory.js'
import { ConnectError } from './errors.js'
import type { Emulator } from './emulator.js'
import { fromMinor, toMinor } from './ledger.js'
import { normalizeIban } from './iban.js'
import { SimulatorRails } from './rails.js'

export function simRoutes(emulator: Emulator) {
  const bad = (msg: string) => new ConnectError(400, 'BAD_REQUEST', msg)
  const amount = (v: unknown) => {
    if (typeof v !== 'string') throw bad('amount must be a decimal string')
    try { return toMinor(v) } catch { throw bad(`invalid amount ${v}`) }
  }
  const balances = async (iban: string) => {
    const out: Record<string, { balance: string; available: string }> = {}
    for (const [ccy, b] of Object.entries(await emulator.ledger.balances(iban))) {
      out[ccy] = { balance: fromMinor(b.balance), available: fromMinor(b.available) }
    }
    return out
  }
  const simRails = () => {
    if (!(emulator.rails instanceof SimulatorRails)) throw bad('the rails are not the simulator')
    return emulator.rails
  }

  return async (app: FastifyInstance) => {
    app.get('/customers', async () => ({
      customers: await Promise.all(emulator.directory.all().map(async (c) => ({
        code: c.code, country: c.country, name: c.name, camt054: c.camt054,
        ...(c.connected ? { connected: c.connected } : {}),
        accounts: await Promise.all(c.accounts.map(async (iban) => ({ iban, balances: await balances(iban) }))),
      }))),
    }))

    app.post('/customers', async (req, reply) => {
      const b = req.body as CustomerInput
      if (!b || typeof b.code !== 'string' || typeof b.country !== 'string' || typeof b.name !== 'string') {
        throw bad('code, country and name are required')
      }
      if (emulator.directory.get(b)) throw new ConnectError(409, 'CONFLICT', 'customer exists')
      try {
        const c = await emulator.addCustomer(b)
        return reply.code(201).send({ code: c.code, country: c.country, accounts: c.accounts })
      } catch (e) { throw bad((e as Error).message) }
    })

    app.get('/accounts/:iban', async (req) => {
      const iban = normalizeIban((req.params as { iban: string }).iban)
      const owner = emulator.directory.ownerOf(iban)
      if (!owner) throw new ConnectError(404, 'NOT_FOUND', `no account ${iban}`)
      return { iban, owner: { code: owner.code, country: owner.country, name: owner.name }, balances: await balances(iban) }
    })

    app.post('/accounts/:iban/fund', async (req) => {
      const iban = normalizeIban((req.params as { iban: string }).iban)
      const b = (req.body ?? {}) as { amount?: string; currency?: string }
      amount(b.amount)
      if (!emulator.directory.ownerOf(iban)) throw new ConnectError(404, 'NOT_FOUND', `no account ${iban}`)
      await emulator.fund(iban, b.amount!, b.currency ?? 'EUR')
      return { iban, balances: await balances(iban) }
    })

    // An incoming credit transfer from another bank: books it and notifies with camt.054.
    app.post('/incoming', async (req) => {
      const b = (req.body ?? {}) as {
        iban?: string; amount?: string; currency?: string; scheme?: string
        debtor?: { name?: string; iban?: string; bic?: string }; remittance?: string; reference?: string; endToEndId?: string
      }
      if (!b.iban) throw bad('iban is required')
      const iban = normalizeIban(b.iban)
      if (!emulator.directory.ownerOf(iban)) throw new ConnectError(404, 'NOT_FOUND', `no account ${iban}`)
      const scheme = b.scheme ?? 'SEPA'
      if (!['SEPA', 'INST', 'SWIFT', 'TARGET2'].includes(scheme)) throw bad(`unknown scheme ${scheme}`)
      const r = await emulator.engine.incoming({
        iban, amount: amount(b.amount), currency: b.currency ?? 'EUR', scheme,
        debtor: b.debtor ?? { name: 'Simulated Debtor' }, remittance: b.remittance, reference: b.reference, endToEndId: b.endToEndId,
      })
      return { iban, accountServicerReference: r.servicerRef, balances: await balances(iban) }
    })

    app.post('/rails/reject', async (req) => {
      const b = (req.body ?? {}) as { account?: string; reason?: string }
      if (!b.account) throw bad('account is required')
      simRails().reject(normalizeIban(b.account), b.reason ?? 'Reason not given.')
      return { ok: true }
    })

    app.post('/rails/no-instant', async (req) => {
      const b = (req.body ?? {}) as { account?: string }
      if (!b.account) throw bad('account is required')
      simRails().noInstant(normalizeIban(b.account))
      return { ok: true }
    })

    app.get('/rails/sent', async () => ({
      payments: simRails().sent.map((p) => ({ ...p, amount: fromMinor(p.amount) })),
    }))

    app.post('/rails/reset', async () => { simRails().reset(); return { ok: true } })
  }
}
