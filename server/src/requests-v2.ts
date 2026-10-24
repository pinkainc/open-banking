// The UK host's requests API (decisions 630–632): GET /v2/requests lists the requests the
// caller submitted (answered 202), GET /v2/requests/{RequestId} returns one as it was sent.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Caller } from './auth.js'
import type { Emulator } from './emulator.js'
import { jsonError } from './errors.js'
import { pageParams } from './messages-v2.js'
import { isDate } from './statements/camt060.js'
import { dateLondon, isoLondon } from './time.js'

type Query = Record<string, string | string[] | undefined>

export function registerRequestsV2(app: FastifyInstance, emulator: Emulator, caller: (req: FastifyRequest) => Promise<Caller>) {
  app.get('/v2/requests', async (req, reply) => {
    const c = await caller(req)
    const q = req.query as Query
    const one = (name: string) => { const v = q[name]; return (Array.isArray(v) ? v[0] : v) || undefined }
    const p = pageParams(q)
    const date = (name: string) => {
      const v = one(name)
      if (v !== undefined && !isDate(v)) throw jsonError(400, 'BAD_REQUEST', `${name} must be a date YYYY-MM-DD`)
      return v
    }
    const startDate = date('startDate')
    const endDate = date('endDate')
    const clientCode = one('clientCode')
    const clientCountry = one('clientCountry')?.toUpperCase()
    const all = (await emulator.requests.list(c.visible)).filter((r) => {
      const day = dateLondon(r.createdAt)
      return (!startDate || day >= startDate) && (!endDate || day <= endDate)
        && (!clientCode || r.clientCode === clientCode) && (!clientCountry || r.clientCountry === clientCountry)
    })
    const items = all.slice((p.pageNumber - 1) * p.pageSize, p.pageNumber * p.pageSize)
    if (items.length === 0) return reply.code(204).send()
    // The G sample has the list only, no paging fields (decision 632).
    return {
      messages: items.map((r) => ({
        messageRequestId: r.id,
        messageResponseType: r.type,
        clientCode: r.clientCode,
        clientCountry: r.clientCountry,
        messageCreatedTime: isoLondon(r.createdAt),
        bankCode: r.bankCode,
      })),
    }
  })

  app.get('/v2/requests/:id', async (req, reply) => {
    const c = await caller(req)
    const r = await emulator.requests.get(c.visible, (req.params as { id: string }).id)
    // G: "204 - no request: Request ID doesn't exist".
    if (!r) return reply.code(204).send()
    return reply.code(200).type(r.contentType).send(r.body)
  })
}
