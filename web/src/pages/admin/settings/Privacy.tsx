import { useState } from 'react';
import { Link } from 'react-router';
import { get, post } from '../../../api/client';
import { Button, ErrorBox, FieldWrap, Notice, Table, Td, Textarea, Th } from '../../../components/ui/core';
import { useConfirm, useToast } from '../../../components/ui/overlays';
import { LegalMarkdown } from '../../../components/legal/LegalMarkdown';
import { t } from '../../../i18n';
import { useAuth } from '../../../lib/auth';
import { fmtDateTime, fmtNumber, plural } from '../../../lib/format';
import { SectionCard } from '../shared';
import { FieldGrid, NumField, SettingsForm, TextAreaField, TextField, useSettingsForm, useSettingsQuery, type Values } from './model';

/* ------------------------------------------------------------------------------------------- Datenschutz & Recht */

const PRIVACY_KEYS = ['privacy.controller', 'privacy.dpo_contact', 'privacy.policy_url', 'privacy.upload_notice', 'legal.privacy_text', 'legal.imprint_text'];

function PrivacyFields() {
  const { v, set, ro } = useSettingsForm();
  const missing = !String(v['privacy.controller'] ?? '').trim() || (!String(v['privacy.policy_url'] ?? '').trim() && !String(v['legal.privacy_text'] ?? '').trim());
  return (
    <>
      <SectionCard title="Angaben nach Art. 13 DSGVO" description="Für Upload-Seite, Aushang, Pressemitteilungen und die eigene Datenschutzerklärung." bodyClassName="flex flex-col gap-4">
        {missing && (
          <Notice tone="warning" title="Pflichtangaben fehlen">
            Ohne verantwortliche Stelle und Datenschutzerklärung zeigt die Upload-Seite nur den allgemeinen Hinweis; angemeldete Verwaltung sieht dort eine Erinnerung.
          </Notice>
        )}
        <FieldGrid>
          <TextField k="privacy.controller" label="Verantwortliche Stelle" help="Name und Anschrift, z. B. „Gemeinde Musterstadt, Hauptstraße 1, 12345 Musterstadt“." max={400} />
          <TextField k="privacy.dpo_contact" label="Datenschutzbeauftragte/r (Kontakt)" help="E-Mail-Adresse oder Anschrift; leer lassen, wenn keine Benennung besteht." max={300} />
          <TextField k="privacy.policy_url" label="Datenschutzerklärung (Adresse)" help="Vollständige Adresse mit https://. Wird auf Upload-Seite und Aushang verlinkt. Leer lassen, um die eigene Seite /datenschutz (unten) zu verlinken." max={500} />
        </FieldGrid>
        <TextAreaField k="privacy.upload_notice" label="Eigener Hinweis (optional)" rows={3} max={2000} help="Erscheint zusätzlich im Abschnitt „Datenschutz“ der Upload-Seite, z. B. Rechtsgrundlage oder Ansprechperson. Höchstens 2000 Zeichen." />
        <p className="m-0 text-sm text-fg-muted">
          Die Upload-Seite nennt immer: Zweck, mögliche Veröffentlichung auf Website und in sozialen Netzwerken (Meta, auch USA), was erfasst wird (Dateien, Hinweis, Dateiname, IP-Adresse zur Missbrauchsabwehr), die Speicherdauer und die Rechte der Betroffenen. Fristen: <Link to="/einstellungen/loeschfristen">Löschfristen</Link>.
        </p>
      </SectionCard>
      <SectionCard title="Datenschutzerklärung und Impressum" description="Eigene Seiten unter /datenschutz und /impressum – ohne Anmeldung erreichbar." bodyClassName="flex flex-col gap-5">
        <LegalTextField k="legal.privacy_text" path="/datenschutz" label="Datenschutzerklärung" max={50000} controller={v['privacy.controller'] ?? ''} v={v} set={set} ro={ro('legal.privacy_text')} />
        <LegalTextField k="legal.imprint_text" path="/impressum" label="Impressum" max={20000} controller={v['privacy.controller'] ?? ''} v={v} set={set} ro={ro('legal.imprint_text')} />
      </SectionCard>
    </>
  );
}

