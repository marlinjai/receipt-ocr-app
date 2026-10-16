/**
 * A small, strict XML reader for electronic invoices (XRechnung in UBL or CII
 * syntax, the XML inside a ZUGFeRD or Factur-X PDF). Pure, no dependency.
 *
 * It reads elements, attributes and text into a tree and keeps each element's
 * local name (the part after the namespace prefix): the invoice standards fix
 * their namespaces, and the prefixes differ from one issuer to the next.
 * Anything an invoice never contains is refused instead of interpreted: a
 * document type declaration (no entity can expand), an unknown entity, a tag
 * that does not close. A file it refuses is read like any other receipt.
 */

export interface XmlElement {
  /** The local name, without namespace prefix: "ID" for "cbc:ID". */
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** The element's own text (CDATA included), entities decoded, not trimmed. */
  text: string;
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

/** Larger than any invoice; a bound so a hostile file cannot keep the server busy. */
export const MAX_XML_CHARS = 5_000_000;

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(Number.parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return String.fromCodePoint(Number.parseInt(ref.slice(1), 10));
    const named = ENTITIES[ref];
    if (named === undefined) throw new XmlError(`unknown entity ${whole}`);
    return named;
  });
}

const localName = (qualified: string) => qualified.slice(qualified.indexOf(':') + 1);

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!([A-Za-z][^>]*)>|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Parse a whole document; returns its root element. Throws `XmlError` on anything malformed or unsupported. */
export function parseXml(source: string): XmlElement {
  if (source.length > MAX_XML_CHARS) throw new XmlError('document too large');
  const text = source.replace(/^﻿/, '');
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let last = 0;
  const addText = (chunk: string) => {
    if (stack.length > 0) stack[stack.length - 1].text += chunk;
    else if (chunk.trim()) throw new XmlError('text outside the root element');
  };
  for (const match of text.matchAll(TOKEN)) {
    const between = text.slice(last, match.index);
    if (between.includes('<')) throw new XmlError('malformed tag');
    addText(decode(between));
    last = match.index + match[0].length;
    const [whole, cdata, declaration, closing, opening, attributeText, selfClosing] = match;
    if (whole.startsWith('<!--') || whole.startsWith('<?')) continue;
    if (cdata !== undefined) {
      addText(cdata);
      continue;
    }
    if (declaration !== undefined) throw new XmlError('document type declarations are not accepted');
    if (closing !== undefined) {
      const open = stack.pop();
      if (!open || open.name !== localName(closing)) throw new XmlError(`unexpected closing tag ${closing}`);
      continue;
    }
    const element: XmlElement = { name: localName(opening), attributes: {}, children: [], text: '' };
    for (const attribute of (attributeText ?? '').matchAll(ATTRIBUTE)) {
      element.attributes[localName(attribute[1])] = decode(attribute[2] ?? attribute[3] ?? '');
    }
    if (stack.length > 0) stack[stack.length - 1].children.push(element);
    else if (root) throw new XmlError('more than one root element');
    else root = element;
    if (!selfClosing) stack.push(element);
  }
  const rest = text.slice(last);
  if (rest.includes('<')) throw new XmlError('malformed tag');
  addText(decode(rest));
  if (stack.length > 0) throw new XmlError(`unclosed element ${stack[stack.length - 1].name}`);
  if (!root) throw new XmlError('no root element');
  return root;
}

/** The direct children with this local name. */
export function children(element: XmlElement | null | undefined, name: string): XmlElement[] {
  return element ? element.children.filter((c) => c.name === name) : [];
}

/** The first element along a path of local names, each a direct child of the one before. */
export function child(element: XmlElement | null | undefined, ...path: string[]): XmlElement | null {
  let current: XmlElement | null = element ?? null;
  for (const name of path) {
    current = current?.children.find((c) => c.name === name) ?? null;
    if (!current) return null;
  }
  return current;
}

/** The trimmed text at a path, or null when the element is missing or empty. */
export function textAt(element: XmlElement | null | undefined, ...path: string[]): string | null {
  const found = child(element, ...path);
  const value = found?.text.trim() ?? '';
  return value === '' ? null : value;
}
