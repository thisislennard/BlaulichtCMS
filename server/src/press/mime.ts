/**
 * Kleiner MIME-Leser für eingehende Mails des Presse-Postfachs (#205) – ohne Zusatzbibliothek.
 *
 * Unterstützt: Kopfzeilen mit Faltung, RFC 2047 (encoded words, B/Q, beliebige Zeichensätze über TextDecoder), rohes
 * UTF-8 in Kopfzeilen (RFC 6532), Parameter nach RFC 2231 (filename*=, Fortsetzungen), Content-Transfer-Encoding
 * base64/quoted-printable/7bit/8bit/binary, verschachtelte multipart-Teile, Adresslisten, Message-ID/In-Reply-To/
 * References. Grenzen gegen Missbrauch: Verschachtelungstiefe, Anzahl der Teile.
 *
 * Intern wird der Rohtext als „binary“ (latin1) behandelt, damit jedes Byte erhalten bleibt; dekodiert wird erst am Ende
 * mit dem angegebenen Zeichensatz.
 */

export interface MailAddress {
  name: string;
  address: string;
}

export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  inline: boolean;
  contentId: string | null;
}

export interface ParsedMail {
  headers: Map<string, string[]>;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  date: Date | null;
  contentType: string;
  text: string;
  html: string | null;
  attachments: MailAttachment[];
}

const MAX_DEPTH = 12;
const MAX_PARTS = 200;

/* ------------------------------------------------------------------ Zeichensätze */

const CHARSET_ALIASES: Record<string, string> = { 'utf8': 'utf-8', 'latin1': 'iso-8859-1', 'latin-1': 'iso-8859-1', 'cp1252': 'windows-1252', 'ascii': 'us-ascii', 'unicode-1-1-utf-7': 'utf-7' };

export function decodeCharset(buf: Buffer, charset?: string | null): string {
  let cs = String(charset ?? '').trim().toLowerCase().replace(/^"|"$/g, '');
  cs = CHARSET_ALIASES[cs] ?? cs;
  if (!cs || cs === 'us-ascii') cs = 'utf-8';
  try {
    return new TextDecoder(cs, { fatal: false }).decode(buf);
  } catch {
    // unbekannter Zeichensatz: gültiges UTF-8 annehmen, sonst Latin-1
    const utf = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return utf.includes('�') ? buf.toString('latin1') : utf;
  }
}

const bin = (s: string) => Buffer.from(s, 'latin1');

/**
 * Steuerzeichen aus Fremdtext entfernen (#237): NUL (U+0000) lehnt PostgreSQL in text-Spalten grundsätzlich ab – ein
 * `=00` (quoted-printable), ein Base64-Teil oder ein RFC-2047-Wort ergäbe sonst einen Fehler beim Speichern. Die übrigen
 * C0-Steuerzeichen außer Tab, Zeilenumbruch und Wagenrücklauf sowie DEL haben in Mailtexten keine Bedeutung.
 */
export function cleanText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** Einzeiliger Fremdtext (Betreff, Namen, Adressen, Kopfzeilen): zusätzlich Tab und Zeilenumbrüche als Leerzeichen. */
export function cleanLine(s: string): string {
  return cleanText(s).replace(/[\t\r\n]+/g, ' ');
}

/** Rohe 8-Bit-Bytes in Kopfzeilen: UTF-8, falls gültig, sonst Windows-1252. */
function decodeRawHeader(s: string): string {
  if (!/[\x80-\xff]/.test(s)) return s;
  const b = bin(s);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return decodeCharset(b, 'windows-1252');
  }
}

/* ------------------------------------------------------------------ Transfer-Kodierungen */

