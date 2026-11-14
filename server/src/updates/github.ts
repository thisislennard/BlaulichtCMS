import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { httpRequest } from '../lib/http.js';
import { readSecret } from '../lib/secrets.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { notify } from '../lib/notify.js';
import { log } from '../lib/log.js';
import { compareVersions } from './releases.js';

export interface ReleaseInfo {
  tag: string;
  version: string;
  name: string;
  notes: string;
  publishedAt: string | null;
  url: string;
  zip: { id: number; name: string; size: number } | null;
  sha: { id: number; name: string } | null;
  sig: { id: number; name: string } | null;
}

export async function updateConfig() {
  const s = await getSettings(true);
  const repo = (s['updates.repo'] || config.defaultUpdateRepo).trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Repository muss im Format besitzer/name angegeben werden.');
  const token = s['updates.token_secret_id'] ? await readSecret(s['updates.token_secret_id']) : null;
  return { repo, token, enabled: s['updates.enabled'], hours: s['updates.check_hours'] };
}

function headers(token: string | null, accept = 'application/vnd.github+json') {
  return { accept, 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  const { repo, token } = await updateConfig();
  const res = await httpRequest({ method: 'GET', url: `${config.githubApiUrl}/repos/${repo}/releases/latest`, headers: headers(token), timeoutMs: 15_000, allowPrivateHosts: config.githubApiUrl.startsWith('http://') ? [new URL(config.githubApiUrl).hostname] : [] });
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new Error(`GitHub verweigert den Zugriff (${res.status}). Token prüfen oder Limit abwarten.`);
  if (res.status !== 200) throw new Error(`GitHub antwortet mit ${res.status}.`);
  const d = res.json() as any;
  const assets: any[] = d.assets ?? [];
  const zip = assets.find((a) => /^lifelink-update-v[\d.]+\.zip$/i.test(a.name));
  const sha = zip ? assets.find((a) => a.name === `${zip.name}.sha256`) : undefined;
  const sig = zip ? assets.find((a) => a.name === `${zip.name}.sig`) : undefined;
  const tag = String(d.tag_name ?? '');
  return {
    tag,
    version: tag.replace(/^v/i, ''),
    name: d.name ?? tag,
    notes: String(d.body ?? '').slice(0, 20_000),
    publishedAt: d.published_at ?? null,
    url: d.html_url ?? '',
    zip: zip ? { id: zip.id, name: zip.name, size: zip.size } : null,
    sha: sha ? { id: sha.id, name: sha.name } : null,
    sig: sig ? { id: sig.id, name: sig.name } : null,
  };
}

/** Lädt ein Release-Asset (folgt der Weiterleitung zum Speicher, Token nur an die GitHub-API). */
async function downloadAsset(id: number, maxBytes: number): Promise<Buffer> {
  const { repo, token } = await updateConfig();
  const res = await httpRequest({
    method: 'GET',
    url: `${config.githubApiUrl}/repos/${repo}/releases/assets/${id}`,
    headers: headers(token, 'application/octet-stream'),
    timeoutMs: 180_000,
    maxResponseBytes: maxBytes,
    maxRedirects: 3,
  });
  if (res.status !== 200) throw new Error(`Download fehlgeschlagen (HTTP ${res.status}).`);
  return res.body;
}

export async function downloadRelease(info: ReleaseInfo, dir: string) {
  if (!info.zip || !info.sha || !info.sig) throw new Error(`Release ${info.tag} enthält nicht alle Dateien (ZIP, .sha256 und .sig werden gebraucht).`);
  const zipFile = path.join(dir, info.zip.name);
  fs.writeFileSync(zipFile, await downloadAsset(info.zip.id, 150 * 1024 * 1024));
  const shaText = (await downloadAsset(info.sha.id, 4096)).toString('utf8').replace(/^﻿/, '');
  const sha = /^[a-f0-9]{64}/i.exec(shaText.trim())?.[0]?.toLowerCase() ?? null;
  if (!sha) throw new Error('Die .sha256-Datei des Releases ist ungültig.');
  const sig = await downloadAsset(info.sig.id, 4096);
  return { zipFile, sha, sig };
}

/** Prüft auf neue Versionen und merkt sich das Ergebnis (wird regelmäßig vom Worker aufgerufen). */
export async function checkForUpdate() {
  try {
    const info = await fetchLatestRelease();
    const prev = (await getSettings(true))['updates.latest'] as any;
    await setSettings({ 'updates.latest': info as any, 'updates.last_check_at': new Date().toISOString(), 'updates.last_check_error': null });
    const available = !!info && compareVersions(info.version, config.version) > 0;
    if (available && prev?.version !== info!.version && (await getSettings())['notify.on_update_available']) {
      await notify({ kind: 'info', title: `LifeLink ${info!.version} ist verfügbar`, body: info!.name, link: '/updates', permission: 'system.manage' });
    }
    return { info, available };
  } catch (e) {
    const msg = (e as Error).message;
    await setSettings({ 'updates.last_check_at': new Date().toISOString(), 'updates.last_check_error': msg });
    log('warn', 'updates', `Update-Prüfung fehlgeschlagen: ${msg}`);
    return { info: null, available: false, error: msg };
  }
}
