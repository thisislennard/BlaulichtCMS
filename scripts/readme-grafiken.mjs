#!/usr/bin/env node
// Grafiken der README (docs/grafik/*.svg) – je eine helle und eine dunkle Fassung.
//
// Aufruf nach Änderungen (z. B. neue Schnittstelle oder neues Modul):  node scripts/readme-grafiken.mjs
//
// Farben aus web/src/theme/tokens.css (Design „Leitstand“), Symbole aus Lucide (ISC, node_modules/lucide-react),
// Logo aus logo/. Im Banner ist IBM Plex (SIL OFL, @fontsource) eingebettet, die Diagramme nutzen die Systemschrift.
// Keine Zahlen in die Grafiken schreiben, die sich mit jedem Release ändern (Rechte, Kapitel) – die stehen im Text.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'grafik');
const NM = join(ROOT, 'node_modules');

const THEMES = {
  hell: {
    bg: '#F6F7F9', card: '#FFFFFF', raised: '#EEF0F3', line: '#DDE1E6', line2: '#B9C0C9', dots: '#D3D8DE',
    text: '#111418', muted: '#4E5560',
    accent: '#D21F3C', accentSoft: 'rgba(210,31,60,.09)',
    ok: '#1E7443', okSoft: 'rgba(30,116,67,.12)', warn: '#8F5200', warnSoft: 'rgba(230,150,0,.16)',
    input: '#2F5B8A', inputSoft: 'rgba(47,91,138,.12)', output: '#6A4C9C', outputSoft: 'rgba(106,76,156,.12)',
    shadow: 'rgba(17,20,24,.12)',
    logo: 'blaulichtcms-logo-hell.svg', mark: 'blaulichtcms-zeichen.svg',
  },
  dunkel: {
    bg: '#0E0F12', card: '#16181C', raised: '#1F2227', line: '#2C3037', line2: '#4A505A', dots: '#2A2E35',
    text: '#EEF0F3', muted: '#A9AFB8',
    accent: '#FF5A6E', accentSoft: 'rgba(255,90,110,.14)',
    ok: '#5BD48A', okSoft: 'rgba(91,212,138,.14)', warn: '#F2B84B', warnSoft: 'rgba(242,184,75,.14)',
    input: '#8DB3E0', inputSoft: 'rgba(141,179,224,.14)', output: '#B9A3E3', outputSoft: 'rgba(185,163,227,.14)',
    shadow: 'rgba(0,0,0,.45)',
    logo: 'blaulichtcms-logo-dunkel.svg', mark: 'blaulichtcms-zeichen-dunkel.svg',
  },
};

const SANS = "'IBM Plex Sans','Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif";
const MONO = "'IBM Plex Mono',ui-monospace,'SFMono-Regular',Consolas,'Liberation Mono',monospace";

// ---------------------------------------------------------------------------------------------------------------
// Bausteine

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** grobe Textbreite für Layout-Entscheidungen (Chips umbrechen) */
const tw = (s, size, weight = 400) => s.length * size * (weight >= 600 ? 0.57 : weight >= 500 ? 0.54 : 0.52);

const iconCache = new Map();
function iconNode(name) {
  if (!iconCache.has(name)) {
    const src = readFileSync(join(NM, 'lucide-react', 'dist', 'esm', 'icons', `${name}.mjs`), 'utf8');
    const alias = src.match(/export \{ default \} from '\.\/([a-z0-9-]+)\.mjs'/);
    if (alias) {
      iconCache.set(name, iconNode(alias[1]));
      return iconCache.get(name);
    }
    const m = src.match(/const __iconData = (\{[\s\S]*?\n\});/);
    if (!m) throw new Error(`Symbol ${name}: Daten nicht gefunden`);
    iconCache.set(name, Function(`return ${m[1]}`)().node);
  }
  return iconCache.get(name);
}

/** Lucide-Symbol an (x, y) mit Kantenlänge size; stroke = sichtbare Linienstärke in px */
function icon(name, x, y, size, color, stroke = 1.9) {
  const s = size / 24;
  const inner = iconNode(name)
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ')}/>`)
    .join('');
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="${(stroke / s).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`;
}

