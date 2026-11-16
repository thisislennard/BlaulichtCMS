#!/usr/bin/env node
/**
 * Schreibt die Formatbeschreibung der Workflow-Datei (#199) neu: das JSON-Schema unter
 * web/public/schema/blaulichtcms-automations-1.schema.json (statisch ausgeliefert unter /schema/…) und die generierten
 * Blöcke der Hilfe (web/src/pages/help/content/workflows-ki.md, Markierungen `<!-- ki-…:start -->` / `<!-- ki-…:ende -->`).
 * Quelle sind Importprüfung und Katalog des Servers (server/src/automations/format.ts). Nach Änderungen am Katalog,
 * an den Knoten-Einstellungen oder am Dateiformat ausführen: `npx tsx scripts/workflow-format.mjs`.
 * Der Unit-Test „workflow-format“ schlägt sonst fehl.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { HELP_BLOCKS, SCHEMA_FILE, schemaFileText } = await import(new URL('../server/src/automations/format.ts', import.meta.url).href);

const changed = [];
const schemaPath = path.join(root, 'web/public/schema', SCHEMA_FILE);
fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
const schema = schemaFileText();
if (!fs.existsSync(schemaPath) || fs.readFileSync(schemaPath, 'utf8') !== schema) {
  fs.writeFileSync(schemaPath, schema);
  changed.push(path.relative(root, schemaPath));
}

for (const b of HELP_BLOCKS) {
  const file = path.join(root, b.file);
  const doc = fs.readFileSync(file, 'utf8');
  const a = doc.indexOf(b.start);
  const e = doc.indexOf(b.end);
  if (a < 0 || e < a) {
    console.error(`Markierungen ${b.start} / ${b.end} fehlen in ${b.file}`);
    process.exit(1);
  }
  const next = `${doc.slice(0, a + b.start.length)}\n\n${b.content()}\n\n${doc.slice(e)}`;
  if (next !== doc) {
    fs.writeFileSync(file, next);
    changed.push(`${b.file} (${b.start})`);
  }
}
console.log(changed.length ? `Aktualisiert: ${changed.join(', ')}` : 'Formatbeschreibung ist aktuell.');