export function decodeQuotedPrintable(s: string, header = false): Buffer {
  let t = header ? s.replace(/_/g, ' ') : s.replace(/[ \t]+(\r?\n)/g, '$1').replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 0x3d && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) {
      out.push(parseInt(t.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(c & 0xff);
  }
  t = '';
  return Buffer.from(out);
}

export function decodeTransfer(body: string, encoding: string): Buffer {
  const e = encoding.trim().toLowerCase();
  if (e === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (e === 'quoted-printable') return decodeQuotedPrintable(body);
  return bin(body);
}

/* ------------------------------------------------------------------ Kopfzeilen */

/** RFC 2047: =?charset?B|Q?text?= – benachbarte kodierte Wörter werden ohne Leerraum verbunden. */
export function decodeWords(raw: string): string {
  const re = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;
  type Seg = { enc: false; text: string } | { enc: true; charset: string; bytes: Buffer };
  const segs: Seg[] = [];
  let last = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(raw)); ) {
    if (m.index > last) segs.push({ enc: false, text: raw.slice(last, m.index) });
    const bytes = m[2].toUpperCase() === 'B' ? Buffer.from(m[3], 'base64') : decodeQuotedPrintable(m[3], true);
    segs.push({ enc: true, charset: m[1].split('*')[0].toLowerCase(), bytes });
    last = re.lastIndex;
  }
  if (last < raw.length) segs.push({ enc: false, text: raw.slice(last) });
  let out = '';
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg.enc) {
      // Leerraum zwischen zwei kodierten Wörtern entfällt (RFC 2047, 6.2)
      if (/^\s*$/.test(seg.text) && segs[i - 1]?.enc && segs[i + 1]?.enc) continue;
      out += decodeRawHeader(seg.text);
      continue;
    }
    // gleicher Zeichensatz direkt dahinter: Bytes zusammenführen (geteilte Mehrbytezeichen)
    const bytes = [seg.bytes];
    let j = i + 1;
    while (j < segs.length) {
      const sep = segs[j];
      const nxt = !sep.enc && /^\s*$/.test(sep.text) ? segs[j + 1] : sep;
      if (!nxt || !nxt.enc || nxt.charset !== seg.charset) break;
      bytes.push(nxt.bytes);
      j = nxt === sep ? j + 1 : j + 2;
    }
    out += decodeCharset(Buffer.concat(bytes), seg.charset);
    i = j - 1;
  }
  return out;
}

export function parseHeaderBlock(block: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const lines = block.split(/\r?\n/);
  const unfolded: string[] = [];
  for (const l of lines) {
    if (/^[ \t]/.test(l) && unfolded.length) unfolded[unfolded.length - 1] += ' ' + l.trim();
    else if (l.trim()) unfolded.push(l);
  }
  for (const l of unfolded) {
    const i = l.indexOf(':');
    if (i <= 0) continue;
    const name = l.slice(0, i).trim().toLowerCase();
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) continue;
    const list = map.get(name) ?? [];
    list.push(cleanLine(l.slice(i + 1)).trim());
    map.set(name, list);
  }
  return map;
}

const first = (h: Map<string, string[]>, name: string) => h.get(name)?.[0] ?? null;

