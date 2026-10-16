/**
 * A small, strict XML reader for electronic invoices (XRechnung in UBL or CII
 * syntax, the XML inside a ZUGFeRD or Factur-X PDF). Pure, no dependency.
 *
 * It reads elements, attributes and text into a tree and keeps each element's
 * local name (the part after the namespace prefix): the invoice standards fix
 * their namespaces, and the prefixes differ from one issuer to the next.
 * Anything an invoice never contains is refused instead of interpreted: a
 * document type declaration (no entity can expand), an unknown entity, a tag
 * that does not close, a duplicate attribute. A file it refuses is read like
 * any other receipt.
 *
 * It reads with a cursor, never searching the rest of the file twice, so its
 * time grows with the length of the file even for hostile input.
 */

export interface XmlElement {
  /** The local name, without namespace prefix: "ID" for "cbc:ID". */
  name: string;
  /** The namespace prefix as written ("cbc"), empty for none. */
  prefix: string;
  /** Attributes by local name; namespace declarations are not among them. */
  attributes: Record<string, string>;
  /** The namespaces this element declares, by prefix ('' for the default namespace). */
  namespaces: Record<string, string>;
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

/** Decode the five XML entities and character references; anything else with "&" is refused. */
function decode(text: string): string {
  if (!text.includes('&')) return text;
  let out = '';
  let pos = 0;
  while (pos < text.length) {
    const amp = text.indexOf('&', pos);
    if (amp === -1) {
      out += text.slice(pos);
      break;
    }
    out += text.slice(pos, amp);
    const semi = text.indexOf(';', amp);
    if (semi === -1 || semi - amp > 12) throw new XmlError('bare ampersand');
    const ref = text.slice(amp + 1, semi);
    let value: string | undefined;
    let code: number | null = null;
    if (/^#x[0-9a-fA-F]{1,6}$/.test(ref)) code = Number.parseInt(ref.slice(2), 16);
    else if (/^#\d{1,7}$/.test(ref)) code = Number.parseInt(ref.slice(1), 10);
    if (code !== null) {
      // XML allows no character 0, no surrogate halves and nothing past the last code point.
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new XmlError(`invalid character reference &${ref};`);
      value = String.fromCodePoint(code);
    } else value = ENTITIES[ref];
    if (value === undefined) throw new XmlError(`unknown entity &${ref};`);
    out += value;
    pos = semi + 1;
  }
  return out;
}

const localName = (qualified: string) => qualified.slice(qualified.indexOf(':') + 1);

const NAME = /[A-Za-z_][\w:.-]*/y;
const ATTRIBUTE = /\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
const TAG_END = /\s*(\/?)>/y;

function matchAt(pattern: RegExp, text: string, pos: number): RegExpExecArray | null {
  pattern.lastIndex = pos;
  return pattern.exec(text);
}

/** Parse a whole document; returns its root element. Throws `XmlError` on anything malformed or unsupported. */
export function parseXml(source: string): XmlElement {
  if (source.length > MAX_XML_CHARS) throw new XmlError('document too large');
  const text = source.replace(/^﻿/, '');
  const stack: Array<{ element: XmlElement; qualified: string }> = [];
  let root: XmlElement | null = null;
  let pos = 0;
  const addText = (chunk: string) => {
    if (stack.length > 0) stack[stack.length - 1].element.text += chunk;
    else if (chunk.trim()) throw new XmlError('text outside the root element');
  };
  /** Skip to just after `terminator`, which must follow; otherwise the document is broken. */
  const skipTo = (terminator: string, from: number): number => {
    const end = text.indexOf(terminator, from);
    if (end === -1) throw new XmlError(`unterminated ${terminator}`);
    return end + terminator.length;
  };

  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    if (lt === -1) {
      addText(decode(text.slice(pos)));
      break;
    }
    if (lt > pos) addText(decode(text.slice(pos, lt)));
    if (text.startsWith('<!--', lt)) {
      pos = skipTo('-->', lt + 4);
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = skipTo(']]>', lt + 9);
      if (stack.length === 0) throw new XmlError('CDATA outside the root element');
      addText(text.slice(lt + 9, end - 3));
      pos = end;
    } else if (text.startsWith('<?', lt)) {
      pos = skipTo('?>', lt + 2);
    } else if (text.startsWith('<!', lt)) {
      throw new XmlError('document type declarations are not accepted');
    } else if (text.startsWith('</', lt)) {
      const name = matchAt(NAME, text, lt + 2);
      const end = name && matchAt(/\s*>/y, text, lt + 2 + name[0].length);
      if (!name || !end) throw new XmlError('malformed closing tag');
      const open = stack.pop();
      if (!open || open.qualified !== name[0]) throw new XmlError(`unexpected closing tag ${name[0]}`);
      pos = lt + 2 + name[0].length + end[0].length;
    } else {
      const name = matchAt(NAME, text, lt + 1);
      if (!name) throw new XmlError('malformed tag');
      const colon = name[0].indexOf(':');
      const element: XmlElement = {
        name: localName(name[0]),
        prefix: colon === -1 ? '' : name[0].slice(0, colon),
        attributes: {},
        namespaces: {},
        children: [],
        text: '',
      };
      const seen = new Set<string>();
      let cursor = lt + 1 + name[0].length;
      for (let attribute = matchAt(ATTRIBUTE, text, cursor); attribute; attribute = matchAt(ATTRIBUTE, text, cursor)) {
        const qualified = attribute[1];
        const value = decode(attribute[2] ?? attribute[3] ?? '');
        if (seen.has(qualified)) throw new XmlError(`duplicate attribute ${qualified}`);
        seen.add(qualified);
        if (qualified === 'xmlns') element.namespaces[''] = value;
        else if (qualified.startsWith('xmlns:')) element.namespaces[qualified.slice(6)] = value;
        else {
          // Attributes are kept by local name, so two that share one ("a" and "x:a") are refused, not overwritten.
          const key = localName(qualified);
          if (key in element.attributes) throw new XmlError(`duplicate attribute ${key}`);
          element.attributes[key] = value;
        }
        cursor += attribute[0].length;
      }
      const end = matchAt(TAG_END, text, cursor);
      if (!end) throw new XmlError('malformed tag');
      if (stack.length > 0) stack[stack.length - 1].element.children.push(element);
      else if (root) throw new XmlError('more than one root element');
      else root = element;
      if (!end[1]) stack.push({ element, qualified: name[0] });
      pos = cursor + end[0].length;
    }
  }
  if (stack.length > 0) throw new XmlError(`unclosed element ${stack[stack.length - 1].qualified}`);
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
