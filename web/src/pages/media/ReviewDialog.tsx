import { useCallback, useEffect, useRef, useState } from 'react';
import { patch } from '../../api/client';
import type { MediaItem } from '../../api/types';
import { Button, FieldWrap, Input, Textarea } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, useErrorToast } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { MediaInfo, MediaThumb } from './gallery';
import { SENSITIVE_LABELS, SENSITIVE_ORDER } from './PrivacyDialog';

export type Decision = 'selected' | 'skipped' | 'on_hold';
type Start = 'open' | 'all' | 'selected' | 'on_hold';

/**
 * Sichtung Datei für Datei: große Vorschau, Infos darunter, gleichwertige Buttons, Tastatur (→ auswählen, ← überspringen,
 * ↓ zurückstellen). Start wie in LiFeOS: offene fortsetzen, alle erneut durchsehen oder nur ausgewählte.
 */
export function ReviewDialog({ ready, onClose, onDecide, onChanged }: { ready: MediaItem[]; onClose: () => void; onDecide: (m: MediaItem, s: Decision) => Promise<void>; onChanged: () => void }) {
  const toastError = useErrorToast();
  const { can } = useAuth();
  const counts = {
    open: ready.filter((m) => m.selection === 'pending').length,
    all: ready.length,
    selected: ready.filter((m) => m.selection === 'selected').length,
    on_hold: ready.filter((m) => m.selection === 'on_hold').length,
  };
  const needsChoice = counts.open < counts.all;
  // Liste beim Start festhalten, damit optimistische Änderungen die Reihenfolge nicht verschieben
  const [list, setList] = useState<MediaItem[] | null>(needsChoice ? null : ready.filter((m) => m.selection === 'pending'));
  const [idx, setIdx] = useState(0);
  const [editInfo, setEditInfo] = useState(false);
  const m = list?.[idx];
  const begin = (s: Start) => {
    setIdx(0);
    setList(s === 'all' ? ready : ready.filter((x) => x.selection === (s === 'open' ? 'pending' : s)));
  };
  // Markierungen direkt in der Sichtung setzen (#118)
  const toggleFlag = async (f: (typeof SENSITIVE_ORDER)[number]) => {
    if (!m) return;
    const cur = m.sensitive_flags ?? [];
    const flags = cur.includes(f) ? cur.filter((x) => x !== f) : SENSITIVE_ORDER.filter((x) => x === f || cur.includes(x));
    setList((l) => l && l.map((x) => (x.id === m.id ? { ...x, sensitive_flags: flags } : x)));
    try {
      await patch(`/media/${m.id}/privacy`, { flags });
      onChanged();
    } catch (e) {
      toastError(e);
      setList((l) => l && l.map((x) => (x.id === m.id ? { ...x, sensitive_flags: cur } : x)));
    }
  };
  const saveInfo = async (field: 'displayName' | 'description', value: string) => {
    if (!m) return;
    const key = field === 'displayName' ? 'display_name' : 'description';
    if ((m[key] ?? '') === value.trim()) return;
    try {
      await patch(`/media/${m.id}`, { [field]: value.trim() });
      setList((l) => l && l.map((x) => (x.id === m.id ? { ...x, [key]: value.trim() } : x)));
      onChanged();
    } catch (e) {
      toastError(e);
    }
  };
  const decide = useCallback(
    (s: Decision) => {
      if (!m) return;
      // sofort weiter zur nächsten Datei; Speichern läuft im Hintergrund
      void onDecide(m, s);
      setIdx((i) => i + 1);
    },
    [m, onDecide],
  );
  useEffect(() => {
    if (!list) return;
    const onKey = (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement)?.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
      if (e.key === 'ArrowRight') decide('selected');
      if (e.key === 'ArrowLeft') decide('skipped');
      if (e.key === 'ArrowDown') (e.preventDefault(), decide('on_hold'));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [decide, list]);
  // Nächste Vorschau vorladen, damit das Weiterschalten ohne Wartezeit klappt
  useEffect(() => {
    const next = list?.[idx + 1];
    if (next?.has_preview) new Image().src = `/api/v1/media/${next.id}/preview`;
  }, [idx, list]);
  const start = useRef<number | null>(null);

  if (!list) {
    const opt = (s: Start, label: string, text: string, icon: string) => (
      <Button key={s} size="md" variant={s === 'open' && counts.open ? 'primary' : 'secondary'} icon={icon} className="!h-auto !py-3 !justify-start !whitespace-normal text-left" disabled={!counts[s]} onClick={() => begin(s)}>
        <span className="flex flex-col items-start">
          <span>
            {label} ({counts[s]})
          </span>
          <span className="text-meta font-normal opacity-80">{text}</span>
        </span>
      </Button>
    );
    return (
      <Dialog open onClose={onClose} title="Sichtung starten" width={520}>
        <div className="flex flex-col gap-2">
          {opt('open', 'Offene fortsetzen', 'Nur Dateien, die noch niemand gesichtet hat.', 'Play')}
          {opt('all', 'Alle erneut durchsehen', 'Bisherige Entscheidungen lassen sich ändern.', 'RefreshCw')}
          {opt('selected', 'Nur ausgewählte', 'Auswahl noch einmal prüfen.', 'CheckSquare')}
          {counts.on_hold > 0 && opt('on_hold', 'Zurückgestellte', 'Später entscheiden – jetzt durchsehen.', 'Pause')}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title={m ? `Sichten · ${idx + 1} von ${list.length}` : 'Sichtung abgeschlossen'} width={760}>
      {!m ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <Icon name="CheckCircle2" size={36} className="text-ok" />
          <p className="m-0">Alle Dateien gesichtet.</p>
          <Button variant="primary" onClick={onClose}>
            Schließen
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div
            className="rounded-card overflow-hidden bg-raised touch-pan-y"
            onTouchStart={(e) => (start.current = e.touches[0].clientX)}
            onTouchEnd={(e) => {
              if (start.current === null) return;
              const dx = e.changedTouches[0].clientX - start.current;
              start.current = null;
              if (dx > 70) decide('selected');
              if (dx < -70) decide('skipped');
            }}
          >
            {m.kind === 'video' && m.has_public ? (
              <video src={`/api/v1/media/${m.id}/public?v=${m.public_rev ?? 0}`} poster={m.has_preview ? `/api/v1/media/${m.id}/preview` : undefined} controls className="w-full max-h-[55vh] bg-black" />
            ) : (
              <MediaThumb m={m} className="w-full max-h-[55vh] aspect-[4/3] [&_img]:object-contain" />
            )}
          </div>
          <MediaInfo m={m} />
          {can('media.organize') && (
            <div>
              <Button size="sm" variant="ghost" icon={editInfo ? 'ChevronDown' : 'ChevronRight'} aria-expanded={editInfo} onClick={() => setEditInfo((v) => !v)}>
                Infos bearbeiten
              </Button>
              {editInfo && (
                <div className="grid gap-3 sm:grid-cols-2 mt-2" key={m.id}>
                  <FieldWrap label="Anzeigename" htmlFor="rv-name">
                    <Input id="rv-name" defaultValue={m.display_name ?? ''} placeholder={m.original_name} maxLength={200} onBlur={(e) => void saveInfo('displayName', e.target.value)} />
                  </FieldWrap>
                  <FieldWrap label="Beschreibung" htmlFor="rv-desc">
                    <Textarea id="rv-desc" rows={2} defaultValue={m.description ?? ''} maxLength={2000} onBlur={(e) => void saveInfo('description', e.target.value)} />
                  </FieldWrap>
                </div>
              )}
            </div>
          )}
          {can('media.redact') && (
            <div className="flex flex-col gap-2">
              <span className="text-label uppercase text-fg-muted">Hinweise zur Datei</span>
              <div className="flex flex-wrap gap-2">
                {SENSITIVE_ORDER.map((f) => {
                  const on = (m.sensitive_flags ?? []).includes(f);
                  return (
                    <Button key={f} size="sm" variant={on ? 'primary' : 'secondary'} icon={on ? 'CheckSquare' : 'Square'} aria-pressed={on} onClick={() => void toggleFlag(f)}>
                      {SENSITIVE_LABELS[f]}
                    </Button>
                  );
                })}
              </div>
              <p className="m-0 text-meta text-fg-muted">Erkennbare Personen, Verletzte oder Kennzeichen? Markieren – unkenntlich machen lässt sich die Datei danach über ihr Menü („Datenschutz und Unkenntlichmachen“).</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Button size="md" icon="SkipForward" className="!h-12" onClick={() => decide('skipped')}>
              Überspringen
            </Button>
            <Button size="md" variant="primary" icon="Check" className="!h-12" onClick={() => decide('selected')}>
              Auswählen
            </Button>
          </div>
          <Button size="sm" variant="ghost" icon="Pause" className="self-center" onClick={() => decide('on_hold')}>
            Zurückstellen
          </Button>
          <p className="m-0 text-meta text-fg-muted text-center">
            Tastatur: → auswählen · ← überspringen · ↓ zurückstellen · Esc schließen. Am Handy: nach rechts oder links wischen.
          </p>
        </div>
      )}
    </Dialog>
  );
}
