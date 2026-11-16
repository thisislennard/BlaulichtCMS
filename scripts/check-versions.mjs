#!/usr/bin/env node
/**
 * Wöchentliche Versionsprüfung (#220) – ersetzt die Pull-Requests von Dependabot: alles soll auf dem neuesten Stand
 * sein, auch Hauptversionen, aber ohne Branches. Vergleicht jede festgelegte Version mit dem neuesten stabilen Stand
 * der Quelle:
 *
 * - npm-Pakete: direkte Abhängigkeiten aus package.json, server/package.json, web/package.json (Version aus
 *   package-lock.json) und test/e2e/package.json (Playwright, Version aus test/e2e/package-lock.json) – gegen npm
 * - Node.js: Hauptversion in den Workflows (`node-version:`) gegen die neueste Node.js-Version; das Image steckt im
 *   Dockerfile und wird wie die anderen Images geprüft
 * - Container-Images (Dockerfile, compose.yaml, test/wordpress/compose.yaml, `image:` in den Workflows) gegen
 *   Docker Hub, je Variante („18-trixie“ → „19-trixie“). Ist ein Image per Digest fixiert, meldet der Bericht auch
 *   einen neuen Digest desselben Tags (neu gebautes Image, z. B. mit Sicherheitsupdates). Die PostgreSQL-Hauptversion
 *   kommt aus dem Basis-Image (postgres:18-trixie) – ein Wechsel braucht Export/Import (docs/betrieb.md).
 * - GitHub Actions (per Commit-SHA mit Version als Kommentar fixiert: `uses: owner/repo@<sha> # v1.2.3`) gegen die
 *   GitHub-Releases; meldet auch, wenn die SHA nicht (mehr) zum Tag im Kommentar passt (umgehängter Tag)
 * - Chromium für die Browsertests kommt fest mit der Playwright-Version (test/e2e/package.json)
 *
 * Aufruf: `node scripts/check-versions.mjs` – schreibt eine Markdown-Liste der veralteten Einträge nach stdout (leer,
 * wenn alles aktuell ist). `.github/workflows/versions.yml` macht daraus genau ein Issue „Neue Versionen verfügbar“.
 * Ohne Abhängigkeiten (nur Node.js ≥ 24 mit fetch). `GITHUB_TOKEN` hebt das Abfragelimit der GitHub-API.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNSTABLE = /(alpha|beta|rc|dev|preview|canary|next|nightly|experimental|insiders)/i;

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(ROOT, f));
const versionKey = (v) => (String(v).match(/\d+/g) ?? []).map(Number);
const cmp = (a, b) => {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};
/** Vergleicht nur so genau wie festgelegt: „26“ ist mit 26.3.0 aktuell, mit 27 nicht. */
const isNewer = (candidate, current) => {
  const n = versionKey(current).length;
  return cmp(versionKey(candidate).slice(0, n).join('.'), current) > 0;
};

async function json(url, headers = {}) {
  const h = { accept: 'application/json', 'user-agent': 'blaulichtcms-versionspruefung', ...headers };
  if (url.startsWith('https://api.github.com/') && process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(30_000) });
    if (r.ok) return r.json();
    if (attempt >= 3 || r.status < 500) throw new Error(`${r.status} ${r.statusText} (${url})`);
    await new Promise((res) => setTimeout(res, 2000 * attempt));
  }
}

/* --------------------------------------- Festgelegte Versionen (ohne Netz) --------------------------------------- */

function npmPins() {
  const pins = [];
  const sets = [
    { manifest: 'package.json', lock: 'package-lock.json', prefix: '' },
    { manifest: 'server/package.json', lock: 'package-lock.json', prefix: 'server/' },
    { manifest: 'web/package.json', lock: 'package-lock.json', prefix: 'web/' },
    { manifest: 'test/e2e/package.json', lock: 'test/e2e/package-lock.json', prefix: '' },
  ];
  for (const s of sets) {
    if (!exists(s.manifest)) continue;
    const pkg = JSON.parse(read(s.manifest));
    const lock = JSON.parse(read(s.lock)).packages ?? {};
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      // im Workspace selbst oder (gehoben) im node_modules der Wurzel
      const v = lock[`${s.prefix}node_modules/${name}`]?.version ?? lock[`node_modules/${name}`]?.version ?? String(range).replace(/^[^\d]*/, '');
      pins.push({ kind: 'npm', name, current: v, where: s.manifest });
    }
  }
  return pins;
}

