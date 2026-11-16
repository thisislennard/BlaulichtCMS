/**
 * Katalog der Automationen: Arten von Eingängen (Auslöser) und Ausgängen (Aktionen), Verarbeitungsknoten und die
 * Datenfelder, die ein Eingang liefert. Die Felder sind die einzige Grundlage für Platzhalter und Bedingungen – ein
 * Ablauf kann nur mit Feldern arbeiten, die hier stehen (bei FE2/Feuersoftware genau die Allowlist der Verbindung).
 */

export type FieldType = 'text' | 'number' | 'datetime' | 'choice' | 'url' | 'bool';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  example: string;
  /** Werte bei Auswahlfeldern */
  options?: string[];
}

export type InputKind = 'fe2' | 'feuersoftware' | 'warnfeed' | 'rss' | 'upload' | 'schedule' | 'manual';
export type OutputKind = 'banner' | 'post' | 'mail' | 'notify' | 'warning_draft';
export type NodeType = 'input' | 'output' | 'condition' | 'switch' | 'template' | 'delay' | 'dedup' | 'approval' | 'merge';

export const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** Felder, die in jedem Lauf zur Verfügung stehen. */
export const SYSTEM_FIELDS: FieldDef[] = [
  { key: 'automation', label: 'Name des Workflows', type: 'text', example: 'Einsatzentwurf aus FE2' },
  { key: 'lauf', label: 'Lauf-Kennung (kurz)', type: 'text', example: '3f2a9c1d' },
  { key: 'jetzt', label: 'Zeitpunkt des Laufs', type: 'datetime', example: '2026-11-16T07:00:00.000Z' },
];

const INCIDENT_FIELDS: FieldDef[] = [
  { key: 'vorgang', label: 'Vorgang', type: 'choice', example: 'neu', options: ['neu', 'aktualisierung', 'beendet'] },
  { key: 'stichwort', label: 'Stichwort', type: 'text', example: 'B2' },
  { key: 'stichwort_text', label: 'Stichwort (Klartext)', type: 'text', example: 'Brand Wohngebäude' },
  { key: 'stichwort_kategorie', label: 'Stichwort-Kategorie (Stichwortverzeichnis)', type: 'text', example: 'Brand' },
  { key: 'einsatzart', label: 'Einsatzart', type: 'text', example: 'Brand' },
  { key: 'ort', label: 'Gemeinde/Ort', type: 'text', example: 'Musterstadt' },
  { key: 'ortsteil', label: 'Ortsteil', type: 'text', example: 'Nord' },
  { key: 'alarmzeit', label: 'Alarmzeit', type: 'datetime', example: '2026-11-16T06:12:00.000Z' },
  { key: 'einheiten', label: 'Eingesetzte Einheiten', type: 'text', example: 'HLF 1, DLK' },
  { key: 'status', label: 'Status (offen/beendet)', type: 'text', example: 'offen' },
  { key: 'quelle', label: 'Quelle', type: 'text', example: 'FE2' },
  { key: 'verbindung', label: 'Name der Verbindung', type: 'text', example: 'FE2 Leitstelle' },
  { key: 'entwurf_link', label: 'Link zum automatischen Einsatzentwurf', type: 'url', example: '/beitraege/…' },
];

