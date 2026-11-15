import zlib from 'node:zlib';

/**
 * Entfernt Standort- und identifizierende Metadaten aus Bild-Originalen, ohne die Bilddaten neu zu kodieren (#119).
 *
 * Entfernt werden:
 * - der GPS-Block im EXIF (alle GPS-Felder) samt Verweis,
 * - Seriennummern von Kamera und Objektiv, Name der Besitzerin/des Besitzers, Urheber-/Autorfelder (Artist, XPAuthor),
 *   eindeutige Bild-ID, Benutzerkommentar und die herstellerspezifischen MakerNotes (enthalten oft Seriennummern,
 *   teils Standort),
 * - XMP-Pakete (können GPS, Orte und Namen enthalten) und IPTC/Photoshop-Blöcke (JPEG APP13: Ort, Personen),
 * - bei PNG zusätzlich Textblöcke (tEXt/zTXt/iTXt).
 *
 * Erhalten bleiben: Kamerahersteller und -modell, Aufnahmezeit, Belichtungsdaten, Ausrichtung, Copyright-Vermerk und
 * das eingebettete EXIF-Vorschaubild. Die Bilddaten selbst bleiben bytegleich.
 *
 * Alle Funktionen arbeiten nur auf Puffern (ohne Datenbank/Dateisystem) und sind dadurch direkt testbar.
 */

export interface ScrubResult {
  /** Neuer Dateiinhalt (bei HEIF dieselbe Länge, sonst ggf. kürzer). */
  data: Buffer;
  /** Waren Standortdaten enthalten (GPS-Block im EXIF oder GPS-Angaben im XMP)? */
  gps: boolean;
  /** Wurde etwas verändert? */
  changed: boolean;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
const TAG_GPS_IFD = 0x8825;
const TAG_EXIF_IFD = 0x8769;
/** IFD0/IFD1: Artist, XPAuthor, XPComment, ImageUniqueID, CameraSerialNumber (DNG). */
const IFD0_PRIVATE = new Set([0x013b, 0x9c9d, 0x9c9c, 0xa420, 0xc62f]);
/** Exif-IFD: MakerNote, UserComment, ImageUniqueID, CameraOwnerName, BodySerialNumber, LensSerialNumber. */
const EXIF_PRIVATE = new Set([0x927c, 0x9286, 0xa420, 0xa430, 0xa431, 0xa435]);

/**
 * Bereinigt einen TIFF/EXIF-Block im Puffer an Ort und Stelle (gleiche Länge). `base` zeigt auf „II“/„MM“,
 * alle Offsets im Block sind relativ dazu. Ungültige Strukturen werden nicht angefasst.
 */
export function scrubTiff(b: Buffer, base: number, len = b.length - base): { gps: boolean; changed: boolean } {
  const res = { gps: false, changed: false };
  if (len < 8 || base < 0 || base + len > b.length) return res;
  const order = b.toString('latin1', base, base + 2);
  if (order !== 'II' && order !== 'MM') return res;
  const le = order === 'II';
  const r16 = (o: number) => (le ? b.readUInt16LE(base + o) : b.readUInt16BE(base + o));
  const r32 = (o: number) => (le ? b.readUInt32LE(base + o) : b.readUInt32BE(base + o));
  const w16 = (o: number, v: number) => (le ? b.writeUInt16LE(v, base + o) : b.writeUInt16BE(v, base + o));
  const w32 = (o: number, v: number) => (le ? b.writeUInt32LE(v, base + o) : b.writeUInt32BE(v, base + o));
  if (r16(2) !== 42) return res;

  const ifdOk = (off: number) => off >= 8 && off + 2 <= len && off + 2 + r16(off) * 12 + 4 <= len;
  /** Außerhalb des Eintrags gespeicherte Werte (größer als 4 Byte) mit Nullen überschreiben. */
  const zeroData = (e: number) => {
    const size = (TYPE_SIZE[r16(e + 2)] ?? 1) * r32(e + 4);
    if (size <= 4) {
      b.fill(0, base + e + 8, base + e + 12);
      return;
    }
    const off = r32(e + 8);
    if (off >= 8 && off + size <= len) b.fill(0, base + off, base + off + size);
  };
  /** Einträge entfernen: übrige nachrücken, Zähler und Verweis auf das nächste IFD anpassen, Rest nullen. */
  const removeEntries = (ifd: number, drop: (tag: number) => boolean) => {
    if (!ifdOk(ifd)) return;
    const n = r16(ifd);
    const keep: Buffer[] = [];
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (drop(r16(e))) {
        zeroData(e);
        res.changed = true;
      } else keep.push(Buffer.from(b.subarray(base + e, base + e + 12)));
    }
    if (keep.length === n) return;
    const next = r32(ifd + 2 + n * 12);
    const end = ifd + 2 + n * 12 + 4;
    w16(ifd, keep.length);
    keep.forEach((k, i) => k.copy(b, base + ifd + 2 + i * 12));
    w32(ifd + 2 + keep.length * 12, next);
    b.fill(0, base + ifd + 2 + keep.length * 12 + 4, base + end);
  };
  const findTag = (ifd: number, tag: number): number | null => {
    if (!ifdOk(ifd)) return null;
    for (let i = 0; i < r16(ifd); i++) {
      const e = ifd + 2 + i * 12;
      if (r16(e) === tag) return r32(e + 8);
    }
    return null;
  };

