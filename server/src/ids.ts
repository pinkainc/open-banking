import { randomUUID } from 'node:crypto'

const hex32 = () => randomUUID().replaceAll('-', '')

/** Message-Request-Id: REQ + 32 hex characters. */
export const requestId = () => `REQ${hex32()}`
/** Message-Response-Id: RES + 32 hex characters. */
export const responseId = () => `RES${hex32()}`
/** AcctSvcrRef: the bank's own reference of a booking, 32 upper-case hex characters. */
export const servicerRef = () => hex32().toUpperCase()
/** camt.054 MsgId: 32 lower-case hex characters. */
export const notificationMsgId = () => hex32()

let seq = 10_000_000
/** pain.002 MsgId: a number, as the reference sends. */
export const statusReportMsgId = () => String(++seq)
