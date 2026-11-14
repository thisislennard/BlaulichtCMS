import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { badRequest } from './errors.js';
import { getSettings } from './settings.js';

/** Prüft und vereinheitlicht die öffentliche Basisadresse (ohne Pfad-Ende, nur http/https). */
export function normalizePublicUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw badRequest('Die öffentliche Adresse ist keine gültige URL (Beispiel: https://lifelink.example.org).');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('Die öffentliche Adresse muss mit https:// (oder im Testbetrieb http://) beginnen.');
  if (url.username || url.password || url.search || url.hash) throw badRequest('Die öffentliche Adresse darf keine Zugangsdaten, Parameter oder Anker enthalten.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Öffentliche Basisadresse für Links (Einladungen, Upload-Links, QR-Codes):
 * Einstellung aus dem Erstsetup → Umgebungsvariable PUBLIC_URL → Adresse der Anfrage.
 */
export async function publicBase(req?: FastifyRequest): Promise<string> {
  const s = await getSettings();
  if (s['general.public_url']) return s['general.public_url'];
  if (config.publicUrl) return config.publicUrl;
  if (req) return `${req.protocol}://${req.headers.host}`;
  return 'http://localhost:7310';
}
