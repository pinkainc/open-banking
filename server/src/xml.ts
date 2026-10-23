// A minimal XML writer (elements, one attribute set, escaping) and a parser set up for
// ISO 20022 documents: namespace prefixes removed, text kept as strings.
import { XMLParser, XMLValidator } from 'fast-xml-parser'

export type Node = string | number | null | undefined | false | XmlEl | Node[]
export interface XmlEl { name: string; attrs?: Record<string, string>; children: Node[] }

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** el('Amt', {Ccy: 'EUR'}, '1.00') or el('GrpHdr', child, child…). Empty children drop out. */
export function el(name: string, ...rest: (Node | Record<string, string>)[]): XmlEl {
  let attrs: Record<string, string> | undefined
  if (rest.length && rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0]) && !('children' in (rest[0] as object))) {
    attrs = rest.shift() as Record<string, string>
  }
  return { name, attrs, children: rest as Node[] }
}

/** Like el, but returns nothing when the value is missing, so optional fields vanish. */
export const opt = (name: string, value: string | undefined | null, attrs?: Record<string, string>) =>
  value === undefined || value === null || value === '' ? null : attrs ? el(name, attrs, value) : el(name, value)

function render(n: Node, out: string[]) {
  if (n === null || n === undefined || n === false) return
  if (Array.isArray(n)) { for (const c of n) render(c, out); return }
  if (typeof n !== 'object') { out.push(esc(String(n))); return }
  const attrs = n.attrs ? Object.entries(n.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('') : ''
  const inner: string[] = []
  for (const c of n.children) render(c, inner)
  out.push(inner.length ? `<${n.name}${attrs}>${inner.join('')}</${n.name}>` : `<${n.name}${attrs}/>`)
}

export function toXml(root: XmlEl, declaration = true): string {
  const out: string[] = []
  render(root, out)
  return (declaration ? '<?xml version="1.0" encoding="UTF-8"?>\n' : '') + out.join('')
}

/** An ISO 20022 Document root with its namespace. */
export const document = (ns: string, body: XmlEl) => el('Document', { xmlns: `urn:iso:std:iso:20022:tech:xsd:${ns}` }, body)

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
})

export class XmlSyntaxError extends Error {}

/** Parses a document. Throws XmlSyntaxError when it is not well-formed. */
export function parseXml(text: string): any {
  const ok = XMLValidator.validate(text)
  if (ok !== true) throw new XmlSyntaxError(`${ok.err.msg} (line ${ok.err.line})`)
  return parser.parse(text)
}

/** Always an array: the parser returns a single child as an object. */
export const many = <T = any>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])

/** The text of an element that may carry attributes. */
export const text = (v: any): string | undefined =>
  v === undefined || v === null ? undefined : typeof v === 'object' ? (v['#text'] !== undefined ? String(v['#text']) : undefined) : String(v)
