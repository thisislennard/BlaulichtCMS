import { useState } from 'react';
import { post } from '../../api/client';
import type { MediaItem } from '../../api/types';
import { Button, FieldWrap, Notice, Textarea } from '../../components/ui/core';
import { Dialog, useErrorToast, useToast } from '../../components/ui/overlays';
import { openFaces, PrivacyChecklistHint, SENSITIVE_LABELS } from '../media/PrivacyDialog';

/** Prüfpunkte bei markierten Medien (#118) – alle müssen bestätigt sein, bevor die Fassung freigegeben werden kann. */
export const PRIVACY_CHECKS = [
  'Erkennbare Personen: Einwilligung liegt vor, eine Ausnahme greift (z. B. Beiwerk, Versammlung) oder sie sind unkenntlich gemacht.',
  'Keine erkennbaren Verletzten, Betroffenen oder Gesundheitsangaben (Art. 9 DSGVO).',
  'Kennzeichen, Adressen und Namen sind unkenntlich, soweit sie Personen zuordenbar machen; bei Videos Ton geprüft.',
];

/** Die Prüfpunkte als Kontrollkästchen (Beiträge und Einsatzliste, #241). */
export function PrivacyCheckList({ checks, onChange }: { checks: boolean[]; onChange: (checks: boolean[]) => void }) {
  return (
    <>
      {PRIVACY_CHECKS.map((text, i) => (
        <label key={i} className="flex items-start gap-2 cursor-pointer">
          <input type="checkbox" className="mt-0.5" checked={checks[i]} onChange={(e) => onChange(checks.map((x, j) => (j === i ? e.target.checked : x)))} />
          <span>{text}</span>
        </label>
      ))}
    </>
  );
}

/**
 * Freigeben oder Zurückweisen genau einer Fassung (Prüfsumme). Genutzt im Beitrag und in der Freigabe-Ansicht (#216);
 * `via` vermerkt im Audit, woher die Entscheidung kam. Alle Regeln prüft der Server (Vier-Augen, Datenschutz-Prüfung).
 */
export function DecisionDialog({ decision, revision, hash, postId, flagged, faces = [], altMissing = 0, altRequired = false, onClose, onDone, via = 'editor' }: { decision: 'approved' | 'rejected'; revision: number; hash: string; postId: string; flagged: MediaItem[]; faces?: MediaItem[]; altMissing?: number; altRequired?: boolean; onClose: () => void; onDone?: () => void; via?: 'editor' | 'review' | 'push' }) {
  const toastError = useErrorToast();
  const toast = useToast();
  const [note, setNote] = useState('');
  // Bilder mit offenen Gesichtsvorschlägen (#214) verlangen dieselbe Prüfung wie markierte Medien (prüft auch der Server)
  const facesOpen = faces.filter((m) => openFaces(m) > 0);
  const facesRunning = faces.filter((m) => m.face_status === 'queued');
  const needsCheck = decision === 'approved' && (flagged.length > 0 || facesOpen.length > 0);
  const [checks, setChecks] = useState<boolean[]>(PRIVACY_CHECKS.map(() => false));
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title={decision === 'approved' ? `Fassung ${revision} freigeben` : `Fassung ${revision} zurückweisen`}
      footer={
        <>
          <Button onClick={onClose}>Abbrechen</Button>
          <Button
            variant={decision === 'approved' ? 'primary' : 'danger'}
            loading={busy}
            disabled={(decision === 'rejected' && !note.trim()) || (needsCheck && checks.some((c) => !c)) || (decision === 'approved' && altRequired && altMissing > 0)}
            onClick={async () => {
              setBusy(true);
              try {
                await post(`/posts/${postId}/decision`, { revision, contentHash: hash, decision, note: note.trim(), privacyChecked: needsCheck && checks.every(Boolean), via });
                toast({ tone: 'success', title: decision === 'approved' ? `Fassung ${revision} freigegeben` : `Fassung ${revision} zurückgewiesen` });
                onDone?.();
                onClose();
              } catch (e) {
                toastError(e);
                setBusy(false);
              }
            }}
          >
            {decision === 'approved' ? 'Freigeben' : 'Zurückweisen'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0">
          Die Entscheidung gilt genau für Fassung {revision} (Prüfsumme <code>{hash.slice(0, 10)}</code>). Jede spätere Änderung an Text, Medien oder Veröffentlichungszielen braucht eine neue Freigabe.
        </p>
        {needsCheck && (
          <fieldset className="m-0 p-3 border border-warn rounded-node flex flex-col gap-2">
            <legend className="px-1 font-medium">Datenschutz-Prüfung</legend>
            {flagged.length > 0 && (
              <p className="m-0">
                {flagged.length === 1 ? 'Eine Datei ist' : `${flagged.length} Dateien sind`} markiert: {[...new Set(flagged.flatMap((m) => m.sensitive_flags ?? []))].map((f) => SENSITIVE_LABELS[f]).join(', ')}.
              </p>
            )}
            {facesOpen.length > 0 && (
              <Notice tone="warning" icon="ScanFace" title="Gesichtsvorschläge offen">
                {facesOpen.length === 1 ? 'Ein Bild hat' : `${facesOpen.length} Bilder haben`} noch ungeprüfte Vorschläge der Gesichtssuche ({facesOpen.reduce((n, m) => n + openFaces(m), 0)} insgesamt). Gefundene Gesichter sind nicht automatisch unkenntlich – vor der Freigabe in den Medien unter „Datenschutz und Unkenntlichmachen“ übernehmen oder verwerfen, sonst bewusst bestätigen.
              </Notice>
            )}
            <PrivacyCheckList checks={checks} onChange={setChecks} />
          </fieldset>
        )}
        {decision === 'approved' && altMissing > 0 && (
          <Notice tone={altRequired ? 'error' : 'warning'} title="Barrierefreiheit">
            {altMissing === 1 ? 'Ein Bild hat' : `${altMissing} Bilder haben`} keinen Alternativtext. Menschen mit Screenreader erfahren dann nicht, was zu sehen ist.{' '}
            {altRequired ? 'Alternativtexte sind Pflicht (Einstellungen → Redaktion & Freigabe): bitte zurückweisen oder ergänzen lassen.' : 'Freigeben ist trotzdem möglich.'}
          </Notice>
        )}
        {decision === 'approved' && facesRunning.length > 0 && (
          <Notice tone="info" title="Gesichtssuche läuft">
            Für {facesRunning.length === 1 ? 'ein Bild' : `${facesRunning.length} Bilder`} läuft die automatische Gesichtssuche noch. Bitte kurz warten und die Ansicht neu laden.
          </Notice>
        )}
        {decision === 'approved' && !needsCheck && <PrivacyChecklistHint />}
        <FieldWrap label={decision === 'approved' ? 'Anmerkung (optional)' : 'Begründung'} required={decision === 'rejected'} htmlFor="dec-note">
          <Textarea id="dec-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </FieldWrap>
      </div>
    </Dialog>
  );
}
