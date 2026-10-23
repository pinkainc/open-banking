// IBAN checks: shape and the ISO 7064 mod-97 check digits.
export const normalizeIban = (s: string) => s.replace(/\s+/g, '').toUpperCase()

export function ibanChecksumOk(iban: string): boolean {
  const s = normalizeIban(iban)
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{1,30}$/.test(s)) return false
  const moved = s.slice(4) + s.slice(0, 4)
  let rem = 0
  for (const ch of moved) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of v) rem = (rem * 10 + Number(d)) % 97
  }
  return rem === 1
}

/** Builds a valid IBAN from a country and a BBAN (used by the simulator). */
export function makeIban(country: string, bban: string): string {
  const probe = `${country}00${bban}`
  const moved = probe.slice(4) + probe.slice(0, 4)
  let rem = 0
  for (const ch of moved) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch
    for (const d of v) rem = (rem * 10 + Number(d)) % 97
  }
  return `${country}${String(98 - rem).padStart(2, '0')}${bban}`
}

export const ibanCountry = (iban: string) => normalizeIban(iban).slice(0, 2)

// Countries and territories of the SEPA schemes (EEA plus the non-EEA participants).
const SEPA = new Set(('AT BE BG HR CY CZ DK EE FI FR DE GR HU IS IE IT LV LI LT LU MT NL NO PL PT RO SK SI ES SE ' +
  'CH GB SM VA MC AD AL MD ME MK RS GI GG JE IM PM BL MF GF GP MQ YT RE AX').split(' '))
export const isSepaCountry = (country: string) => SEPA.has(country)
