import type { PressRequest } from './shared';

/** Zusatzdaten der Detailansicht (Mails, Antworten – #205/#206). */
export interface PressDetailExtras {
  messages?: unknown[];
}

/** Mail-Verlauf einer Anfrage (#205/#206). */
export function PressMessages(_props: { request: PressRequest; detail: PressDetailExtras; onChange: () => void }) {
  return null;
}
