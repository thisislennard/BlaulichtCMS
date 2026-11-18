import type { FastifyInstance } from 'fastify';
import { requireAnyAuth } from '../auth/context.js';
import { APPROVAL_LIST_PERMISSIONS, approvalOverview } from '../approvals/pending.js';

/**
 * Freigaben (#251): eine Arbeitsliste über alle Arten, für die die Person entscheiden darf, plus freigegebene Vorgänge,
 * die sie veröffentlichen bzw. versenden darf. Reine Sammlung – entschieden wird über die bestehenden Endpunkte der Art.
 * Die Rechte prüft approvalOverview je Art; ohne passendes Recht erscheint die Art nicht.
 */
export async function approvalRoutes(app: FastifyInstance) {
  app.get('/approvals/pending', { preHandler: requireAnyAuth(...APPROVAL_LIST_PERMISSIONS) }, async (req) => approvalOverview(req.auth!));
}