export function PrivacyPage() {
  return (
    <SettingsForm keys={PRIVACY_KEYS} label="Datenschutz & Recht">
      <PrivacyFields />
    </SettingsForm>
  );
}

/* -------------------------------------------------------------------------------------------------- Löschfristen */

const RETENTION_KEYS = [
  'privacy.collection_retention_days', 'privacy.deleted_media_days', 'privacy.upload_link_days', 'media.blocked_days', 'media.security_log_days', 'privacy.uploader_months',
  'privacy.upload_ip_retention_days', 'privacy.press_request_months', 'privacy.press_open_months', 'privacy.press_release_log_months', 'privacy.press_contact_review_months',
  'privacy.warning_days', 'privacy.fe2_event_days', 'privacy.official_warning_days', 'privacy.receipt_days', 'privacy.automation_run_days', 'retention.log_days', 'retention.audit_days',
];

function RetentionFields() {
  const { can } = useAuth();
  const { dirty } = useSettingsForm();
  const days = t('admin.common.days');
  return (
    <>
      <SectionCard title="Medien und Upload-Links" bodyClassName="flex flex-col gap-4">
        <FieldGrid>
          <NumField k="privacy.collection_retention_days" label="Abgeschlossene Sammlungen löschen nach" help="Archivierte Sammlungen bzw. Sammlungen ohne aktiven Link, gerechnet ab der letzten Aktivität. Dateien in laufenden Beiträgen bleiben. 0 = nie." unit={days} />
          <NumField k="privacy.deleted_media_days" label="Papierkorb leeren nach" help="Gelöschte Dateien, Ordner und Sammlungen bleiben so lange wiederherstellbar; danach endgültig entfernt. Gilt auch für Datensätze abgewiesener Dateien. 0 = nie automatisch." unit={days} />
          <NumField k="media.blocked_days" label="Gesperrte Dateien löschen nach" help="Dateien mit Prüfbefund liegen so lange in der Quarantäne (erneut prüfen oder trotzdem freigeben möglich), danach samt Datensatz gelöscht. 0 = nie." unit={days} min={0} max={3650} />
          <NumField k="privacy.upload_link_days" label="Abgelaufene Upload-Links" help="Abgelaufene oder widerrufene Links (Token, Bezeichnung) und Weiterleitungen aus dem Import. 0 = nie." unit={days} />
          <NumField k="privacy.uploader_months" label="Angaben der Hochladenden" help="Name, E-Mail-Adresse, Aufnahmeort und -datum (je Upload-Link abfragbar) danach entfernen; die Dateien bleiben. 0 = nie." unit="Monate" min={0} max={120} />
          <NumField k="media.security_log_days" label="Sicherheitsereignisse der Upload-Seiten" help="Gekürzter IP-Hash, Link, Ereignis. 0 = unbegrenzt." unit={days} min={0} max={3650} />
        </FieldGrid>
      </SectionCard>
      <SectionCard title="Presse" bodyClassName="flex flex-col gap-4">
        <FieldGrid>
          <NumField k="privacy.press_request_months" label="Erledigte Presseanfragen" help="Anfrage samt Kontaktdaten, Verlauf, Mails und Anhängen so viele Monate nach der Erledigung löschen. 0 = nie." unit="Monate" min={0} max={120} />
          <NumField k="privacy.press_open_months" label="Nicht erledigte Presseanfragen" help="Neu, in Bearbeitung oder beantwortet: so viele Monate nach der letzten Aktivität löschen. 30 Tage vorher kommt eine Benachrichtigung an „Presseanfragen bearbeiten“; jede Änderung, Notiz oder Mail setzt die Frist zurück. 0 = nie." unit="Monate" min={0} max={120} />
          <NumField k="privacy.press_release_log_months" label="Versandprotokolle der Pressemitteilungen" help="Empfängeradressen, Stand und Fehlermeldungen je Pressemitteilung so viele Monate nach dem Versand löschen; die Zahl der gesendeten und nicht erreichten Empfänger bleibt. 0 = nie." unit="Monate" min={0} max={120} />
          <NumField k="privacy.press_contact_review_months" label="Presseverteiler: Wiedervorlage nach" help="Kontakte ohne Pressemitteilung, Änderung oder „Geprüft“ seit so vielen Monaten erscheinen im Presseverteiler als „zu prüfen“ – gelöscht wird nichts automatisch. 0 = aus." unit="Monate" min={0} max={120} />
        </FieldGrid>
      </SectionCard>
      <SectionCard title="Warnungen, Verbindungen und Workflows" bodyClassName="flex flex-col gap-4">
        <FieldGrid>
          <NumField k="privacy.warning_days" label="Warnvorgänge" help="Nach dem letzten Bearbeitungsschritt des Vorgangs samt Aktualisierungen: Fassungen mit Rückrufkontakt, PDF, Versandnachweise. 0 = nie." unit={days} />
          <NumField k="privacy.fe2_event_days" label="Einsatzmeldungen (FE2, Feuersoftware Connect)" help="Stichwort, Einsatzart, Ort, Zeit, Einheiten. Beiträge und Warnvorgänge daraus bleiben. 0 = nie." unit={days} />
          <NumField k="privacy.official_warning_days" label="Amtliche Warnungen" help="Gerechnet ab dem Ablauf der Warnung, frühestens ab dem letzten Abruf, in dem die Quelle sie noch geliefert hat. 0 = nie." unit={days} />
          <NumField k="privacy.receipt_days" label="Empfangsprotokoll der Verbindungen" help="Abrufe und eingehende Meldungen von amtlichen Warnungen, FE2 und Feuersoftware Connect samt Entscheidung und Rohdaten (Einsatzdaten nur geschwärzt). Höchstens 500 Einträge je Verbindung. 1–30 Tage." unit={days} min={1} max={30} />
          <NumField k="privacy.automation_run_days" label="Laufprotokolle der Workflows" help="Eingangsdaten, Schritte und Freigaben abgeschlossener Läufe (1 bis 3650 Tage)." unit={days} min={1} max={3650} />
        </FieldGrid>
      </SectionCard>
      <SectionCard title="Protokolle und Anmeldungen" bodyClassName="flex flex-col gap-4">
        <FieldGrid>
          <NumField k="retention.log_days" label={t('admin.settings.retLogs')} unit={days} min={1} />
          <NumField k="retention.audit_days" label={t('admin.settings.retAudit')} unit={days} min={30} />
          <NumField k="privacy.upload_ip_retention_days" label="IP-Adressen ohne Konto" help="Öffentliche Uploads und Anmeldeversuche unbekannter Konten: IP danach im Audit entfernt (1 bis 365 Tage)." unit={days} />
        </FieldGrid>
        <BackupRetentionNote />
      </SectionCard>
      <SectionCard id="probelauf" title="Was würde gelöscht?" description="Probelauf mit den gespeicherten Fristen. Der Worker löscht sonst stündlich von selbst." bodyClassName="flex flex-col gap-4">
        <RetentionPreview manage={can('system.retention')} dirty={dirty} />
      </SectionCard>
    </>
  );
}

