import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSettings } from '../lib/settings.js';

/*
 * Datenschutzerklärung und Impressum (#187): öffentlich, ohne Anmeldung (Einträge in auth/route-access.ts). Gepflegt
 * unter Einstellungen → Datenschutz (Recht settings.privacy). Der Text ist Markdown; die Oberfläche stellt ihn ohne
 * HTML dar (react-markdown ohne rehype-raw, keine javascript:-Links).
 */

const KEYS = { datenschutz: 'legal.privacy_text', impressum: 'legal.imprint_text' } as const;

export async function legalRoutes(app: FastifyInstance) {
  const limit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  /** Welche Seiten einen Text haben (Links auf Anmeldung, Upload-Seite und in der App nur dann einblenden). */
  app.get('/public/legal', limit, async () => {
    const s = await getSettings();
    return { privacy: !!String(s['legal.privacy_text'] ?? '').trim(), imprint: !!String(s['legal.imprint_text'] ?? '').trim() };
  });

  app.get('/public/legal/:kind', limit, async (req) => {
    const { kind } = z.object({ kind: z.enum(['datenschutz', 'impressum']) }).parse(req.params);
    const s = await getSettings();
    return {
      kind,
      text: String(s[KEYS[kind]] ?? '').trim(),
      organization: s['general.organization'] || s['general.instance_name'],
    };
  });
}
