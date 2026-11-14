/* Typen der API-Antworten (Spiegel von server/src). */

export type Category = 'trigger' | 'condition' | 'data' | 'action' | 'control';

export interface FieldOption {
  value: string;
  label: string;
  hint?: string;
}

export interface Field {
  key: string;
  type:
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
  label: string;
  help?: string;
  placeholder?: string;
  required?: boolean;
  default?: any;
  options?: FieldOption[];
  advanced?: boolean;
  showIf?: { key: string; equals: any };
  min?: number;
  max?: number;
  unit?: 'seconds' | 'minutes';
}

export interface PortDef {
  id: string;
  label: string;
}

export interface OutputField {
  path: string;
  type: string;
  description: string;
}

export interface NodeTypeInfo {
  type: string;
  category: Category;
  title: string;
  description: string;
  icon: string;
  connector: string | null;
  connectionOptional: boolean;
  fields: Field[];
  outputs: PortDef[] | null;
  dynamicOutputs: boolean;
  outputFields: OutputField[];
  sampleOutput: any;
  sideEffect: boolean;
  idempotent: boolean | null;
  trigger: string | null;
  help: string | null;
}

export interface ConnectorInfo {
  id: string;
  name: string;
  kind: string;
  group: string;
  description: string;
  monogram: string;
  color: string;
  fields: Field[];
  secretFields: Field[];
  needsConnection: boolean;
  setupMinutes: number;
  securityNotes: string[];
  testInfo: string[];
  testable: boolean;
  help: string | null;
  nodes: string[];
}

export interface Catalog {
  categories: { id: Category; label: string }[];
  nodes: NodeTypeInfo[];
  connectors: ConnectorInfo[];
  operators: { id: string; label: string; unary?: boolean }[];
  filters: { name: string; args: string; description: string; example: string }[];
  bannerColors: { value: string; label: string; hex: string }[];
}

export interface GraphNode {
  id: string;
  type: string;
  key: string;
  name: string;
  position: { x: number; y: number };
  config: Record<string, any>;
  settings?: { retries?: number; retryDelaySec?: number; timeoutSec?: number; onError?: 'stop' | 'continue' };
  connectionId?: string | null;
  disabled?: boolean;
  notes?: string;
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

export type RunStatus = 'queued' | 'running' | 'waiting' | 'success' | 'error' | 'canceled' | 'dead' | 'needs_review';
export type StepStatus = 'running' | 'success' | 'error' | 'skipped' | 'waiting' | 'simulated';

export interface Me {
  stage: 'mfa' | 'mfa_setup' | 'full';
  user: { id: string; email: string; name: string; roles: string[]; totp_enabled: boolean; preferences: Preferences };
  permissions: string[];
  roleLabels: string[];
  instance: { name: string; subtitle: string; timezone: string; language: string };
  version: string;
  recoveryCodesLeft: number;
  mfaRequired: boolean;
  passwordMinLength: number;
}

export interface Preferences {
  theme?: 'dark' | 'light' | 'system';
  reducedMotion?: boolean;
  compactTables?: boolean;
  sidebarCollapsed?: boolean;
  language?: 'de' | 'en';
}

export interface Issue {
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
  field?: string;
}