/** Sicherungen enthalten gelöschte Daten bis zum Ende ihrer Aufbewahrung – eingestellt unter Sicherung (nur Anzeige). */
function BackupRetentionNote() {
  const { saved } = useSettingsForm();
  const { can } = useAuth();
  return (
    <p className="m-0 text-sm text-fg-muted">
      Sicherungen: lokal bleiben die letzten {fmtNumber(Number(saved['backup.keep'] ?? 0))} Sicherungen; gelöschte Daten leben darin bis zu ihrer Rotation weiter (ebenso auf dem Ziel außer Haus).{' '}
      {can('backup.manage') ? <Link to="/einstellungen/sicherung">Aufbewahrung unter Sicherung</Link> : 'Eingestellt unter Sicherung.'}
    </p>
  );
}

export function RetentionPage() {
  useSettingsQuery();
  return (
    <SettingsForm keys={RETENTION_KEYS} label="Löschfristen">
      <RetentionFields />
    </SettingsForm>
  );
}

/* Datenschutzerklärung und Impressum (#187): Markdown mit Vorschau, öffentlich unter /datenschutz bzw. /impressum. */
const TEMPLATE_MARK = "Vorlage – bitte vollständig prüfen und anpassen";
function legalTemplate(kind: "legal.privacy_text" | "legal.imprint_text", controller: string): string {
  const head = `> **${TEMPLATE_MARK}.** Diese Gliederung ist nur ein Ausgangspunkt und ersetzt keine rechtliche Prüfung. Alle Angaben in [eckigen Klammern] ersetzen, nicht zutreffende Abschnitte entfernen und diesen Hinweis zum Schluss löschen.

`;
  const who = controller.trim() || "[Name der Organisation]  \n[Anschrift]";
  if (kind === "legal.imprint_text") {
    return `${head}# Impressum

${who}

**Vertreten durch:** [Name, Funktion]

**Kontakt:** [Telefon] · [E-Mail-Adresse]

**Verantwortlich für den Inhalt:** [Name, Anschrift]

[Weitere Angaben, z. B. Aufsichtsbehörde oder Register]
`;
  }
  return `${head}# Datenschutzerklärung

## Verantwortliche Stelle

${who}

[E-Mail-Adresse, Telefon]

## Datenschutzbeauftragte/r

[Kontakt oder Hinweis, dass keine Benennung besteht]

## Welche Daten verarbeitet werden

### Upload-Links (Upload-Seite)

[Hochgeladene Dateien, abgefragte Angaben, IP-Adresse zur Missbrauchsabwehr]

### Veröffentlichungen auf der Website und Einsatzliste

[Beiträge, Banner und Einträge der Einsatzliste (Alarmzeit, Stichwort, Ort nur als Ortsteil bzw. Gemeinde, Kurzbericht, Fotos) nach Freigabe auf der Website; ggf. Name der Autorin bzw. des Autors; Umgang mit Abgebildeten, Widerspruch und Zurückziehen]

### Soziale Netzwerke

[Nur die tatsächlich genutzten Netzwerke nennen, z. B. Facebook/Instagram (Meta), X, Mastodon (Instanz und Betreiber), Bluesky: welche Inhalte dort veröffentlicht werden, eigene Verantwortung der Betreiber, Drittland (USA), gemeinsame Verantwortung für Seiten-Statistiken bei Meta, Link zur Datenschutzerklärung der Präsenz]

### Anmeldung in BlaulichtCMS

[Konten der Mitarbeitenden, Anmelde- und Aktivitätsprotokoll; Beschäftigte und Ehrenamtliche ggf. gesondert informieren: Push-Benachrichtigungen über die Push-Dienste der Browserhersteller, E-Mail-Benachrichtigungen, Kalender-Abo]

### Presseanfragen

[Anfragen von Journalistinnen und Journalisten per Telefon, E-Mail oder über das Presse-Postfach: Name, Medium, Kontaktdaten, Anfrage, Mails an das Presse-Postfach samt Anhängen; Zweck: Beantwortung (Auskunftsanspruch der Presse nach Landespressegesetz); Löschung nach der Erledigung bzw. nach der letzten Aktivität, siehe Speicherdauer]

### Presseverteiler und Pressemitteilungen

[Name, Medium, berufliche Kontaktdaten von Redaktionen; Herkunft der Adresse (z. B. öffentliche Redaktionsadresse, Visitenkarte, eigene Anfrage); Rechtsgrundlage (z. B. Art. 6 Abs. 1 lit. e DSGVO i. V. m. Landesrecht oder Einwilligung nach Art. 6 Abs. 1 lit. a); Widerspruch bzw. Abmeldung jederzeit über den Link in jeder Mail – danach bleibt nur ein Sperrvermerk (Adresse); Versandprotokolle werden nach einer Frist gelöscht]

## Zwecke und Rechtsgrundlagen

[Zweck je Verarbeitung und Rechtsgrundlage – z. B. Öffentlichkeitsarbeit als öffentliche Aufgabe (Art. 6 Abs. 1 lit. e DSGVO i. V. m. Landesrecht), Auskünfte an die Presse (Art. 6 Abs. 1 lit. c DSGVO i. V. m. Landespressegesetz), Einwilligung]

## Empfänger und Übermittlung in Drittländer

[z. B. Öffentlichkeit (Website), Hoster der Website, Betreiber der sozialen Netzwerke (Meta, X, Bluesky – USA; Mastodon-Instanz je nach Standort), Redaktionen als Empfänger von Pressemitteilungen, Mail- bzw. Microsoft-365-Dienstleister, Hosting- und Sicherungsdienstleister; Grundlage einer Übermittlung in die USA, z. B. EU-US Data Privacy Framework]

## Speicherdauer

[Fristen, siehe Einstellungen → Löschfristen]

## Ihre Rechte

[Auskunft, Berichtigung, Löschung, Einschränkung, Widerspruch (z. B. gegen Veröffentlichung oder Aufnahme in den Presseverteiler), Beschwerde bei der zuständigen Aufsichtsbehörde (Landesbeauftragte bzw. Landesbeauftragter für den Datenschutz)]

## Stand

[Datum]
`;
}

