import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../api/client';
import { Badge, Button, Card, ErrorBox, Notice, SkeletonRows } from '../../components/ui/core';
import { fmtBytes } from '../../lib/format';

interface Part {
  files: number;
  bytes: number;
}
interface Storage {
  disk: { free: number; total: number } | null;
  min_free_gb: number;
  warn_gb: number;
  ready: Part;
  checking: Part;
  blocked: Part;
  trash: Part;
  exports: Part;
  by_kind: (Part & { kind: string })[];
  by_collection: (Part & { id: string; title: string; archived: boolean; max_bytes: number })[];
}

const KIND: Record<string, string> = { image: 'Fotos', video: 'Videos', unbekannt: 'unbekannt' };

/** Balken mit Anteil (rein dekorativ; der Wert steht immer als Text daneben). */
function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 rounded-full bg-raised overflow-hidden flex-1 min-w-[60px]" aria-hidden="true">
      <div className="h-full bg-fg-muted" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Speicherübersicht wie LiFeOS: freier Platz, Verbrauch je Art, Sammlung und Ordner, Papierkorb, Quarantäne, ZIPs. */
export function StorageCard() {
  const q = useQuery({ queryKey: ['media-admin', 'storage'], queryFn: () => get<Storage>('/media-admin/storage') });
  const [open, setOpen] = useState<string | null>(null);
  const folders = useQuery({ queryKey: ['media-admin', 'storage', open], queryFn: () => get<any>(`/media-admin/storage?collection=${open}`), enabled: !!open });
  const d = q.data;
  const low = d?.disk && d.warn_gb > 0 && d.disk.free < d.warn_gb * 1024 ** 3;
  const maxCol = Math.max(1, ...(d?.by_collection ?? []).map((c) => c.bytes));
  const row = (label: string, p: Part, extra?: React.ReactNode) => (
    <div className="flex items-center gap-3 text-sm py-1">
      <span className="w-44 shrink-0">{label}</span>
      <span className="font-mono text-meta w-28 shrink-0">{fmtBytes(p.bytes)}</span>
      <span className="text-meta text-fg-muted">{p.files} Datei(en)</span>
      {extra}
    </div>
  );
  return (
    <Card title="Speicher" subtitle="Grundlage sind die Größen der hochgeladenen Dateien; Vorschauen und öffentliche Fassungen kommen etwa 5–15 % dazu.">
      {q.isLoading && <SkeletonRows rows={4} />}
      {q.error && <ErrorBox title="Konnte nicht geladen werden">{(q.error as Error).message}</ErrorBox>}
      {d && (
        <div className="flex flex-col gap-4">
          {d.disk && (
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">Frei: {fmtBytes(d.disk.free)}</span>
                <span className="text-fg-muted">von {fmtBytes(d.disk.total)}</span>
                {low ? <Badge tone="warning">unter der Warnschwelle ({d.warn_gb} GB)</Badge> : <Badge tone="success">ausreichend</Badge>}
              </div>
              <Bar value={d.disk.total - d.disk.free} max={d.disk.total} />
              <span className="text-meta text-fg-muted">Uploads werden unter {d.min_free_gb} GB frei gesperrt; Warnung unter {d.warn_gb || '–'} GB (Einstellungen → Medien).</span>
            </div>
          )}
          {low && <Notice tone="warning">Platz schaffen: Papierkorb leeren, gesperrte Dateien löschen oder alte Sammlungen in den Papierkorb legen.</Notice>}
          <div className="flex flex-col">
            {row('Geprüfte Dateien', d.ready)}
            {d.by_kind.map((k) => row(`· ${KIND[k.kind] ?? k.kind}`, k))}
            {row('In Prüfung', d.checking)}
            {row('Gesperrt (Quarantäne)', d.blocked)}
            {row('Papierkorb', d.trash, <Link to="/medien/papierkorb" className="text-meta ml-auto">Papierkorb →</Link>)}
            {row('Sammeldownloads (ZIP)', d.exports)}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-label uppercase text-fg-muted">Größte Sammlungen</span>
            <ul className="m-0 p-0 list-none flex flex-col">
              {d.by_collection.map((c) => (
                <li key={c.id} className="flex flex-col py-1 border-b border-line last:border-0">
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <Link to={`/medien/${c.id}`} className="w-56 truncate">
                      {c.title}
                    </Link>
                    <Bar value={c.bytes} max={maxCol} />
                    <span className="font-mono text-meta w-24 text-right">{fmtBytes(c.bytes)}</span>
                    <span className="text-meta text-fg-muted w-32">{c.files} Datei(en){c.archived ? ' · archiviert' : ''}</span>
                    <Button size="sm" variant="ghost" icon={open === c.id ? 'ChevronDown' : 'ChevronRight'} aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>
                      Ordner
                    </Button>
                  </div>
                  {open === c.id && folders.data && (
                    <ul className="m-0 pl-6 py-1 list-none text-sm flex flex-col gap-0.5">
                      <li className="flex gap-3">
                        <span className="w-56 truncate text-fg-muted">Oberste Ebene</span>
                        <span className="font-mono text-meta">{fmtBytes(folders.data.top.bytes)}</span>
                        <span className="text-meta text-fg-muted">{folders.data.top.files} Datei(en)</span>
                      </li>
                      {folders.data.folders.map((f: any) => (
                        <li key={f.id} className="flex gap-3">
                          <span className="w-56 truncate">{f.name}</span>
                          <span className="font-mono text-meta">{fmtBytes(f.bytes)}</span>
                          <span className="text-meta text-fg-muted">{f.files} Datei(en)</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Card>
  );
}
