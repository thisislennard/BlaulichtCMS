import fs from 'node:fs';
import type { FastifyReply } from 'fastify';
import { notFound } from '../lib/errors.js';

/** Datei aus der privaten Ablage streamen – mit festem Typ, ohne MIME-Sniffing. */
export async function sendFileResponse(reply: FastifyReply, file: string, type: string, downloadName?: string, opts: { immutable?: boolean } = {}) {
  // Asynchron (#192): synchrone Dateisystemaufrufe halten bei langsamem Speicher (NAS, volle Platte) die ganze API an
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st?.isFile()) throw notFound('Datei nicht vorhanden.');
  // Vorschauen/öffentliche Fassungen ändern sich für eine Medien-ID nie → im Browser lange cachen (nur privat)
  reply.header('content-type', type).header('content-length', st.size).header('x-content-type-options', 'nosniff').header('cache-control', opts.immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=300');
  reply.header('content-disposition', downloadName ? `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` : 'inline');
  return reply.send(fs.createReadStream(file));
}