function text(x, y, s, { size = 15, weight = 400, fill, anchor, mono, ls } = {}) {
  return `<text x="${x}" y="${y}" font-size="${size}"${weight !== 400 ? ` font-weight="${weight}"` : ''} fill="${fill}"${anchor ? ` text-anchor="${anchor}"` : ''}${mono ? ' class="m"' : ''}${ls ? ` letter-spacing="${ls}"` : ''}>${esc(s)}</text>`;
}

function box(t, x, y, w, h, { r = 14, tone, fill, dash } = {}) {
  const stroke = tone === 'accent' ? t.accent : t.line;
  const sw = tone === 'accent' ? 2 : 1;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill ?? t.card}" stroke="${stroke}" stroke-width="${sw}"${dash ? ' stroke-dasharray="5 5"' : ''}/>`;
}

function badge(t, x, y, s, name, tone) {
  const fill = tone ? t[`${tone}Soft`] : t.raised;
  const color = tone ? t[tone] : t.text;
  const is = Math.round(s * 0.52);
  return `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${Math.round(s * 0.27)}" fill="${fill}"/>${icon(name, x + (s - is) / 2, y + (s - is) / 2, is, color)}`;
}

function chip(t, x, y, label, { tone, size = 13, h = 28, weight = 500, padX = 11 } = {}) {
  const w = Math.round(tw(label, size, weight) + padX * 2);
  const fill = tone ? t[`${tone}Soft`] : t.raised;
  const color = tone ? t[tone] : t.text;
  return {
    w,
    svg: `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="7" fill="${fill}"/>${text(x + w / 2, y + h / 2 + size * 0.36, label, { size, weight, fill: color, anchor: 'middle' })}`,
  };
}

function chipFlow(t, x, y, maxW, labels, opts = {}) {
  const gap = 8;
  const h = opts.h ?? 28;
  let cx = x;
  let cy = y;
  let out = '';
  for (const l of labels) {
    const { w } = chip(t, 0, 0, l, opts);
    if (cx > x && cx + w > x + maxW) {
      cx = x;
      cy += h + gap;
    }
    out += chip(t, cx, cy, l, opts).svg;
    cx += w + gap;
  }
  return { svg: out, bottom: cy + h };
}

/** Pfeil/Kurve von (x1,y1) nach (x2,y2), waagerecht ein- und auslaufend */
function curve(x1, y1, x2, y2, color, marker = 'ah', sw = 1.5) {
  const mx = (x1 + x2) / 2;
  return `<path d="M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${sw}"${marker ? ` marker-end="url(#${marker})"` : ''}/>`;
}

const line = (x1, y1, x2, y2, color, sw = 1.5, marker) =>
  `<path d="M${x1} ${y1}L${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${sw}"${marker ? ` marker-end="url(#${marker})"` : ''}/>`;

function logoInner(file) {
  return readFileSync(join(ROOT, 'logo', file), 'utf8')
    .replace(/<metadata>[\s\S]*?<\/metadata>/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '');
}

function fontFaces() {
  const face = (pkg, file, family, weight) =>
    `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(join(NM, '@fontsource', pkg, 'files', file)).toString('base64')}) format('woff2')}`;
  return (
    face('ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2', 'BC Plex Sans', 400) +
    face('ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2', 'BC Plex Sans', 600) +
    face('ibm-plex-mono', 'ibm-plex-mono-latin-500-normal.woff2', 'BC Plex Mono', 500)
  );
}