/** Wert und Parameter einer strukturierten Kopfzeile (Content-Type, Content-Disposition) samt RFC 2231. */
export function parseParams(value: string): { value: string; params: Record<string, string> } {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"' && value[i - 1] !== '\\') quoted = !quoted;
    if (c === ';' && !quoted) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  const main = parts.shift()!.trim().toLowerCase();
  const raw: Record<string, { v: string; ext: boolean }[]> = {};
  const simple: Record<string, string> = {};
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const key = p.slice(0, i).trim().toLowerCase();
    let v = p.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(key);
    if (m) {
      const idx = m[2] !== undefined ? Number(m[2]) : 0;
      (raw[m[1]] ??= [])[idx] = { v, ext: !!m[3] || (m[2] === undefined && key.endsWith('*')) };
    } else simple[key] = v;
  }
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(simple)) params[k] = decodeWords(v);
  for (const [k, list] of Object.entries(raw)) {
    let charset = 'utf-8';
    const bytes: Buffer[] = [];
    list.forEach((seg, i) => {
      if (!seg) return;
      let v = seg.v;
      if (seg.ext) {
        if (i === 0) {
          const mm = /^([^']*)'[^']*'(.*)$/.exec(v);
          if (mm) {
            charset = mm[1] || charset;
            v = mm[2];
          }
        }
        bytes.push(bin(v.replace(/%([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16)))));
      } else bytes.push(bin(v));
    });
    params[k] = decodeCharset(Buffer.concat(bytes), charset);
  }
  return { value: main, params };
}

/** Ein RFC-2047-Wort an dieser Stelle (wird beim Aufteilen als Ganzes übernommen). */
const ENCODED_WORD = /=\?[^?\s]+\?[BbQq]\?[^?]*\?=/y;

/**
 * Adressliste: „Name <a@b>, "Nach, Vor" <c@d>, e@f (Kommentar)“. Gruppen werden aufgelöst.
 *
 * Aufgeteilt wird auf dem Rohtext (Anführungszeichen, Kommentare, spitze Klammern und kodierte Wörter beachtet); erst
 * danach wird je Eintrag der Name dekodiert (RFC 2047 Abschn. 5, #229). Ein kodierter Name mit Komma wie
 * `=?iso-8859-1?Q?M=FCller=2C_Hans?=` („Müller, Hans“) bleibt so ein Name.
 */
export function parseAddressList(raw: string | null): MailAddress[] {
  if (!raw) return [];
  const text = raw;
  const items: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '=' && text[i + 1] === '?') {
      ENCODED_WORD.lastIndex = i;
      const w = ENCODED_WORD.exec(text);
      if (w) {
        cur += w[0];
        i += w[0].length - 1;
        continue;
      }
    }
    if (c === '"' && text[i - 1] !== '\\' && !paren) quoted = !quoted;
    else if (!quoted && c === '(') paren++;
    else if (!quoted && c === ')' && paren) paren--;
    else if (!quoted && !paren && c === '<') angle++;
    else if (!quoted && !paren && c === '>' && angle) angle--;
    if (!quoted && !angle && !paren && (c === ',' || c === ';')) {
      items.push(cur);
      cur = '';
    } else cur += c;
  }
  items.push(cur);
  const out: MailAddress[] = [];
  // Name erst jetzt dekodieren – auch in Anführungszeichen, wie es verbreitete Mailprogramme (regelwidrig) schreiben
  const name = (s: string) => cleanLine(decodeWords(s.trim().replace(/^"|"$/g, '').replace(/\\(.)/g, '$1'))).replace(/\s+/g, ' ').trim();
  for (let item of items) {
    item = item.replace(/^[^:<"]*:\s*/, (g) => (g.includes('@') ? g : '')).trim(); // Gruppenname „Team: …“
    if (!item) continue;
    const m = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(item);
    if (m) {
      out.push({ name: name(m[1]), address: cleanLine(decodeRawHeader(m[2])).toLowerCase() });
      continue;
    }
    const comment = /\(([^)]*)\)/.exec(item)?.[1] ?? '';
    const addr = /([^\s<>()"]+@[^\s<>()",;]+)/.exec(item)?.[1];
    if (addr) out.push({ name: name(comment), address: cleanLine(decodeRawHeader(addr)).toLowerCase() });
  }
  return out;
}

export function messageIds(raw: string | null): string[] {
  if (!raw) return [];
  return [...raw.matchAll(/<([^<>\s]{1,500})>/g)].map((m) => `<${m[1]}>`);
}

/* ------------------------------------------------------------------ Teile */

interface Part {
  headers: Map<string, string[]>;
  body: string;
}

function splitHead(s: string): Part {
  const m = /\r?\n\r?\n/.exec(s);
  if (!m) return { headers: parseHeaderBlock(s), body: '' };
  // Teil ohne Kopfzeilen beginnt direkt mit einer Leerzeile
  if (m.index === 0) return { headers: new Map(), body: s.slice(m[0].length) };
  return { headers: parseHeaderBlock(s.slice(0, m.index)), body: s.slice(m.index + m[0].length) };
}

function splitMultipart(body: string, boundary: string): string[] {
  const esc = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\r?\\n)--${esc}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');
  const parts: string[] = [];
  let start = -1;
  for (let m: RegExpExecArray | null; (m = re.exec(body)); ) {
    if (start >= 0) parts.push(body.slice(start, m.index));
    if (m[1]) return parts;
    start = re.lastIndex;
    // Zeilenumbruch nach der Grenze überspringen
    if (body[start] === '\r') start++;
    if (body[start] === '\n') start++;
    if (parts.length > MAX_PARTS) break;
  }
  if (start >= 0) parts.push(body.slice(start)); // fehlende Abschlussgrenze: Rest als letzter Teil
  return parts;
}