  const ifd0 = r32(4);
  if (!ifdOk(ifd0)) return res;
  const gpsIfd = findTag(ifd0, TAG_GPS_IFD);
  const exifIfd = findTag(ifd0, TAG_EXIF_IFD);
  const ifd1 = r32(ifd0 + 2 + r16(ifd0) * 12);
  if (gpsIfd !== null) {
    res.gps = true;
    res.changed = true;
    if (ifdOk(gpsIfd)) {
      const n = r16(gpsIfd);
      for (let i = 0; i < n; i++) zeroData(gpsIfd + 2 + i * 12);
      b.fill(0, base + gpsIfd, base + gpsIfd + 2 + n * 12 + 4);
    }
  }
  if (exifIfd !== null) removeEntries(exifIfd, (t) => EXIF_PRIVATE.has(t));
  removeEntries(ifd0, (t) => t === TAG_GPS_IFD || IFD0_PRIVATE.has(t));
  if (ifd1 && ifd1 !== ifd0) removeEntries(ifd1, (t) => t === TAG_GPS_IFD || IFD0_PRIVATE.has(t));
  return res;
}

const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');
const XMP_NS = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
const XMP_EXT_NS = Buffer.from('http://ns.adobe.com/xmp/extension/\0', 'latin1');
const xmpHasGps = (buf: Buffer) => /GPS(Latitude|Longitude)|exif:GPS|LocationShown|LocationCreated/i.test(buf.toString('latin1'));

export function scrubJpeg(input: Buffer): ScrubResult {
  const b = Buffer.from(input);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return { data: input, gps: false, changed: false };
  const parts: Buffer[] = [b.subarray(0, 2)];
  let gps = false;
  let changed = false;
  let pos = 2;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) break;
    const marker = b[pos + 1];
    if (marker === 0xff) {
      parts.push(b.subarray(pos, pos + 1));
      pos += 1;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // Bilddaten beginnen: Rest unverändert übernehmen
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(b.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    const segEnd = pos + 2 + b.readUInt16BE(pos + 2);
    if (segEnd > b.length) break;
    const payload = b.subarray(pos + 4, segEnd);
    let drop = false;
    if (marker === 0xe1 && payload.subarray(0, 6).equals(EXIF_HEADER)) {
      const r = scrubTiff(b, pos + 4 + 6, payload.length - 6);
      gps ||= r.gps;
      changed ||= r.changed;
    } else if (marker === 0xe1 && (payload.subarray(0, XMP_NS.length).equals(XMP_NS) || payload.subarray(0, XMP_EXT_NS.length).equals(XMP_EXT_NS))) {
      gps ||= xmpHasGps(payload);
      drop = true;
    } else if (marker === 0xed) drop = true; // APP13: Photoshop/IPTC (Orte, Personen, Stichwörter)
    if (drop) changed = true;
    else parts.push(b.subarray(pos, segEnd));
    pos = segEnd;
  }
  parts.push(b.subarray(pos));
  return { data: changed ? Buffer.concat(parts) : input, gps, changed };
}

