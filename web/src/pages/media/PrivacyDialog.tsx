import { useEffect, useRef, useState } from 'react';
import { get, patch, post } from '../../api/client';
import type { FaceProposal, MediaItem, Redaction, Region, SensitiveFlag } from '../../api/types';
import { Badge, Button, cx, Notice, SegmentedControl, Select, Spinner, Switch, ToggleButton } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useErrorToast, useToast } from '../../components/ui/overlays';
import { fmtDateTime } from '../../lib/format';
import { PLATE_SIZE_LABELS, plateBox, type PlateSize } from './plateBox';

/** Markierungen aus der Sichtung (#118). */
export const SENSITIVE_LABELS: Record<SensitiveFlag, string> = {
  persons: 'Personen erkennbar',
  health: 'Verletzte / Gesundheit',
  plates: 'Kennzeichen / Adressen',
  sensitive: 'Sonstiger sensibler Inhalt',
};
export const SENSITIVE_ORDER: SensitiveFlag[] = ['persons', 'health', 'plates', 'sensitive'];

const MODE_LABELS: Record<Redaction['mode'], string> = { pixelate: 'Verpixeln', blur: 'Weichzeichnen', box: 'Schwarz abdecken' };

/** Prüffragen vor Auswahl und Freigabe – Kurzfassung der Hilfe („Sichtung“ → Personen und sensible Inhalte). */
export function PrivacyChecklistHint({ className }: { className?: string }) {
  return (
    <Notice tone="info" title="Vor der Veröffentlichung prüfen" className={className}>
      <ul className="m-0 pl-4 flex flex-col gap-0.5">
        <li>Sind Personen erkennbar? Veröffentlichen nur mit Einwilligung oder wenn eine Ausnahme greift (z. B. Personen nur als Beiwerk, Versammlung) – sonst unkenntlich machen.</li>
        <li>Keine erkennbaren Verletzten, Betroffenen oder Gesundheitsangaben (besondere Kategorie nach Art. 9 DSGVO).</li>
        <li>Kennzeichen, Hausnummern, Namensschilder und Bildschirme unkenntlich machen, wenn sie Personen zuordenbar machen.</li>
        <li>Bei Videos auf Stimmen und Funkverkehr achten – notfalls ohne Ton veröffentlichen.</li>
      </ul>
    </Notice>
  );
}

/** Zahl offener Gesichtsvorschläge (#214) – aus der Liste oder, in Beitragsmedien, aus dem Zähler des Servers. */
export function openFaces(m: Pick<MediaItem, 'face_proposals' | 'faces_open'> | null | undefined): number {
  if (!m) return 0;
  if (typeof m.faces_open === 'number') return m.faces_open;
  return (m.face_proposals ?? []).filter((p) => p.status === 'open').length;
}

const MAX_REDACTIONS = 200;

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const pct = (v: number) => `${(v * 100).toFixed(3)}%`;

/**
 * Datenschutz je Datei: Markierungen, Bereiche unkenntlich machen und zuschneiden (Bilder), ohne Ton (Videos).
 * Gezeichnet wird auf der Vorschau (gedreht, wie das Bild angezeigt wird); der Server erzeugt daraus eine neue
 * öffentliche Fassung. Das Original bleibt unverändert.
 */