export const INPUT_KINDS: Record<InputKind, { label: string; description: string; icon: string; source?: 'connection' | 'feed' | 'collection'; connectionKind?: string; phases?: { value: string; label: string }[]; fields: FieldDef[] }> = {
  fe2: {
    label: 'FE2-Alarm',
    description: 'Einsatzmeldung aus einer aktiven FE2-Verbindung (nur die Felder der Allowlist).',
    icon: 'Siren',
    source: 'connection',
    connectionKind: 'fe2',
    phases: [
      { value: 'neu', label: 'Neuer Einsatz' },
      { value: 'aktualisierung', label: 'Aktualisierung' },
      { value: 'beendet', label: 'Einsatz beendet' },
    ],
    fields: INCIDENT_FIELDS,
  },
  feuersoftware: {
    label: 'Feuersoftware-Einsatz',
    description: 'Einsatz aus einer aktiven Verbindung zu Feuersoftware Connect (gleiche Felder wie FE2).',
    icon: 'Siren',
    source: 'connection',
    connectionKind: 'feuersoftware',
    phases: [
      { value: 'neu', label: 'Neuer Einsatz' },
      { value: 'aktualisierung', label: 'Aktualisierung' },
      { value: 'beendet', label: 'Einsatz beendet' },
    ],
    fields: INCIDENT_FIELDS.map((f) => (f.key === 'quelle' ? { ...f, example: 'Feuersoftware Connect' } : f)),
  },
  warnfeed: {
    label: 'Amtliche Warnung',
    description: 'Neue, aktualisierte oder aufgehobene Warnung aus einer aktiven Warnfeed-Verbindung (NINA/CAP).',
    icon: 'AlertTriangle',
    source: 'connection',
    connectionKind: 'warnfeed',
    phases: [
      { value: 'neu', label: 'Neue Warnung' },
      { value: 'aktualisierung', label: 'Aktualisierung' },
      { value: 'entwarnung', label: 'Entwarnung (Aufhebung)' },
    ],
    fields: [
      { key: 'vorgang', label: 'Vorgang', type: 'choice', example: 'neu', options: ['neu', 'aktualisierung', 'entwarnung'] },
      { key: 'ereignis', label: 'Ereignis', type: 'text', example: 'Sturmböen' },
      { key: 'ueberschrift', label: 'Überschrift', type: 'text', example: 'Amtliche Unwetterwarnung vor Orkanböen' },
      { key: 'beschreibung', label: 'Beschreibung (gekürzt)', type: 'text', example: 'Es treten Orkanböen mit Geschwindigkeiten um 120 km/h auf.' },
      { key: 'verhalten', label: 'Verhaltenshinweise (gekürzt)', type: 'text', example: 'Gebäude nicht verlassen.' },
      { key: 'stufe', label: 'Stufe (1 gering … 4 extrem)', type: 'number', example: '3' },
      { key: 'schwere', label: 'Schwere (CAP)', type: 'choice', example: 'Severe', options: ['Minor', 'Moderate', 'Severe', 'Extreme', 'Unknown'] },
      { key: 'dringlichkeit', label: 'Dringlichkeit (CAP)', type: 'text', example: 'Immediate' },
      { key: 'gebiete', label: 'Gebiete', type: 'text', example: 'Kreis Musterland' },
      { key: 'gueltig_bis', label: 'Gültig bis', type: 'datetime', example: '2026-11-16T18:00:00.000Z' },
      { key: 'quelle', label: 'Herausgebende Stelle', type: 'text', example: 'Deutscher Wetterdienst' },
      { key: 'link', label: 'Link zur Originalquelle', type: 'url', example: 'https://warnung.bund.de/' },
      { key: 'im_gebiet', label: 'Im eigenen Gebiet', type: 'choice', example: 'ja', options: ['ja', 'nein'] },
    ],
  },
  rss: {
    label: 'RSS-Eintrag',
    description: 'Neuer Eintrag einer Quelle unter Redaktion → Quellen.',
    icon: 'Newspaper',
    source: 'feed',
    fields: [
      { key: 'titel', label: 'Titel', type: 'text', example: 'Pressemitteilung der Stadt' },
      { key: 'link', label: 'Link', type: 'url', example: 'https://example.org/meldung' },
      { key: 'zusammenfassung', label: 'Zusammenfassung', type: 'text', example: 'Kurzer Anrisstext …' },
      { key: 'veroeffentlicht', label: 'Veröffentlicht', type: 'datetime', example: '2026-11-16T05:30:00.000Z' },
      { key: 'quelle', label: 'Name der Quelle', type: 'text', example: 'Stadt Musterstadt' },
    ],
  },
  upload: {
    label: 'Neue Uploads',
    description: 'Neue geprüfte Dateien über einen Upload-Link einer Sammlung – gebündelt je Zeitfenster.',
    icon: 'UploadCloud',
    source: 'collection',
    fields: [
      { key: 'sammlung', label: 'Sammlung', type: 'text', example: 'Hochwasser Nord' },
      { key: 'sammlung_link', label: 'Link zur Sammlung', type: 'url', example: '/medien/…' },
      { key: 'link_bezeichnung', label: 'Bezeichnung des Upload-Links', type: 'text', example: 'Aushang Rathaus' },
      { key: 'anzahl', label: 'Neue Dateien im Zeitfenster', type: 'number', example: '3' },
    ],
  },
  schedule: {
    label: 'Zeitplan',
    description: 'Täglich zu einer Uhrzeit (wahlweise nur an bestimmten Wochentagen) oder alle N Minuten.',
    icon: 'CalendarClock',
    fields: [
      { key: 'zeitpunkt', label: 'Geplanter Zeitpunkt', type: 'datetime', example: '2026-11-16T06:00:00.000Z' },
      { key: 'offene_beitraege', label: 'Beiträge zur Freigabe', type: 'number', example: '2' },
      { key: 'offene_beitraege_liste', label: 'Titel der Beiträge zur Freigabe', type: 'text', example: '– Brand in Nord\n– Übung am Samstag' },
      { key: 'offene_banner', label: 'Banner zur Freigabe', type: 'number', example: '1' },
      { key: 'offene_warnentwuerfe', label: 'Warnentwürfe zur Freigabe', type: 'number', example: '0' },
      { key: 'offene_automationsfreigaben', label: 'Offene Freigaben aus Workflows', type: 'number', example: '0' },
    ],
  },
  manual: {
    label: 'Manueller Start',
    description: 'Start per Knopf im Workflow – mit eigenen Feldern, die beim Start ausgefüllt werden.',
    icon: 'MousePointerClick',
    fields: [{ key: 'gestartet_von', label: 'Gestartet von', type: 'text', example: 'Alex Beispiel' }],
  },
};