interface Collected {
  text: string[];
  html: string[];
  attachments: MailAttachment[];
  count: number;
}

function walk(p: Part, depth: number, acc: Collected, inAlternative = false) {
  if (++acc.count > MAX_PARTS) return;
  const ct = parseParams(first(p.headers, 'content-type') ?? 'text/plain');
  const type = ct.value.includes('/') ? ct.value : 'text/plain';
  const disp = parseParams(first(p.headers, 'content-disposition') ?? '');
  const filename = disp.params.filename || ct.params.name || '';
  const cte = first(p.headers, 'content-transfer-encoding') ?? '7bit';
  if (type.startsWith('multipart/') && ct.params.boundary && depth < MAX_DEPTH) {
    for (const sub of splitMultipart(p.body, ct.params.boundary)) walk(splitHead(sub), depth + 1, acc, type === 'multipart/alternative' || inAlternative);
    return;
  }
  const isAttachment = disp.value === 'attachment' || (!!filename && !type.startsWith('text/')) || (!!filename && disp.value === 'attachment');
  if (!isAttachment && (type === 'text/plain' || type === 'text/html')) {
    const content = cleanText(decodeCharset(decodeTransfer(p.body, cte), ct.params.charset));
    (type === 'text/plain' ? acc.text : acc.html).push(content);
    return;
  }
  const content = decodeTransfer(p.body, cte);
  const cid = first(p.headers, 'content-id');
  const ext = type === 'message/rfc822' ? '.eml' : '';
  acc.attachments.push({
    filename: (filename || `anhang-${acc.attachments.length + 1}${ext}`).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200),
    contentType: type,
    content,
    inline: disp.value === 'inline' || (!disp.value && !!cid),
    contentId: cid ? cid.replace(/^<|>$/g, '') : null,
  });
}

/** Komplette Mail (RFC 5322) lesen. */
export function parseMail(raw: Buffer): ParsedMail {
  const s = raw.toString('latin1');
  const top = splitHead(s);
  const h = top.headers;
  const acc: Collected = { text: [], html: [], attachments: [], count: 0 };
  walk(top, 0, acc);
  const dateRaw = first(h, 'date');
  const date = dateRaw ? new Date(dateRaw.replace(/\s*\([^)]*\)\s*$/, '')) : null;
  const html = acc.html.length ? acc.html.join('\n<hr>\n') : null;
  const text = acc.text.length ? acc.text.join('\n\n') : html ? cleanText(htmlToText(html)) : '';
  return {
    headers: h,
    messageId: messageIds(first(h, 'message-id'))[0] ?? null,
    inReplyTo: messageIds(first(h, 'in-reply-to'))[0] ?? null,
    references: messageIds(first(h, 'references')).slice(-50),
    subject: cleanLine(decodeWords(first(h, 'subject') ?? '')).replace(/\s+/g, ' ').trim(),
    from: parseAddressList(first(h, 'from'))[0] ?? null,
    to: parseAddressList((h.get('to') ?? []).join(', ')),
    cc: parseAddressList((h.get('cc') ?? []).join(', ')),
    replyTo: parseAddressList(first(h, 'reply-to')),
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    contentType: parseParams(first(h, 'content-type') ?? 'text/plain').value,
    text: text.replace(/\r\n/g, '\n'),
    html,
    attachments: acc.attachments,
  };
}

