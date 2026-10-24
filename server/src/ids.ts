import { randomUUID } from 'node:crypto'

const hex32 = () => randomUUID().replaceAll('-', '')

/**
 * Request ids made in this process whose 202 is not recorded yet (decision 987): the first
 * attempt of a UK webhook waits for the record, so the bank code it reads is the request's
 * even when the request log is a store that answers later. Forgotten after OPEN_MS.
 */
const open = new Map<string, () => void>()
const waits = new Map<string, Promise<void>>()
const OPEN_MS = 5_000

/** Message-Request-Id: REQ + 32 hex characters. */
export const requestId = () => {
  const id = `REQ${hex32()}`
  waits.set(id, new Promise<void>((resolve) => {
    open.set(id, resolve)
    setTimeout(() => closeRequest(id), OPEN_MS).unref()
  }))
  return id
}
/** The request is recorded (or was never going to be): whoever waits for it goes on. */
export function closeRequest(id: string) {
  open.get(id)?.()
  open.delete(id)
  waits.delete(id)
}
/** Resolves once a request id made in this process is recorded; at once for any other id. */
export const requestRecorded = (id: string | undefined): Promise<void> => (id && waits.get(id)) || Promise.resolve()
/** Message-Response-Id: RES + 32 hex characters. */
export const responseId = () => `RES${hex32()}`
/** AcctSvcrRef: the bank's own reference of a booking, 32 upper-case hex characters. */
export const servicerRef = () => hex32().toUpperCase()
/** camt.054 MsgId: 32 lower-case hex characters. */
export const notificationMsgId = () => hex32()

let seq = 10_000_000
/** pain.002 MsgId: a number, as the reference sends. */
export const statusReportMsgId = () => String(++seq)
