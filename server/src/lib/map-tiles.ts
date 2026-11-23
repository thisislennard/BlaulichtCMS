import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { z } from 'zod';
import { config } from '../config.js';
import { httpRequest } from './http.js';

/**
 * Karten für den Warnentwurf (#277): Kartenkacheln von OpenStreetMap über den Server (Zwischenspeicher im Datenordner)
 * und ein fester Kartenausschnitt mit dem markierten Gebiet für das PDF.
 *
 * Datenschutz: Der Browser lädt Kacheln nur von BlaulichtCMS – OpenStreetMap sieht die Adresse des Servers, nie die
 * der Personen. Nutzungsregeln der OSM-Kachelserver: eigene Kennung (User-Agent), Zwischenspeicher (mindestens 7 Tage),
 * keine Massenabrufe, Namensnennung „© OpenStreetMap-Mitwirkende“. Eigener Kachelserver über BLAULICHTCMS_TILE_URL.
 */
export const TILE_URL = () => process.env.BLAULICHTCMS_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const MAP_ATTRIBUTION = '© OpenStreetMap-Mitwirkende';
const TILE = 256;
const MAX_ZOOM = 18;
const CACHE_DAYS = 14;

const tileDir = () => path.join(config.dataDir, 'map-tiles');
const mapDir = () => path.join(config.dataDir, 'map-cache');

/** Markiertes Gebiet: Vieleck aus Breite/Länge (WGS84). Teil der Fassung des Warnentwurfs (data.area_geo). */
export const areaGeoSchema = z.object({
  type: z.literal('polygon'),
  points: z
    .array(z.tuple([z.number().min(-85).max(85), z.number().min(-180).max(180)]))
    .min(3, 'Das Gebiet braucht mindestens drei Punkte.')
    .max(200, 'Höchstens 200 Punkte.'),
});
export type AreaGeo = z.infer<typeof areaGeoSchema>;

export function validTile(z: number, x: number, y: number) {
  return Number.isInteger(z) && Number.isInteger(x) && Number.isInteger(y) && z >= 0 && z <= MAX_ZOOM && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;
}

const inflight = new Map<string, Promise<Buffer>>();

