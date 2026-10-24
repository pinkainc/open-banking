// The emulator's control plane, mounted at /_sim. Not part of the Connect API: it sets
// up customers and money, injects incoming payments and steers the simulated rails.
// Bodies and answers are JSON; amounts are decimal strings ("12.50").
import type { FastifyInstance } from 'fastify'
import type { Customer, CustomerInput, CustomerPatch } from './directory.js'
import { ConnectError } from './errors.js'
import type { Emulator } from './emulator.js'
import { fromMinor, toMinor } from './ledger.js'
import { normalizeIban } from './iban.js'
import { RailsRetryLater, SimulatorRails, type Scheme } from './rails.js'
import { isDate } from './statements/camt060.js'
import { DEFAULT_LIMITS, type Limits, type ReportSettings } from './statements/reports.js'
import { dateTallinn } from './time.js'

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
      customers: await Promise.all((await emulator.directory.all()).map(async (c) => ({
        ...customerSettings(c), name: c.name, camt054: c.camt054,
        ...(c.connected ? { connected: c.connected } : {}),
        accounts: await Promise.all(c.accounts.map(async (iban) => ({ iban, balances: await balances(iban) }))),
      }))),
    }))

    app.post('/customers', async (req, reply) => {
      const b = req.body as CustomerInput
      if (!b || typeof b.code !== 'string' || typeof b.country !== 'string' || typeof b.name !== 'string') {
        throw bad('code, country and name are required')
      }
      if (await emulator.directory.get(b)) throw new ConnectError(409, 'CONFLICT', 'customer exists')
      try {
        const c = await emulator.addCustomer(b)
        return reply.code(201).send({ code: c.code, country: c.country, accounts: c.accounts })
      } catch (e) { throw bad((e as Error).message) }
    })

    // Per-customer settings an account manager would switch: payment confirmation, direct debit.
    const customerSettings = (c: Customer) => ({
      code: c.code, country: c.country, payments: c.payments ?? 'DIRECT',
      directDebit: { agreement: !!c.directDebit?.agreement, debtorNotification: !!c.directDebit?.debtorNotification },
    })
    app.patch('/customers/:country/:code', async (req) => {
      const { country, code } = req.params as { country: string; code: string }
      const c = await emulator.directory.get({ code, country })
      if (!c) throw new ConnectError(404, 'NOT_FOUND', `no customer ${country}/${code}`)
      const b = (req.body ?? {}) as { payments?: unknown; directDebit?: Record<string, unknown> }
      if (b.payments !== undefined && b.payments !== 'DIRECT' && b.payments !== 'PENDING') throw bad('payments must be DIRECT or PENDING')
      const dd = b.directDebit
      if (dd !== undefined && (typeof dd !== 'object' || dd === null || Object.entries(dd).some(([k, v]) => (k !== 'agreement' && k !== 'debtorNotification') || typeof v !== 'boolean'))) {
        throw bad('directDebit takes the booleans agreement and debtorNotification')
      }
      const patch: CustomerPatch = {}
      if (b.payments !== undefined) patch.payments = b.payments as 'DIRECT' | 'PENDING'
      if (dd !== undefined) patch.directDebit = { ...c.directDebit, ...(dd as { agreement?: boolean; debtorNotification?: boolean }) }
      // Stored at once (decision 970): a PENDING switch outlives a restart on a persistent directory.
      return customerSettings((await emulator.directory.update(c, patch)) ?? c)
    })

    // Payments waiting in the internet bank (SCA) or in the bank's manual review.
    app.get('/payments/pending', async () => ({ payments: await emulator.engine.parked() }))
    for (const action of ['approve', 'reject'] as const) {
      app.post(`/payments/pending/${action}`, async (req) => {
        const b = (req.body ?? {}) as { refs?: unknown; reason?: unknown }
        if (!Array.isArray(b.refs) || b.refs.length === 0 || !b.refs.every((r) => typeof r === 'string')) throw bad('refs must be a non-empty array of AcctSvcrRef strings')
        if (b.reason !== undefined && (action === 'approve' || typeof b.reason !== 'string' || !b.reason)) throw bad('reason is a non-empty string, for reject only')
        const unknown = await emulator.engine.decide(b.refs as string[], action === 'approve', b.reason as string | undefined)
        if (unknown.length) throw new ConnectError(404, 'NOT_FOUND', `not pending: ${unknown.join(', ')}`)
        return { [action === 'approve' ? 'approved' : 'rejected']: b.refs }
      })
    }

    app.get('/accounts/:iban', async (req) => {
      const iban = normalizeIban((req.params as { iban: string }).iban)
      const owner = await emulator.directory.ownerOf(iban)
      if (!owner) throw new ConnectError(404, 'NOT_FOUND', `no account ${iban}`)
      return { iban, owner: { code: owner.code, country: owner.country, name: owner.name }, balances: await balances(iban) }
    })

    app.post('/accounts/:iban/fund', async (req) => {
      const iban = normalizeIban((req.params as { iban: string }).iban)
      const b = (req.body ?? {}) as { amount?: string; currency?: string }
      amount(b.amount)
      if (!await emulator.directory.ownerOf(iban)) throw new ConnectError(404, 'NOT_FOUND', `no account ${iban}`)
      await emulator.fund(iban, b.amount!, b.currency ?? 'EUR')
      return { iban, balances: await balances(iban) }
    })

    // An incoming credit transfer from another bank: books it and notifies with camt.054.
    app.post('/incoming', async (req) => {
      const b = (req.body ?? {}) as {
        iban?: string; amount?: string; currency?: string; scheme?: string
        debtor?: { name?: string; iban?: string; bic?: string; account?: string }; remittance?: string; reference?: string; endToEndId?: string
        creditorName?: string; pmtInfId?: string; instrId?: string
      }
      if (!b.iban) throw bad('iban is required')
      // `iban` may also be an agency account: an IBAN or a sort code and account number (decision 835).
      const iban = normalizeIban(b.iban)
      const viban = await emulator.viban.registry.get(iban)
      const agency = !await emulator.directory.ownerOf(iban) && !viban ? (await emulator.agency.accounts.find(iban))[0] : undefined
      if (!await emulator.directory.ownerOf(iban) && !viban && !agency) throw new ConnectError(404, 'NOT_FOUND', `no account ${iban}`)
      const scheme = b.scheme ?? 'SEPA'
      if (!['SEPA', 'INST', 'SWIFT', 'TARGET2', 'FAST'].includes(scheme)) throw bad(`unknown scheme ${scheme}`)
      const r = await emulator.engine.incoming({
        iban, amount: amount(b.amount), currency: b.currency ?? 'EUR', scheme,
        debtor: b.debtor ?? { name: 'Simulated Debtor' }, remittance: b.remittance, reference: b.reference, endToEndId: b.endToEndId,
        creditorName: b.creditorName, pmtInfId: b.pmtInfId, instrId: b.instrId,
      })
      const account = viban?.master ?? agency?.master ?? iban
      // A VIBAN that is not ACTIVE: the bank returns the payment (ISO reason AC04 / AC06).
      if (r.returned) return { iban, returned: true, reason: r.returned.code, description: r.returned.reason, balances: await balances(account) }
      return { iban, ...(viban || agency ? { masterAccount: account } : {}), accountServicerReference: r.servicerRef, balances: await balances(account) }
    })

    // Account reports: automatic end-of-day statement and payment limits per customer.
    const reportCustomer = async (req: { params: unknown }) => {
      const { country, code } = req.params as { country: string; code: string }
      const c = await emulator.directory.get({ code, country: country.toUpperCase() })
      if (!c) throw new ConnectError(404, 'NOT_FOUND', `no customer ${country}/${code}`)
      return c
    }
    const reportView = async (c: { code: string; country: string }) => {
      const s = await emulator.reports.settings(c)
      return { code: c.code, country: c.country, automaticStatement: s.automaticStatement ?? null, limits: { ...DEFAULT_LIMITS, ...s.limits } }
    }
    app.get('/reports/:country/:code', async (req) => reportView(await reportCustomer(req)))
    app.put('/reports/:country/:code', async (req) => {
      const c = await reportCustomer(req)
      const b = (req.body ?? {}) as { automaticStatement?: unknown; limits?: Record<string, unknown> }
      const s: ReportSettings = {}
      if ('automaticStatement' in b) {
        const v = b.automaticStatement
        if (v !== null && v !== '08' && v !== '02') throw bad('automaticStatement must be "08", "02" or null')
        s.automaticStatement = v ?? undefined
      }
      if (b.limits !== undefined) {
        if (typeof b.limits !== 'object' || b.limits === null) throw bad('limits must be an object')
        const limits: Partial<Limits> = {}
        for (const [k, v] of Object.entries(b.limits)) {
          if (k !== 'daily' && k !== 'monthly' && k !== 'instant') throw bad(`unknown limit ${k}`)
          amount(v)
          limits[k] = v as string
        }
        s.limits = { ...(await emulator.reports.settings(c)).limits, ...limits }
      }
      await emulator.reports.configure(c, s)
      return reportView(c)
    })
    // Sends the automatic statements of a finished day now (default: every day finished
    // since the last run, as the clock-driven tick does).
    app.post('/end-of-day', async (req) => {
      const b = (req.body ?? {}) as { date?: unknown }
      if (b.date === undefined) return { messages: await emulator.reports.tick() }
      if (typeof b.date !== 'string' || !isDate(b.date)) throw bad('date must be YYYY-MM-DD')
      if (b.date >= dateTallinn(emulator.clock.now())) throw bad('date must be a finished day (Europe/Tallinn)')
      return { date: b.date, messages: await emulator.reports.endOfDay(b.date) }
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

    // SEPA Instant to this account is attempted and fails: automatic selection falls back to SEPA.
    app.post('/rails/instant-failure', async (req) => {
      const b = (req.body ?? {}) as { account?: string }
      if (!b.account) throw bad('account is required')
      simRails().instantFails(normalizeIban(b.account))
      return { ok: true }
    })

    app.get('/rails/sent', async () => ({
      payments: simRails().sent.map((p) => ({ ...p, amount: fromMinor(p.amount) })),
    }))

    app.post('/rails/reset', async () => { simRails().reset(); return { ok: true } })

    // Deferred rails (decision 931): payments are answered `accepted` and settle on /rails/deliver.
    app.post('/rails/defer', async (req) => {
      const b = (req.body ?? {}) as { on?: boolean }
      simRails().defer(b.on !== false)
      return { deferred: simRails().deferred }
    })
    // The debtor's bank returns a collection the rails settled (decision 1000): 409 while it must wait.
    app.post('/rails/collection-return', async (req, reply) => {
      const b = (req.body ?? {}) as { ref?: unknown; code?: unknown }
      if (typeof b.ref !== 'string' || !b.ref || typeof b.code !== 'string' || !/^[A-Z0-9]{4}$/.test(b.code)) throw bad('ref and a four-character code are required')
      try { return { applied: await simRails().returnCollection(b.ref, b.code) } } catch (e) {
        if (e instanceof RailsRetryLater) return reply.code(409).send({ error: e.message, retry: true })
        throw e
      }
    })
    // The payer's bank recalls a credit (camt.056, decision 1001).
    app.post('/rails/recall', async (req) => {
      const b = (req.body ?? {}) as { ref?: unknown; code?: unknown; recallRef?: unknown }
      if (typeof b.ref !== 'string' || !b.ref || typeof b.code !== 'string' || !/^[A-Z0-9]{4}$/.test(b.code)) throw bad('ref and a four-character code are required')
      return simRails().recall({ ref: b.ref, code: b.code, recallRef: typeof b.recallRef === 'string' && b.recallRef ? b.recallRef : `RCL-${b.ref}` })
    })
    // The creditor's bank returns a payment of ours the rails settled (pacs.004, decision 1014).
    app.post('/rails/payment-return', async (req) => {
      const b = (req.body ?? {}) as { ref?: unknown; code?: unknown; returnRef?: unknown; scheme?: unknown; amount?: unknown; currency?: unknown }
      if (typeof b.ref !== 'string' || !b.ref || typeof b.code !== 'string' || !/^[A-Z0-9]{4}$|^[0-9]{8}$/.test(b.code)) throw bad('ref and a return code are required')
      if (b.scheme !== undefined && !['SEPA', 'INST', 'SWIFT', 'TARGET2', 'FAST'].includes(b.scheme as string)) throw bad(`unknown scheme ${String(b.scheme)}`)
      if (b.currency !== undefined && (typeof b.currency !== 'string' || !/^[A-Z]{3}$/.test(b.currency))) throw bad(`bad currency ${String(b.currency)}`)
      let amount: bigint | undefined
      if (b.amount !== undefined) {
        try { amount = toMinor(b.amount as string) } catch { throw bad(`bad amount ${String(b.amount)}`) }
        if (amount <= 0n) throw bad(`bad amount ${String(b.amount)}`)
      }
      return simRails().returnPayment({
        ref: b.ref, code: b.code, returnRef: typeof b.returnRef === 'string' && b.returnRef ? b.returnRef : `RTR-${b.ref}`,
        scheme: b.scheme as Scheme | undefined, amount, currency: b.currency as string | undefined,
      })
    })
    // Timeouts (decision 1002): payments are taken but answered `unknown`; the engine reconciles them.
    app.post('/rails/timeout', async (req) => {
      const b = (req.body ?? {}) as { on?: boolean }
      simRails().timeouts(b.on !== false)
      return { timeouts: simRails().timingOut }
    })
    // Asks the rails about every payment waiting at least minAgeMs (default 0) and settles what they tell.
    app.post('/rails/reconcile', async (req) => {
      const b = (req.body ?? {}) as { minAgeMs?: unknown }
      if (b.minAgeMs !== undefined && (typeof b.minAgeMs !== 'number' || b.minAgeMs < 0)) throw bad('minAgeMs must be a number ≥ 0')
      return { settled: await emulator.engine.reconcile({ minAgeMs: (b.minAgeMs as number | undefined) ?? 0 }) }
    })
    app.get('/rails/held', async () => ({ payments: [...simRails().held].map(([ref, outcome]) => ({ ref, outcome })) }))
    // Delivers the held outcomes (all, or `ref`); `reject` (a reason) or `unavailable` overrides the outcome.
    app.post('/rails/deliver', async (req) => {
      const b = (req.body ?? {}) as { ref?: string; reject?: string; unavailable?: boolean }
      if (b.ref !== undefined && !simRails().held.has(b.ref)) throw bad(`no held payment ${b.ref}`)
      const outcome = b.reject !== undefined ? { status: 'rejected' as const, reason: b.reject } : b.unavailable ? { status: 'unavailable' as const } : undefined
      return { delivered: await simRails().deliver(b.ref, outcome) }
    })
  }
}
