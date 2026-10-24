// KeyedStore semantics (decision 961), memory always and Postgres when DATABASE_URL is
// set: add only when absent, take once, bounds as BoundedMap (time to live by the injected
// clock, oldest first beyond max, a set makes the key the newest), kinds and namespaces apart.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, test } from 'node:test'
import type { Bounds } from '../src/bounded.js'
import { ManualClock } from '../src/clock.js'
import { memoryKeyed, type KeyedFactory } from '../src/keyed.js'
import { pgKeyed } from '../src/pg/keyed.js'
import { pgDb } from './helpers.js'

const STORES: [string, (clock: ManualClock, ns?: string) => Promise<KeyedFactory>][] = [['memory', async (clock) => memoryKeyed(clock)]]
if (process.env.DATABASE_URL) STORES.push(['postgres', async (clock, ns) => pgKeyed(await pgDb(), clock, ns ?? randomUUID())])

for (const [name, make] of STORES) {
  describe(`KeyedStore (${name})`, () => {
    const store = async <V>(bounds: Bounds, kind = 'k') => {
      const clock = new ManualClock('2026-03-10T08:00:00Z')
      return { clock, s: (await make(clock))<V>(kind, bounds) }
    }

    test('get, set, add only when absent, take once, entries oldest first', async () => {
      const { s } = await store<{ n: number }>({ max: 10 })
      assert.equal(await s.get('a'), undefined)
      await s.set('a', { n: 1 })
      assert.equal(await s.add('a', { n: 2 }), false)
      assert.deepEqual(await s.get('a'), { n: 1 })
      assert.equal(await s.add('b', { n: 3 }), true)
      await s.set('a', { n: 4 }) // the newest now
      assert.deepEqual(await s.entries(), [['b', { n: 3 }], ['a', { n: 4 }]])
      assert.deepEqual(await s.take('a'), { n: 4 })
      assert.equal(await s.take('a'), undefined)
      assert.equal(await s.has('a'), false)
      assert.equal(await s.has('b'), true)
    })

    test('bounds: time to live by the clock, the oldest beyond max', async () => {
      const { clock, s } = await store<true>({ ttlMs: 1000, max: 2 })
      await s.set('a', true)
      clock.advance(500)
      await s.set('b', true)
      clock.advance(500)
      assert.equal(await s.has('a'), false, 'expired')
      assert.equal(await s.add('a', true), true, 'an expired key is absent')
      await s.set('c', true)
      assert.deepEqual((await s.entries()).map(([k]) => k), ['a', 'c'], 'b the oldest beyond max')
      assert.equal(await s.take('b'), undefined)
    })

    test('kinds are apart', async () => {
      const clock = new ManualClock('2026-03-10T08:00:00Z')
      const f = await make(clock)
      await f<number>('x', { max: 5 }).set('k', 1)
      assert.equal(await f<number>('y', { max: 5 }).get('k'), undefined)
      assert.equal(await f<number>('x', { max: 5 }).get('k'), name === 'memory' ? undefined : 1, 'memory: every store its own; Postgres: the kind\'s rows')
    })
  })
}

if (process.env.DATABASE_URL) test('KeyedStore (postgres): namespaces are apart, a new store on the same namespace sees the rows', async () => {
  const clock = new ManualClock('2026-03-10T08:00:00Z')
  const ns = randomUUID()
  await pgKeyed(await pgDb(), clock, ns)<string>('k', { max: 5 }).set('a', 'x')
  assert.equal(await pgKeyed(await pgDb(), clock)<string>('k', { max: 5 }).get('a'), undefined)
  assert.equal(await pgKeyed(await pgDb(), clock, ns)<string>('k', { max: 5 }).get('a'), 'x')
})
