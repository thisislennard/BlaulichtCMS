import { useId, useState, type ReactNode } from 'react';
import { download } from '../../api/client';
import { Button, FieldWrap, LinkButton, Notice, Textarea } from '../../components/ui/core';
import { CopyButton, Dialog } from '../../components/ui/overlays';
import type { Catalog } from './shared';

/* Workflows mit KI erstellen (#199): Formatbeschreibung (JSON-Schema) und Katalog herunterladen, Anfrage kopieren,
   Ergebnis wie jede Exportdatei importieren. Keine Schnittstelle nach außen – die Dateien gibt man selbst weiter. */

/** Statische Datei der Oberfläche speichern (nicht über den Router, sonst öffnete sich eine leere Seite). */
function saveStatic(href: string, name: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="m-0 font-mono text-[12px] font-medium uppercase tracking-[0.08em]">
        <span className="text-fg-muted">{String(n).padStart(2, '0')} —</span> {title}
      </h3>
      {children}
    </li>
  );
}

export function AiAssistDialog({ ai, canImport, onImport, onClose }: { ai: NonNullable<Catalog['ai']>; canImport: boolean; onImport: () => void; onClose: () => void }) {
  const promptId = useId();
  const [prompt, setPrompt] = useState(ai.prompt);
  return (
    <Dialog
      open
      onClose={onClose}
      width={680}
      title="Workflows mit KI erstellen"
      footer={
        <>
          <LinkButton to="/hilfe/workflows-ki" icon="BookOpen">
            Hilfe
          </LinkButton>
          <Button onClick={onClose}>Schließen</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-sm text-fg-muted">
          Eine KI (gleich welchen Anbieters) entwirft aus Formatbeschreibung, Katalog und dem Wunsch eine Workflow-Datei. BlaulichtCMS prüft sie beim Import; sie startet immer als inaktiver Entwurf.
        </p>
        <Notice tone="warning" title="Nie Einsatz- oder Personendaten an eine KI geben">
          Keine Alarmtexte, Adressen, Namen, Telefonnummern, Fotos oder Zugangsdaten – auch nicht als Beispiel. Formatbeschreibung, Katalog und der Wunsch in eigenen Worten reichen.
        </Notice>
        <ol className="m-0 p-0 list-none flex flex-col gap-4">
          <Step n={1} title="Formatbeschreibung">
            <p className="m-0 text-sm">Das JSON-Schema der Workflow-Datei: Knotenarten, Felder, Bedingungen, Platzhalter und Beispiele – für jede Installation gleich.</p>
            <div className="flex items-center gap-3 flex-wrap">
              <Button icon="FileDown" onClick={() => saveStatic(ai.schemaPath, ai.schemaFile)}>
                JSON-Schema herunterladen
              </Button>
              <span className="font-mono text-meta text-fg-muted break-all">{ai.schemaFile}</span>
            </div>
          </Step>
          <Step n={2} title="Katalog dieser Installation">
            <p className="m-0 text-sm">
              Vorhandene Eingänge und Ausgänge (Art und Name), Felder je Auslöser, Vergleiche, Bildvorlagen, Kalender-Kategorien und das aktive Stichwortverzeichnis. Ohne Zugangsdaten, Kennungen, Einsatzdaten, Läufe, Medien und Personen.
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              <Button icon="Braces" onClick={() => download('/automations/catalog/export')}>
                Katalog exportieren
              </Button>
              <span className="font-mono text-meta text-fg-muted break-all">{ai.catalogFile}</span>
            </div>
          </Step>
          <Step n={3} title="Anfrage an die KI">
            <FieldWrap label="Vorlage für die Anfrage" htmlFor={promptId} help="„…“ am Ende durch den eigenen Wunsch ersetzen, kopieren und mit beiden Dateien an die KI geben." labelAction={<CopyButton value={prompt} size="sm" label="Anfrage kopieren" />}>
              <Textarea id={promptId} rows={9} value={prompt} maxLength={8000} onChange={(e) => setPrompt(e.target.value)} className="text-sm" />
            </FieldWrap>
            {prompt !== ai.prompt && (
              <div>
                <Button size="sm" icon="RotateCcw" onClick={() => setPrompt(ai.prompt)}>
                  Vorlage wiederherstellen
                </Button>
              </div>
            )}
          </Step>
          <Step n={4} title="Ergebnis importieren">
            <p className="m-0 text-sm">
              Die Antwort als .json-Datei speichern oder als Text einfügen. Meldet der Import Fehler, nennt jede Meldung den Ort in der Datei – die Meldungen lassen sich kopieren und der KI zur Korrektur geben.
            </p>
            {canImport ? (
              <div>
                <Button variant="primary" icon="FileUp" onClick={onImport}>
                  Ergebnis importieren
                </Button>
              </div>
            ) : (
              <p className="m-0 text-meta text-fg-muted">Importieren braucht das Recht „Workflows verwalten“.</p>
            )}
          </Step>
        </ol>
      </div>
    </Dialog>
  );
}
