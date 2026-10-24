// Errors answered synchronously. The documented error document is <Errors> with one
// <Error> per problem (ErrorCode, Description, optional Field).
import type { FastifyReply } from 'fastify'
import { el, toXml } from './xml.js'

export class ConnectError extends Error {
  /** json: the messages API answers errors as {"errors":[{errorCode, description}]}. */
  constructor(readonly status: number, readonly code: string, message: string, readonly field?: string, readonly json = false) { super(message) }
}

/** An error of the messages API (JSON body). */
export const jsonError = (status: number, code: string, message: string) => new ConnectError(status, code, message, undefined, true)
export const notFound = () => jsonError(404, 'NOT_FOUND', 'Requested resource not found')

export const forbidden = (message: string) => new ConnectError(403, 'FORBIDDEN', message)

/**
 * An error answered with a JSON body of its own (UK `/accounts/*`, decision 708): the
 * AWS-gateway `{"Message": ...}` or a bare JSON string, sent as given.
 */
export class JsonBodyError extends ConnectError {
  constructor(status: number, readonly body: unknown) { super(status, String(status), typeof body === 'string' ? body : JSON.stringify(body)) }
}

export function errorsXml(errors: { code: string; description: string; field?: string }[]): string {
  return toXml(el('Errors', ...errors.map((e) =>
    el('Error', el('ErrorCode', e.code), el('Description', e.description), e.field ? el('Field', e.field) : null))))
}

export function sendError(reply: FastifyReply, e: ConnectError) {
  if (e instanceof JsonBodyError) return reply.code(e.status).type('application/json').send(JSON.stringify(e.body))
  if (e.json) return reply.code(e.status).type('application/json').send({ errors: [{ errorCode: e.code, description: e.message }] })
  return reply.code(e.status).type('application/xml').send(errorsXml([{ code: e.code, description: e.message, field: e.field }]))
}
