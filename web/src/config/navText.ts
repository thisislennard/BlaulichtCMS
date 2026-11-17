import { t } from '../i18n';
import { navGroupOf, navItem } from './navigation';

/**
 * Menüpfad als Text für Hinweise („Einrichtung → Stichwörter & Regeln“), optional mit Reiter oder Abschnitt
 * („Einstellungen → Datenschutz“). Hinweise verwenden diese Funktion statt fest geschriebener Bezeichnungen, damit
 * sie bei einer Umbenennung im Menü mitgehen (#257).
 */
export function navTrail(id: string, ...more: string[]): string {
  const it = navItem(id);
  if (!it) throw new Error(`Unbekannter Menüpunkt: ${id}`);
  const group = navGroupOf(id);
  return [group ? t(group) : '', t(it.label), ...more].filter(Boolean).join(' → ');
}

/** Nur die Menübezeichnung (ohne Bereich), z. B. für Linktexte. */
export function navLabel(id: string): string {
  const it = navItem(id);
  if (!it) throw new Error(`Unbekannter Menüpunkt: ${id}`);
  return t(it.label);
}
