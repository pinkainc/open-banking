// Schema validation with libxml2 (compiled to WebAssembly, no native build). The
// schemas are the bank's published XSDs, downloaded by scripts/fetch-reference.sh; when
// they are absent the server falls back to the structural checks in pain001.ts.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateXML } from 'xmllint-wasm'

export class XsdValidator {
  constructor(readonly dir: string) {}

  has(ns: string) { return existsSync(join(this.dir, `${ns}.xsd`)) }

  /** Error messages (empty when valid). Throws when the schema is not available. */
  async validate(xml: string, ns: string): Promise<string[]> {
    const file = (n: string) => ({ fileName: `${n}.xsd`, contents: readFileSync(join(this.dir, `${n}.xsd`), 'utf8') })
    const preload = ns === 'pain.001.001.09' && this.has('supl.001.001.01') ? [file('supl.001.001.01')] : []
    const r = await validateXML({ xml: [{ fileName: 'request.xml', contents: xml }], schema: [file(ns)], preload })
    return r.valid ? [] : r.errors.map((e) => e.message.replace(/^.*?Schemas validity error : /, '').trim())
  }
}
