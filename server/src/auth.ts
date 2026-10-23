// Who is calling, and on whose behalf. The transport has already verified the client
// certificate against the trusted CA (mutual TLS); here the certificate subject is
// mapped to a customer, and the Client-Code / Client-Country headers select the
// customer a service provider acts for. Failures are the documented FORBIDDEN cases.
import type { FastifyRequest } from 'fastify'
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
}

export type Identify = (req: FastifyRequest) => CertIdentity | undefined

/** Reads the verified peer certificate of the TLS connection. */
export const identifyFromTls: Identify = (req) => {
  const socket = req.raw.socket as TLSSocket
  if (typeof socket.getPeerCertificate !== 'function' || !socket.authorized) return undefined
  const cert = socket.getPeerCertificate()
  if (!cert || !cert.subject) return undefined
  const s = cert.subject as unknown as Record<string, string | string[]>
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  return {
    serialNumber: one(s.serialNumber), commonName: one(s.CN),
    certSerial: cert.serialNumber, validFrom: cert.valid_from, validTo: cert.valid_to,
  }
}

export interface Caller {
  /** The certificate holder. */
  user: Customer
  /** The customer the request acts for (the user itself, or a connected customer). */
  customer: Customer
  /** Customers whose messages the request may read. */
  visible: Set<string>
  cert: CertIdentity
}

const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

export function resolveCaller(req: FastifyRequest, directory: Directory, identify: Identify): Caller {
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
