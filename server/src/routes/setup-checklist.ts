import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { CHECKLIST_IDS, setupChecklist } from '../lib/setup-checklist.js';

/**
 * Checkliste „BlaulichtCMS startklar“ (#255). Der Stand jedes Punkts wird bei jedem Abruf neu erkannt; gespeichert wird
 * nur, welche offenen Punkte ausgeblendet sind. Die Dashboard-Kachel „setup“ lädt sie nur, wenn sie im Layout steht.
 */
export async function setupChecklistRoutes(app: FastifyInstance) {
  app.get('/setup/checklist', { preHandler: requireAuth('settings.general') }, async (req) => setupChecklist(req.auth!.permissions));

  /** Punkte aus- oder wieder einblenden (`show: 'all'` = alle wieder zeigen). */
  app.put('/setup/checklist', { preHandler: requireAuth('settings.general') }, async (req) => {
    const id = z.enum(CHECKLIST_IDS);
    const b = z.object({ hide: z.array(id).max(CHECKLIST_IDS.length).optional(), show: z.union([z.array(id).max(CHECKLIST_IDS.length), z.literal('all')]).optional() }).parse(req.body);
    const s = await getSettings(true);
    const before = Array.isArray(s['setup.checklist_hidden']) ? (s['setup.checklist_hidden'] as string[]) : [];
    const hidden = new Set(before.filter((x) => (CHECKLIST_IDS as readonly string[]).includes(x)));
    for (const x of b.hide ?? []) hidden.add(x);
    if (b.show === 'all') hidden.clear();
    else for (const x of b.show ?? []) hidden.delete(x);
    const next = CHECKLIST_IDS.filter((x) => hidden.has(x));
    if (JSON.stringify(next) !== JSON.stringify(before)) {
      await setSettings({ 'setup.checklist_hidden': next }, req.auth!.user?.id ?? null);
      await audit(req.auth!.actor, 'setup.checklist_changed', { type: 'settings', label: 'BlaulichtCMS startklar' }, { ausgeblendet: next.join(', ') || 'keine' });
    }
    return setupChecklist(req.auth!.permissions);
  });
}
