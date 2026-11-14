import { httpRequest, classifyStatus } from '../lib/http.js';
import { parseIcs, type IcsEvent } from '../lib/ics.js';
import { sha256Hex } from '../lib/crypto.js';
import { StepError } from '../lib/errors.js';
import type { Connector, NodeType, RuntimeConnection } from '../engine/types.js';

/**
 * Alamos FE2. Einsätze kommen per Push aus dem FE2-Alarmablauf (Plugin „HTTP/JSON“ bzw.
 * „Allgemeiner Webhook“) an eine LifeLink-Adresse; Termine über den offiziellen iCal-Export
 * der FE2-Kalenderverwaltung. Ein direkter Zugriff auf die interne FE2-Datenbank wird bewusst
 * nicht genutzt (undokumentiertes Schema, kein Support, Risiko für das Alarmsystem).
 */

type Raw = Record<string, any>;

const pick = (o: Raw, ...keys: string[]) => {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  return undefined;
};

function isoOrNow(v: unknown): string {
  const d = v ? new Date(String(v)) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** FE2 sendet je nach Version und Plugin unterschiedliche Feldnamen – wir vereinheitlichen. */
export function normalizeAlarm(input: unknown) {
  const d: Raw = input && typeof input === 'object' ? (input as Raw) : {};
  // Manche Plugins schachteln die Daten unter "data" oder "parameters"
  const r: Raw = { ...(typeof d.data === 'object' ? d.data : {}), ...(typeof d.parameters === 'object' ? d.parameters : {}), ...d };
  const strasse = pick(r, 'strasse', 'street', 'Strasse');
  const hnr = pick(r, 'hausnummer', 'hnr', 'house');
  const plz = pick(r, 'plz', 'zip', 'postalCode');
  const stadt = pick(r, 'ort', 'city', 'Ort', 'stadt');
  const built = [strasse ? `${strasse}${hnr ? ` ${hnr}` : ''}` : '', [plz, stadt].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const unitsRaw = pick(r, 'units', 'einheiten', 'fahrzeuge', 'Einheiten', 'Fahrzeuge', 'vehicles') ?? [];
  const einheiten = Array.isArray(unitsRaw)
    ? unitsRaw.map((u) => (typeof u === 'object' && u ? String(u.name ?? u.address ?? JSON.stringify(u)) : String(u)))
    : String(unitsRaw)
        .split(/[,;|]/)
        .map((s) => s.trim())
        .filter(Boolean);
  const id = pick(r, 'externalId', 'einsatznummer', 'Einsatznummer', 'id', 'alarmId', 'dbId');
  return {
    einsatz_id: id != null ? String(id) : null,
    stichwort: String(pick(r, 'keyword', 'stichwort', 'Stichwort', 'einsatzart', 'Einsatzart') ?? 'Unbekannt').trim(),
    stichwort_text: String(pick(r, 'keyword_description', 'stichwortText', 'keywordDescription', 'meldebild', 'Meldebild') ?? '').trim(),
    meldung: String(pick(r, 'message', 'meldung', 'Meldung', 'bemerkung', 'Bemerkung', 'freitext', 'text') ?? '').trim(),
    ort: String(pick(r, 'location', 'adresse', 'einsatzort', 'Einsatzort', 'address') ?? built ?? '').trim() || built,
    strasse: strasse ? String(strasse) : '',
    hausnummer: hnr ? String(hnr) : '',
    plz: plz ? String(plz) : '',
    stadt: stadt ? String(stadt) : '',
    ortsteil: String(pick(r, 'ortsteil', 'district', 'Ortsteil') ?? ''),
    objekt: String(pick(r, 'objekt', 'building', 'Objekt') ?? ''),
    einheiten,
    alarmzeit: isoOrNow(pick(r, 'timestamp', 'alarmzeit', 'Alarmzeit', 'zeit', 'datetime', 'alarmDate')),
    koordinaten: r.lat && r.lng ? { lat: Number(r.lat), lng: Number(r.lng) } : null,
    roh: d,
  };
}

export function normalizeCalendarPush(input: unknown) {
  const r: Raw = input && typeof input === 'object' ? (input as Raw) : {};
  const id = pick(r, 'id', 'eintrag_id', 'kalender_id', 'uid');
  return {
    termin_id: id != null ? String(id) : null,
    titel: String(pick(r, 'titel', 'title', 'betreff', 'Titel', 'Betreff') ?? 'Termin').trim(),
    beschreibung: String(pick(r, 'beschreibung', 'description', 'notizen', 'Beschreibung') ?? '').trim(),
    ort: String(pick(r, 'ort', 'location', 'raum', 'Ort') ?? '').trim(),
    beginn: isoOrNow(pick(r, 'start', 'startzeit', 'beginn', 'Start', 'Beginn')),
    ende: pick(r, 'ende', 'endzeit', 'end', 'Ende') ? isoOrNow(pick(r, 'ende', 'endzeit', 'end', 'Ende')) : null,
    kalender: String(pick(r, 'kalender', 'calendar', 'kategorie', 'Kalender') ?? '').trim(),
    ersteller: String(pick(r, 'ersteller', 'organizer', 'autor') ?? '').trim(),
    roh: r,
  };
}

export const alamosConnector: Connector = {
  id: 'alamos',
  name: 'Alamos FE2',
  kind: 'Alarmierung · Webhook + iCal',
  group: 'Alarmierung',
  description: 'Einsätze aus dem FE2-Alarmablauf empfangen und Termine aus dem FE2-Kalender (iCal-Export) übernehmen.',
  monogram: 'FE2',
  color: '#DC2626',
  needsConnection: false,
  setupMinutes: 5,
  fields: [{ key: 'label', type: 'text', label: 'Bezeichnung', placeholder: 'FE2 Gerätehaus', help: 'Nur zur Orientierung.' }],
  secretFields: [
    {
      key: 'icsUrl',
      type: 'secret',
      label: 'iCal-Export-Adresse',
      help: 'In FE2: Kalender → iCal-Export → Link kopieren. Die Adresse enthält einen Zugriffsschlüssel und wird verschlüsselt gespeichert.',
    },
  ],
  securityNotes: [
    'Einsatzdaten kommen per Push aus FE2 – LifeLink greift nicht auf die FE2-Datenbank zu.',
    'Nur freigegebene Felder weiterverwenden; Personendaten nicht an öffentliche Ziele senden.',
  ],
  testInfo: ['iCal-Export abrufen', 'Kalenderdaten lesen'],
  async test(conn) {
    const t0 = Date.now();
    if (!conn.secrets.icsUrl) return [{ label: 'iCal-Export', ok: true, ms: 0, message: 'Kein iCal-Export hinterlegt (nur Einsätze per Push)' }];
    try {
      const events = await fetchCalendar(conn, 'Europe/Berlin', 30);
      return [
        { label: 'iCal-Export abrufen', ok: true, ms: Date.now() - t0 },
        { label: 'Kalender lesen', ok: true, ms: 0, message: `${events.length} Termine in den nächsten 30 Tagen` },
      ];
    } catch (e) {
      return [{ label: 'iCal-Export abrufen', ok: false, ms: Date.now() - t0, message: (e as Error).message }];
    }
  },
  help: 'Siehe Hilfe → „Alamos FE2 anbinden“: Im FE2-Alarmablauf ein HTTP-/Webhook-Plugin auf die LifeLink-Adresse des Triggers „Alamos-Einsatz“ zeigen lassen.',
};

export async function fetchCalendar(conn: RuntimeConnection, tz: string, horizonDays: number): Promise<IcsEvent[]> {
  const url = conn.secrets.icsUrl;
  if (!url) throw new StepError('config', 'In der Alamos-Verbindung ist keine iCal-Adresse hinterlegt.');
  const res = await httpRequest({
    method: 'GET',
    url: url.replace(/^webcal:/i, 'https:'),
    timeoutMs: 30_000,
    maxResponseBytes: 10_000_000,
    allowPrivateHosts: conn.config.allowPrivate ? [new URL(url.replace(/^webcal:/i, 'https:')).hostname] : [],
  });
  const err = classifyStatus(res, 'FE2-Kalender');
  if (err) throw err;
  const text = res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new StepError('invalid_payload', 'Die Adresse liefert keinen iCal-Kalender.');
  const now = Date.now();
  return parseIcs(text, { defaultTz: tz, windowStart: now - 86_400_000, windowEnd: now + horizonDays * 86_400_000 });
}

export function calendarEventHash(e: IcsEvent): string {
  return sha256Hex(JSON.stringify([e.title, e.start, e.end, e.location, e.description, e.status])).slice(0, 16);
}

export const alamosAlarmTrigger: NodeType = {
  type: 'alamos.alarm',
  category: 'trigger',
  title: 'Alamos-Einsatz',
  description: 'Startet bei jedem Einsatz, den FE2 aus dem Alarmablauf an LifeLink sendet.',
  icon: 'Siren',
  trigger: 'webhook',
  fields: [
    {
      key: 'kind',
      type: 'select',
      label: 'Art der Daten',
      default: 'alarm',
      options: [
        { value: 'alarm', label: 'Einsatz / Alarm' },
        { value: 'calendar', label: 'Kalendereintrag (Push aus FE2)' },
      ],
    },
    { key: 'keywordFilter', type: 'text', label: 'Nur Stichworte (Komma-Liste, beginnt mit)', placeholder: 'B, TH', advanced: true, help: 'Leer = alle Einsätze. Filtert schon beim Empfang.' },
    { key: 'calendarFilter', type: 'text', label: 'Nur Kalender', advanced: true, showIf: { key: 'kind', equals: 'calendar' } },
    { key: 'dedupMinutes', type: 'number', label: 'Duplikate ignorieren (Minuten)', default: 30, min: 0, max: 1440, advanced: true, help: 'Gleiche Einsatznummer innerhalb dieser Zeit startet keinen zweiten Lauf.' },
  ],
  outputs: [{ id: 'out', label: 'Ausgang' }],
  outputFields: [
    { path: 'einsatz_id', type: 'text', description: 'Einsatznummer / externe ID' },
    { path: 'stichwort', type: 'text', description: 'Stichwort, z. B. B3' },
    { path: 'stichwort_text', type: 'text', description: 'Meldebild / Stichworttext' },
    { path: 'meldung', type: 'text', description: 'Meldung / Freitext' },
    { path: 'ort', type: 'text', description: 'Einsatzort (zusammengesetzt)' },
    { path: 'stadt', type: 'text', description: 'Stadt' },
    { path: 'ortsteil', type: 'text', description: 'Ortsteil' },
    { path: 'einheiten', type: 'list', description: 'Alarmierte Einheiten' },
    { path: 'alarmzeit', type: 'date', description: 'Alarmzeit (UTC)' },
    { path: 'roh', type: 'object', description: 'Unveränderte FE2-Daten' },
  ],
  sampleOutput: normalizeAlarm({ einsatznummer: 'E-2026-0815', stichwort: 'B3', meldebild: 'Wohnungsbrand', strasse: 'Hauptstraße', hausnummer: '12', plz: '65835', ort: 'Musterstadt', einheiten: ['HLF 1', 'DLK'], alarmzeit: '2026-10-29T16:08:00Z' }),
  async execute(ctx) {
    return { output: ctx.data[ctx.node.key] };
  },
  help: 'FE2 schickt die Einsatzdaten per HTTP-POST (JSON) an die Adresse dieses Triggers. Der Zugriffsschlüssel steht im Header „X-LifeLink-Token“ oder „Authorization: Bearer …“.',
};

export const alamosCalendarTrigger: NodeType = {
  type: 'alamos.calendar',
  category: 'trigger',
  title: 'Alamos-Kalender (iCal)',
  description: 'Prüft regelmäßig den FE2-Kalender und startet bei neuen, geänderten, abgesagten oder bald beginnenden Terminen.',
  icon: 'CalendarDays',
  connector: 'alamos',
  trigger: 'ics',
  fields: [
    { key: 'intervalMinutes', type: 'number', label: 'Prüfen alle (Minuten)', default: 15, min: 5, max: 1440, help: 'FE2 erzeugt den Export etwa alle 2 Stunden neu – öfter als alle 15 Minuten bringt wenig.' },
    {
      key: 'events',
      type: 'multiselect',
      label: 'Starten bei',
      default: ['new', 'changed', 'deleted'],
      options: [
        { value: 'new', label: 'Neuer Termin' },
        { value: 'changed', label: 'Geänderter Termin' },
        { value: 'deleted', label: 'Abgesagt / gelöscht' },
        { value: 'starting', label: 'Termin beginnt bald' },
      ],
    },
    { key: 'leadMinutes', type: 'number', label: 'Vorlauf (Minuten)', default: 60, min: 1, max: 10080, showIf: { key: 'events', equals: 'starting' } },
    { key: 'horizonDays', type: 'number', label: 'Zeitraum (Tage voraus)', default: 60, min: 1, max: 365, advanced: true },
    { key: 'titleFilter', type: 'text', label: 'Nur Termine mit Titel (enthält)', advanced: true },
  ],
  outputs: [{ id: 'out', label: 'Ausgang' }],
  outputFields: [
    { path: 'aenderung', type: 'text', description: 'neu, geaendert, geloescht oder beginnt_bald' },
    { path: 'titel', type: 'text', description: 'Titel des Termins' },
    { path: 'beschreibung', type: 'text', description: 'Beschreibung' },
    { path: 'ort', type: 'text', description: 'Ort' },
    { path: 'beginn', type: 'date', description: 'Beginn (UTC)' },
    { path: 'ende', type: 'date', description: 'Ende (UTC)' },
    { path: 'ganztaegig', type: 'boolean', description: 'Ganztägig?' },
    { path: 'kategorien', type: 'list', description: 'Kategorien' },
    { path: 'uid', type: 'text', description: 'Termin-ID' },
  ],
  sampleOutput: { aenderung: 'neu', titel: 'Übungsdienst', beschreibung: 'Thema: Atemschutz', ort: 'Gerätehaus', beginn: '2026-11-02T18:30:00.000Z', ende: '2026-11-02T20:30:00.000Z', ganztaegig: false, kategorien: ['Übung'], uid: 'abc@fe2' },
  async execute(ctx) {
    return { output: ctx.data[ctx.node.key] };
  },
};