function LegalTextField({ k, path, label, max, controller, v, set, ro }: { k: "legal.privacy_text" | "legal.imprint_text"; path: string; label: string; max: number; controller: string; v: Values; set: (k: string, x: unknown) => void; ro: boolean }) {
  const ask = useConfirm();
  const [preview, setPreview] = useState(false);
  const id = `s-${k.replace(/\W/g, "-")}`;
  const text = String(v[k] ?? "");
  const insert = async () => {
    if (text.trim() && !(await ask({ title: "Mustertext einfügen?", text: "Der bisherige Text wird durch den Mustertext ersetzt.", confirmLabel: "Ersetzen" }))) return;
    set(k, legalTemplate(k, controller));
    setPreview(false);
  };
  return (
    <FieldWrap
      label={label}
      htmlFor={id}
      help={`Markdown (# Überschrift, **fett**, - Liste, [Link](https://…)); HTML wird nicht übernommen. Öffentlich ohne Anmeldung unter ${path}; leer = Seite und Links ausgeblendet. ${text.length.toLocaleString("de-DE")} / ${max.toLocaleString("de-DE")} Zeichen.`}
      labelAction={
        <div className="flex flex-wrap items-center gap-1.5">
          {!ro && (
            <Button size="sm" icon="FileText" onClick={insert}>
              Mustertext einfügen
            </Button>
          )}
          <Button size="sm" icon={preview ? "Pencil" : "Eye"} onClick={() => setPreview((p) => !p)} aria-pressed={preview}>
            {preview ? "Bearbeiten" : "Vorschau"}
          </Button>
        </div>
      }
    >
      {text.includes(TEMPLATE_MARK) && (
        <Notice tone="warning">Der Text enthält noch den Vorlagenhinweis. Bitte alle Angaben prüfen, ergänzen und den Hinweis entfernen.</Notice>
      )}
      {preview ? (
        <div className="border border-line rounded-control p-4 bg-bg min-h-[120px] max-h-[480px] overflow-y-auto">
          {text.trim() ? <LegalMarkdown text={text} /> : <p className="m-0 text-sm text-fg-muted">Noch kein Text hinterlegt.</p>}
        </div>
      ) : (
        <Textarea id={id} rows={10} maxLength={max} disabled={ro} value={text} onChange={(e) => set(k, e.target.value)} />
      )}
      {text.trim() && (
        <a href={path} target="_blank" rel="noopener" className="text-meta self-start">
          Gespeicherte Seite öffnen
        </a>
      )}
    </FieldWrap>
  );
}

