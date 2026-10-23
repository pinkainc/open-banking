// Formatting of timestamps the way the reference reports them: Estonian time
// (Europe/Tallinn, +02:00 or +03:00 with daylight saving).
const ZONE = 'Europe/Tallinn'

const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
})

function local(d: Date) {
  const p: Record<string, string> = {}
  for (const { type, value } of parts.formatToParts(d)) p[type] = value
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0')
  // Offset: the local wall-clock time read as UTC, minus the instant.
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second, d.getUTCMilliseconds())
  const off = Math.round((wall - d.getTime()) / 60000)
  const sign = off < 0 ? '-' : '+'
  const abs = Math.abs(off)
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}`, ms, offset }
}

/** 2026-01-15T12:00:00.000+02:00 */
export function isoTallinn(d: Date): string {
  const l = local(d)
  return `${l.date}T${l.time}.${l.ms}${l.offset}`
}

/** 2026-01-15T12:00:00.000 — local time without an offset (camt.054.001.02). */
export function localTallinn(d: Date): string {
  const l = local(d)
  return `${l.date}T${l.time}.${l.ms}`
}

/** 2026-01-15 */
export function dateTallinn(d: Date): string { return local(d).date }

/** 2022-02-28 05:01:33:067 — the messageCreatedTime of the message list. */
export function listTimeTallinn(d: Date): string {
  const l = local(d)
  return `${l.date} ${l.time}:${l.ms}`
}

/** The heartbeat timestamp: seven fractional digits, as in the documented sample. */
export function heartbeatTallinn(d: Date): string {
  const l = local(d)
  return `${l.date}T${l.time}.${l.ms}0000${l.offset}`
}
