/** Fehlerklassen – bestimmen, ob automatisch wiederholt werden darf. */
export type ErrorClass =
  | 'auth'
  | 'permission'
  | 'invalid_payload'
  | 'rate_limit'
  | 'transient'
  | 'conflict'
  | 'timeout_unknown'
  | 'config'
  | 'internal';

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'invalid_request', msg, details);
export const notFound = (msg = 'Nicht gefunden.') => new AppError(404, 'not_found', msg);
export const forbidden = (msg = 'Dafür fehlt die Berechtigung.') => new AppError(403, 'forbidden', msg);
export const conflict = (msg: string, details?: unknown) => new AppError(409, 'conflict', msg, details);
export const unauthorized = (msg = 'Bitte anmelden.') => new AppError(401, 'unauthorized', msg);

/** Fehler eines Konnektors/Nodes während der Ausführung. */
export class StepError extends Error {
  errorClass: ErrorClass;
  /** Wurde die externe Anfrage evtl. schon verarbeitet? (Timeout nach dem Senden) */
  sideEffectUnknown: boolean;
  retryAfterMs?: number;
  hint?: string;
  technical?: string;
  constructor(
    errorClass: ErrorClass,
    message: string,
    opts: { hint?: string; technical?: string; retryAfterMs?: number; sideEffectUnknown?: boolean } = {},
  ) {
    super(message);
    this.errorClass = errorClass;
    this.hint = opts.hint;
    this.technical = opts.technical;
    this.retryAfterMs = opts.retryAfterMs;
    this.sideEffectUnknown = opts.sideEffectUnknown ?? errorClass === 'timeout_unknown';
  }
}

export const ERROR_CLASS_LABELS: Record<ErrorClass, string> = {
  auth: 'Anmeldung beim Zielsystem fehlgeschlagen',
  permission: 'Berechtigung im Zielsystem fehlt',
  invalid_payload: 'Ungültige Daten',
  rate_limit: 'Zu viele Anfragen (Rate-Limit)',
  transient: 'Vorübergehender Netzwerk- oder Serverfehler',
  conflict: 'Konflikt im Zielsystem',
  timeout_unknown: 'Zeitüberschreitung – Ergebnis unklar',
  config: 'Konfigurationsfehler',
  internal: 'Interner Fehler',
};

/** Darf nach dieser Fehlerklasse automatisch erneut versucht werden? */
export function isRetryableClass(c: ErrorClass): boolean {
  return c === 'transient' || c === 'rate_limit';
}

export function toStepError(err: unknown): StepError {
  if (err instanceof StepError) return err;
  const e = err as NodeJS.ErrnoException;
  const code = e?.code ?? '';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code)) {
    return new StepError('transient', 'Das Zielsystem ist nicht erreichbar.', { technical: `${code}: ${e.message}` });
  }
  if (code === 'ETIMEDOUT' || e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new StepError('timeout_unknown', 'Zeitüberschreitung beim Zielsystem.', { technical: e.message });
  }
  return new StepError('internal', 'Unerwarteter Fehler bei der Ausführung.', { technical: e?.message ?? String(err) });
}
