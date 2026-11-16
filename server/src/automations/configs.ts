import { z } from 'zod';
import { ROLE_IDS } from '../auth/permissions.js';
import { FIELD_KEY, LIMITS, type InputKind, type OutputKind } from './catalog.js';

/* Einstellungen je Art von Eingang und Ausgang (serverseitig geprüft; die Oberfläche spiegelt die Felder). */

const tpl = (max: number) => z.string().max(max).default('');
const phases = <T extends string>(values: readonly [T, ...T[]]) => z.array(z.enum(values)).min(1, 'mindestens ein Vorgang').max(values.length);

export const INPUT_CONFIG: Record<InputKind, z.ZodType<any>> = {
  fe2: z.object({ connectionId: z.uuid(), phases: phases(['neu', 'aktualisierung', 'beendet'] as const).default(['neu']) }),
  feuersoftware: z.object({ connectionId: z.uuid(), phases: phases(['neu', 'aktualisierung', 'beendet'] as const).default(['neu']) }),
  warnfeed: z.object({ connectionId: z.uuid(), phases: phases(['neu', 'aktualisierung', 'entwarnung'] as const).default(['neu']), onlyInArea: z.boolean().default(true) }),
  rss: z.object({ feedId: z.uuid().nullable().default(null) }),
  upload: z.object({ collectionId: z.uuid().nullable().default(null), windowMinutes: z.number().int().min(5).max(1440).default(30) }),
  schedule: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('daily'),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit im Format HH:MM'),
      weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    }),
    z.object({ mode: z.literal('interval'), minutes: z.number().int().min(LIMITS.minIntervalMinutes, `mindestens ${LIMITS.minIntervalMinutes} Minuten`).max(1440) }),
  ]),
  manual: z.object({
    fields: z
      .array(z.object({ key: z.string().regex(FIELD_KEY, 'Feldnamen: Kleinbuchstaben, Ziffern und _'), label: z.string().trim().min(1).max(80), example: z.string().max(300).default('') }))
      .max(10)
      .default([]),
  }),
};

const variants = z
  .object({
    wordpress: z.object({ title: tpl(400), body: tpl(20_000) }).partial().optional(),
    facebook: z.object({ body: tpl(20_000) }).partial().optional(),
    instagram: z.object({ body: tpl(2_200) }).partial().optional(),
  })
  .default({});

const roles = z.array(z.enum(ROLE_IDS as [string, ...string[]])).max(ROLE_IDS.length).default([]);

export const OUTPUT_CONFIG: Record<OutputKind, z.ZodType<any>> = {
  banner: z.object({
    siteIds: z.array(z.uuid()).min(1, 'mindestens eine Website').max(5),
    title: z.string().min(2).max(300),
    text: tpl(1000),
    tone: z.enum(['info', 'warning', 'danger', 'auto']).default('info'),
    priority: z.number().int().min(1).max(3).default(2),
    durationHours: z.number().int().min(1).max(168).default(6),
    endFromField: z.boolean().default(true),
    linkUrl: tpl(500),
    linkText: tpl(100),
    submit: z.boolean().default(true),
  }),
  post: z.object({
    kind: z.enum(['news', 'incident', 'event', 'situation']).default('news'),
    title: z.string().min(2).max(400),
    body: tpl(20_000),
    excerpt: tpl(1_000),
    variants,
    siteId: z.uuid().nullable().default(null),
    submit: z.boolean().default(false),
  }),
  mail: z
    .object({
      roles,
      responsibilityIds: z.array(z.uuid()).max(20).default([]),
      subject: z.string().min(2).max(300),
      body: z.string().min(1).max(10_000),
    })
    .refine((c) => c.roles.length || c.responsibilityIds.length, { message: 'Bitte Rollen oder Zuständigkeiten als Empfänger wählen.', path: ['roles'] }),
  notify: z
    .object({
      roles,
      userIds: z.array(z.uuid()).max(50).default([]),
      kind: z.enum(['info', 'warning']).default('info'),
      title: z.string().min(2).max(300),
      body: tpl(1000),
      link: tpl(300),
    })
    .refine((c) => c.roles.length || c.userIds.length, { message: 'Bitte Rollen oder Personen wählen.', path: ['roles'] }),
  warning_draft: z.object({
    data: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), tpl(2000)).default({}),
    responsibilityIds: z.array(z.uuid()).max(20).default([]),
  }),
};
