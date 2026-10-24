// The UK host's messages V2 family (decisions 620–627): GET /v2/messages (pages,
// includeProcessed, includeMetadata) and PATCH /v2/messages/processed (delete and
// undelete). Views of the same inbox as the v1 /messages routes: a message deleted with v1
// is processed in v2 and the other way round.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Caller } from './auth.js'
import { keyOf } from './directory.js'
import type { Emulator } from './emulator.js'
import { jsonError } from './errors.js'
import type { Scope } from './inbox.js'
import { JsonBodyError, asObject, parseJsonBody } from './jsonbody.js'
import { messageMetadata } from './metadata.js'
import { isoLondon } from './time.js'

/** pageSize when the request has none (the G samples show 100) and its documented maximum. */
export const V2_PAGE_SIZE = 100
export const V2_MAX_PAGE_SIZE = 1000
/** Most status changes in one PATCH (undocumented; as many as one page lists). */
export const V2_MAX_CHANGES = 1000

const bad = (description: string) => jsonError(400, 'BAD_REQUEST', description)

type Query = Record<string, string | string[] | undefined>
const one = (q: Query, name: string) => {
  const v = q[name]
  return Array.isArray(v) ? v[0] : v
}

/** An optional boolean query parameter: true/false (or 1/0), anything else is 400. */
export function boolParam(q: Query, name: string): boolean {
  const v = one(q, name)
  if (v === undefined || v === '') return false
  if (/^(true|1)$/i.test(v)) return true
  if (/^(false|0)$/i.test(v)) return false
  throw bad(`${name} must be true or false`)
}

/** pageSize (1…, capped at 1000 as v1 caps limit) and pageNumber (1-based). */
export function pageParams(q: Query): { pageSize: number; pageNumber: number } {
  const int = (name: string, dflt: number) => {
    const v = one(q, name)
    if (v === undefined || v === '') return dflt
    if (!/^\d+$/.test(v) || Number(v) < 1) throw bad(`${name} must be a positive integer`)
    return Number(v)
  }
  return { pageSize: Math.min(int('pageSize', V2_PAGE_SIZE), V2_MAX_PAGE_SIZE), pageNumber: int('pageNumber', 1) }
}

/** One page of a list, or undefined when it is empty (204). */
export function page<T>(all: T[], p: { pageSize: number; pageNumber: number }) {
  const items = all.slice((p.pageNumber - 1) * p.pageSize, p.pageNumber * p.pageSize)
  if (items.length === 0) return undefined
  return { pageNumber: p.pageNumber, pageSize: p.pageSize, totalPages: Math.ceil(all.length / p.pageSize), totalElements: all.length, items }
}

/**
 * The customers a v2 list covers: the caller's usual view (Client-Code, Client-Country,
 * Filter-Service-Provider), narrowed to the provider's own messages by serviceProvider=true.
 */
export function v2Customers(c: Caller, serviceProvider: boolean): Set<string> {
  if (!serviceProvider) return c.visible
  const own = keyOf(c.user)
  return new Set([...c.visible].filter((k) => k === own))
}

export function registerMessagesV2(app: FastifyInstance, emulator: Emulator, caller: (req: FastifyRequest) => Caller, bankCode: string) {
  app.get('/v2/messages', async (req, reply) => {
    const c = caller(req)
    const q = req.query as Query
    const p = pageParams(q)
    const includeProcessed = boolParam(q, 'includeProcessed')
    const includeMetadata = boolParam(q, 'includeMetadata')
    const scope: Scope = { customers: v2Customers(c, boolParam(q, 'serviceProvider')), type: one(q, 'responseType') || undefined }
    const requestId = one(q, 'messageRequestId') || undefined
    // LHV UK messages only: an answer to a request the host handed to LHV EE (decision 607) is not listed.
    const entries = (await emulator.inbox.entries(scope, { includeProcessed, requestId }))
      .filter((e) => !e.message.requestId || (emulator.requests.bankCodeOf(e.message.requestId) ?? bankCode) === bankCode)
    const result = page(entries, p)
    if (!result) return reply.code(204).send()
    const { items, ...paging } = result
    return {
      ...paging,
      messages: items.map(({ message: m, processed }) => {
        const metadata = includeMetadata ? messageMetadata(m) : undefined
        return {
          messageResponseId: m.id,
          ...(m.requestId ? { messageRequestId: m.requestId } : {}),
          messageResponseType: m.type,
          clientCode: m.clientCode,
          clientCountry: m.clientCountry,
          ...(includeProcessed ? { messageProcessed: processed } : {}),
          messageCreatedTime: isoLondon(m.createdAt),
          bankCode,
          ...(metadata ? { metadata } : {}),
        }
      }),
    }
  })
}

/** PATCH /v2/messages/processed, in a scope whose JSON bodies arrive as text (jsonTextScope). */
export function registerMessagesProcessed(scope: FastifyInstance, emulator: Emulator, caller: (req: FastifyRequest) => Caller) {
  scope.patch('/v2/messages/processed', async (req, reply) => {
    const c = caller(req)
    let body: unknown
    try { body = parseJsonBody(req.body) } catch (e) {
      if (e instanceof JsonBodyError) throw bad(e.message)
      throw e
    }
    const list = asObject(body)?.messages
    if (!Array.isArray(list) || list.length === 0) throw bad('messages must be a non-empty array')
    if (list.length > V2_MAX_CHANGES) throw bad(`At most ${V2_MAX_CHANGES} messages can be updated at once`)
    const changes = list.map((item, i) => {
      const o = asObject(item)
      if (!o || typeof o.messageResponseId !== 'string' || !o.messageResponseId) throw bad(`messages[${i}].messageResponseId must be a string`)
      if (typeof o.messageProcessed !== 'boolean') throw bad(`messages[${i}].messageProcessed must be true or false`)
      return { id: o.messageResponseId, processed: o.messageProcessed }
    })
    const refused = await emulator.inbox.setProcessed({ customers: c.visible }, changes)
    if (refused) {
      // The G sample's wording, "Message-Request-Id" included, for an id the caller never had.
      throw bad(refused.reason === 'unknown'
        ? `Invalid Message-Request-Id: ${refused.id}`
        : `Message ${refused.id} is archived and cannot be undeleted`)
    }
    return reply.code(204).send()
  })
}