function defs(t) {
  const marker = (id, c) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M2 1.6L8.6 5L2 8.4" fill="none" stroke="${c}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>`;
  return (
    marker('ah', t.line2) + marker('ahIn', t.input) + marker('ahOut', t.output) + marker('ahAcc', t.accent) +
    `<filter id="sh" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="${t.shadow}" flood-opacity="1"/></filter>`
  );
}

function svg(t, w, h, label, body, { fonts = false } = {}) {
  const sans = (fonts ? "'BC Plex Sans'," : '') + SANS;
  const mono = (fonts ? "'BC Plex Mono'," : '') + MONO;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">` +
    `<title>${esc(label)}</title><style>${fonts ? fontFaces() : ''}text{font-family:${sans}}.m{font-family:${mono}}</style>` +
    `<defs>${defs(t)}</defs>${body}</svg>\n`
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Titelbanner

function banner(t) {
  const W = 1280;
  const H = 400;
  let b = `<clipPath id="clip"><rect width="${W}" height="${H}" rx="24"/></clipPath>`;
  b += `<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="4" cy="4" r="1.4" fill="${t.dots}"/></pattern>`;
  b += `<g clip-path="url(#clip)"><rect width="${W}" height="${H}" fill="${t.bg}"/><rect x="660" width="${W - 660}" height="${H}" fill="url(#dots)"/></g>`;
  b += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="23.5" fill="none" stroke="${t.line}"/>`;

  // Logo, Untertitel, Ablauf
  b += `<g transform="translate(72 84) scale(1.5)">${logoInner(t.logo)}</g>`;
  b += text(74, 246, 'Redaktionssystem für Öffentlichkeitsarbeit', { size: 27, fill: t.text });
  b += text(74, 282, 'und Krisenkommunikation', { size: 27, fill: t.text });
  const words = ['SAMMELN', 'SICHTEN', 'SCHREIBEN', 'FREIGEBEN', 'VERÖFFENTLICHEN'];
  b += `<text x="75" y="336" font-size="14.5" font-weight="500" letter-spacing="1.4" class="m" fill="${t.muted}">${words.map(esc).join(`<tspan fill="${t.accent}"> · </tspan>`)}</text>`;

  // Beitragskarte
  const cx = 780;
  const cy = 58;
  const cw = 430;
  b += `<g filter="url(#sh)">${box(t, cx, cy, cw, 284, { r: 16 })}</g>`;
  b += text(cx + 24, cy + 40, 'BEITRAG', { size: 12, weight: 500, mono: true, ls: 1.2, fill: t.muted });
  const pillW = Math.round(tw('Freigegeben', 13, 600) + 36);
  b += `<rect x="${cx + cw - 24 - pillW}" y="${cy + 22}" width="${pillW}" height="26" rx="13" fill="${t.okSoft}"/>`;
  b += `<circle cx="${cx + cw - 24 - pillW + 14}" cy="${cy + 35}" r="3.5" fill="${t.ok}"/>`;
  b += text(cx + cw - 24 - pillW + 24, cy + 40, 'Freigegeben', { size: 13, weight: 600, fill: t.ok });
  b += text(cx + 24, cy + 74, 'Brand in einer Lagerhalle', { size: 19, weight: 600, fill: t.text });
  b += text(cx + 24, cy + 98, 'B-2026-0142 · F3 · Einsatzbericht', { size: 12.5, weight: 500, mono: true, fill: t.muted });
  b += line(cx + 24, cy + 118, cx + cw - 24, cy + 118, t.line, 1);
  const rows = [
    ['Website', 'veröffentlicht', true],
    ['Instagram · Beitrag und Story', 'veröffentlicht', true],
    ['Facebook', 'veröffentlicht', true],
    ['Mastodon', 'geplant 18:00', false],
  ];
  rows.forEach(([name, status, done], i) => {
    const y = cy + 152 + i * 36;
    b += icon(done ? 'circle-check' : 'clock', cx + 24, y - 15, 19, done ? t.ok : t.muted);
    b += text(cx + 54, y, name, { size: 15, fill: t.text });
    b += text(cx + cw - 24, y, status, { size: 12.5, weight: 500, mono: true, anchor: 'end', fill: done ? t.ok : t.muted });
  });

  // schwebende Hinweise
  const c1 = 'zum Sichten';
  const c1w = Math.round(48 + tw('12 neue Fotos ', 15, 600) + tw(c1, 15) + 18);
  b += `<g filter="url(#sh)"><rect x="700" y="30" width="${c1w}" height="48" rx="24" fill="${t.card}" stroke="${t.line}"/></g>`;
  b += icon('images', 716, 44, 20, t.accent);
  b += `<text x="746" y="59" font-size="15" fill="${t.text}"><tspan font-weight="600">12 neue Fotos</tspan><tspan fill="${t.muted}"> ${esc(c1)}</tspan></text>`;

  const c2w = Math.round(48 + tw('Banner: Unwetterwarnung ', 15, 600) + tw('aktiv', 12.5, 500) + 22);
  b += `<g filter="url(#sh)"><rect x="716" y="334" width="${c2w}" height="48" rx="24" fill="${t.card}" stroke="${t.line}"/></g>`;
  b += icon('megaphone', 732, 348, 20, t.warn);
  b += `<text x="762" y="363" font-size="15" fill="${t.text}"><tspan font-weight="600">Banner: Unwetterwarnung</tspan></text>`;
  b += text(716 + c2w - 20, 363, 'aktiv', { size: 12.5, weight: 500, mono: true, anchor: 'end', fill: t.warn });

  return svg(t, W, H, 'BlaulichtCMS – Redaktionssystem für Öffentlichkeitsarbeit und Krisenkommunikation', b, { fonts: true });
}

// ---------------------------------------------------------------------------------------------------------------
// Projektumfang: Module als Kacheln

const MODULE = [
  ['camera', 'Fotos sammeln', ['per Link und QR-Code,', 'hochladen ohne Konto']],
  ['images', 'Sichtung und Medien', ['Galerie, Ordner, Papierkorb,', 'Bereiche unkenntlich machen']],
  ['file-text', 'Beiträge', ['Fassungen, Vorlagen und', 'eigene Texte je Netzwerk']],
  ['badge-check', 'Freigabe', ['genau einer Fassung, auch', 'unterwegs am Handy'], 'accent'],
  ['send', 'Veröffentlichen', ['Website und sieben Netzwerke', 'mit Reichweite je Beitrag']],
  ['megaphone', 'Banner', ['Hinweise und Warnungen', 'oben auf der Website']],
  ['list-ordered', 'Einsatzliste', ['auf der Website, mit', 'Statistik je Jahr']],
  ['palette', 'Designvorlagen', ['Logos, Layouts und', 'befüllbare Bildvorlagen']],
  ['calendar-days', 'Kalender', ['Termine, Serien, iCal-Abos', 'und geplante Beiträge']],
  ['message-square-quote', 'Presse', ['Anfragen, Postfach, Verteiler', 'und Pressemitteilungen']],
  ['siren', 'Warnungen', ['Warnentwurf für MoWaS,', 'amtliche Warnungen']],
  ['workflow', 'Workflows', ['Wenn – Nur wenn – Dann,', 'visueller Editor']],
  ['layout-dashboard', 'Dashboard', ['je Rolle, per Drag-and-drop', 'anpassbar']],
  ['monitor-smartphone', 'App und Push', ['installierbar auf Handy und', 'Computer, mit Push']],
  ['users', 'Rollen und Rechte', ['eigene Rollen, feine Rechte', 'für jede Funktion']],
];

// Die README erscheint auf der Repo-Startseite nur ~830 px breit (Faktor ~0,65) – Schrift daher groß wählen.
function umfang(t) {
  const W = 1280;
  const cols = 3;
  const gap = 24;
  const vgap = 20;
  const tw0 = (W - gap * (cols - 1)) / cols;
  const th = 128;
  const rowsN = Math.ceil(MODULE.length / cols);
  const H = rowsN * th + (rowsN - 1) * vgap + 2;
  let b = '';
  MODULE.forEach(([ic, title, sub, tone], i) => {
    const x = Math.round((i % cols) * (tw0 + gap)) + 1;
    const y = Math.floor(i / cols) * (th + vgap) + 1;
    b += box(t, x, y, Math.round(tw0) - 2, th, { r: 18, tone });
    b += badge(t, x + 22, y + 24, 56, ic, tone);
    b += text(x + 96, y + 50, title, { size: 23, weight: 600, fill: t.text });
    sub.forEach((s, j) => (b += text(x + 96, y + 80 + j * 25, s, { size: 18, fill: t.muted })));
  });
  return svg(t, W, H, 'Module von BlaulichtCMS', b);
}

// ---------------------------------------------------------------------------------------------------------------
// Idee: der Ablauf in fünf Schritten

const ABLAUF = [
  ['camera', 'Sammeln', ['per Link und QR-Code,', 'ohne Konto']],
  ['scan-eye', 'Sichten', ['auswählen, ordnen,', 'unkenntlich machen']],
  ['file-pen-line', 'Schreiben', ['ein Beitrag,', 'Texte je Netzwerk']],
  ['badge-check', 'Freigeben', ['genau diese Fassung,', 'Vier-Augen-Prinzip'], 'accent'],
  ['send', 'Veröffentlichen', ['Website und', 'soziale Netzwerke']],
];

function ablauf(t) {
  const W = 1280;
  const w = 232;
  const gap = (W - ABLAUF.length * w) / (ABLAUF.length - 1);
  const y = 2;
  const h = 222;
  let b = '';
  ABLAUF.forEach(([ic, title, sub, tone], i) => {
    const x = Math.round(i * (w + gap)) + 1;
    b += box(t, x, y, w - 2, h, { r: 18, tone });
    b += badge(t, x + 20, y + 22, 56, ic, tone);
    b += text(x + w - 22, y + 56, `0${i + 1}`, { size: 16, weight: 500, mono: true, anchor: 'end', fill: tone ? t.accent : t.muted });
    b += text(x + 20, y + 126, title, { size: 22, weight: 600, fill: t.text });
    sub.forEach((s, j) => (b += text(x + 20, y + 160 + j * 26, s, { size: 17, fill: t.muted })));
    if (i < ABLAUF.length - 1) b += line(x + w + 3, y + h / 2, Math.round((i + 1) * (w + gap)) - 3, y + h / 2, t.line2, 1.8, 'ah');
  });
  return svg(t, W, h + 4, 'Ablauf: Sammeln, Sichten, Schreiben, Freigeben, Veröffentlichen', b);
}

// ---------------------------------------------------------------------------------------------------------------
// Schnittstellen: eingehend → BlaulichtCMS → ausgehend

const EINGEHEND = [
  ['siren', 'FE2', 'Alarme mit Stichwort und Ort'],
  ['radio-tower', 'Feuersoftware Connect', 'Einsätze nach RIC und Stichwort'],
  ['triangle-alert', 'Amtliche Warnungen', 'Warn-App NINA (MoWaS, DWD), CAP'],
  ['inbox', 'Presse-Postfach', 'IMAP oder Microsoft 365'],
  ['calendar-days', 'Kalender', 'iCal, z. B. aus Outlook oder Google'],
  ['rss', 'RSS- und Atom-Feeds', 'Anregungen für eigene Beiträge'],
  ['smartphone', 'Upload-Links', 'Fotos und Videos ohne Konto'],
];

const AUSGEHEND = [
  ['globe', 'WordPress (Bridge)', 'Beiträge, Einsatzliste, Social-Feed'],
  ['share-2', 'Facebook · Instagram · Threads', 'Beiträge, Stories, Statistik'],
  ['message-circle', 'X · Mastodon · Bluesky', 'offizielle Schnittstellen'],
  ['send', 'WhatsApp-Kanal', 'vorbereitet, geteilt von Hand'],
  ['mail', 'E-Mail', 'SMTP oder Microsoft 365'],
  ['bell', 'Web Push', 'Browser und installierte App'],
  ['file-text', 'Warnentwurf', 'PDF an die zuständige Stelle'],
];

function schnittstellen(t) {
  const W = 1280;
  const colW = 400;
  const midW = 300;
  const midX = (W - midW) / 2;
  const rightX = W - colW;
  const top = 48;
  const nh = 76;
  const ng = 12;
  const n = Math.max(EINGEHEND.length, AUSGEHEND.length);
  const bottom = top + n * nh + (n - 1) * ng;
  const H = bottom + 2;
  const mid = (top + bottom) / 2;
  let b = '';

  b += `<circle cx="7" cy="20" r="5" fill="${t.input}"/>`;
  b += text(22, 26, 'EINGEHEND', { size: 15, weight: 500, mono: true, ls: 1.5, fill: t.input });
  b += `<circle cx="${rightX + 7}" cy="20" r="5" fill="${t.output}"/>`;
  b += text(rightX + 22, 26, 'AUSGEHEND', { size: 15, weight: 500, mono: true, ls: 1.5, fill: t.output });

  const column = (items, x, tone, side) =>
    items.forEach(([ic, title, sub], i) => {
      const y = top + i * (nh + ng);
      const cy = y + nh / 2;
      const spread = mid - ((items.length - 1) * 22) / 2 + i * 22;
      b += box(t, x + 1, y, colW - 2, nh, { r: 16 });
      b += badge(t, x + 15, y + 15, 46, ic, tone);
      b += text(x + 76, y + 33, title, { size: 18.5, weight: 600, fill: t.text });
      b += text(x + 76, y + 57, sub, { size: 15.5, fill: t.muted });
      if (side === 'in') {
        b += `<circle cx="${x + colW}" cy="${cy}" r="3" fill="${t.input}"/>`;
        b += curve(x + colW, cy, midX - 4, spread, t.input, 'ahIn', 1.4);
      } else {
        b += `<circle cx="${midX + midW}" cy="${spread}" r="3" fill="${t.output}"/>`;
        b += curve(midX + midW, spread, x - 4, cy, t.output, 'ahOut', 1.4);
      }
    });
  column(EINGEHEND, 0, 'input', 'in');
  column(AUSGEHEND, rightX, 'output', 'out');

  // Mitte: BlaulichtCMS
  const mh = 340;
  const my = mid - mh / 2;
  b += `<g filter="url(#sh)">${box(t, midX, my, midW, mh, { r: 22 })}</g>`;
  b += `<g transform="translate(${W / 2 - 42} ${my + 30}) scale(1.3125)">${logoInner(t.mark)}</g>`;
  b += text(W / 2, my + 160, 'BlaulichtCMS', { size: 28, weight: 700, anchor: 'middle', fill: t.text });
  b += text(W / 2, my + 188, 'selbst gehostet', { size: 17, anchor: 'middle', fill: t.muted });
  const chips = [['Sichtung'], ['Beiträge'], ['Freigabe', 'accent'], ['Workflows']];
  chips.forEach(([label, tone], i) => {
    const cw = 124;
    const x = W / 2 - cw - 6 + (i % 2) * (cw + 12);
    const y = my + 214 + Math.floor(i / 2) * 50;
    const fill = tone ? t.accentSoft : t.raised;
    b += `<rect x="${x}" y="${y}" width="${cw}" height="40" rx="9" fill="${fill}"/>`;
    b += text(x + cw / 2, y + 26, label, { size: 16, weight: 500, anchor: 'middle', fill: tone ? t.accent : t.text });
  });

  return svg(t, W, H, 'Schnittstellen: eingehend FE2, Feuersoftware, Warnungen, Postfach, Kalender, Feeds, Uploads – ausgehend WordPress, soziale Netzwerke, E-Mail, Push, Warnentwurf', b);
}

// ---------------------------------------------------------------------------------------------------------------
// Workflows: Wenn – Nur wenn – Dann

function workflow(t) {
  const W = 1280;
  const cw = 390;
  const gap = (W - 3 * cw) / 2;
  const y = 2;
  const pad = 20;
  const inner = cw - 2 * pad;
  const chipOpts = { size: 15.5, h: 34, padX: 12 };
  const colX = (i) => Math.round(i * (cw + gap)) + 1;
  let b = '';

  const wenn = chipFlow(t, colX(0) + pad, y + 186, inner, ['Feuersoftware', 'Amtliche Warnung', 'RSS-Eintrag', 'Kalendereintrag', 'Neue Uploads', 'Zeitplan', 'Presseanfrage', 'Manuell'], chipOpts);
  const dann = chipFlow(t, colX(2) + pad, y + 186, inner, ['Beitragsentwurf', 'Bild aus Vorlage', 'E-Mail', 'App-Benachrichtigung', 'Einsatzliste', 'Warnentwurf', 'Pressemitteilung'], chipOpts);
  const bedingung = ['Feld – Vergleich – Wert, mit', 'Vorschlägen aus dem', 'Stichwortverzeichnis. Ohne', 'Bedingung läuft der Workflow', 'bei jedem Auslöser.'];
  const textBottom = y + 200 + (bedingung.length - 1) * 25 + 8;
  const ch = Math.max(wenn.bottom, dann.bottom, textBottom) - y + 24;

  const cards = [
    ['1', 'WENN', 'Auslöser', 'input'],
    ['2', 'NUR WENN', 'Bedingung', null],
    ['3', 'DANN', 'Aktionen', 'output'],
  ];
  cards.forEach(([nr, label, sub, tone], i) => {
    const x = colX(i);
    const color = tone ? t[tone] : t.muted;
    b += box(t, x, y, cw - 2, ch, { r: 18 });
    b += `<circle cx="${x + pad + 16}" cy="${y + 38}" r="16" fill="${tone ? t[`${tone}Soft`] : t.raised}"/>`;
    b += text(x + pad + 16, y + 44, nr, { size: 16, weight: 500, mono: true, anchor: 'middle', fill: color });
    b += text(x + pad + 44, y + 44, label, { size: 16, weight: 500, mono: true, ls: 1.5, fill: color });
    b += text(x + cw - pad - 2, y + 44, sub, { size: 17, anchor: 'end', fill: t.muted });
    if (i !== 1) b += text(x + pad, y + 172, 'AUCH', { size: 13.5, weight: 500, mono: true, ls: 1.4, fill: t.muted });
    if (i < 2) b += line(x + cw + 3, y + 104, colX(i + 1) - 4, y + 104, t.line2, 1.8, 'ah');
  });

  // Beispiele
  const example = (x, ic, label, tone) =>
    `<rect x="${x + pad}" y="${y + 72}" width="${inner}" height="64" rx="13" fill="${t[`${tone}Soft`]}"/>` +
    icon(ic, x + pad + 18, y + 91, 26, t[tone]) +
    text(x + pad + 58, y + 111, label, { size: 19, weight: 600, fill: t.text });
  b += example(colX(0), 'siren', 'Alarm aus FE2', 'input');
  b += example(colX(2), 'megaphone', 'Banner auf der Website', 'output');
  [['Stichwort-Kategorie'], ['ist'], ['Brand']].reduce((x, [label]) => {
    const w = Math.round(tw(label, 16, 600) + 24);
    b += `<rect x="${x}" y="${y + 72}" width="${w}" height="64" rx="13" fill="${t.raised}"/>`;
    b += text(x + w / 2, y + 110, label, { size: 16, weight: 600, anchor: 'middle', fill: t.text });
    return x + w + 8;
  }, colX(1) + pad);
  bedingung.forEach((s, j) => (b += text(colX(1) + pad, y + 200 + j * 25, s, { size: 17, fill: t.muted })));
  b += wenn.svg + dann.svg;

  // als Satz
  const sy = y + ch + 24;
  b += box(t, 1, sy, W - 2, 72, { r: 16 });
  b += badge(t, 16, sy + 14, 44, 'workflow');
  b += text(76, sy + 43, '„Wenn ein Alarm aus FE2 eingeht und die Stichwort-Kategorie Brand ist, erscheint nach Freigabe ein Banner auf der Website.“', { size: 18, fill: t.text });

  // Lebenslauf eines Workflows
  const ly = sy + 72 + 26;
  const steps = ['Entwurf', 'Testlauf ohne Wirkung', 'Aktivieren', 'Schrittprotokoll'];
  const opts = { size: 16, h: 38, padX: 14 };
  const widths = steps.map((s) => chip(t, 0, 0, s, opts).w);
  const total = widths.reduce((a, w) => a + w, 0) + (steps.length - 1) * 48;
  let x = (W - total) / 2;
  steps.forEach((s, i) => {
    b += chip(t, x, ly, s, { ...opts, tone: i === 2 ? 'accent' : undefined }).svg;
    x += widths[i];
    if (i < steps.length - 1) b += line(x + 8, ly + 19, x + 40, ly + 19, t.line2, 1.8, 'ah');
    x += 48;
  });

  return svg(t, W, ly + 40, 'Workflow in drei Schritten: Wenn – Nur wenn – Dann', b);
}

// ---------------------------------------------------------------------------------------------------------------
// Technische Umsetzung: Aufbau (von oben nach unten, damit die Schrift auch schmal lesbar bleibt)

function aufbau(t) {
  const W = 1280;
  let b = '';
  const node = (x, y, w, h, ic, title, sub, tone) =>
    box(t, x, y, w, h, { r: 16 }) +
    badge(t, x + 16, y + (h - 46) / 2, 46, ic, tone) +
    text(x + 78, y + h / 2 - 4, title, { size: 19, weight: 600, fill: t.text }) +
    text(x + 78, y + h / 2 + 20, sub, { size: 15.5, fill: t.muted });
  const vcurve = (x1, y1, x2, y2, color = t.line2, marker = 'ah') => {
    const my = (y1 + y2) / 2;
    return `<path d="M${x1} ${y1}C${x1} ${my} ${x2} ${my} ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="1.6"${marker ? ` marker-end="url(#${marker})"` : ''}/>`;
  };

  // oben: Zugriffe
  const CW = 880; // Breite des Containers, an der sich die oberen Reihen ausrichten
  const clients = [
    ['monitor-smartphone', 'Browser und App', 'Oberfläche, installierbar'],
    ['globe', 'WordPress', 'Bridge holt Aufträge ab'],
    ['siren', 'FE2', 'meldet Alarme'],
  ];
  const cw = 272;
  const cgap = (CW - 3 * cw) / 2;
  const proxy = { x: CW / 2 - 130, y: 124, w: 260, h: 76 };
  clients.forEach(([ic, title, sub], i) => {
    const x = Math.round(i * (cw + cgap)) + 1;
    b += node(x, 1, cw - 2, 76, ic, title, sub);
    b += vcurve(x + cw / 2, 77, CW / 2 + (i - 1) * 60, proxy.y - 4);
  });
  b += node(proxy.x, proxy.y, proxy.w, proxy.h, 'network', 'Reverse Proxy', 'HTTPS');

  // Container
  const C = { x: 1, y: 248, w: CW - 2, h: 384 };
  const ix = C.x + 24;
  const iw = C.w - 48;
  b += `<rect x="${C.x}" y="${C.y}" width="${C.w}" height="${C.h}" rx="22" fill="${t.bg}" stroke="${t.line2}" stroke-width="1.3" stroke-dasharray="7 6"/>`;
  const lbl = 'CONTAINER  blaulichtcms';
  b += text(C.x + C.w - 24, C.y + 34, lbl, { size: 15, weight: 500, mono: true, ls: 1.2, anchor: 'end', fill: t.muted });
  b += icon('container', C.x + C.w - 24 - lbl.length * 10.2 - 30, C.y + 18, 21, t.muted);

  const sw = (iw - 16) / 2;
  const svc = { y: C.y + 52, h: 96 };
  const services = [
    ['server', 'API · Fastify', 'REST, Live-Updates, Oberfläche'],
    ['cog', 'Worker', 'Medien, Workflows, Abrufe, Fristen'],
  ];
  services.forEach(([ic, title, sub], i) => (b += node(ix + i * (sw + 16), svc.y, sw, svc.h, ic, title, sub)));
  const pg = { y: C.y + 176, h: 76 };
  b += node(ix, pg.y, iw, pg.h, 'database', 'PostgreSQL 18', 'im selben Container');
  const sup = { y: C.y + 284, h: 76 };
  b += node(ix, sup.y, iw, sup.h, 'activity', 'Supervisor', 'startet die Dienste und schaltet bei Updates um');
  [ix + sw / 2, ix + sw + 16 + sw / 2].forEach((x) => (b += line(x, svc.y + svc.h, x, pg.y, t.line2, 1.5)));

  // Proxy → API
  b += vcurve(proxy.x + proxy.w / 2, proxy.y + proxy.h, ix + sw / 2, svc.y - 4);

  // rechts: nach außen und Volume
  const rx = 960;
  const rw = W - rx - 1;
  const workerRight = ix + iw;
  b += text(rx, svc.y - 14, 'AUSGEHEND', { size: 15, weight: 500, mono: true, ls: 1.5, fill: t.output });
  b += box(t, rx, svc.y, rw, svc.h, { r: 16 });
  b += badge(t, rx + 16, svc.y + 25, 46, 'send', 'output');
  b += text(rx + 78, svc.y + 30, 'Nach außen', { size: 19, weight: 600, fill: t.text });
  b += text(rx + 78, svc.y + 55, 'soziale Netzwerke, E-Mail,', { size: 15.5, fill: t.muted });
  b += text(rx + 78, svc.y + 77, 'Push, Warnungen, Feeds', { size: 15.5, fill: t.muted });
  b += line(workerRight, svc.y + svc.h / 2, rx - 4, svc.y + svc.h / 2, t.output, 1.6, 'ahOut');
  b += node(rx, pg.y, rw, pg.h, 'hard-drive', 'Volume', 'Datenbank und Medien');
  b += line(workerRight, pg.y + pg.h / 2, rx, pg.y + pg.h / 2, t.line2, 1.5);

  return svg(t, W, C.y + C.h + 2, 'Aufbau: Browser, WordPress und FE2 erreichen über einen Reverse Proxy den Container mit API, Worker, PostgreSQL und Supervisor; Daten liegen in einem Volume', b);
}

// ---------------------------------------------------------------------------------------------------------------

const GRAFIKEN = { banner, umfang, ablauf, schnittstellen, workflow, aufbau };

mkdirSync(OUT, { recursive: true });
for (const [mode, t] of Object.entries(THEMES)) {
  for (const [name, fn] of Object.entries(GRAFIKEN)) {
    const file = join(OUT, `${name}-${mode}.svg`);
    writeFileSync(file, fn(t));
    console.log(`docs/grafik/${name}-${mode}.svg`);
  }
}
