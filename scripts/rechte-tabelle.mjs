#!/usr/bin/env node
/**
 * Schreibt die Tabelle aller Rechte in die Hilfe (web/src/pages/help/content/benutzer-rollen.md, zwischen den
 * Markierungen `<!-- rechte:start -->` und `<!-- rechte:ende -->`). Quelle ist der Rechte-Katalog des Servers
 * (server/src/auth/permissions.ts). Nach Änderungen am Katalog ausführen: `node scripts/rechte-tabelle.mjs`.
 * Der Unit-Test „Tabelle der Rechte in benutzer-rollen.md ist aktuell“ schlägt sonst fehl.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { permissionTableMarkdown } = await import(new URL('../server/src/auth/permissions.ts', import.meta.url).href);
const file = path.join(root, 'web/src/pages/help/content/benutzer-rollen.md');
const START = '<!-- rechte:start -->';
const END = '<!-- rechte:ende -->';
const doc = fs.readFileSync(file, 'utf8');
const a = doc.indexOf(START);
const b = doc.indexOf(END);
if (a < 0 || b < a) {
  console.error(`Markierungen ${START} / ${END} fehlen in ${file}`);
  process.exit(1);
}
const next = `${doc.slice(0, a + START.length)}\n\n${permissionTableMarkdown()}\n\n${doc.slice(b)}`;
if (next !== doc) fs.writeFileSync(file, next);
console.log(next === doc ? 'Tabelle der Rechte ist aktuell.' : 'Tabelle der Rechte aktualisiert.');