export const OUTPUT_KINDS: Record<OutputKind, { label: string; description: string; icon: string; directCapable: boolean; produces: FieldDef[] }> = {
  banner: {
    label: 'Banner',
    description: 'Banner-Entwurf im eingestellten Stil (zur Freigabe eingereicht) – je Website ein Banner.',
    icon: 'Megaphone',
    directCapable: true,
    produces: [{ key: 'banner_link', label: 'Link zu den Bannern', type: 'url', example: '/banner' }],
  },
  post: {
    label: 'Beitrag',
    description: 'Beitragsentwurf aus einer Vorlage mit Texten je Kanal und vorausgewählten sozialen Kanälen (auch als Story oder zum Teilen von Hand), optional zur Freigabe eingereicht.',
    icon: 'FileText',
    directCapable: true,
    produces: [
      { key: 'beitrag_link', label: 'Link zum Beitrag', type: 'url', example: '/beitraege/…' },
      { key: 'beitrag_titel', label: 'Titel des Beitrags', type: 'text', example: 'Brand in Musterstadt' },
    ],
  },
  mail: {
    label: 'E-Mail',
    description: 'E-Mail über den eingerichteten Mailserver an Rollen oder hinterlegte Zuständigkeiten.',
    icon: 'Mail',
    directCapable: true,
    produces: [],
  },
  notify: {
    label: 'App-Benachrichtigung',
    description: 'Benachrichtigung in BlaulichtCMS an Rollen oder einzelne Personen.',
    icon: 'Bell',
    directCapable: false,
    produces: [],
  },
  warning_draft: {
    label: 'Warnentwurf vorbereiten',
    description: 'Warnentwurf mit vorausgefüllten Feldern – Warnstufe, Freigabe und Versand bleiben bei Menschen.',
    icon: 'Siren',
    directCapable: false,
    produces: [
      { key: 'warnentwurf_link', label: 'Link zum Warnentwurf', type: 'url', example: '/warnungen/…' },
      { key: 'warnentwurf_nr', label: 'Vorgangsnummer', type: 'text', example: 'W-2026-0007' },
    ],
  },
};