/** Bild-Referenzen: „repo:tag@sha256:…“ (Digest optional). */
function imagePins() {
  const pins = [];
  const files = [
    ['Dockerfile', /^FROM\s+(\S+)/gm],
    ['compose.yaml', /^\s+image:\s*(\S+)\s*$/gm],
    ['test/wordpress/compose.yaml', /^\s+image:\s*(\S+)\s*$/gm],
    ...fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml')).map((f) => [`.github/workflows/${f}`, /^\s+image:\s*(\S+)\s*$/gm]),
  ];
  for (const [file, re] of files) {
    if (!exists(file)) continue;
    for (const m of read(file).matchAll(re)) {
      const ref = m[1];
      if (ref.includes('${') || !ref.includes(':')) continue; // eigenes Image (blaulichtcms:local) bzw. Variable
      const [image, digest = ''] = ref.split('@');
      const [repo, tag] = image.split(':');
      pins.push({ kind: 'Image', name: repo, current: tag, digest, where: file });
    }
  }
  return pins;
}

function nodePins() {
  const pins = [];
  for (const f of fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((x) => x.endsWith('.yml'))) {
    for (const m of read(`.github/workflows/${f}`).matchAll(/node-version:\s*['"]?([\d.]+)/g)) pins.push({ kind: 'Node.js', name: 'node', current: m[1], where: `.github/workflows/${f}` });
  }
  return pins;
}

const USES = /uses:\s*([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@(?:([0-9a-f]{40})[ \t]+#[ \t]*(v?\d[\w.]*)|(\S+))[ \t]*$/gm;
function actionPins() {
  const pins = [];
  for (const f of fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((x) => x.endsWith('.yml')).sort()) {
    for (const m of read(`.github/workflows/${f}`).matchAll(USES)) pins.push({ kind: 'GitHub Action', name: m[1], current: m[3] ?? m[4], sha: m[2] ?? '', where: `.github/workflows/${f}` });
  }
  return pins;
}

function allPins() {
  const seen = new Map();
  for (const p of [...npmPins(), ...nodePins(), ...imagePins(), ...actionPins()]) {
    const key = `${p.kind}|${p.name}|${p.current}|${p.digest ?? ''}|${p.sha ?? ''}`;
    if (seen.has(key)) seen.get(key).where.add(p.where);
    else seen.set(key, { ...p, where: new Set([p.where]) });
  }
  return [...seen.values()];
}

/* ------------------------------------------- Neuesten Stand nachschlagen ------------------------------------------- */

const npmLatest = async (name) => (await json(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, { accept: 'application/vnd.npm.install-v1+json' }))['dist-tags'].latest;

let nodeIndex = null;
async function nodeLatest() {
  nodeIndex ??= await json('https://nodejs.org/dist/index.json');
  // index.json ist absteigend sortiert; Vorabversionen (z. B. v27.0.0-alpha…) überspringen
  return nodeIndex.map((r) => r.version.replace(/^v/, '')).find((v) => /^\d+\.\d+\.\d+$/.test(v));
}

const hubRepo = (repo) => (repo.includes('/') ? repo : `library/${repo}`);
async function dockerTags(repo) {
  let url = `https://hub.docker.com/v2/repositories/${hubRepo(repo)}/tags?page_size=100&ordering=last_updated`;
  const tags = [];
  for (let i = 0; i < 6 && url; i++) {
    const d = await json(url);
    tags.push(...(d.results ?? []).map((t) => t.name));
    url = d.next;
  }
  return tags;
}
const dockerDigest = async (repo, tag) => (await json(`https://hub.docker.com/v2/repositories/${hubRepo(repo)}/tags/${encodeURIComponent(tag)}`)).digest ?? '';

async function imageLatest(pin) {
  // gleiche Variante mit gleicher Stellenzahl: „18-trixie“ → „19-trixie“, „9.0.2-1“ → „9.1.0-1“
  const pattern = new RegExp(`^${pin.current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\d+/g, '\\d+')}$`);
  const stable = (await dockerTags(pin.name)).filter((t) => pattern.test(t) && !UNSTABLE.test(t));
  return stable.reduce((best, t) => (cmp(t, best) > 0 ? t : best), pin.current);
}

async function actionLatest(repo) {
  // nicht releases/latest: maßgeblich ist die höchste stabile Einzelversion
  const releases = await json(`https://api.github.com/repos/${repo}/releases?per_page=50`);
  const tags = releases.filter((r) => !r.draft && !r.prerelease && /^v?\d+(\.\d+)*$/.test(r.tag_name)).map((r) => r.tag_name);
  return tags.reduce((best, t) => (!best || cmp(t, best) > 0 ? t : best), '');
}

async function tagCommit(repo, tag) {
  let obj = (await json(`https://api.github.com/repos/${repo}/git/ref/tags/${tag}`)).object;
  for (let i = 0; i < 5; i++) {
    if (obj.type === 'commit') return obj.sha;
    obj = (await json(`https://api.github.com/repos/${repo}/git/tags/${obj.sha}`)).object;
  }
  throw new Error(`Tag ${tag} von ${repo} zeigt auf keinen Commit`);
}

async function check(pin) {
  switch (pin.kind) {
    case 'npm': {
      const latest = await npmLatest(pin.name);
      return cmp(latest, pin.current) > 0 ? { newest: latest } : null;
    }
    case 'Node.js': {
      const latest = await nodeLatest();
      return isNewer(latest, pin.current) ? { newest: `${latest.split('.')[0]} (${latest})` } : null;
    }
    case 'Image': {
      const latest = await imageLatest(pin);
      if (latest !== pin.current) return { newest: latest + (pin.digest ? ` (Digest \`${await dockerDigest(pin.name, latest)}\`)` : '') };
      if (pin.digest) {
        const digest = await dockerDigest(pin.name, pin.current);
        if (digest && digest !== pin.digest) return { newest: `neuer Digest \`${digest}\`` };
      }
      return null;
    }
    case 'GitHub Action': {
      const latest = await actionLatest(pin.name);
      if (pin.sha && (await tagCommit(pin.name, pin.current)) !== pin.sha) throw new Error(`gepinnte SHA ${pin.sha} passt nicht zum Tag ${pin.current}`);
      if ((latest && isNewer(latest, pin.current)) || !pin.sha) return { newest: `${latest || pin.current} (\`${await tagCommit(pin.name, latest || pin.current)}\`)` };
      return null;
    }
  }
  return null;
}

/** Parallel, aber höflich gegenüber den Quellen. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function report() {
  const pins = allPins();
  const outdated = [];
  const failed = [];
  await mapLimit(pins, 6, async (pin) => {
    try {
      const r = await check(pin);
      if (r) outdated.push({ pin, newest: r.newest });
    } catch (e) {
      failed.push({ pin, error: e.message });
    }
  });
  // Node.js-Hauptversion im Image und in den Workflows soll übereinstimmen
  const imageNode = pins.find((p) => p.kind === 'Image' && p.name === 'node')?.current.match(/^\d+/)?.[0];
  for (const p of pins.filter((x) => x.kind === 'Node.js' && imageNode && versionKey(x.current)[0] !== Number(imageNode))) {
    failed.push({ pin: p, error: `Workflow nutzt Node.js ${p.current}, das Image Node.js ${imageNode}` });
  }
  const order = ['Node.js', 'Image', 'GitHub Action', 'npm'];
  const sort = (a, b) => order.indexOf(a.pin.kind) - order.indexOf(b.pin.kind) || a.pin.name.localeCompare(b.pin.name);
  return { outdated: outdated.sort(sort), failed: failed.sort(sort), total: pins.length };
}

export function markdown({ outdated, failed }) {
  if (!outdated.length && !failed.length) return '';
  const where = (p) => [...p.where].map((w) => `\`${w}\``).join(', ');
  const lines = [];
  if (outdated.length) {
    lines.push(
      'Neue Versionen gegenüber dem Stand auf `main` – auch Hauptversionen umsetzen (Changelog prüfen, `npm run typecheck`, Tests, CI abwarten).',
      '',
      '- npm: Version in der `package.json` anheben, dann `npm install` (bzw. in `test/e2e`: `npm install --prefix test/e2e`) – der Lock zieht mit.',
      '- Images: Tag **und** Digest übernehmen (`name:tag@sha256:…`). Neue PostgreSQL-Hauptversion nur geplant (Export/Import, `docs/betrieb.md`); `postgresql-client-NN` in `.github/workflows/ci.yml` mitziehen.',
      '- Node.js: Image im `Dockerfile` und `node-version` in allen Workflows gemeinsam anheben.',
      '- GitHub Actions mit der genannten Commit-SHA pinnen: `uses: owner/repo@<sha> # <version>`.',
      '- Playwright: Chromium wechselt mit der Version – die Browsertests der CI zeigen, ob alles passt.',
      '',
      '| Art | Name | festgelegt | neu | Datei |',
      '|---|---|---|---|---|',
      ...outdated.map(({ pin, newest }) => `| ${pin.kind} | \`${pin.name}\` | ${pin.current}${pin.digest ? ' (mit Digest)' : ''} | **${newest}** | ${where(pin)} |`),
    );
  }
  if (failed.length) {
    lines.push('', 'Nicht prüfbar oder uneinheitlich (Quelle nicht erreichbar, SHA passt nicht zum Tag, Versionen weichen ab):', '');
    lines.push(...failed.map(({ pin, error }) => `- ${pin.kind} \`${pin.name}\` ${pin.current} (${where(pin)}): ${error}`));
  }
  lines.push('', `_Geprüft am ${new Date().toISOString().slice(0, 10)} von \`scripts/check-versions.mjs\` (\`.github/workflows/versions.yml\`)._`);
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await report();
  process.stdout.write(markdown(r));
  console.error(`${r.total} festgelegte Versionen geprüft: ${r.outdated.length} veraltet, ${r.failed.length} nicht prüfbar.`);
}