export function scrubPng(input: Buffer): ScrubResult {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (input.length < 8 || !input.subarray(0, 8).equals(SIG)) return { data: input, gps: false, changed: false };
  const b = Buffer.from(input);
  const parts: Buffer[] = [b.subarray(0, 8)];
  let gps = false;
  let changed = false;
  let pos = 8;
  while (pos + 12 <= b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('latin1', pos + 4, pos + 8);
    const end = pos + 12 + len;
    if (end > b.length) break;
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      gps ||= xmpHasGps(b.subarray(pos + 8, pos + 8 + len));
      changed = true;
    } else {
      if (type === 'eXIf') {
        const r = scrubTiff(b, pos + 8, len);
        gps ||= r.gps;
        if (r.changed) {
          changed = true;
          b.writeUInt32BE(zlib.crc32(b.subarray(pos + 4, pos + 8 + len)) >>> 0, pos + 8 + len);
        }
      }
      parts.push(b.subarray(pos, end));
    }
    pos = end;
    if (type === 'IEND') break;
  }
  if (pos < b.length) parts.push(b.subarray(pos));
  return { data: changed ? Buffer.concat(parts) : input, gps, changed };
}

export function scrubWebp(input: Buffer): ScrubResult {
  if (input.length < 12 || input.toString('latin1', 0, 4) !== 'RIFF' || input.toString('latin1', 8, 12) !== 'WEBP') return { data: input, gps: false, changed: false };
  const b = Buffer.from(input);
  const parts: Buffer[] = [];
  let gps = false;
  let changed = false;
  let vp8x: Buffer | null = null;
  let pos = 12;
  while (pos + 8 <= b.length) {
    const fourcc = b.toString('latin1', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const end = pos + 8 + size + (size & 1);
    if (pos + 8 + size > b.length) break;
    if (fourcc === 'XMP ') {
      gps ||= xmpHasGps(b.subarray(pos + 8, pos + 8 + size));
      changed = true;
    } else {
      if (fourcc === 'EXIF') {
        const off = b.subarray(pos + 8, pos + 14).equals(EXIF_HEADER) ? 6 : 0;
        const r = scrubTiff(b, pos + 8 + off, size - off);
        gps ||= r.gps;
        changed ||= r.changed;
      }
      const chunk = b.subarray(pos, Math.min(end, b.length));
      if (fourcc === 'VP8X') vp8x = chunk;
      parts.push(chunk);
    }
    pos = end;
  }
  if (!changed) return { data: input, gps, changed };
  if (vp8x) vp8x[8] &= ~0x04; // XMP-Kennzeichen löschen
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return { data: Buffer.concat([head, body]), gps, changed };
}

/**
 * HEIC/HEIF (ISO-BMFF): Ohne lizenzpflichtigen Decoder wird nicht umgebaut, sondern an Ort und Stelle bereinigt –
 * EXIF-Blöcke („Exif\0\0“ + TIFF-Kopf) wie oben, XMP-Pakete werden mit Leerzeichen überschrieben. Länge und alle
 * Verweise im Container bleiben gleich.
 */
export function scrubHeif(input: Buffer): ScrubResult {
  const b = Buffer.from(input);
  let gps = false;
  let changed = false;
  for (let i = b.indexOf(EXIF_HEADER); i !== -1; i = b.indexOf(EXIF_HEADER, i + 6)) {
    const t = i + 6;
    const head = b.toString('latin1', t, t + 4);
    if (head !== 'II*\0' && head !== 'MM\0*') continue;
    const r = scrubTiff(b, t);
    gps ||= r.gps;
    changed ||= r.changed;
  }
  const open = Buffer.from('<x:xmpmeta', 'latin1');
  const close = Buffer.from('</x:xmpmeta>', 'latin1');
  for (let i = b.indexOf(open); i !== -1; i = b.indexOf(open, i + 1)) {
    const j = b.indexOf(close, i);
    if (j === -1) break;
    gps ||= xmpHasGps(b.subarray(i, j));
    b.fill(0x20, i, j + close.length);
    changed = true;
  }
  return { data: changed ? b : input, gps, changed };
}

/** Bereinigt ein Bild-Original nach Format (MIME-Typ aus der Inhaltsprüfung). */
export function scrubImage(input: Buffer, mime: string): ScrubResult {
  switch (mime) {
    case 'image/jpeg':
      return scrubJpeg(input);
    case 'image/png':
      return scrubPng(input);
    case 'image/webp':
      return scrubWebp(input);
    case 'image/heic':
    case 'image/heif':
    case 'image/avif':
      // AVIF nutzt denselben ISOBMFF-/HEIF-Aufbau (Exif- und XMP-Elemente)
      return scrubHeif(input);
    default:
      return { data: input, gps: false, changed: false };
  }
}
