import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Design-Regel „ein Akzent“ (docs/design-leitstand.md §1, §2, §6; #270) als Prüfung über die Quellen der Oberfläche:
 * Rot gefüllt nur für Hauptaktionen, aktive Navigation, Zähler mit Handlungsbedarf und „Du bist dran“; Auswahl im
 * Muster „Rot zart + roter Rand“; der Badge-Ton „primary“ nur für laufende Vorgänge.
 */

const WEB = path.join(__dirname, '../../web/src');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Laufende Vorgänge – nur sie dürfen den Badge-Ton „primary“ tragen. */
const RUNNING = /^(running|sending|publishing|scheduled|sent|queued)$/;

/**
 * Dateien, in denen eine rot gefüllte Fläche gewollt ist: Hauptknopf und Schalter (Basiskomponenten), Zähler und
 * ungelesene Mitteilungen (Kopfzeile, untere Leiste am Handy, Mitteilungen), „Du bist dran“ (Dashboard), heutiger Tag im Kalender, gewähltes
 * Element im Bildvorlagen-Editor, Fortschritt auf der öffentlichen Upload-Seite.
 */
const FILLED_RED_ALLOWED = new Set([
  'components/ui/core.tsx',
  'components/layout/AppShell.tsx',
  'components/layout/MobileTabBar.tsx',
  'pages/Notifications.tsx',
  'pages/dashboard/widgets.tsx',
  'pages/calendar/views.tsx',
  'pages/designs/ImageTemplateEditor.tsx',
  'pages/public/UploadPage.tsx',
]);

/** Verstöße in einer Quelldatei (Text) – je Fund „Zeile: Ausschnitt“. */
function findings(file: string, src: string): string[] {
  const out: string[] = [];
  const at = (i: number, why: string) => out.push(`${file}:${src.slice(0, i).split('\n').length}: ${why}`);
  const lines = src.split('\n');
  let offset = 0;
  for (const text of lines) {
    // <Badge tone="primary"> bzw. tone={… 'primary'} – immer eine feste Kennzeichnung, kein laufender Vorgang
    if (/tone=(?:"primary"|\{[^}]*['"]primary['"])/.test(text)) at(offset, `Badge-Ton primary: ${text.trim().slice(0, 120)}`);
    // { tone: 'primary' } unter einem Schlüssel, der kein laufender Vorgang ist
    const keyed = text.match(/^\s*['"]?([\w-]+)['"]?\s*:\s*\{[^}]*tone:\s*['"]primary['"]/);
    if (keyed && !RUNNING.test(keyed[1])) at(offset, `Badge-Ton primary für „${keyed[1]}“`);
    // Umschalter/Auswahl im Stil der Hauptaktion: aria-pressed zusammen mit variant „primary“
    if (/aria-pressed/.test(text) && /variant=\{[^}]*['"]primary['"]/.test(text)) at(offset, `Umschalter rot gefüllt: ${text.trim().slice(0, 120)}`);
    // gewählt = rot gefüllt mit Schrift auf Akzent in einer Bedingung (Schritte, Antworten, Haken)
    if (!FILLED_RED_ALLOWED.has(file) && /\?\s*['"][^'"]*(?<![\w-])bg-primary(?:-solid)?\s[^'"]*text-on-primary/.test(text)) at(offset, `Auswahl rot gefüllt: ${text.trim().slice(0, 120)}`);
    // rot gefüllte Fläche außerhalb der erlaubten Stellen
    if (!FILLED_RED_ALLOWED.has(file) && /(?<![\w-])bg-primary(?:-solid)?(?![\w-])/.test(text)) at(offset, `rote Fläche: ${text.trim().slice(0, 120)}`);
    offset += text.length + 1;
  }
  // Tabellen „Record<…, Tone> = { schluessel: 'primary', … }“ (auch über mehrere Zeilen)
  for (const m of src.matchAll(/Record<[^>]*\bTone\s*>\s*=\s*\{([^}]*)\}/g)) {
    for (const e of m[1].matchAll(/['"]?([\w-]+)['"]?\s*:\s*['"]primary['"]/g)) if (!RUNNING.test(e[1])) at(m.index!, `Badge-Ton primary für „${e[1]}“`);
  }
  return out;
}

describe('Design-Regel „ein Akzent“ (#270)', () => {
  it('Oberfläche: kein Rot für Auswahl, Schritte, Ansichtsschalter und Kennzeichnungen', () => {
    const all = sources(WEB).flatMap((f) => findings(path.relative(WEB, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')));
    expect(all).toEqual([]);
  });

  it('die Prüfung meldet die bekannten Abweichungen (Stand v0.6.2)', () => {
    const old = [
      `<Button size="sm" variant={view === 'grid' ? 'primary' : 'ghost'} iconOnly icon="LayoutGrid" aria-label="Kacheln" aria-pressed={view === 'grid'} />`,
      `<span className="w-6 h-6 rounded-full bg-primary text-on-primary">{n}</span>`,
      `className={cx('h-9 px-3', s.id === step ? 'bg-primary text-on-primary border-primary' : 'bg-card')}`,
      `{on && <span className="absolute top-1 right-1 bg-primary-solid text-on-primary rounded-full p-0.5" />}`,
      `const LEVEL_TONE: Record<string, Tone> = {\n  error: "error",\n  info: "primary",\n};`,
      `const STATUS_TONE: Record<PressStatus, Tone> = { new: 'primary', in_progress: 'warning' };`,
      `{t.kind === 'image' && <Badge tone="primary">Befüllbar</Badge>}`,
      `  write: { label: "ändern", tone: "primary" },`,
      `<Badge tone={r.level === 1 ? 'error' : r.level === 2 ? 'warning' : 'primary'}>Warnstufe {r.level}</Badge>`,
    ];
    for (const src of old) expect(findings('pages/beispiel.tsx', src), src).not.toEqual([]);
    // Erlaubt: laufende Vorgänge, Hauptaktion, Auswahl-Muster
    const ok = [
      `  sending: { tone: 'primary', label: 'Wird versendet', pulse: true },`,
      `<Button variant="primary" icon="Check">Auswählen</Button>`,
      `className={cx('border', sel ? 'bg-primary-soft border-primary text-fg' : 'bg-card')}`,
      `const OUT: Record<string, Tone> = { queued: 'primary', sent: 'success' };`,
    ];
    for (const src of ok) expect(findings('pages/beispiel.tsx', src), src).toEqual([]);
  });
});
