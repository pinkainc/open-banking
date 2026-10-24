// The Bacs calendar (G bacs-direct-debit.md "Glossary", "Cut-offs"): working days are the
// weekdays that are not bank holidays in England and Wales, and the cycle runs on them:
// input day 1, processing day 2 (LHV receives mandates, collections and credits and tells
// the customer), entry day 3 (debits and credits settle, mandates activate), day 5 the
// settlement of returns. Times in the docs are UK local time (decision 741).
import { addDays } from '../statements/camt060.js'
import { dateLondon, isoLondon } from '../time.js'
import { easter } from '../directdebit/target2.js'

const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()
const weekend = (date: string) => dow(date) === 0 || dow(date) === 6

/** The n-th (1-based) or, with n = -1, the last Monday of a month. */
function monday(year: number, month: number, n: number): string {
  const mm = String(month).padStart(2, '0')
  if (n > 0) {
    let d = `${year}-${mm}-01`
    while (dow(d) !== 1) d = addDays(d, 1)
    return addDays(d, 7 * (n - 1))
  }
  let d = addDays(month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`, -1)
  while (dow(d) !== 1) d = addDays(d, -1)
  return d
}

const cache = new Map<number, Set<string>>()

/**
 * The bank holidays of England and Wales in a year (gov.uk rules): New Year's Day, Good
 * Friday, Easter Monday, the early May and spring bank holidays, the summer bank holiday,
 * Christmas Day and Boxing Day, each moved to the next free weekday when it falls on a
 * weekend. One-off holidays (jubilees, coronations, state funerals) are not included.
 */
export function bankHolidays(year: number): Set<string> {
  let s = cache.get(year)
  if (s) return s
  s = new Set<string>()
  const substitute = (date: string) => {
    let d = date
    while (weekend(d) || s!.has(d)) d = addDays(d, 1)
    s!.add(d)
  }
  substitute(`${year}-01-01`)
  const e = easter(year)
  s.add(addDays(e, -2))
  s.add(addDays(e, 1))
  s.add(monday(year, 5, 1))
  s.add(monday(year, 5, -1))
  s.add(monday(year, 8, -1))
  substitute(`${year}-12-25`)
  substitute(`${year}-12-26`)
  cache.set(year, s)
  return s
}

/** A Bacs working day: a weekday that is not a bank holiday in England and Wales. */
export const isBacsDay = (date: string) => !weekend(date) && !bankHolidays(Number(date.slice(0, 4))).has(date)

/** The Bacs working day n working days after a date (n ≥ 1). */
export function nextBacsDay(date: string, n = 1): string {
  let d = date
  for (let i = 0; i < n; i++) {
    d = addDays(d, 1)
    while (!isBacsDay(d)) d = addDays(d, 1)
  }
  return d
}

/** The instant of a UK wall-clock time ('06:00') on a date, whatever the daylight saving. */
export function londonInstant(date: string, time: string): number {
  const [h, m] = time.split(':').map(Number)
  const wall = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m)
  const offset = (t: number) => {
    const o = isoLondon(new Date(t)).slice(-6)
    return (o[0] === '-' ? -1 : 1) * (Number(o.slice(1, 3)) * 60 + Number(o.slice(4, 6))) * 60_000
  }
  return wall - offset(wall - offset(wall))
}

/** The days of one cycle as LHV sees it: processing day (today, or the next working day) and entry day. */
export function cycle(now: Date): { processing: string; entry: string } {
  const today = dateLondon(now)
  const processing = isBacsDay(today) ? today : nextBacsDay(today)
  return { processing, entry: nextBacsDay(processing) }
}

/** The cut-offs of G "Cut-offs" (UK time). */
export const CUTOFF = {
  /** Debits on the entry day: 06:00, retried at 11:30, 15:00 and 18:30. */
  debits: ['06:00', '11:30', '15:00', '18:30'],
  /** Incoming credits settle with the debits' first run (decision 742). */
  credits: '06:00',
  /** Mandates activate at 11:35, the rest at the 18:35 retry, the end of the debtor's rejection window. */
  mandateEarly: '11:35',
  mandate: '18:35',
  /** The debtor can reject a collection until 18:30 on the entry day. */
  collectionReject: '18:30',
  /** Returns settle on day 5 of the original cycle at 05:00; reversals the next working day at 05:00. */
  refunds: '05:00',
} as const
