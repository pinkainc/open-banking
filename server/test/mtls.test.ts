// The real transport: HTTPS with mutual TLS and certificates from scripts/dev-ca.sh.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
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
import { C1, ROOT, SP, seed, storeOptions } from './helpers.js'

let openssl = true
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }) } catch { openssl = false }
/** Whether this openssl can backdate certificates (x509 -not_before, OpenSSL 3.4+). */
const periods = openssl && (() => { const h = spawnSync('openssl', ['x509', '-help'], { encoding: 'utf8' }); return `${h.stdout}${h.stderr}`.includes('-not_before') })()

describe('mutual TLS', { skip: openssl ? false : 'openssl not available' }, () => {
  let dir: string, foreign: string, app: FastifyInstance, port: number, emulator: Emulator
  const read = (d: string, f: string) => readFileSync(join(d, f))
  const devCa = (d: string, ...args: string[]) =>
    execFileSync(join(ROOT, 'scripts/dev-ca.sh'), args, { env: { ...process.env, CERTS_DIR: d }, stdio: 'ignore' })

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ob-certs-'))
    foreign = mkdtempSync(join(tmpdir(), 'ob-foreign-'))
    devCa(dir)
    devCa(dir, 'client', 'weird', 'ABC123')
    devCa(foreign, 'client', 'intruder', C1.code) // same code, another CA
    if (periods) {
      periodCert(dir, 'expired', C1.code, '20200101000000Z', '20210101000000Z')
      periodCert(dir, 'future', C1.code, '20990101000000Z', '20991231000000Z')
      periodCert(foreign, 'expiredIntruder', C1.code, '20200101000000Z', '20210101000000Z')
    }
    emulator = await Emulator.fromSeed(seed(), await storeOptions())
    app = buildApp({ emulator, https: { key: read(dir, 'server.key'), cert: read(dir, 'server.crt'), ca: read(dir, 'ca.crt') } })
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as AddressInfo).port
  })
  after(async () => {
    await app?.close()
    for (const d of [dir, foreign]) if (d) rmSync(d, { recursive: true, force: true })
  })

  /** A client certificate of the CA in `d` with an explicit validity period. */
  const periodCert = (d: string, name: string, code: string, from: string, to: string) => {
    const o = { cwd: d, stdio: 'ignore' as const }
    execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/C=EE/O=${name}/CN=${name}/serialNumber=${code}`], o)
    execFileSync('openssl', ['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-not_before', from, '-not_after', to, '-out', `${name}.crt`], o)
  }

  const get = (path: string, client?: { dir: string; name: string }, headers: Record<string, string> = {}, body?: string) =>
    new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? headers : { 'content-type': 'application/xml', ...headers }, ca: read(dir, 'ca.crt'), servername: 'localhost',
        ...(client ? { cert: read(client.dir, `${client.name}.crt`), key: read(client.dir, `${client.name}.key`) } : {}),
      }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
      })
      req.on('error', reject)
      req.end(body)
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

  test('direct debit endpoints: a customer certificate gets through, none is refused in the handshake', async () => {
    for (const path of ['/direct-debit/collection', '/direct-debit/incoming-collection']) {
      const r = await get(path, { dir, name: 'client1' }, {}, '<Document')
      assert.equal(r.status, 400, 'past TLS and identity: the body is checked')
      await assert.rejects(get(path, undefined, {}, '<Document/>'))
      assert.equal((await get(path, { dir, name: 'stranger' }, {}, '<Document/>')).status, 403)
    }
  })

  test('service provider headers over TLS', async () => {
    assert.equal((await get('/heartbeat', { dir, name: 'provider' })).status, 403)
    const ok = await get('/heartbeat', { dir, name: 'provider' }, { 'Client-Code': C1.code, 'Client-Country': 'EE' })
    assert.equal(ok.status, 200)
    const own = await get('/messages/count', { dir, name: 'provider' }, { 'Client-Code': SP.code, 'Client-Country': 'EE' })
    assert.equal(own.status, 200)
  })

  describe('validity period and the contract certificate (decision 502)', { skip: periods ? false : 'openssl cannot backdate certificates (needs x509 -not_before)' }, () => {
    test('an expired certificate of the trusted CA: 403 "is expired"', async () => {
      const r = await get('/heartbeat', { dir, name: 'expired' })
      assert.equal(r.status, 403)
      assert.deepEqual(parseXml(r.body).Errors.Error, { ErrorCode: 'FORBIDDEN', Description: 'User authentication certificate is expired' })
    })

    test('a certificate valid only from 2099: 403 "is not yet valid"', async () => {
      const r = await get('/messages/next', { dir, name: 'future' })
      assert.equal(r.status, 403)
      assert.equal(parseXml(r.body).Errors.Error.Description, 'User authentication certificate is not yet valid')
    })

    test('an expired certificate of another CA: still refused at the transport', async () => {
      await assert.rejects(get('/heartbeat', { dir: foreign, name: 'expiredIntruder' }))
    })

    test('a contract naming another certificate: 403 "different than expected"', async () => {
      const fp = (name: string) => new X509Certificate(read(dir, `${name}.crt`)).fingerprint256
      const c1 = emulator.directory.get(C1)!
      try {
        c1.certificates = [fp('client2')]
        const r = await get('/heartbeat', { dir, name: 'client1' })
        assert.equal(r.status, 403)
        assert.equal(parseXml(r.body).Errors.Error.Description, 'User authentication certificate is different than expected')
        c1.certificates = [fp('client1')]
        assert.equal((await get('/heartbeat', { dir, name: 'client1' })).status, 200)
      } finally { delete c1.certificates }
    })
  })
})
