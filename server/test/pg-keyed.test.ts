// KeyedStore semantics (decision 961), memory always and Postgres when DATABASE_URL is
// set: add only when absent, take once, bounds as BoundedMap (time to live by the injected
// clock, oldest first beyond max, a set makes the key the newest), kinds and namespaces apart.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, test } from 'node:test'
import type { Bounds } from '../src/bounded.js'
import { ManualClock } from '../src/clock.js'
import { claimName, memoryKeyed, updateKeyed, type KeyedFactory } from '../src/keyed.js'
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

    test('replace keeps the place and the expiry, only for a live key (decision 975)', async () => {
      const { clock, s } = await store<{ n: number }>({ ttlMs: 1000, max: 10 })
      await s.set('a', { n: 1 })
      clock.advance(400)
      await s.set('b', { n: 2 })
      assert.equal(await s.replace('a', { n: 3 }), true)
      assert.deepEqual(await s.entries(), [['a', { n: 3 }], ['b', { n: 2 }]], 'a stays the oldest')
      assert.equal(await s.replace('c', { n: 4 }), false, 'absent: nothing written')
      assert.equal(await s.has('c'), false)
      clock.advance(600)
      assert.equal(await s.replace('a', { n: 5 }), false, 'expired at its first time to live')
      assert.deepEqual(await s.entries(), [['b', { n: 2 }]])
    })

    test('replace with expected is a compare-and-set; updateKeyed loses no write of two at once (decision 1008)', async () => {
      const { s } = await store<{ n: number; tags?: string[]; b?: { y: number; x: number } }>({ max: 10 })
      await s.set('a', { n: 1, b: { x: 1, y: 2 } })
      assert.equal(await s.replace('a', { n: 2 }, { n: 9 }), false, 'another value stored: nothing written')
      assert.equal(await s.replace('a', { n: 2 }, { b: { y: 2, x: 1 }, n: 1 }), true, 'equal as JSON, whatever the key order')
      assert.equal(await s.replace('c', { n: 3 }, { n: 2 }), false, 'absent')
      assert.equal(await s.has('c'), false)
      // Twenty writers at once, each adding its tag with a read-modify-write: every tag is kept.
      const tags = Array.from({ length: 20 }, (_, i) => `t${i}`)
      await Promise.all(tags.map((t) => updateKeyed(s, 'u', async (v) => {
        await new Promise((r) => setTimeout(r, Math.random() * 5))
        return { n: (v?.n ?? 0) + 1, tags: [...(v?.tags ?? []), t] }
      })))
      const u = await s.get('u')
      assert.equal(u?.n, 20)
      assert.deepEqual([...u!.tags!].sort(), [...tags].sort())
      assert.equal(await updateKeyed(s, 'u', () => undefined), undefined, 'f stores nothing')
      assert.equal((await s.get('u'))?.n, 20)
    })

    test('claimName: one holder of a name; one that does not show is waited for, then taken over (decision 1012)', async () => {
      const { s } = await store<string>({ max: 10 })
      const shown = new Set<string>()
      const shows = async (h: string) => shown.has(h)
      const got = await Promise.all(['r1', 'r2', 'r3'].map((r) => claimName(s, 'n', r, async (h) => { shown.add(h); return true })))
      assert.equal(new Set(got).size, 1, 'every claimant answers the same holder')
      assert.equal(await claimName(s, 'n', got[0], shows), got[0], 'the holder again: its own')
      // A holder stored right after the claim is waited for and answered.
      await s.set('m', 'slow')
      setTimeout(() => shown.add('slow'), 30)
      assert.equal(await claimName(s, 'm', 'r4', shows, 1000), 'slow')
      // One that never shows (a crash between the claim and the store) is taken over.
      await s.set('k', 'lost')
      assert.equal(await claimName(s, 'k', 'r5', shows, 50), 'r5')
      assert.equal(await s.get('k'), 'r5')
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
