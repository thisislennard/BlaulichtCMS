import fs from 'node:fs';
import { config } from '../config.js';
import { httpRequest, type HttpResponse } from '../lib/http.js';
import { log } from '../lib/log.js';
import { notify } from '../lib/notify.js';
import { readSecret } from '../lib/secrets.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { compareVersions, parseVersion, ZIP_LIMITS } from './core.js';

/**
 * Update-Quelle GitHub-Releases (wie LiFeOS): `GET /repos/<besitzer>/<name>/releases/latest`, Dateien über die
 * Asset-API (`Accept: application/octet-stream`). Ein Token ist nur für private Repositories nötig und wird
 * ausschließlich an die konfigurierte API geschickt – die Weiterleitung zum Dateispeicher folgt ohne Authorization.
 *
 * Nur HTTPS; http://localhost bzw. 127.0.0.1 ausschließlich in Tests (NODE_ENV=test).
 */
export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const assetName = (version: string) => `blaulichtcms-update-v${version}.zip`;

export interface ReleaseInfo {
  tag: string;
  version: string;
  name: string;
  notes: string;
  publishedAt: string | null;
  url: string;
  assets: { zip: AssetRef | null; sha256: AssetRef | null; sig: AssetRef | null };
}
interface AssetRef {
  id: number;
  name: string;
  size: number;
}

export class UpdateSourceError extends Error {}

const isTestLocal = (u: URL) => process.env.NODE_ENV === 'test' && u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);

/** Prüft eine API-Adresse (Einstellung) und liefert sie normalisiert (ohne abschließenden Schrägstrich). */
export function normalizeApiUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new UpdateSourceError('API-Adresse ist keine gültige Adresse.');
  }
  if (u.username || u.password || u.search || u.hash) throw new UpdateSourceError('API-Adresse ohne Zugangsdaten, Parameter oder Anker angeben.');
  if (u.protocol !== 'https:' && !isTestLocal(u)) throw new UpdateSourceError('API-Adresse muss mit https:// beginnen.');
  return u.toString().replace(/\/+$/, '');
}

export async function updateSource() {
  const s = await getSettings(true);
  const repo = String(s['updates.repo'] || '').trim();
  if (!REPO_RE.test(repo)) throw new UpdateSourceError('Repository bitte im Format besitzer/name angeben.');
  const apiUrl = normalizeApiUrl(s['updates.api_url'] || 'https://api.github.com');
  const token = s['updates.token_secret_id'] ? await readSecret(s['updates.token_secret_id']) : null;
  return { repo, apiUrl, token, allowPrivate: s['security.allowed_private_hosts'] ?? [] };
}

