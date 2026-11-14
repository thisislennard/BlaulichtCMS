/* Gemeinsame Hilfen für Lauf-Darstellungen (Dashboard, Workflow-Übersicht, Ausführungsverlauf). */
import { useEffect, useState } from 'react';
import type { Catalog } from '../../api/types';
import { cx, RUN_STATUS, type Tone } from '../../components/ui/core';
import { fmtDate, fmtTime } from '../../lib/format';

export const ACTIVE_RUN = ['queued', 'running', 'waiting'];
export const FAILED_RUN = ['error', 'dead', 'needs_review'];

const DOT: Record<Tone, string> = {
  success: 'bg-ok',
  error: 'bg-err',
  warning: 'bg-warn',
  neutral: 'bg-fg-muted',
  primary: 'bg-fg-link',
  cyan: 'bg-cyan',
};
const TEXT: Record<Tone, string> = {
  success: 'text-ok',
  error: 'text-err',
  warning: 'text-warn',
  neutral: 'text-fg-muted',
  primary: 'text-fg-link',
  cyan: 'text-cyan',
};

export function runTone(status: string): Tone {
  return RUN_STATUS[status]?.tone ?? 'neutral';
}
export function runLabel(status: string): string {
  return RUN_STATUS[status]?.label ?? status;
}
export function toneDot(tone: Tone) {
  return DOT[tone];
}
export function toneText(tone: Tone) {
  return TEXT[tone];
}

/** Statuspunkt (dekorativ) – Text daneben oder sr-only liefert die Bedeutung. */
export function StatusDot({ status, className }: { status: string; className?: string }) {
  const s = RUN_STATUS[status];
  return <span aria-hidden="true" className={cx('inline-block w-2 h-2 rounded-full shrink-0', DOT[runTone(status)], s?.pulse && 'll-pulse', className)} />;
}

/** Icon und lesbarer Name für einen Auslöser-Typ aus dem Katalog. */
export function triggerInfo(catalog: Catalog | undefined, kind: string | null | undefined): { icon: string; title: string } {
  const n = kind ? catalog?.nodes.find((x) => x.type === kind) : undefined;
  if (n) return { icon: n.icon, title: n.title };
  const k = kind ?? '';
  if (k.includes('alamos')) return { icon: 'Siren', title: 'Alamos' };
  if (k.includes('schedule')) return { icon: 'CalendarClock', title: 'Zeitplan' };
  if (k.includes('webhook')) return { icon: 'Webhook', title: 'Webhook' };
  if (k.includes('mail') || k.includes('imap')) return { icon: 'Mail', title: 'E-Mail' };
  if (k.includes('mqtt')) return { icon: 'RadioTower', title: 'MQTT' };
  if (k.includes('manual')) return { icon: 'MousePointerClick', title: 'Manuell' };
  return { icon: 'Zap', title: k || '–' };
}

/** Uhrzeit für heute, sonst Datum + Uhrzeit (kurz). */
export function fmtWhen(v: string | null | undefined, seconds = false): string {
  if (!v) return '–';
  const today = fmtDate(new Date()) === fmtDate(v);
  return today ? fmtTime(v, seconds) : `${fmtDate(v).slice(0, 6)} ${fmtTime(v)}`;
}

/** Re-render in festem Takt (für relative Zeitangaben). */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Ist gerade ein Eingabefeld fokussiert (dann keine Einzeltasten-Kürzel)? */
export function isTypingTarget(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  if (!e) return false;
  const tag = e.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.isContentEditable || !!e.closest?.('[role="dialog"],[role="menu"]');
}
