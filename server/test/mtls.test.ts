// The real transport: HTTPS with mutual TLS and certificates from scripts/dev-ca.sh.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { Emulator } from '../src/emulator.js'
import { parseXml } from '../src/xml.js'
import { C1, ROOT, SP, seed } from './helpers.js'

let openssl = true
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }) } catch { openssl = false }

describe('mutual TLS', { skip: openssl ? false : 'openssl not available' }, () => {
  let dir: string, foreign: string, app: FastifyInstance, port: number
  const read = (d: string, f: string) => readFileSync(join(d, f))
  const devCa = (d: string, ...args: string[]) =>
    execFileSync(join(ROOT, 'scripts/dev-ca.sh'), args, { env: { ...process.env, CERTS_DIR: d }, stdio: 'ignore' })

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ob-certs-'))
    foreign = mkdtempSync(join(tmpdir(), 'ob-foreign-'))
    devCa(dir)
    devCa(dir, 'client', 'weird', 'ABC123')
    devCa(foreign, 'client', 'intruder', C1.code) // same code, another CA
    const emulator = await Emulator.fromSeed(seed())
    app = buildApp({ emulator, https: { key: read(dir, 'server.key'), cert: read(dir, 'server.crt'), ca: read(dir, 'ca.crt') } })
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as AddressInfo).port
  })
  after(async () => {
    await app?.close()
    for (const d of [dir, foreign]) if (d) rmSync(d, { recursive: true, force: true })
  })

  const get = (path: string, client?: { dir: string; name: string }, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port, path, method: 'GET', headers, ca: read(dir, 'ca.crt'), servername: 'localhost',
        ...(client ? { cert: read(client.dir, `${client.name}.crt`), key: read(client.dir, `${client.name}.key`) } : {}),
      }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
      })
      req.on('error', reject)
      req.end()
    })

  test('a customer certificate gets through', async () => {
    const r = await get('/heartbeat', { dir, name: 'client1' })
    assert.equal(r.status, 200)
    assert.equal(r.headers['x-bank-code'], 'LHVEE')
    assert.match(parseXml(r.body).HeartBeatResponse.TimeStamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}\+0[23]:00$/)
  })

  test('heartbeat/mq reports the certificate', async () => {
    const r = await get('/heartbeat/mq', { dir, name: 'client1' })
    assert.equal(r.status, 202)
    const m = await get('/messages/next', { dir, name: 'client1' })
    const cert = parseXml(m.body).HeartBeatResponse.Certificates.Certificate
    assert.match(String(cert.SerialNumber), /^[0-9A-F]+$/)
    assert.match(cert.ValidFrom, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/)
  })

  test('no client certificate: refused in the handshake', async () => {
    await assert.rejects(get('/heartbeat'))
  })

  test('a certificate from another CA: refused in the handshake', async () => {
    await assert.rejects(get('/heartbeat', { dir: foreign, name: 'intruder' }))
  })

  test('a trusted certificate of an unknown customer: 403 with the error document', async () => {
    const r = await get('/heartbeat', { dir, name: 'stranger' })
    assert.equal(r.status, 403)
    assert.deepEqual(parseXml(r.body).Errors.Error, { ErrorCode: 'FORBIDDEN', Description: "User doesn't exist" })
  })

  test('a non-numeric subject serialNumber: 403', async () => {
    const r = await get('/heartbeat', { dir, name: 'weird' })
    assert.equal(r.status, 403)
    assert.equal(parseXml(r.body).Errors.Error.Description, 'Certificate has invalid SERIALNUMBER field')
  })

  test('service provider headers over TLS', async () => {
    assert.equal((await get('/heartbeat', { dir, name: 'provider' })).status, 403)
    const ok = await get('/heartbeat', { dir, name: 'provider' }, { 'Client-Code': C1.code, 'Client-Country': 'EE' })
    assert.equal(ok.status, 200)
    const own = await get('/messages/count', { dir, name: 'provider' }, { 'Client-Code': SP.code, 'Client-Country': 'EE' })
    assert.equal(own.status, 200)
  })
})