/* ------------------------------------------------------------------ HTML */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€', ndash: '–', mdash: '—', hellip: '…', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', sbquo: '‚', laquo: '«', raquo: '»', copy: '©', reg: '®', shy: '' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** HTML → lesbarer Text (für Anzeige, Suche und Mails ohne Textteil). */
export function htmlToText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|head|title|template)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|h[1-6]|li|blockquote|table|section|article)\s*>/gi, '\n').replace(/<li\b[^>]*>/gi, '• ');
  s = s.replace(/<a\b[^>]*href\s*=\s*["']?(https?:[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => {
    const label = t.replace(/<[^>]*>/g, '').trim();
    return label && label !== href ? `${label} (${href})` : href;
  });
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const DROP_ELEMENTS = /<(script|style|iframe|frame|frameset|object|embed|applet|form|input|button|select|textarea|link|meta|base|svg|math|template|noscript|video|audio|source|track|canvas|portal)\b[\s\S]*?(<\/\1\s*>|\/?>)/gi;

/**
 * HTML einer Mail entschärfen (zusätzlich zur Anzeige in einem abgeschotteten iframe ohne Skripte): gefährliche
 * Elemente, Ereignis-Attribute, Stilangaben mit Adressen, javascript:-/data:-Links und Bilder aus dem Internet (Zählpixel)
 * entfallen. Links bleiben, öffnen aber in neuem Fenster ohne Referrer.
 */
export function sanitizeHtml(html: string): { html: string; blockedImages: number } {
  let blocked = 0;
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  // erst Inhalt gefährlicher Elemente samt Text entfernen, dann einzelne öffnende Tags
  for (let i = 0; i < 3; i++) s = s.replace(DROP_ELEMENTS, '');
  s = s.replace(/<\/?(script|style|iframe|object|embed|form|link|meta|base|svg|math)\b[^>]*>/gi, '');
  s = s.replace(/<([a-z][a-z0-9]*)\b([^>]*)>/gi, (_m, tag: string, attrs: string) => {
    const keep: string[] = [];
    for (const a of attrs.matchAll(/([a-z_:][-a-z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/gi)) {
      const name = a[1].toLowerCase();
      let value = (a[2] ?? '').replace(/^["']|["']$/g, '');
      const plain = decodeEntities(value).replace(/[\u0000- ]/g, '').toLowerCase();
      if (name.startsWith('on') || name === 'target' || name === 'rel' || name === 'srcset' || name === 'formaction' || name === 'xmlns' || name.includes(':')) continue;
      if (['href', 'src', 'background', 'action', 'poster', 'lowsrc', 'dynsrc'].includes(name)) {
        if (name === 'href' && /^(https?:|mailto:|tel:|#)/.test(plain)) {
          keep.push(`href="${value.replace(/"/g, '&quot;')}"`);
          continue;
        }
        if (name === 'src' && tag.toLowerCase() === 'img' && /^data:image\/(png|jpe?g|gif|webp);/.test(plain)) {
          keep.push(`src="${value.replace(/"/g, '&quot;')}"`);
          continue;
        }
        if (name === 'src' && tag.toLowerCase() === 'img') blocked++;
        continue;
      }
      if (name === 'style') {
        if (/url\s*\(|expression|@import|behavior|-moz-binding|javascript/i.test(plain)) continue;
        value = value.replace(/"/g, '&quot;');
      }
      keep.push(a[2] === undefined ? name : `${name}="${value.replace(/"/g, '&quot;')}"`);
    }
    if (tag.toLowerCase() === 'a') keep.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
    return `<${tag}${keep.length ? ' ' + keep.join(' ') : ''}>`;
  });
  return { html: s, blockedImages: blocked };
}
