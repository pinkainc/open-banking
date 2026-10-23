// The TARGET2 calendar and the SEPA Direct Debit key times of P 09 ("Glossary",
// "Cut-offs"). Times there are CET; Tallinn is always one hour ahead (both follow EU
// daylight saving), so 11:30 CET is 12:30 in Tallinn.
import { addDays, instant } from '../statements/camt060.js'

/** Easter Sunday of a year (anonymous Gregorian algorithm), as YYYY-MM-DD. */
export function easter(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Closed: weekends, 1 January, Good Friday, Easter Monday, 1 May, 25 and 26 December. */
export function isTarget2Day(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
  if (dow === 0 || dow === 6) return false
  const md = date.slice(5)
  if (md === '01-01' || md === '05-01' || md === '12-25' || md === '12-26') return false
  const e = easter(Number(date.slice(0, 4)))
  return date !== addDays(e, -2) && date !== addDays(e, 1)
}

/** The due date itself when it is a TARGET2 day, else the next one. */
export function settlementDate(due: string): string {
  let d = due
  while (!isTarget2Day(d)) d = addDays(d, 1)
  return d
}

/** The last TARGET2 day before a date. */
export function previousTarget2Day(date: string): string {
  let d = addDays(date, -1)
  while (!isTarget2Day(d)) d = addDays(d, -1)
  return d
}

/** Settlement of collections: 11:30 CET on the settlement date. */
export const settlementAt = (settlement: string) => instant(settlement, '12:30:00')
/** A debtor's refusal on the settlement date is a refusal until 10:30 CET, a return after. */
export const refusalCutoff = (settlement: string) => instant(settlement, '11:30:00')
/** The creditor's last moment: 15:30 CET on the TARGET2 day before the settlement date. */
export const submissionCutoff = (settlement: string) => instant(previousTarget2Day(settlement), '16:30:00')
/** Collections reach the debtor at the earliest 14 calendar days before the due date. */
export const EARLIEST_DAYS = 14
/** A settled collection can be refunded through Connect for 8 weeks. */
export const REFUND_DAYS = 56
