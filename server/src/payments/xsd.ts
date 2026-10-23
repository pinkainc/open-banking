// Schema validation with libxml2 (compiled to WebAssembly, no native build). The
// schemas are the bank's published XSDs, downloaded by scripts/fetch-reference.sh; when
// they are absent the server falls back to the structural checks in pain001.ts. Further
// directories are searched after the first (the ISO 20022 schemas of the versions the bank
// publishes none for, reference/iso/; decision 550).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryPages, validateXML } from 'xmllint-wasm'

/** libxml2's default 32 MiB is too little for a full statement page (10 000 entries) or the 10 MB mock. */
const MAX_MEMORY_PAGES = memoryPages.GiB

export class XsdValidator {
  readonly dirs: string[]
  constructor(readonly dir: string, ...more: string[]) { this.dirs = [dir, ...more] }

  #path(ns: string) { return this.dirs.map((d) => join(d, `${ns}.xsd`)).find((p) => existsSync(p)) }

  has(ns: string) { return this.#path(ns) !== undefined }

  /** Error messages (empty when valid). Throws when the schema is not available. */
  async validate(xml: string, ns: string): Promise<string[]> {
    const file = (n: string) => {
      const p = this.#path(n)
      if (!p) throw new Error(`no XSD for ${n}`)
      return { fileName: `${n}.xsd`, contents: readFileSync(p, 'utf8') }
    }
    const preload = (ns === 'pain.001.001.09' || ns === 'pain.008.001.08') && this.has('supl.001.001.01') ? [file('supl.001.001.01')] : []
    const r = await validateXML({ xml: [{ fileName: 'request.xml', contents: xml }], schema: [file(ns)], preload, maxMemoryPages: MAX_MEMORY_PAGES })
    return r.valid ? [] : r.errors.map((e) => e.message.replace(/^.*?Schemas validity error : /, '').trim())
  }
}
