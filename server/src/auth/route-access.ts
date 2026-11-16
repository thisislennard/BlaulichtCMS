import type { FastifyInstance } from 'fastify';
import type { Guard, RouteAccess } from './context.js';

/**
 * Routentabelle mit Zugriffsangaben. Jede Route unter /api/v1 braucht entweder eine Zugriffsangabe
 * (requireAuth/requireAnyAuth als preHandler) oder einen Eintrag in PUBLIC_ROUTES – sonst scheitert der Test
 * „Jede Route hat eine Zugriffsangabe“. So kann keine neue Route versehentlich ohne Rechteprüfung entstehen.
 */
export interface RouteEntry {
  method: string;
  /** Pfad ohne /api/v1 */
  url: string;
  access: RouteAccess | null;
}

/** Bewusst ohne Anmeldung erreichbar: eigener Schutz je Route (Token, Schlüssel, Signatur, Drosselung). */
export const PUBLIC_ROUTES: string[] = [
  // Anmeldung, Ersteinrichtung, Einladung (Zwischenstufen der Sitzung werden im Handler geprüft)
  'GET /auth/state',
  'POST /auth/setup',
  'POST /auth/login',
  'POST /auth/mfa',
  'GET /auth/mfa/setup',
  'POST /auth/mfa/setup',
  'POST /auth/logout',
  'GET /auth/me',
  'GET /auth/invite/:token',
  'POST /auth/invite/:token',
  // BlaulichtCMS Bridge (eigener Schlüssel je Website)
  'POST /bridge/pair',
  'GET /bridge/status',
  'GET /bridge/update',
  'GET /bridge/update/package',
  'GET /bridge/jobs',
  'POST /bridge/unpair',
  'POST /bridge/report',
  'POST /bridge/jobs/:id/result',
  'GET /bridge/media/:id',
  // Verbindungen: Rückkehr von der Meta-Anmeldung (Zustand im Vorgang), FE2-Eingang (Zugangsschlüssel),
  // befristete Medienadressen für den Abruf durch Meta, Testbild
  'GET /connections/oauth/callback',
  'POST /inbound/fe2/:id',
  'POST /inbound/fe2/:id/:token',
  'GET /m/:token',
  'GET /connection-test-image.jpg',
  // Öffentliche Upload-Seite (Token des Upload-Links)
  'GET /public/design-images/:id',
  'GET /public/upload/:token',
  'POST /public/upload/:token/unlock',
  'POST /public/upload/:token',
  'POST /public/upload/:token/sessions',
  'GET /public/upload/:token/sessions/:id',
  'PUT /public/upload/:token/sessions/:id',
  // Datenschutzerklärung und Impressum (#187)
  'GET /public/legal',
  'GET /public/legal/:kind',
];

const API = '/api/v1';

/** Vor dem Registrieren der Routen aufrufen; füllt die Tabelle beim Registrieren. */
export function collectRouteAccess(app: FastifyInstance): RouteEntry[] {
  const table: RouteEntry[] = [];
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith(`${API}/`)) return;
    const guards = ([] as unknown[]).concat((route.preHandler as unknown) ?? []) as Guard[];
    const access = guards.map((g) => g?.access).find(Boolean) ?? null;
    for (const method of ([] as string[]).concat(route.method)) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      table.push({ method, url: route.url.slice(API.length), access });
    }
  });
  return table;
}
