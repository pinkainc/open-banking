// Time is injected everywhere it matters (message expiry, timestamps in messages), so
// tests can move it forward instead of waiting five days.
export interface Clock { now(): Date }

export const systemClock: Clock = { now: () => new Date() }

/** A clock that only moves when told to. */
export class ManualClock implements Clock {
  #t: number
  constructor(start: Date | string = '2026-01-15T10:00:00Z') { this.#t = new Date(start).getTime() }
  now() { return new Date(this.#t) }
  advance(ms: number) { this.#t += ms }
  set(t: Date | string) { this.#t = new Date(t).getTime() }
}

export const DAY_MS = 24 * 60 * 60 * 1000