export const NODE_TYPES: Record<NodeType, { label: string; category: 'input' | 'process' | 'output'; description: string; icon: string }> = {
  input: { label: 'Eingang', category: 'input', description: 'Auslöser aus der Liste der Eingänge.', icon: 'Zap' },
  output: { label: 'Ausgang', category: 'output', description: 'Aktion aus der Liste der Ausgänge.', icon: 'Send' },
  condition: { label: 'Bedingung', category: 'process', description: 'Prüft Felder und verzweigt nach „trifft zu“ und „trifft nicht zu“.', icon: 'Filter' },
  switch: { label: 'Verzweigung', category: 'process', description: 'Wählt den Weg nach dem Wert eines Feldes.', icon: 'Split' },
  template: { label: 'Felder setzen', category: 'process', description: 'Legt neue Felder aus Textvorlagen mit {{platzhaltern}} an.', icon: 'TextCursorInput' },
  delay: { label: 'Warten', category: 'process', description: 'Wartet eine feste Zeit (höchstens 24 Stunden).', icon: 'Hourglass' },
  dedup: { label: 'Einmal je Vorgang', category: 'process', description: 'Lässt je Schlüssel nur den ersten Lauf im Zeitfenster durch.', icon: 'CopyPlus' },
  approval: { label: 'Freigabe anfordern', category: 'process', description: 'Hält den Lauf an, bis eine Person freigibt oder ablehnt.', icon: 'ShieldCheck' },
  merge: { label: 'Zusammenführen', category: 'process', description: 'Führt Wege wieder zusammen.', icon: 'GitBranch' },
};

/** Grenzen gegen Schleifen und Fluten. */
export const LIMITS = {
  maxNodes: 60,
  maxEdges: 150,
  maxDelayMinutes: 24 * 60,
  maxDedupMinutes: 7 * 24 * 60,
  maxApprovalHours: 72,
  minIntervalMinutes: 15,
  maxConditionRules: 20,
  maxTemplateLength: 5000,
  maxCases: 12,
};

/** Bedingungs-Operatoren. */
export const OPERATORS = {
  eq: 'ist gleich',
  neq: 'ist nicht gleich',
  contains: 'enthält',
  not_contains: 'enthält nicht',
  starts_with: 'beginnt mit',
  in: 'ist eines von (Liste)',
  gte: 'ist mindestens (Zahl)',
  lte: 'ist höchstens (Zahl)',
  exists: 'ist ausgefüllt',
  not_exists: 'ist leer',
} as const;
export type Operator = keyof typeof OPERATORS;

/** Ausgangs-Ports eines Knotens (Kanten starten hier). */
export function outputPorts(node: { type: string; data?: any }): { id: string; label: string }[] {
  switch (node.type) {
    case 'condition':
      return [
        { id: 'true', label: 'trifft zu' },
        { id: 'false', label: 'trifft nicht zu' },
      ];
    case 'switch':
      return [...((node.data?.cases ?? []) as { id: string; value: string }[]).map((c) => ({ id: `case:${c.id}`, label: c.value || '(leer)' })), { id: 'default', label: 'sonst' }];
    case 'approval':
      return [
        { id: 'approved', label: 'freigegeben' },
        { id: 'rejected', label: 'abgelehnt' },
      ];
    case 'output':
      return [{ id: 'out', label: 'danach' }];
    default:
      return [{ id: 'out', label: 'weiter' }];
  }
}

export function hasInputPort(type: string): boolean {
  return type !== 'input';
}
