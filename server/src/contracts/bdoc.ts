// The contract container returned by POST /contracts: a BDOC (ASiC-E) zip with the
// contract text, unsigned. LHV's container is signed by the bank and waits for the
// customer's signature; here it only has to be a well-formed ASiC-E a client can store,
// show or hand to a signing tool (docs/decisions.md 412).
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(b: Buffer): number {
  let c = 0xffffffff
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** A zip archive; `store` entries are uncompressed (ASiC requires that for `mimetype`). */
export function zip(entries: { name: string; data: Buffer | string; store?: boolean }[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8')
    const body = e.store ? data : deflateRawSync(data)
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(data)
    const method = e.store ? 0 : 8
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(method, 8)
    head.writeUInt32LE(0, 10); head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28)
    local.push(head, name, body)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(0, 12); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += head.length + name.length + body.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, cdBuf, end])
}

/** An unsigned ASiC-E container with one text document, base64. */
export function bdoc(fileName: string, text: string): string {
  const manifest = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.etsi.asic-e+zip"/>
  <manifest:file-entry manifest:full-path="${fileName}" manifest:media-type="text/plain"/>
</manifest:manifest>
`
  return zip([
    { name: 'mimetype', data: 'application/vnd.etsi.asic-e+zip', store: true },
    { name: 'META-INF/manifest.xml', data: manifest },
    { name: fileName, data: text },
  ]).toString('base64')
}
