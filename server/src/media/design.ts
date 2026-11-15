import path from 'node:path';
import { badRequest } from '../lib/errors.js';
import { config } from '../config.js';

/*
 * Gestaltung der öffentlichen Upload-Seite wie LiFeOS (Paket 10). Eine Gestaltung ist ein kleines JSON-Dokument:
 *   { accent: 'rot', header: true, blocks: [{ type: 'banner', image: '<uuid>', alt: '…' }, …, { type: 'upload' }] }
 * Serverseitig gegen ein festes Schema geprüft (bekannte Typen, Längen, genau ein Upload-Bereich, höchstens 30 Bausteine)
 * und nur als Text gespeichert; die Oberfläche stellt alles als Text dar, nie als HTML. Akzentfarben kommen aus einer
 * festen Palette mit ausreichendem Kontrast zu weißer Schrift. Der Datenschutzabschnitt (Art. 13 DSGVO) ist kein
 * Baustein und erscheint immer.
 */
export const MAX_BLOCKS = 30;

export const ACCENTS: Record<string, string> = {
  rot: 'Rot',
  dunkelrot: 'Dunkelrot',
  blau: 'Blau',
  gruen: 'Grün',
  orange: 'Orange',
  anthrazit: 'Anthrazit',
};

type FieldSpec = ['text', number] | ['multiline', number] | ['choice', string[]] | ['image'];
export const BLOCK_TYPES: Record<string, { label: string; fields: Record<string, { spec: FieldSpec; def: string }> }> = {
  banner: { label: 'Titelbild', fields: { image: { spec: ['image'], def: '' }, alt: { spec: ['text', 150], def: '' }, height: { spec: ['choice', ['s', 'm', 'l']], def: 'm' } } },
  logo: { label: 'Logo', fields: { image: { spec: ['image'], def: '' }, alt: { spec: ['text', 150], def: '' }, align: { spec: ['choice', ['left', 'center']], def: 'center' } } },
  heading: { label: 'Überschrift', fields: { text: { spec: ['text', 120], def: '' }, size: { spec: ['choice', ['l', 'm']], def: 'l' } } },
  text: { label: 'Text', fields: { text: { spec: ['multiline', 2000], def: '' } } },
  image: { label: 'Bild', fields: { image: { spec: ['image'], def: '' }, alt: { spec: ['text', 150], def: '' }, caption: { spec: ['text', 200], def: '' } } },
  note: { label: 'Hinweisbox', fields: { text: { spec: ['multiline', 500], def: '' }, style: { spec: ['choice', ['info', 'warning']], def: 'info' } } },
  divider: { label: 'Trennlinie', fields: {} },
  welcome: { label: 'Begrüßungstext des Links', fields: {} },
  upload: { label: 'Upload-Bereich', fields: {} },
};

export interface Design {
  accent: string;
  header: boolean;
  blocks: Record<string, string>[];
}

export const DEFAULT_DESIGN: Design = { accent: 'rot', header: true, blocks: [{ type: 'welcome' }, { type: 'upload' }] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Gestaltung prüfen und normalisieren; wirft 400 mit verständlicher Meldung. Bild-IDs prüft der Aufrufer gegen die Datenbank. */
export function cleanDesign(raw: unknown): Design {
  if (!raw || typeof raw !== 'object') throw badRequest('Die Gestaltung ist beschädigt.');
  const data = raw as Record<string, unknown>;
  const accent = typeof data.accent === 'string' ? data.accent : 'rot';
  if (!(accent in ACCENTS)) throw badRequest('Unbekannte Akzentfarbe.');
  const blocks = data.blocks;
  if (!Array.isArray(blocks) || !blocks.length) throw badRequest('Die Gestaltung braucht mindestens den Upload-Bereich.');
  if (blocks.length > MAX_BLOCKS) throw badRequest(`Höchstens ${MAX_BLOCKS} Bausteine.`);
  const out: Record<string, string>[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object' || typeof (b as any).type !== 'string' || !BLOCK_TYPES[(b as any).type]) throw badRequest('Unbekannter Baustein.');
    const type = (b as any).type as string;
    const block: Record<string, string> = { type };
    for (const [name, { spec, def }] of Object.entries(BLOCK_TYPES[type].fields)) {
      let value = (b as any)[name] ?? def;
      if (typeof value !== 'string') throw badRequest('Ungültiger Wert in einem Baustein.');
      if (spec[0] === 'choice') {
        if (!spec[1].includes(value)) throw badRequest('Ungültige Auswahl in einem Baustein.');
      } else if (spec[0] === 'image') {
        if (value && !UUID_RE.test(value)) throw badRequest('Ungültiges Bild.');
      } else {
        // Steuerzeichen raus; einzeilige Texte ohne Zeilenumbrüche
        value = spec[0] === 'multiline' ? value.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim() : value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
        if (value.length > spec[1]) throw badRequest(`Ein Text ist zu lang (höchstens ${spec[1]} Zeichen).`);
      }
      block[name] = value;
    }
    if (['banner', 'logo', 'image'].includes(type) && !block.image) throw badRequest('Bitte für jeden Bildbaustein ein Bild hochladen.');
    out.push(block);
  }
  if (out.filter((b) => b.type === 'upload').length !== 1) throw badRequest('Der Upload-Bereich muss genau einmal vorkommen.');
  return { accent, header: data.header !== false, blocks: out };
}

export function designImageIds(d: Design | null | undefined): string[] {
  return [...new Set((d?.blocks ?? []).map((b) => b.image).filter((x): x is string => !!x))];
}

/** Platzhalter {thema} (Titel der Sammlung) und {datum} (Veranstaltungsdatum) – Ergebnis bleibt Text. */
export function renderText(text: string, title: string, eventDate: Date | string | null): string {
  // DATE-Spalten liefert node-postgres als lokale Mitternacht, Zeichenketten als „JJJJ-MM-TT“ – beides ohne Zeitzonenversatz lesen
  let date = '';
  const m = typeof eventDate === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(eventDate) : null;
  if (m) date = `${m[3]}.${m[2]}.${m[1]}`;
  else if (eventDate instanceof Date && !Number.isNaN(eventDate.getTime())) date = `${String(eventDate.getDate()).padStart(2, '0')}.${String(eventDate.getMonth() + 1).padStart(2, '0')}.${eventDate.getFullYear()}`;
  return (text ?? '').replaceAll('{thema}', title ?? '').replaceAll('{datum}', date);
}

/** Gestaltung für die öffentliche Seite: Platzhalter ersetzt. */
export function resolveDesign(d: Design, title: string, eventDate: Date | string | null): Design {
  return {
    ...d,
    blocks: d.blocks.map((b) => {
      const r: Record<string, string> = { ...b };
      for (const k of ['text', 'alt', 'caption']) if (typeof r[k] === 'string') r[k] = renderText(r[k], title, eventDate);
      return r;
    }),
  };
}

export const designImagePath = (id: string, mime: string) => path.join(config.mediaDir, 'design', `${id}.${mime === 'image/png' ? 'png' : 'jpg'}`);
