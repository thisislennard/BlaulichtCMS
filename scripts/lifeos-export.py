#!/usr/bin/env python3
"""LiFeOS-Presse-Modul -> BlaulichtCMS-Austauschformat ``blaulichtcms-import/1`` (docs/import.md).

Laeuft im LiFeOS-Container (dort sind Datenbank und das Volume ``press_media`` erreichbar) und braucht nur die
Standardbibliothek plus psycopg2, das im LiFeOS-Image ohnehin installiert ist. LiFeOS wird dabei **nur gelesen**:
lesende Transaktion mit festem Schnappschuss, Originale werden kopiert, nie verschoben.

    docker compose exec -T lifeos python - --out /tmp/blaulichtcms-import < scripts/lifeos-export.py
    docker compose cp lifeos:/tmp/blaulichtcms-import ./blaulichtcms-import

Zuordnung:
- Thema (Wurzel) und jeder Ordner mit Inhalt -> eine BlaulichtCMS-Sammlung ("Thema / Ordner / Unterordner")
- Medien: nur geprueft (security_status 'released'), nicht geloescht, nicht in einem geloeschten Ordner
- Auswahl: Swipe-Auswahl des Ordners (selected -> selected, rejected -> skipped, sonst pending);
  ohne Entscheidung wird ein redaktionell abgelehntes Medium zu skipped
- Upload-Links: Frist und Bezeichnung; der Token liegt in LiFeOS nur als SHA-256 vor und wird als
  ``token_sha256`` uebergeben - damit funktioniert die Weiterleitung alter Links. Pausierte oder
  deaktivierte Links gelten als widerrufen.

Exit-Code 0 = vollstaendig, 2 = Probleme (z. B. fehlende Originaldatei; Details in export-report.json).
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import sys

import psycopg2
import psycopg2.extras

MIME_EXT = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'image/heic': '.heic', 'image/heif': '.heif', 'image/tiff': '.tif',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv',
}


def iso(value):
    """LiFeOS speichert naive UTC-Zeitpunkte."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.timezone.utc)
    return value.isoformat().replace('+00:00', 'Z')


def blob_path(root, key):
    if not key or not key.isalnum():
        raise ValueError(f'ungueltiger Ablageschluessel {key!r}')
    return os.path.join(root, 'blobs', key[:2], key)


def copy_with_hash(src, dst):
    h = hashlib.sha256()
    size = 0
    with open(src, 'rb') as fin, open(dst, 'xb') as fout:
        for chunk in iter(lambda: fin.read(1024 * 1024), b''):
            h.update(chunk)
            size += len(chunk)
            fout.write(chunk)
    return size, h.hexdigest()


def clip(text, n):
    text = (text or '').strip()
    return text if len(text) <= n else text[: n - 1] + '…'