interface RetentionReport {
  dry_run: boolean;
  categories: { key: string; label: string; days: number; count: number; detail?: string; note?: string }[];
  collections: { id: string; title: string; last_activity: string; archived: boolean; media: number; kept: number; used_in: string[] }[];
}

/** Probelauf der Löschfristen (#97): „Was würde gelöscht?“ und sofort anwenden. */
function RetentionPreview({ manage, dirty }: { manage: boolean; dirty: boolean }) {
  const ask = useConfirm();
  const toast = useToast();
  const [report, setReport] = useState<RetentionReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { can } = useAuth();
  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await get<RetentionReport>("/system/retention"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!(await ask({ title: "Löschfristen jetzt anwenden?", text: "Alles, was der Probelauf zeigt, wird endgültig gelöscht. Der Worker macht das sonst stündlich von selbst.", confirmLabel: "Jetzt löschen" }))) return;
    setBusy(true);
    try {
      const r = await post<RetentionReport>("/system/retention/run");
      const n = r.categories.reduce((a, c) => a + c.count, 0);
      toast({ tone: "success", title: "Löschfristen angewendet", text: `${plural(n, 'Eintrag', 'Einträge')} gelöscht.` });
      setReport(await get<RetentionReport>("/system/retention"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const total = report?.categories.reduce((a, c) => a + c.count, 0) ?? 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2 items-center">
        <Button size="sm" icon="Search" loading={busy && !report} onClick={load} disabled={busy}>
          Was würde gelöscht?
        </Button>
        {report && manage && total > 0 && (
          <Button size="sm" variant="danger" icon="Trash2" onClick={run} disabled={busy || dirty}>
            Jetzt anwenden
          </Button>
        )}
        {dirty && report && <span className="text-sm text-fg-muted">Geänderte Fristen erst speichern – der Probelauf nutzt die gespeicherten Werte.</span>}
      </div>
      {error && <ErrorBox title="Probelauf fehlgeschlagen">{error}</ErrorBox>}
      {report && (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Daten</Th>
                <Th align="right">Frist</Th>
                <Th align="right">Würde gelöscht</Th>
              </tr>
            </thead>
            <tbody>
              {report.categories.map((c) => (
                <tr key={c.key}>
                  <Td>{c.label}</Td>
                  <Td align="right">{c.days ? `${fmtNumber(c.days)} Tage` : "nie"}</Td>
                  <Td align="right">
                    {fmtNumber(c.count)}
                    {c.detail && c.count ? <span className="text-fg-muted"> ({c.detail})</span> : null}
                    {c.note ? <span className="block text-meta text-fg-muted">{c.note}</span> : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {report.collections.length > 0 && (
            <ul className="m-0 pl-5 text-sm flex flex-col gap-1">
              {report.collections.map((c) => (
                <li key={c.id}>
                  {can("media.view") ? <Link to={`/medien/${c.id}`}>{c.title}</Link> : c.title} – letzte Aktivität {fmtDateTime(c.last_activity)}, {plural(Number(c.media), 'Datei', 'Dateien')}
                  {c.kept > 0 && <span className="text-fg-muted">; {fmtNumber(c.kept)} bleiben (verwendet in {c.used_in.map((x) => `„${x}“`).join(", ")})</span>}
                </li>
              ))}
            </ul>
          )}
          {total === 0 && <p className="m-0 text-sm text-fg-muted">Derzeit ist nichts fällig.</p>}
        </>
      )}
    </div>
  );
}