/** Kachel aus dem Zwischenspeicher oder vom Kachelserver (gleichzeitige Abrufe derselben Kachel nur einmal). */
export async function getTile(z: number, x: number, y: number): Promise<Buffer> {
  if (!validTile(z, x, y)) throw new Error('Ungültige Kachel.');
  const file = path.join(tileDir(), String(z), String(x), `${y}.png`);
  const st = await fs.promises.stat(file).catch(() => null);
  if (st && Date.now() - st.mtimeMs < CACHE_DAYS * 86_400_000) return fs.promises.readFile(file);
  const key = `${z}/${x}/${y}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    try {
      const url = TILE_URL().replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
      // Ein per Umgebungsvariable gesetzter Kachelserver (eigener Server, Testdienst) darf im internen Netz liegen
      const own = process.env.BLAULICHTCMS_TILE_URL ? [new URL(process.env.BLAULICHTCMS_TILE_URL.replace(/\{[xyz]\}/g, '0')).hostname] : [];
      const res = await httpRequest({ method: 'GET', url, timeoutMs: 15_000, maxResponseBytes: 2 * 1024 * 1024, allowPrivateHosts: own, headers: { 'user-agent': `BlaulichtCMS/${config.version} (+https://github.com/thisislennard/BlaulichtCMS)`, accept: 'image/png,image/*' } });
      if (res.status >= 400 || !/^image\//.test(res.headers['content-type'] ?? '')) throw new Error(`Kachelserver antwortet mit HTTP ${res.status}.`);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(`${file}.tmp`, res.body);
      await fs.promises.rename(`${file}.tmp`, file);
      return res.body;
    } catch (e) {
      // Veraltete Kachel ist besser als keine
      if (st) return fs.promises.readFile(file);
      throw e;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

/** Web-Mercator: Breite/Länge → Pixel auf Zoomstufe z. */
export function project(lat: number, lng: number, z: number) {
  const s = TILE * 2 ** z;
  const sin = Math.sin((lat * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * s, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s };
}

/** Größte Zoomstufe (bis 17), bei der das Gebiet mit Rand in den Ausschnitt passt. */
export function fitZoom(points: [number, number][], width: number, height: number, pad = 48) {
  for (let z = 17; z > 1; z--) {
    const px = points.map(([la, ln]) => project(la, ln, z));
    const w = Math.max(...px.map((p) => p.x)) - Math.min(...px.map((p) => p.x));
    const h = Math.max(...px.map((p) => p.y)) - Math.min(...px.map((p) => p.y));
    if (w <= width - 2 * pad && h <= height - 2 * pad) return z;
  }
  return 2;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Kartenausschnitt (JPEG, klein genug für den Mailanhang) mit dem markierten Gebiet. Ergebnis je Gebiet zwischengespeichert, damit dieselbe Fassung
 * immer dasselbe PDF ergibt – auch wenn sich die Karte von OpenStreetMap später ändert.
 */
export async function renderAreaMap(area: AreaGeo, width = 1200, height = 680): Promise<Buffer> {
  const hash = crypto.createHash('sha256').update(JSON.stringify({ p: area.points, w: width, h: height, t: TILE_URL() })).digest('hex').slice(0, 32);
  const file = path.join(mapDir(), `${hash}.jpg`);
  const cached = await fs.promises.readFile(file).catch(() => null);
  if (cached) return cached;
  const z = fitZoom(area.points, width, height);
  const px = area.points.map(([la, ln]) => project(la, ln, z));
  const cx = (Math.min(...px.map((p) => p.x)) + Math.max(...px.map((p) => p.x))) / 2;
  const cy = (Math.min(...px.map((p) => p.y)) + Math.max(...px.map((p) => p.y))) / 2;
  const left = cx - width / 2;
  const top = cy - height / 2;
  const n = 2 ** z;
  const tiles: OverlayOptions[] = [];
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + width - 1) / TILE); tx++) {
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + height - 1) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      const wx = ((tx % n) + n) % n;
      const buf = await getTile(z, wx, ty);
      // Kacheln am Rand zuschneiden – sharp erlaubt keine Überlagerung außerhalb der Fläche
      const ox = Math.round(tx * TILE - left);
      const oy = Math.round(ty * TILE - top);
      const cropL = Math.max(0, -ox);
      const cropT = Math.max(0, -oy);
      const cw = Math.min(TILE - cropL, width - Math.max(0, ox));
      const ch = Math.min(TILE - cropT, height - Math.max(0, oy));
      if (cw <= 0 || ch <= 0) continue;
      const part = await sharp(buf).resize(TILE, TILE).extract({ left: cropL, top: cropT, width: cw, height: ch }).png().toBuffer();
      tiles.push({ input: part, left: Math.max(0, ox), top: Math.max(0, oy) });
    }
  }
  const pts = px.map((p) => `${(p.x - left).toFixed(1)},${(p.y - top).toFixed(1)}`).join(' ');
  const label = esc(MAP_ATTRIBUTION);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <polygon points="${pts}" fill="#C8102E" fill-opacity="0.18" stroke="#C8102E" stroke-width="4" stroke-linejoin="round"/>
      <rect x="${width - 236}" y="${height - 30}" width="236" height="30" fill="#FFFFFF" fill-opacity="0.85"/>
      <text x="${width - 10}" y="${height - 10}" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="#333333" text-anchor="end">${label}</text>
    </svg>`,
  );
  const jpg = await sharp({ create: { width, height, channels: 3, background: { r: 230, g: 230, b: 230 } } })
    .composite([...tiles, { input: svg, left: 0, top: 0 }])
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  await fs.promises.mkdir(mapDir(), { recursive: true });
  await fs.promises.writeFile(`${file}.tmp`, jpg);
  await fs.promises.rename(`${file}.tmp`, file);
  return jpg;
}
