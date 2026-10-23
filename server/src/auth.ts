// Who is calling, and on whose behalf. The transport has already verified the client
// certificate against the trusted CA (mutual TLS; only a validity-period failure is let
// through, to be answered here); the certificate subject is mapped to a customer, checked
// against the certificates of its contract and the clock, and the Client-Code /
// Client-Country headers select the customer a service provider acts for. Failures are
// the documented FORBIDDEN cases.
import type { FastifyRequest } from 'fastify'
import { X509Certificate } from 'node:crypto'
import type { TLSSocket } from 'node:tls'
import { keyOf, type Customer, type Directory } from './directory.js'
import { forbidden } from './errors.js'

/** What the transport tells us about the client certificate. */
export interface CertIdentity {
  serialNumber?: string
  commonName?: string
  /** The certificate's own serial (hex), reported by heartbeat/mq. */
  certSerial?: string
  validFrom?: string
  validTo?: string
  /** SHA-256 fingerprint, upper-case hex with colons (Node's `fingerprint256`). */
  fingerprint256?: string
}

export type Identify = (req: FastifyRequest) => CertIdentity | undefined

/** OpenSSL verification results that only concern the validity period (decision 502). */
const PERIOD_ERRORS = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID'])

/** The CA certificates of a PEM bundle. */
export function caCertificates(pem: string | Buffer): X509Certificate[] {
  return (String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((p) => new X509Certificate(p))
}

/**
 * Whether the TLS layer accepted the peer, or refused it only for its validity period
 * while a trusted CA did issue it (the period is then judged by resolveCaller).
 */
export function peerAcceptable(socket: TLSSocket, cas: X509Certificate[]): boolean {
  if (socket.authorized) return true
  const err = String(socket.authorizationError ?? '')
  if (!PERIOD_ERRORS.has(err) || typeof socket.getPeerX509Certificate !== 'function') return false
  const peer = socket.getPeerX509Certificate()
  return !!peer && cas.some((ca) => peer.checkIssued(ca) && peer.verify(ca.publicKey))
}

/** Reads the peer certificate of the TLS connection; `cas` judges period-only failures. */
export const tlsIdentify = (cas: X509Certificate[] = []): Identify => (req) => {
  const socket = req.raw.socket as TLSSocket
  if (typeof socket.getPeerCertificate !== 'function' || !peerAcceptable(socket, cas)) return undefined
  const cert = socket.getPeerCertificate()
  if (!cert || !cert.subject) return undefined
  const s = cert.subject as unknown as Record<string, string | string[]>
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  return {
    serialNumber: one(s.serialNumber), commonName: one(s.CN),
    certSerial: cert.serialNumber, validFrom: cert.valid_from, validTo: cert.valid_to, fingerprint256: cert.fingerprint256,
  }
}

/** Accepts only certificates the TLS layer verified completely. */
export const identifyFromTls: Identify = tlsIdentify()

/** A certificate fingerprint in one form: upper-case hex without separators. */
export const normalizeFingerprint = (f: string) => f.replace(/[^0-9a-f]/gi, '').toUpperCase()

export interface Caller {
  /** The certificate holder. */
  user: Customer
  /** The customer the request acts for (the user itself, or a connected customer). */
  customer: Customer
  /** Customers whose messages the request may read. */
  visible: Set<string>
  cert: CertIdentity
  /**
   * Services granted for this request (decision 501): the customer's own contract when it
   * acts for itself, the provider's contract with the customer otherwise. Undefined: all.
   */
  services?: string[]
}

/** Service names of P 14 that gate a route (decision 501). */
export const SERVICE = {
  heartbeat: 'HEARTBEAT',
  statement: 'ACCOUNT_STATEMENT',
  balance: 'ACCOUNT_BALANCE',
  payments: 'PAYMENTS_WITHOUT_SIGNATURE',
} as const

/** 403 "User has not been granted the requested service" unless the service is enabled. */
export function requireService(c: Caller, service: string) {
  if (c.services && !c.services.includes(service)) throw forbidden('User has not been granted the requested service')
}

/**
 * The certificate against the user's contract (decision 502): one of the registered
 * fingerprints when the contract lists any, and inside its validity period by `now`.
 */
function checkCertificate(user: Customer, cert: CertIdentity, now: Date) {
  if (user.certificates) {
    if (user.certificates.length === 0) throw forbidden("User doesn't have valid certificate for authentication")
    const f = cert.fingerprint256 ? normalizeFingerprint(cert.fingerprint256) : undefined
    if (!f || !user.certificates.some((c) => normalizeFingerprint(c) === f)) throw forbidden('User authentication certificate is different than expected')
  }
  const t = now.getTime()
  const from = cert.validFrom ? Date.parse(cert.validFrom) : NaN
  const to = cert.validTo ? Date.parse(cert.validTo) : NaN
  if (!Number.isNaN(from) && from > t) throw forbidden('User authentication certificate is not yet valid')
  if (!Number.isNaN(to) && to < t) throw forbidden('User authentication certificate is expired')
}

const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

export function resolveCaller(req: FastifyRequest, directory: Directory, identify: Identify, now: Date = new Date()): Caller {
  const cert = identify(req)
  if (!cert) throw forbidden('User authentication certificate is missing')
  let code: string
  if (cert.serialNumber !== undefined) {
    if (!/^\d+$/.test(cert.serialNumber)) throw forbidden('Certificate has invalid SERIALNUMBER field')
    code = cert.serialNumber
  } else {
    if (!cert.commonName) throw forbidden('Invalid certificate subject common name')
    code = cert.commonName
  }
  const matches = directory.byCode(code)
  if (matches.length === 0) throw forbidden("User doesn't exist")
  // A code registered in several countries: prefer the one holding a provider contract.
  const user = matches.find((c) => c.connected) ?? matches[0]
  checkCertificate(user, cert, now)

  const clientCode = header(req, 'Client-Code')
  const clientCountry = header(req, 'Client-Country')
  if (clientCode !== undefined && clientCountry === undefined) throw forbidden("Missing 'Client-Country' request header")
  if (clientCountry !== undefined && clientCountry.length !== 2) {
    throw forbidden("'Client-Country' request header value is not in correct format. Length should be 2 characters (i.e. EE)")
  }

  if (user.connected) {
    if (clientCode === undefined) throw forbidden("Can't authenticate. No 'Client-Code' header for service provider")
    const wanted = { code: clientCode, country: clientCountry!.toUpperCase() }
    if (keyOf(wanted) === keyOf(user)) {
      const own = /^(1|true)$/i.test(header(req, 'Filter-Service-Provider') ?? '')
      const visible = new Set([keyOf(user), ...(own ? [] : user.connected.map(keyOf))])
      return { user, customer: user, visible, cert }
    }
    const customer = directory.get(wanted)
    if (!customer) throw forbidden("User doesn't exist")
    if (!user.connected.some((k) => keyOf(k) === keyOf(customer))) throw forbidden("User doesn't have valid contract")
    return { user, customer, visible: new Set([keyOf(customer)]), cert }
  }

  if (clientCode !== undefined && keyOf({ code: clientCode, country: clientCountry!.toUpperCase() }) !== keyOf(user)) {
    throw forbidden("User doesn't have valid contract")
  }
  return { user, customer: user, visible: new Set([keyOf(user)]), cert }
}