function headers(token: string | null, accept: string): Record<string, string> {
  return { accept, 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

function privateHosts(u: URL, allowed: string[]): string[] {
  return isTestLocal(u) ? [u.hostname] : allowed;
}

async function apiGet(src: Awaited<ReturnType<typeof updateSource>>, pathName: string, accept: string, maxBytes: number, timeoutMs: number, followRedirects = true): Promise<HttpResponse> {
  const url = new URL(`${src.apiUrl}${pathName}`);
  return httpRequest({ method: 'GET', url: url.toString(), headers: headers(src.token, accept), timeoutMs, maxResponseBytes: maxBytes, allowPrivateHosts: privateHosts(url, src.allowPrivate), followRedirects, maxRedirects: 0 });
}

/** Neuestes Release (ohne Entwürfe und Vorabversionen) oder null, wenn es noch keines gibt. */
export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  const src = await updateSource();
  const res = await apiGet(src, `/repos/${src.repo}/releases/latest`, 'application/vnd.github+json', 2_000_000, 20_000, false);
  if (res.status === 404) return null;
  if (res.status === 401) throw new UpdateSourceError('GitHub hat den Token abgelehnt (401). Token prüfen oder entfernen (öffentliche Repositories brauchen keinen).');
  if (res.status === 403 || res.status === 429) throw new UpdateSourceError(`GitHub verweigert den Abruf (${res.status}) – vermutlich Abruflimit erreicht. Später erneut versuchen.`);
  if (res.status !== 200) throw new UpdateSourceError(`GitHub antwortet mit Status ${res.status}.`);
  const d = res.json() as any;
  const tag = String(d?.tag_name ?? '');
  const version = tag.replace(/^v/, '');
  if (!/^v/.test(tag) || !parseVersion(version)) throw new UpdateSourceError(`Das neueste Release hat keine gültige Versionsbezeichnung („${tag.slice(0, 40)}“, erwartet vX.Y.Z).`);
  const assets: any[] = Array.isArray(d.assets) ? d.assets : [];
  const pick = (name: string): AssetRef | null => {
    const a = assets.find((x) => x?.name === name);
    return a && Number.isInteger(a.id) ? { id: a.id, name: a.name, size: Number(a.size) || 0 } : null;
  };
  const zip = assetName(version);
  return {
    tag,
    version,
    name: String(d.name ?? tag).slice(0, 200),
    notes: String(d.body ?? '').slice(0, 20_000),
    publishedAt: d.published_at ?? null,
    url: /^https:\/\//.test(String(d.html_url ?? '')) ? String(d.html_url) : '',
    assets: { zip: pick(zip), sha256: pick(`${zip}.sha256`), sig: pick(`${zip}.sig`) },
  };
}

/**
 * Lädt ein Release-Asset. Die Asset-API antwortet mit 302 auf den Dateispeicher; dorthin geht die Anfrage ohne
 * Authorization-Kopfzeile (Token nur für die API) und nur über HTTPS.
 */
export async function downloadAsset(asset: AssetRef, maxBytes: number): Promise<Buffer> {
  const src = await updateSource();
  if (asset.size > maxBytes) throw new UpdateSourceError(`${asset.name} ist zu groß (${Math.round(asset.size / 1024 ** 2)} MB).`);
  let res = await apiGet(src, `/repos/${src.repo}/releases/assets/${asset.id}`, 'application/octet-stream', maxBytes, 300_000, false);
  for (let hop = 0; res.status >= 300 && res.status < 400; hop++) {
    const loc = res.headers.location;
    if (!loc || hop >= 3) throw new UpdateSourceError(`Download von ${asset.name}: ungültige oder zu viele Weiterleitungen.`);
    const next = new URL(loc, res.url);
    if (next.protocol !== 'https:' && !isTestLocal(next)) throw new UpdateSourceError(`Download von ${asset.name}: Weiterleitung auf eine unverschlüsselte Adresse abgewiesen.`);
    res = await httpRequest({ method: 'GET', url: next.toString(), headers: { accept: 'application/octet-stream' }, timeoutMs: 300_000, maxResponseBytes: maxBytes, allowPrivateHosts: privateHosts(next, src.allowPrivate), followRedirects: false });
  }
  if (res.status !== 200) throw new UpdateSourceError(`Download von ${asset.name} fehlgeschlagen (Status ${res.status}).`);
  return res.body;
}

/** Lädt ZIP, Prüfsumme und Signatur eines Releases in `dir`. */
export async function downloadRelease(info: ReleaseInfo, zipFile: string) {
  const { zip, sha256, sig } = info.assets;
  if (!zip || !sha256 || !sig) throw new UpdateSourceError(`Release ${info.tag} ist unvollständig: ${assetName(info.version)}, .sha256 und .sig werden gebraucht.`);
  const shaText = (await downloadAsset(sha256, 4096)).toString('utf8').replace(/^﻿/, '').trim();
  const m = /^([a-f0-9]{64})(?:\s+\*?(\S+))?$/i.exec(shaText.split(/\r?\n/)[0] ?? '');
  if (!m) throw new UpdateSourceError('Die .sha256-Datei des Releases ist ungültig.');
  if (m[2] && m[2] !== zip.name) throw new UpdateSourceError('Die .sha256-Datei gehört zu einer anderen Datei.');
  const signature = await downloadAsset(sig, 4096);
  fs.writeFileSync(zipFile, await downloadAsset(zip, ZIP_LIMITS.maxZipBytes), { mode: 0o600 });
  return { sha256: m[1].toLowerCase(), signature };
}

export interface CheckResult {
  ok: boolean;
  latest: ReleaseInfo | null;
  available: boolean;
  error?: string;
}

/**
 * Prüft auf ein neues Release, merkt sich das Ergebnis in den Einstellungen und benachrichtigt „System verwalten“
 * einmal je neuer Version. Vom Worker im eingestellten Abstand und über „Jetzt prüfen“ aufgerufen.
 */
export async function checkForUpdate(): Promise<CheckResult> {
  const at = new Date().toISOString();
  try {
    const latest = await fetchLatestRelease();
    const available = !!latest && compareVersions(latest.version, config.version) > 0;
    await setSettings({ 'updates.latest': latest as any, 'updates.last_check_at': at, 'updates.last_check_error': null });
    const s = await getSettings(true);
    if (available && s['updates.notified_version'] !== latest!.version) {
      await setSettings({ 'updates.notified_version': latest!.version });
      await notify({
        kind: 'info',
        title: `Update verfügbar: Version ${latest!.version}`,
        body: `BlaulichtCMS ${latest!.version} steht bereit (installiert: ${config.version}). Installation unter Einstellungen → Updates.`,
        link: '/einstellungen#updates',
        permission: 'system.manage',
      });
      log('info', 'updates', `Update verfügbar: ${config.version} → ${latest!.version}`);
    }
    return { ok: true, latest, available };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    await setSettings({ 'updates.last_check_at': at, 'updates.last_check_error': msg }).catch(() => {});
    log('warn', 'updates', `Update-Prüfung fehlgeschlagen: ${msg}`);
    return { ok: false, latest: null, available: false, error: msg };
  }
}

/** Fällig, wenn eingeschaltet und die letzte Prüfung länger als das Intervall zurückliegt. */
export async function updateCheckDue(now = Date.now()): Promise<boolean> {
  const s = await getSettings();
  if (!s['updates.enabled']) return false;
  const last = s['updates.last_check_at'] ? new Date(s['updates.last_check_at']).getTime() : 0;
  return now - last >= Math.max(1, s['updates.check_hours']) * 3600_000;
}
