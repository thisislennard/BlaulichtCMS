/**
 * Verträge für Nodes (Workflow-Bausteine) und Konnektoren (Integrationen).
 * Palette, Integrationskarten, Assistent, Node-Panel und Hilfe werden aus diesen Manifesten erzeugt.
 */

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'switch'
  | 'secret'
  | 'url'
  | 'host'
  | 'port'
  | 'variableText'
  | 'variableTextarea'
  | 'color'
  | 'duration'
  | 'multiselect'
  | 'json'
  | 'conditions'
  | 'mappings'
  | 'keyvalue'
  | 'list'
  | 'cases'
  | 'cron'
  | 'timezone'
  | 'wpPages';

export interface FieldOption {
  value: string;
  label: string;
  hint?: string;
}

export interface Field {
  key: string;
  type: FieldType;
  label: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  default?: unknown;
  options?: FieldOption[];
  /** Erscheint unter „Erweiterte Optionen“ (eingeklappt). */
  advanced?: boolean;
  showIf?: { key: string; equals: unknown | unknown[] };
  min?: number;
  max?: number;
  /** Bei Typ duration: Einheit der gespeicherten Zahl. */
  unit?: 'seconds' | 'minutes';
  /** Für Hilfe/Validierung: Darf die Vorlage Variablen enthalten? */
  allowVariables?: boolean;
}

export type Category = 'trigger' | 'condition' | 'data' | 'action' | 'control';

export const CATEGORY_LABELS: Record<Category, string> = {
  trigger: 'Trigger',
  condition: 'Bedingungen',
  data: 'Datenverarbeitung',
  action: 'Aktionen',
  control: 'Steuerung',
};

export interface GraphNode {
  id: string;
  type: string;
  /** Eindeutiger, lesbarer Schlüssel für Variablen: {{ key.feld }} */
  key: string;
  name: string;
  position: { x: number; y: number };
  config: Record<string, any>;
  settings?: NodeSettings;
  connectionId?: string | null;
  disabled?: boolean;
  notes?: string;
}

export interface NodeSettings {
  retries?: number;
  retryDelaySec?: number;
  timeoutSec?: number;
  onError?: 'stop' | 'continue';
}

export interface GraphEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewport?: { x: number; y: number; zoom: number };
}

export interface PortDef {
  id: string;
  label: string;
}

export interface OutputField {
  path: string;
  type: 'text' | 'number' | 'boolean' | 'date' | 'list' | 'object';
  description: string;
  example?: unknown;
}

export interface RuntimeConnection {
  id: string;
  name: string;
  connector: string;
  config: Record<string, any>;
  secrets: Record<string, string>;
}

export interface ExecContext {
  run: { id: number; mode: 'production' | 'test'; simulate: boolean; correlationId: string; startedAt: string; workflowId: string; workflowName: string };
  node: GraphNode;
  /** Variablen-Kontext: { trigger, <nodeKey>: Ausgabe, run } */
  data: Record<string, unknown>;
  render(tpl: string | undefined | null, esc?: 'none' | 'html' | 'json' | 'url'): string;
  renderValue(tpl: string | undefined | null): unknown;
  connection: RuntimeConnection | null;
  timeoutMs: number;
  idempotencyKey: string;
  attempt: number;
  log(message: string): void;
}

export interface NodeResult {
  output: unknown;
  port?: string;
  externalRef?: string;
  statusText?: string;
  /** Nur Steuerung „Warten“: Lauf pausiert bis zu diesem Zeitpunkt. */
  waitUntil?: number;
  /** Nur „Lauf beenden“: Status des Laufs. */
  stopRun?: 'success' | 'error';
}

export type TriggerKind = 'webhook' | 'schedule' | 'manual' | 'mqtt' | 'imap' | 'ics';

export interface NodeType {
  type: string;
  category: Category;
  title: string;
  description: string;
  /** lucide-Icon-Name */
  icon: string;
  /** Konnektor, dessen Verbindung der Node braucht. */
  connector?: string;
  connectionOptional?: boolean;
  fields: Field[];
  outputs: PortDef[] | ((config: Record<string, any>) => PortDef[]);
  outputFields?: OutputField[];
  sampleOutput?: unknown;
  /** Verändert der Node externe Systeme? (Aktionen) */
  sideEffect?: boolean;
  /** Ist eine Wiederholung ohne Doppelwirkung möglich? */
  idempotent?: boolean | ((config: Record<string, any>) => boolean);
  trigger?: TriggerKind;
  /** Felder, deren Werte als Empfänger/Ziele in der Veröffentlichungsvorschau erscheinen. */
  targetFields?: string[];
  validate?(config: Record<string, any>, node: GraphNode): string[];
  execute(ctx: ExecContext): Promise<NodeResult>;
  /** Testlauf ohne Seiteneffekte: beschreibt, was passieren würde. */
  simulate?(ctx: ExecContext): Promise<NodeResult>;
  /** Markdown-Hilfe für die Hilfeseite */
  help?: string;
}

export interface TestStep {
  label: string;
  ok: boolean;
  ms: number;
  message?: string;
}

export interface Connector {
  id: string;
  name: string;
  /** z. B. „Alarmierung · REST + Webhook“ */
  kind: string;
  group: 'Alarmierung' | 'Website' | 'E-Mail' | 'Nachrichten' | 'IoT' | 'Allgemein';
  description: string;
  monogram: string;
  /** Markenfarbe für das Monogramm (Hex) */
  color: string;
  fields: Field[];
  secretFields: Field[];
  /** Zeigt die Integration ohne gespeicherte Verbindung als „Verfügbar“ an */
  needsConnection: boolean;
  /** Wie lange dauert die Einrichtung etwa? */
  setupMinutes: number;
  securityNotes: string[];
  testInfo: string[];
  test?(conn: RuntimeConnection): Promise<TestStep[]>;
  help?: string;
}