export function PrivacyDialog({ m, onClose, onSaved }: { m: MediaItem; onClose: () => void; onSaved: (m: MediaItem) => void }) {
  const toast = useToast();
  const toastError = useErrorToast();
  const [flags, setFlags] = useState<SensitiveFlag[]>(m.sensitive_flags ?? []);
  const [redactions, setRedactions] = useState<Redaction[]>(m.redactions ?? []);
  const [crop, setCrop] = useState<Region | null>(m.crop ?? null);
  const [stripAudio, setStripAudio] = useState(!!m.strip_audio);
  const [tool, setTool] = useState<'redact' | 'plate' | 'crop'>('redact');
  const [plateSize, setPlateSize] = useState<PlateSize>('m');
  const [mode, setMode] = useState<Redaction['mode']>('pixelate');
  const [draft, setDraft] = useState<Region | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<MediaItem | null>(null);
  // Gesichtsvorschläge (#214): Entscheidungen gelten erst mit „Speichern“
  const [proposals, setProposals] = useState<FaceProposal[]>(m.face_proposals ?? []);
  const [decisions, setDecisions] = useState<Record<string, 'accepted' | 'rejected'>>({});
  const [face, setFace] = useState({ status: m.face_status ?? null, checkedAt: m.face_checked_at ?? null, error: m.face_error ?? null });
  const [searching, setSearching] = useState(false);
  const area = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const isImage = m.kind === 'image' && m.has_public && m.has_preview;
  const isVideo = m.kind === 'video' && m.has_public;

  const point = (e: React.PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };
  const rect = (a: { x: number; y: number }, b: { x: number; y: number }): Region => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

  const statusOf = (p: FaceProposal): FaceProposal['status'] => (p.id in decisions ? decisions[p.id] : p.status);
  const openList = proposals.filter((p) => statusOf(p) === 'open');
  const decidedCount = proposals.length - openList.length;
  const label = (p: FaceProposal) => `V${proposals.indexOf(p) + 1}`;

  const acceptFaces = (list: FaceProposal[]) => {
    setRedactions((cur) => [...cur, ...list.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h, mode }))].slice(0, MAX_REDACTIONS));
    setDecisions((d) => ({ ...d, ...Object.fromEntries(list.map((p) => [p.id, 'accepted' as const])) }));
  };
  const rejectFaces = (list: FaceProposal[]) => setDecisions((d) => ({ ...d, ...Object.fromEntries(list.map((p) => [p.id, 'rejected' as const])) }));

  const applyServer = (x: MediaItem) => {
    setProposals(x.face_proposals ?? []);
    setFace({ status: x.face_status ?? null, checkedAt: x.face_checked_at ?? null, error: x.face_error ?? null });
  };

  // Während die Suche läuft: Stand alle 2 s abfragen (höchstens 3 Minuten)
  useEffect(() => {
    if (face.status !== 'queued') return;
    let n = 0;
    const t = setInterval(async () => {
      if (++n > 90) return clearInterval(t);
      try {
        const d = await get<{ media: MediaItem }>(`/media/${m.id}/details`);
        if (d.media.face_status !== 'queued') applyServer(d.media);
      } catch {
        /* nächster Versuch */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [face.status, m.id]);

  const searchFaces = async () => {
    setSearching(true);
    try {
      const r = await post<{ media: MediaItem }>(`/media/${m.id}/faces`);
      applyServer(r.media);
    } catch (e) {
      toastError(e);
    } finally {
      setSearching(false);
    }
  };

  const toggleFlag = (f: SensitiveFlag) => setFlags((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : SENSITIVE_ORDER.filter((x) => x === f || cur.includes(x))));

  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { flags };
      if (isImage) Object.assign(body, { redactions, crop });
      if (isVideo) body.stripAudio = stripAudio;
      const decided = Object.entries(decisions).map(([id, status]) => ({ id, status }));
      if (decided.length) body.proposals = decided;
      const r = await patch<{ media: MediaItem; rendering: boolean }>(`/media/${m.id}/privacy`, body);
      setSaved(r.media);
      setDecisions({});
      applyServer(r.media);
      onSaved(r.media);
      toast({ tone: 'success', title: r.rendering ? 'Gespeichert – die öffentliche Fassung wird im Hintergrund neu erzeugt' : 'Gespeichert' });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      width={820}
      title={`Datenschutz · ${m.original_name}`}
      footer={
        <>
          <Button onClick={onClose}>{saved ? 'Schließen' : 'Abbrechen'}</Button>
          <Button variant="primary" icon="Save" loading={busy} onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
          <legend className="text-label uppercase text-fg-muted mb-1">Markierungen</legend>
          <div className="flex flex-wrap gap-2">
            {SENSITIVE_ORDER.map((f) => (
              <ToggleButton key={f} size="sm" pressed={flags.includes(f)} onClick={() => toggleFlag(f)}>
                {SENSITIVE_LABELS[f]}
              </ToggleButton>
            ))}
          </div>
          <p className="m-0 text-meta text-fg-muted">Markierte Dateien verlangen bei der Freigabe eine ausdrücklich bestätigte Datenschutz-Prüfung.</p>
        </fieldset>

        <PrivacyChecklistHint />

        {isImage && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <SegmentedControl
                label="Werkzeug"
                size="sm"
                value={tool}
                onChange={setTool}
                options={[
                  { value: 'redact', label: 'Bereich unkenntlich machen' },
                  { value: 'plate', label: 'Kennzeichen anklicken' },
                  { value: 'crop', label: 'Zuschneiden' },
                ]}
              />
              {tool !== 'crop' && (
                <Select aria-label="Art der Unkenntlichmachung" value={mode} onChange={(e) => setMode(e.target.value as Redaction['mode'])} className="!w-auto">
                  {(Object.keys(MODE_LABELS) as Redaction['mode'][]).map((k) => (
                    <option key={k} value={k}>
                      {MODE_LABELS[k]}
                    </option>
                  ))}
                </Select>
              )}
              {tool === 'plate' && (
                <Select aria-label="Größe des Kennzeichens im Bild" value={plateSize} onChange={(e) => setPlateSize(e.target.value as PlateSize)} className="!w-auto">
                  {(Object.keys(PLATE_SIZE_LABELS) as PlateSize[]).map((k) => (
                    <option key={k} value={k}>
                      {PLATE_SIZE_LABELS[k]}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <p className="m-0 text-meta text-fg-muted">
              {tool === 'redact'
                ? 'Rechteck über Gesichter, Kennzeichen oder Schilder ziehen. Mehrere Bereiche möglich.'
                : tool === 'plate'
                  ? 'Auf die Mitte eines Kennzeichens klicken – es wird in der gewählten Größe unkenntlich gemacht. Schräge oder ungewöhnlich große Schilder als Rechteck ziehen.'
                  : 'Rechteck um den Ausschnitt ziehen, der veröffentlicht werden soll.'}
            </p>
            <div className="flex justify-center bg-raised rounded-node p-2">
              <div
                ref={area}
                className="relative inline-block select-none touch-none cursor-crosshair"
                onPointerDown={(e) => {
                  (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                  start.current = point(e);
                  setDraft(null);
                }}
                onPointerMove={(e) => start.current && setDraft(rect(start.current, point(e)))}
                onPointerUp={(e) => {
                  if (!start.current) return;
                  const from = start.current;
                  const r = rect(from, point(e));
                  start.current = null;
                  setDraft(null);
                  if (tool === 'plate' && r.w < 0.01 && r.h < 0.01) {
                    // Klick ohne Ziehen: Bereich in Kennzeichenform um den Klickpunkt
                    const b = area.current!.getBoundingClientRect();
                    setRedactions((cur) => [...cur, { ...plateBox(from, b.width / b.height, plateSize), mode }].slice(0, MAX_REDACTIONS));
                    return;
                  }
                  if (r.w < 0.01 || r.h < 0.01) return;
                  if (tool === 'crop') setCrop(r);
                  else setRedactions((cur) => [...cur, { ...r, mode }].slice(0, MAX_REDACTIONS));
                }}
              >
                <img src={`/api/v1/media/${m.id}/preview`} alt="" draggable={false} className="block max-w-full max-h-[50vh]" />
                {redactions.map((r, i) => (
                  <div key={i} className="absolute border-2 border-err bg-err-soft pointer-events-none flex items-start justify-end" style={{ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) }}>
                    <span className="text-meta bg-err text-on-primary px-1 rounded-chip">{i + 1}</span>
                  </div>
                ))}
                {openList.map((p) => (
                  <div key={p.id} className="absolute border-2 border-dashed border-warn pointer-events-none flex items-start justify-start" style={{ left: pct(p.x), top: pct(p.y), width: pct(p.w), height: pct(p.h) }}>
                    <span className="text-meta bg-warn text-on-primary px-1 rounded-chip">{label(p)}</span>
                  </div>
                ))}
                {crop && <div className="absolute border-2 border-dashed border-primary pointer-events-none" style={{ left: pct(crop.x), top: pct(crop.y), width: pct(crop.w), height: pct(crop.h) }} />}
                {draft && <div className={cx('absolute border-2 pointer-events-none', tool === 'crop' ? 'border-dashed border-primary' : 'border-err')} style={{ left: pct(draft.x), top: pct(draft.y), width: pct(draft.w), height: pct(draft.h) }} />}
              </div>
            </div>
            <FacePanel
              status={face.status}
              checkedAt={face.checkedAt}
              error={face.error}
              open={openList}
              decided={decidedCount}
              label={label}
              searching={searching}
              onSearch={searchFaces}
              onAccept={acceptFaces}
              onReject={rejectFaces}
            />
            {(redactions.length > 0 || crop) && (
              <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
                {redactions.map((r, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <span className="w-6 text-fg-muted">{i + 1}.</span>
                    <Select aria-label={`Art für Bereich ${i + 1}`} value={r.mode} onChange={(e) => setRedactions((cur) => cur.map((x, j) => (j === i ? { ...x, mode: e.target.value as Redaction['mode'] } : x)))} className="!w-auto">
                      {(Object.keys(MODE_LABELS) as Redaction['mode'][]).map((k) => (
                        <option key={k} value={k}>
                          {MODE_LABELS[k]}
                        </option>
                      ))}
                    </Select>
                    <Button size="sm" icon="Trash2" onClick={() => setRedactions((cur) => cur.filter((_, j) => j !== i))}>
                      Entfernen
                    </Button>
                  </li>
                ))}
                {crop && (
                  <li className="flex items-center gap-2">
                    <Icon name="Crop" size={16} className="text-fg-muted" />
                    <span>Zuschnitt aktiv</span>
                    <Button size="sm" icon="X" onClick={() => setCrop(null)}>
                      Zuschnitt aufheben
                    </Button>
                  </li>
                )}
              </ul>
            )}
            {saved && (
              <div className="flex flex-col gap-1.5">
                <span className="text-label uppercase text-fg-muted">Öffentliche Fassung</span>
                <img src={`/api/v1/media/${m.id}/public?v=${saved.public_rev ?? 0}`} alt="Öffentliche Fassung" className="block max-w-full max-h-[40vh] rounded-node border border-line self-start" />
              </div>
            )}
          </div>
        )}

        {isVideo && (
          <div className="flex flex-col gap-2">
            <Switch checked={stripAudio} onChange={setStripAudio} label="Ohne Ton veröffentlichen" description="Die öffentliche Fassung enthält dann nur das Bild – keine Stimmen, kein Funkverkehr. Das Original bleibt vollständig." />
            <p className="m-0 text-meta text-fg-muted">Bereiche in Videos unkenntlich zu machen ist hier nicht möglich. Zeigt ein Video erkennbare Personen oder Verletzte, es nicht verwenden oder vorher mit einem Schnittprogramm bearbeiten.</p>
          </div>
        )}

        {!isImage && !isVideo && <Notice tone="warning">Für diese Datei gibt es keine öffentliche Fassung (z. B. HEIC). Nur Markierungen sind möglich.</Notice>}
      </div>
    </Dialog>
  );
}

/**
 * Gesichtsvorschläge (#214): Stand der automatischen Suche, offene Vorschläge einzeln oder alle übernehmen bzw.
 * verwerfen, Suche (erneut) anstoßen. Übernommen wird mit der oben gewählten Art; gespeichert erst mit „Speichern“.
 */
function FacePanel({ status, checkedAt, error, open, decided, label, searching, onSearch, onAccept, onReject }: { status: MediaItem['face_status']; checkedAt: string | null; error: string | null; open: FaceProposal[]; decided: number; label: (p: FaceProposal) => string; searching: boolean; onSearch: () => void; onAccept: (l: FaceProposal[]) => void; onReject: (l: FaceProposal[]) => void }) {
  const running = status === 'queued';
  let text: string;
  if (running) text = 'Die Suche läuft im Hintergrund …';
  else if (status === 'failed') text = `Die Suche ist fehlgeschlagen${error ? `: ${error}` : '.'}`;
  else if (status === 'unavailable') text = `Die automatische Suche ist auf dieser Installation nicht verfügbar${error ? ` (${error})` : ''}. Bitte von Hand prüfen.`;
  else if (status === 'done') text = open.length ? `${open.length === 1 ? 'Ein offener Vorschlag' : `${open.length} offene Vorschläge`} (gestrichelt im Bild): übernehmen oder verwerfen.` : decided ? 'Alle Vorschläge sind geprüft.' : 'Keine Gesichter gefunden.';
  else text = 'Für dieses Bild wurde noch nicht nach Gesichtern gesucht.';
  return (
    <section aria-label="Gesichtsvorschläge" className="flex flex-col gap-2 p-3 rounded-node border border-line">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="ScanFace" size={16} className="text-fg-muted" />
        <span className="font-medium">Gesichtsvorschläge</span>
        {open.length > 0 && <Badge tone="warning">{open.length} offen</Badge>}
        {running && <Spinner size={14} />}
        <span className="ml-auto flex flex-wrap gap-2">
          {open.length > 1 && (
            <Button size="sm" icon="CheckCheck" onClick={() => onAccept(open)}>
              Alle übernehmen
            </Button>
          )}
          {open.length > 1 && (
            <Button size="sm" icon="X" onClick={() => onReject(open)}>
              Alle verwerfen
            </Button>
          )}
          <Button size="sm" icon="ScanFace" loading={searching} onClick={onSearch}>
            {status ? 'Erneut suchen' : 'Gesichter suchen'}
          </Button>
        </span>
      </div>
      <p className="m-0 text-meta text-fg-muted" aria-live="polite">
        {text}
        {status === 'done' && checkedAt ? ` Stand: ${fmtDateTime(checkedAt)}.` : ''}
      </p>
      {open.length > 0 && (
        <ul className="m-0 p-0 list-none grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {open.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2">
              <span className="w-8 font-medium text-warn">{label(p)}</span>
              <span className="text-fg-muted min-w-[6.5rem]">Sicherheit {Math.round(p.score * 100)} %</span>
              <Button size="sm" icon="Check" aria-label={`Vorschlag ${label(p)} übernehmen`} onClick={() => onAccept([p])}>
                Übernehmen
              </Button>
              <Button size="sm" icon="X" aria-label={`Vorschlag ${label(p)} verwerfen`} onClick={() => onReject([p])}>
                Verwerfen
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 text-meta text-fg-muted">
        Die Suche ist nur eine Hilfe: Seitlich, verdeckt, unscharf oder sehr klein abgebildete Gesichter findet sie oft nicht, Kennzeichen und Schilder sucht sie nicht. Bitte das ganze Bild selbst prüfen und fehlende Bereiche von Hand ergänzen.
      </p>
    </section>
  );
}
