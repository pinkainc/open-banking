// HTTP surface of FX: the two Connect operations (202, the answer in the inbox) and the
// emulator's own /_sim/fx control plane (rates, margin, pricing outage, SPOT settlement).
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Caller } from '../auth.js'
import { ConnectError } from '../errors.js'
import type { Emulator } from '../emulator.js'
import { requestId } from '../ids.js'
import { accepted } from '../requests.js'
import { fromMinor } from '../ledger.js'
import { jsonTextScope } from '../jsonbody.js'
import { FX_TYPES, endOfDay, type Offer } from './service.js'

export function registerFx(app: FastifyInstance, emulator: Emulator, caller: (req: FastifyRequest) => Caller) {
  jsonTextScope(app, (scope) => {
    const route = (path: string, type: string, handle: (body: unknown, c: Caller, id: string) => Promise<void>) =>
      scope.post(path, async (req, reply) => {
        const c = caller(req)
        const id = requestId()
        await handle(req.body, c, id)
        return accepted(emulator.requests, req, reply, c, id, type)
      })
    route('/fx/trade-offer', FX_TYPES.offer, (b, c, id) => emulator.fx.offer(b, c.customer, id))
    route('/fx/trade-offer-confirmation', FX_TYPES.confirmation, (b, c, id) => emulator.fx.confirm(b, c.customer, id))
  })
}

/** An offer and its deal as the control plane shows them. */
function offerView(o: Offer) {
  return {
    customer: { code: o.customer.code, country: o.customer.country },
    requestReference: o.requestReference, accountIban: o.account, status: o.status, ...(o.errors ? { errors: o.errors } : {}),
    currencyFrom: o.currencyFrom, currencyTo: o.currencyTo,
    ...(o.amountFrom !== undefined ? { amountFrom: fromMinor(o.amountFrom) } : {}),
    ...(o.amountTo !== undefined ? { amountTo: fromMinor(o.amountTo) } : {}),
    ...(o.quote !== undefined ? { baseCurrency: o.baseCurrency, quote: o.quote } : {}),
    tenor: o.tenor, tradeDate: o.tradeDate, ...(o.settlementDate ? { settlementDate: endOfDay(o.settlementDate) } : {}),
    ...(o.validUntil ? { validUntil: o.validUntil.toISOString() } : {}),
    accountServicerReference: o.accountServicerReference,
    ...(o.deal ? {
      deal: {
        status: o.deal.status, ...(o.deal.pmtInfId !== undefined ? { pmtInfId: o.deal.pmtInfId } : {}),
        confirmedAt: o.deal.confirmedAt.toISOString(), ...(o.deal.settledAt ? { settledAt: o.deal.settledAt.toISOString() } : {}),
      },
    } : {}),
  }
}

export function fxSimRoutes(emulator: Emulator) {
  const bad = (msg: string) => new ConnectError(400, 'BAD_REQUEST', msg)
  const pricing = emulator.fx.pricing
  const state = () => ({ rates: pricing.rates(), margin: pricing.margin, available: pricing.available })
  return async (app: FastifyInstance) => {
    app.get('/offers', async () => ({ offers: [...emulator.fx.offers.values()].map(offerView) }))

    app.get('/pricing', async () => state())

    // { rates?: {USD: "1.08", ...} (units per 1 EUR), margin?: "0.003", available?: false }
    app.put('/pricing', async (req) => {
      const b = (req.body ?? {}) as { rates?: unknown; margin?: unknown; available?: unknown }
      if (b.rates !== undefined) {
        if (!b.rates || typeof b.rates !== 'object') throw bad('rates must be an object of currency → units per 1 EUR')
        try { pricing.setRates(b.rates as Record<string, string>) } catch (e) { throw bad((e as Error).message) }
      }
      if (b.margin !== undefined) {
        const m = Number(b.margin)
        if (!Number.isFinite(m) || m < 0 || m >= 1) throw bad('margin must be a fraction in [0, 1)')
        pricing.margin = m
      }
      if (b.available !== undefined) {
        if (typeof b.available !== 'boolean') throw bad('available must be a boolean')
        pricing.available = b.available
      }
      return state()
    })

    // Settles the due SPOT deals now (main.ts does this every minute).
    app.post('/settle', async () => ({ settled: await emulator.fx.tick() }))
  }
}
