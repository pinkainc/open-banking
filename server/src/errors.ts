// Errors answered synchronously. The documented error document is <Errors> with one
// <Error> per problem (ErrorCode, Description, optional Field).
import type { FastifyReply } from 'fastify'
import { el, toXml } from './xml.js'

export class ConnectError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly field?: string) { super(message) }
}

export const forbidden = (message: string) => new ConnectError(403, 'FORBIDDEN', message)

export function errorsXml(errors: { code: string; description: string; field?: string }[]): string {
  return toXml(el('Errors', ...errors.map((e) =>
    el('Error', el('ErrorCode', e.code), el('Description', e.description), e.field ? el('Field', e.field) : null))))
}

export function sendError(reply: FastifyReply, e: ConnectError) {
  return reply.code(e.status).type('application/xml').send(errorsXml([{ code: e.code, description: e.message, field: e.field }]))
}