def main(argv=None):
    # Originale (ggf. mit Standort) und Manifest (Uploader-Hinweise, Token-Pruefsummen) nur fuer den Eigentuemer
    # lesbar anlegen (#138)
    os.umask(0o077)
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--out', required=True, help='Zielordner (darf noch nicht existieren oder muss leer sein)')
    ap.add_argument('--database-url', default=os.environ.get('DATABASE_URL'), help='Standard: $DATABASE_URL')
    ap.add_argument('--media-root', default=os.environ.get('PRESS_MEDIA_ROOT') or '/app/press_media',
                    help='Standard: $PRESS_MEDIA_ROOT bzw. /app/press_media')
    ap.add_argument('--include-archived', action='store_true', help='auch archivierte Themen uebernehmen')
    args = ap.parse_args(argv)

    if not args.database_url:
        ap.error('keine Datenbank: --database-url oder DATABASE_URL setzen')
    out = os.path.abspath(args.out)
    if os.path.exists(out) and os.listdir(out):
        ap.error(f'{out} ist nicht leer')
    os.makedirs(os.path.join(out, 'files'), exist_ok=True)

    dsn = args.database_url.replace('postgresql+psycopg2://', 'postgresql://').replace('postgresql+psycopg://', 'postgresql://')
    conn = psycopg2.connect(dsn)
    conn.set_session(readonly=True, isolation_level='REPEATABLE READ')
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def q(sql, params=()):
        cur.execute(sql, params)
        return cur.fetchall()

    topics = q("""SELECT id, title, description, event_date, status, created_at FROM press_topics
                  WHERE deleted_at IS NULL ORDER BY id""")
    if not args.include_archived:
        topics = [t for t in topics if t['status'] != 'archived']
    folders = {f['id']: f for f in q('SELECT id, topic_id, parent_id, name, created_at, deleted_at FROM press_folders')}

    def folder_chain(fid):
        """Namen von der Wurzel bis zum Ordner; None, wenn der Ordner oder ein Elternordner geloescht ist."""
        names, seen = [], set()
        while fid is not None:
            f = folders.get(fid)
            if f is None or f['deleted_at'] is not None or fid in seen:
                return None
            seen.add(fid)
            names.append(f['name'])
            fid = f['parent_id']
        return list(reversed(names))

    media_rows = q("""SELECT m.id, m.public_id, m.topic_id, m.folder_id, m.original_filename, m.display_name,
                             m.uploader_note, m.editorial_status, m.uploaded_at, b.storage_key, b.size_bytes,
                             b.sha256 AS blob_sha256, b.mime_type
                      FROM press_media m JOIN press_blobs b ON b.id = m.blob_id
                      WHERE m.deleted_at IS NULL AND m.security_status = 'released'
                      ORDER BY m.topic_id, m.folder_id NULLS FIRST, m.uploaded_at, m.id""")
    skipped_unreleased = q("""SELECT count(*) AS n FROM press_media
                              WHERE deleted_at IS NULL AND (security_status <> 'released' OR blob_id IS NULL)""")[0]['n']
    decisions = {}
    for r in q("""SELECT s.topic_id, s.folder_key, e.media_id, e.status FROM press_selection_entries e
                  JOIN press_selections s ON s.id = e.selection_id WHERE s.purpose = 'standard'"""):
        decisions[(r['topic_id'], r['folder_key'], r['media_id'])] = r['status']
    links = q("""SELECT id, topic_id, folder_id, label, token_hash, status, expires_at, disabled_at
                 FROM press_upload_links ORDER BY id""")

    topic_ids = {t['id'] for t in topics}
    collections = {}  # (topic_id, folder_id|None) -> collection
    problems = []
    stats = {'collections': 0, 'media': 0, 'bytes': 0, 'links': 0,
             'skipped_unreleased': skipped_unreleased, 'skipped_deleted_folder': 0, 'skipped_archived_topic': 0}

    def collection_for(topic, folder_id):
        key = (topic['id'], folder_id)
        if key in collections:
            return collections[key]
        chain = [] if folder_id is None else folder_chain(folder_id)
        if chain is None:
            return None
        note = [clip(topic['description'], 1500)]
        if topic['event_date']:
            note.append(f"Datum: {topic['event_date'].isoformat()}")
        if topic['status'] == 'archived':
            note.append('In LiFeOS archiviert.')
        created = topic['created_at'] if folder_id is None else folders[folder_id]['created_at']
        col = {
            'ref': f"lifeos-topic-{topic['id']}" + (f'-folder-{folder_id}' if folder_id else ''),
            'title': clip(' / '.join([topic['title'], *chain]), 200),
            'purpose': '',
            'note': clip('\n'.join(n for n in note if n), 1900),
            'created_at': iso(created),
            'media': [],
            'links': [],
        }
        collections[key] = col
        return col

    topics_by_id = {t['id']: t for t in topics}
    for m in media_rows:
        topic = topics_by_id.get(m['topic_id'])
        if topic is None:
            stats['skipped_archived_topic'] += 1
            continue
        col = collection_for(topic, m['folder_id'])
        if col is None:
            stats['skipped_deleted_folder'] += 1
            continue
        src = blob_path(args.media_root, m['storage_key'])
        ext = MIME_EXT.get(m['mime_type']) or os.path.splitext(m['original_filename'] or '')[1].lower()[:6]
        rel = f"files/{m['public_id']}{ext}"
        try:
            size, sha = copy_with_hash(src, os.path.join(out, rel))
        except FileNotFoundError:
            problems.append(f"Originaldatei fehlt: Medium {m['public_id']} ({src})")
            continue
        if m['blob_sha256'] and m['blob_sha256'] != sha:
            problems.append(f"Pruefsumme weicht von LiFeOS ab: Medium {m['public_id']}")
        decision = decisions.get((m['topic_id'], m['folder_id'] or 0, m['id']))
        if decision == 'selected':
            selection = 'selected'
        elif decision == 'rejected' or (decision is None and m['editorial_status'] == 'rejected'):
            selection = 'skipped'
        else:
            selection = 'pending'
        col['media'].append({
            'ref': f"lifeos-media-{m['public_id']}",
            'file': rel,
            'original_name': clip(m['original_filename'] or m['display_name'] or m['public_id'], 300),
            'size': size,
            'sha256': sha,
            'selection': selection,
            'uploaded_at': iso(m['uploaded_at']),
            'note': clip(m['uploader_note'], 500),
        })
        stats['media'] += 1
        stats['bytes'] += size

    for link in links:
        topic = topics_by_id.get(link['topic_id'])
        if topic is None:
            continue
        col = collection_for(topic, link['folder_id'])
        if col is None:
            col = collection_for(topic, None)  # Zielordner geloescht -> Link landet an der Themenwurzel
        col['links'].append({
            'ref': f"lifeos-link-{link['id']}",
            'token_sha256': link['token_hash'],
            'expires_at': iso(link['expires_at']),
            'revoked': link['status'] in ('paused', 'disabled') or link['disabled_at'] is not None,
            'label': clip(link['label'], 200),
        })
        stats['links'] += 1

    result = [c for c in collections.values() if c['media'] or c['links']]
    stats['collections'] = len(result)
    for c in result:
        if len(c['links']) > 100:
            problems.append(f"Sammlung {c['ref']}: {len(c['links'])} Links (hoechstens 100)")
    manifest = {
        'format': 'blaulichtcms-import/1',
        'source': 'lifeos',
        'exported_at': iso(dt.datetime.now(dt.timezone.utc)),
        'collections': result,
    }
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    with open(os.path.join(out, 'export-report.json'), 'w', encoding='utf-8') as f:
        json.dump({'stats': stats, 'problems': problems}, f, ensure_ascii=False, indent=1)
    conn.rollback()
    conn.close()

    print(json.dumps(stats, ensure_ascii=False))
    for p in problems:
        print(f'PROBLEM: {p}', file=sys.stderr)
    return 2 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
