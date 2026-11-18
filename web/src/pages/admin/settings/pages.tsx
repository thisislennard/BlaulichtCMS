import { type ReactNode } from 'react';
import { Link } from 'react-router';
import { cx, FieldWrap, LinkButton, Select, Skeleton, Textarea } from '../../../components/ui/core';
import { Icon } from '../../../components/ui/Icon';
import { t } from '../../../i18n';
import { useAuth } from '../../../lib/auth';
import { STATE_OPTIONS, STATES_WITH_CATALOG } from '../../../lib/keywords';
import { fmtBytes, fmtNumber, fmtRelative } from '../../../lib/format';
import { navPath } from '../../../config/navigation';
import { navTrail } from '../../../config/navText';
import { LoadError, SectionCard } from '../shared';
import { fmtUptime, useSystemStatus } from '../SystemStatus';
import { fieldId, FieldGrid, NumField, SettingsForm, SwitchField, TextAreaField, TextField, useSettingsForm, useSettingsQuery } from './model';

/* ---------------------------------------------------------------------------------------------- Organisation */

const ORG_KEYS = ['general.instance_name', 'general.organization', 'general.sender_name', 'general.public_url', 'general.timezone', 'general.state', 'general.language'];

function timeZones(current: string): string[] {
  let list: string[] = [];
  try {
    list = (Intl as any).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    list = [];
  }
  if (!list.length) list = ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'UTC'];
  return list.includes(current) || !current ? list : [current, ...list];
}

/** Vorschau, wo welcher Name erscheint (#256: drei Namensfelder mit Erklärung). */
function NamePreview() {
  const { v } = useSettingsForm();
  const instance = String(v['general.instance_name'] ?? '').trim() || 'BlaulichtCMS';
  const org = String(v['general.organization'] ?? '').trim() || instance;
  const sender = String(v['general.sender_name'] ?? '').trim() || org;
  const rows: [string, string, string][] = [
    ['Kopfzeile, Fenstertitel, Upload-Seite, Aushang, Warnentwurf (PDF)', org, 'Organisation (sonst Instanzname)'],
    ['Push-Mitteilungen, Kalender-Abo, Authenticator-App, Betreff der Sicherheitsmeldungen', instance, 'Instanzname'],
    ['Absender von Pressemitteilungen, Presseantworten und Warnmails', sender, 'Absendername (sonst Organisation)'],
  ];
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <h3 className="m-0 text-sm font-semibold">So erscheinen die Namen</h3>
      <dl className="m-0 grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] text-sm bg-raised rounded-node p-3">
        {rows.map(([where, value, from]) => (
          <div key={where} className="contents">
            <dt className="text-fg-muted">{where}</dt>
            <dd className="m-0 min-w-0">
              <span className="font-medium break-words">{value}</span> <span className="text-meta text-fg-muted">· {from}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function OrganisationFields() {
  const { v, set, ro, env } = useSettingsForm();
  return (
    <>
      <SectionCard title="Namen" description="Drei Namen für verschiedene Stellen – die Vorschau zeigt, wo welcher erscheint." bodyClassName="flex flex-col gap-5">
        <FieldGrid>
          <TextField k="general.instance_name" label={t('admin.settings.instanceName')} required help="Name dieser Installation, z. B. „BlaulichtCMS Musterwehr“. Für Push, Kalender-Abo und Authenticator-App." />
          <TextField k="general.organization" label="Organisation" help="Erscheint in der Kopfzeile, auf Upload-Seiten, Aushängen und Warnentwürfen." />
          <TextField k="general.sender_name" label="Absendername" help="Name vor der Absenderadresse von E-Mails (Pressemitteilungen, Antworten, Warnversand)." />
        </FieldGrid>
        <NamePreview />
      </SectionCard>
      <SectionCard title="Adresse, Zeit und Sprache" bodyClassName="flex flex-col gap-5">
        <FieldGrid>
          <TextField
            k="general.public_url"
            label={t('admin.settings.publicUrl')}
            help={`Steht in Einladungen, Upload-Links und QR-Codes. Bereits gedruckte Codes zeigen weiter auf die alte Adresse.${env?.publicUrl ? ` Umgebung: ${env.publicUrl}` : ''}`}
          />
          <FieldWrap
            label={t('admin.settings.timezone')}
            htmlFor={fieldId('general.timezone')}
            help="Gilt für alle Zeitangaben: Anzeige und Eingabe von Datum und Uhrzeit, Verläufe, Kalender, Benachrichtigungen, Vorgangsnummern und zeitgesteuerte Abläufe. Gespeichert wird zeitzonenneutral, ein Wechsel stellt auch ältere Einträge um."
          >
            <Select id={fieldId('general.timezone')} disabled={ro('general.timezone')} value={v['general.timezone']} onChange={(e) => set('general.timezone', e.target.value)}>
              {timeZones(v['general.timezone']).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          </FieldWrap>
          <FieldWrap
            label="Bundesland"
            htmlFor={fieldId('general.state')}
            help={
              <>
                Legt das Stichwortverzeichnis fest ({navTrail('warningConfig')}). Mitgeliefert für {STATE_OPTIONS.filter((x) => STATES_WITH_CATALOG.includes(x.id)).map((x) => x.name).join(' und ')}; für andere Länder eine eigene Liste importieren.{' '}
                <Link to="/hilfe/stichwoerter-regeln#stichwortverzeichnis-der-laender">Mehr dazu</Link>
              </>
            }
          >
            <Select id={fieldId('general.state')} disabled={ro('general.state')} value={v['general.state'] ?? ''} onChange={(e) => set('general.state', e.target.value)}>
              <option value="">Nicht gewählt</option>
              {STATE_OPTIONS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {STATES_WITH_CATALOG.includes(x.id) ? ' (Verzeichnis mitgeliefert)' : ''}
                </option>
              ))}
              <option value="eigen">Eigene Liste (ohne Landesverzeichnis)</option>
            </Select>
          </FieldWrap>
          <FieldWrap label={t('admin.settings.language')} htmlFor={fieldId('general.language')}>
            <Select id={fieldId('general.language')} disabled={ro('general.language')} value={v['general.language']} onChange={(e) => set('general.language', e.target.value)}>
              <option value="de">{t('admin.settings.languages.de')}</option>
              <option value="en">{t('admin.settings.languages.en')}</option>
            </Select>
          </FieldWrap>
        </FieldGrid>
      </SectionCard>
    </>
  );
}

export function OrganisationPage() {
  return (
    <SettingsForm keys={ORG_KEYS} label="Organisation">
      <OrganisationFields />
    </SettingsForm>
  );
}

/* ---------------------------------------------------------------------------------------- Redaktion & Freigabe */

const EDITORIAL_KEYS = ['editorial.four_eyes', 'editorial.alt_text_required', 'press.reply_approval', 'invites.valid_hours', 'press.reminder_hours'];

export function EditorialPage() {
  return (
    <SettingsForm keys={EDITORIAL_KEYS} label="Redaktion & Freigabe">
      <SectionCard title="Freigabe" description="Vorgaben für Beiträge, Banner, Warnentwürfe und Presseantworten." bodyClassName="flex flex-col gap-4">
        <SwitchField k="editorial.four_eyes" label="Vier-Augen-Prinzip" description="Wer am Inhalt geschrieben oder die Fassung eingereicht hat, darf sie nicht selbst freigeben. Gilt für Beiträge, Banner und Warnentwürfe." />
        <SwitchField k="editorial.alt_text_required" label="Alternativtext ist Pflicht" description="An: Ohne Alternativtext je Bild lässt sich ein Beitrag für Website oder soziale Netzwerke nicht freigeben. Aus: Die Freigabe zeigt nur eine Warnung." />
        <SwitchField k="press.reply_approval" label="Antworten an die Presse freigeben lassen" description="Antworten auf Presseanfragen gehen erst raus, wenn eine zweite Person mit „Antworten an die Presse freigeben“ zugestimmt hat." />
      </SectionCard>
      <SectionCard title="Fristen" bodyClassName="flex flex-col gap-4">
        <FieldGrid>
          <NumField k="invites.valid_hours" label="Einladungen gültig" help="So lange gilt der Link einer Einladung oder eines Passwort-Zurücksetzens (1 bis 720 Stunden)." unit="Std." min={1} max={720} />
          <NumField k="press.reminder_hours" label="Erinnerung vor Frist (Presseanfragen)" help="An die zuständige Person, sonst an alle mit „Presseanfragen bearbeiten“. 0 = nur bei Überschreitung." unit="Std." min={0} max={72} />
        </FieldGrid>
      </SectionCard>
    </SettingsForm>
  );
}

/* -------------------------------------------------------------------------------------------- Medien & Upload */

const MEDIA_KEYS = [
  'media.max_file_mb', 'media.link_max_files', 'media.link_default_days', 'media.link_max_days', 'media.collection_max_files', 'media.collection_max_gb',
  'media.min_free_gb', 'media.export_hours', 'media.export_max_gb', 'media.storage_warn_gb', 'media.strip_location', 'media.allowed_types', 'media.max_image_mp',
  'media.max_video_minutes', 'media.max_video_edge', 'media.full_decode_seconds', 'media.check_timeout_s', 'media.video_full_decode', 'media.allow_animated',
  'media.face_detect', 'media.face_threshold', 'media.notices', 'media.camera_buttons', 'media.link_show_once', 'media.done_text',
];

const TYPE_OPTIONS: [string, string][] = [
  ['jpeg', 'JPEG'],
  ['png', 'PNG'],
  ['webp', 'WebP'],
  ['heic', 'HEIC/HEIF'],
  ['avif', 'AVIF'],
  ['gif', 'GIF'],
  ['mp4', 'MP4'],
  ['mov', 'MOV'],
  ['webm', 'WebM'],
  ['3gp', '3GP'],
];

/** Global erlaubte Dateitypen (je Upload-Link weiter einschränkbar). */
function AllowedTypesField() {
  const { v, set, ro } = useSettingsForm();
  const list = Array.isArray(v['media.allowed_types']) ? (v['media.allowed_types'] as string[]) : [];
  const readOnly = ro('media.allowed_types');
  return (
    <fieldset id={fieldId('media.allowed_types')} className="m-0 p-0 border-0 flex flex-col gap-2">
      <legend className="text-sm font-medium mb-1">Erlaubte Dateitypen</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {TYPE_OPTIONS.map(([k, label]) => (
          <label key={k} className="inline-flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 accent-[var(--bc-primary-solid)]"
              disabled={readOnly || (list.length === 1 && list.includes(k))}
              checked={list.includes(k)}
              onChange={(e) => set('media.allowed_types', e.target.checked ? [...list, k] : list.filter((x) => x !== k))}
            />
            {label}
          </label>
        ))}
      </div>
      <p className="m-0 text-meta text-fg-muted">Geprüft wird der Dateiinhalt. Je Upload-Link lässt sich die Auswahl weiter einschränken; mindestens ein Typ bleibt erlaubt.</p>
    </fieldset>
  );
}

export function MediaPage() {
  const { can } = useAuth();
  return (
    <SettingsForm keys={MEDIA_KEYS} label="Medien & Upload">
      <SectionCard title="Grenzen und Speicher" description="Neue Dateien landen immer zuerst in der Prüfung." bodyClassName="flex flex-col gap-4">
        <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))]">
          <NumField k="media.max_file_mb" label="Maximale Dateigröße" unit="MB" min={1} max={20000} />
          <NumField k="media.collection_max_files" label="Dateien je Sammlung" min={1} max={100000} />
          <NumField k="media.collection_max_gb" label="Speicher je Sammlung" unit="GB" min={1} max={10000} />
          <NumField k="media.min_free_gb" label="Mindestens frei halten" help="Darunter werden Uploads gesperrt und der Healthcheck meldet einen Fehler." unit="GB" min={1} max={10000} />
          <NumField k="media.storage_warn_gb" label="Speicherwarnung unter" help="Benachrichtigung an „Medien administrieren“ (höchstens alle 12 Stunden). 0 = aus." unit="GB" min={0} max={100000} />
          <NumField k="media.export_hours" label="ZIP-Downloads verfügbar" help="Danach wird das ZIP gelöscht." unit="Std." min={1} max={336} />
          <NumField k="media.export_max_gb" label="Max. Größe eines ZIP" unit="GB" min={1} max={500} />
        </FieldGrid>
        <AllowedTypesField />
        <SwitchField k="media.strip_location" label="Standortdaten auch aus Originalen entfernen" description="Nach der Prüfung werden GPS-Angaben, Seriennummern, Personen- und XMP/IPTC-Angaben verlustfrei aus dem Original entfernt (Bilddaten bleiben unverändert, Videos werden ohne Metadaten umverpackt). Entfernte Angaben lassen sich nicht wiederherstellen." />
        <SwitchField k="media.notices" label="Benachrichtigungen zu Medien" description="Neue Dateien über Upload-Links (gebündelt je Sammlung), Link läuft bald ab, Kontingent erreicht, Speicher knapp. Jede Person kann einzelne Arten unter „Mein Konto“ abschalten." />
      </SectionCard>

      <SectionCard
        title="Upload-Links und Upload-Seite"
        description="Vorgaben für neue Upload-Links. Aussehen der Seite: eigene Seite."
        action={can('media.design') ? <LinkButton to={navPath('uploadPage')} size="sm" variant="ghost" icon="PanelTop">Upload-Seite gestalten</LinkButton> : undefined}
        bodyClassName="flex flex-col gap-4"
      >
        <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))]">
          <NumField k="media.link_max_files" label="Dateien je Upload-Link" min={1} max={1000} />
          <NumField k="media.link_default_days" label="Upload-Link gültig (Standard)" unit={t('admin.common.days')} min={1} max={90} />
          <NumField k="media.link_max_days" label="Upload-Link höchstens gültig" help="Gilt auch für „Verlängern“ und „Bis Termin“." unit={t('admin.common.days')} min={1} max={365} />
        </FieldGrid>
        <SwitchField k="media.link_show_once" label="Upload-Links nur einmal anzeigen" description="Link und QR-Code erscheinen nur direkt nach dem Anlegen bzw. „Neu erzeugen“; gespeichert wird nur eine Prüfsumme. Aus: jederzeit erneut abrufbar (verschlüsselt gespeichert). Gilt für neu angelegte und neu erzeugte Links." />
        <SwitchField k="media.camera_buttons" label="Knöpfe „Foto aufnehmen“ und „Video aufnehmen“ auf dem Handy anzeigen" description="Auf Touch-Geräten öffnen sie direkt die Kamera. Der große Knopf „Bilder oder Videos auswählen“ (Galerie) ist immer da." />
        <DoneText />
      </SectionCard>

      <SectionCard title="Inhaltsprüfung und Gesichtsvorschläge" description="Was beim Prüfen neuer Dateien gilt." bodyClassName="flex flex-col gap-4">
        <FieldGrid className="grid-cols-[repeat(auto-fit,minmax(min(220px,100%),1fr))]">
          <NumField k="media.max_image_mp" label="Max. Bildauflösung" help="Größere Bilder werden gesperrt (Schutz vor Dekompressionsbomben)." unit="MP" min={1} max={500} />
          <NumField k="media.max_video_minutes" label="Max. Videodauer" unit="Min." min={1} max={600} />
          <NumField k="media.max_video_edge" label="Max. Videoauflösung (längere Kante)" unit="Pixel" min={320} max={8192} />
          <NumField k="media.full_decode_seconds" label="Videos Bild für Bild prüfen bis" help="Längere Videos: dieser Anfang Bild für Bild, danach alle Schlüsselbilder." unit="Sek." min={10} max={36000} />
          <NumField k="media.check_timeout_s" label="Zeitlimit je Prüfung/Umwandlung" unit="Sek." min={60} max={14400} />
          <NumField k="media.face_threshold" label="Mindestsicherheit der Gesichtsvorschläge" help="Niedriger: mehr Vorschläge, auch Fehltreffer. Höher: weniger Fehltreffer, aber mehr übersehene Gesichter. Standard 60 %." unit="%" min={30} max={95} />
        </FieldGrid>
        <SwitchField k="media.video_full_decode" label="Videos zur Prüfung dekodieren (empfohlen)" description="Findet beschädigte oder manipulierte Videos, bevor jemand sie öffnet. Fällt ein Video nur hier auf, kann „Medien administrieren“ es nach eigener Prüfung trotzdem freigeben." />
        <SwitchField k="media.allow_animated" label="Animierte Bilder (GIF, WebP, PNG, AVIF) zulassen" description="Vorschau und öffentliche Fassung zeigen das erste Bild. Aus: animierte Bilder werden gesperrt." />
        <SwitchField k="media.face_detect" label="Gesichter automatisch vorschlagen" description="Nach der Prüfung sucht BlaulichtCMS lokal im Container nach Gesichtern und schlägt sie unter „Datenschutz und Unkenntlichmachen“ vor. Unkenntlich wird nur, was jemand übernimmt; gespeichert werden nur Rechtecke – keine Wiedererkennung." />
        <p className="m-0 flex items-start gap-2 text-sm text-fg-muted">
          <Icon name="ShieldCheck" size={15} className="mt-0.5 shrink-0" />
          Öffentliche Fassungen enthalten keine Standort- und Kameradaten. Originale bleiben privat und sind nur mit Recht abrufbar. Fristen für gesperrte Dateien und den Papierkorb: <Link to="/einstellungen/loeschfristen">Löschfristen</Link>.
        </p>
      </SectionCard>
    </SettingsForm>
  );
}

function DoneText() {
  return <TextAreaField k="media.done_text" label="Text nach erfolgreichem Upload (optional)" rows={2} max={1000} help="Leer = „Die Dateien sind angekommen und werden geprüft, bevor sie verwendet werden.“ Die Vorgangsnummer erscheint immer darunter." />;
}

/* -------------------------------------------------------------------------------------------------- Sicherheit */

const SECURITY_KEYS = [
  'security.require_2fa_admins', 'security.require_2fa_media', 'security.require_2fa_all', 'security.session_idle_minutes', 'security.session_max_hours',
  'security.lockout_attempts', 'security.lockout_minutes', 'security.password_min_length', 'security.allowed_private_hosts', 'security.remember_enabled',
  'security.mfa_remember_enabled', 'security.remember_days', 'security.mfa_remember_days', 'security.alert_inapp', 'security.alert_mail_admins',
  'security.alert_mail_user', 'security.alert_failed_logins', 'security.alert_downloads',
];

function PrivateHosts() {
  const { v, set, ro } = useSettingsForm();
  const id = fieldId('security.allowed_private_hosts');
  return (
    <FieldWrap
      label="Interne Ziele freigeben"
      htmlFor={id}
      help="Ein Host je Zeile, z. B. mail.intern.example, *.intern.example oder eine IP-Adresse. Abrufe aus BlaulichtCMS (Feeds, Kalender-Abos, Update-Prüfung, IMAP des Presse-Postfachs) gehen sonst nur an öffentliche Adressen; der IMAP-Abruf darf zu diesen Hosts auch andere Ports als 993/143 nutzen. Nur eintragen, was wirklich intern erreichbar sein muss."
    >
      <Textarea
        id={id}
        rows={3}
        mono
        spellCheck={false}
        autoComplete="off"
        disabled={ro('security.allowed_private_hosts')}
        value={((v['security.allowed_private_hosts'] as string[] | undefined) ?? []).join('\n')}
        onChange={(e) => set('security.allowed_private_hosts', e.target.value.split('\n'))}
      />
    </FieldWrap>
  );
}

function SecurityFields() {
  const { v } = useSettingsForm();
  const grid = 'grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))]';
  return (
    <>
      <SectionCard title="Anmeldung" description={t('admin.settings.secDesc')} bodyClassName="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <SwitchField k="security.require_2fa_admins" label={t('admin.settings.req2faAdmins')} description={t('admin.settings.req2faAdminsDesc')} disabled={!!v['security.require_2fa_all']} />
          <SwitchField k="security.require_2fa_media" label={t('admin.settings.req2faMedia')} description={t('admin.settings.req2faMediaDesc')} disabled={!!v['security.require_2fa_all']} />
          <SwitchField k="security.require_2fa_all" label={t('admin.settings.req2faAll')} description={t('admin.settings.req2faAllDesc')} />
        </div>
        <FieldGrid className={grid}>
          <NumField k="security.session_idle_minutes" label={t('admin.settings.idle')} help={t('admin.settings.idleHelp')} unit={t('admin.common.minutes')} min={5} />
          <NumField k="security.session_max_hours" label={t('admin.settings.maxSession')} unit={t('admin.common.hours')} min={1} />
          <NumField k="security.lockout_attempts" label={t('admin.settings.lockAttempts')} unit={t('admin.settings.attempts')} />
          <NumField k="security.lockout_minutes" label={t('admin.settings.lockMinutes')} unit={t('admin.common.minutes')} min={1} />
          <NumField k="security.password_min_length" label={t('admin.settings.pwLen')} help={t('admin.settings.pwLenHelp')} unit={t('admin.settings.chars')} min={10} max={128} />
        </FieldGrid>
      </SectionCard>
      <SectionCard title="Angemeldet bleiben und gemerkte Geräte" description="Gilt für alle Rollen. Gemerkte Sitzungen und Geräte sind an das Geräte-Cookie des Browsers gebunden; kritische Aktionen verlangen weiterhin Passwort und Code. Abschalten beendet gemerkte Sitzungen bzw. entfernt gemerkte Geräte sofort." bodyClassName="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <SwitchField k="security.remember_enabled" label="„Angemeldet bleiben“ erlauben" description="Ankreuzfeld auf der Anmeldeseite (in der installierten App vorbelegt). Keine Abmeldung bei Leerlauf; die Sitzung endet erst nach der eingestellten Zeit ohne Nutzung." />
          <SwitchField k="security.mfa_remember_enabled" label="Zwei-Faktor auf einem Gerät merken erlauben" description="Nach einem Code aus der Authenticator-App fragt die Anmeldung auf diesem Gerät eine Zeit lang nur das Passwort ab. Wiederherstellungscodes merken kein Gerät." />
        </div>
        <FieldGrid className={grid}>
          <NumField k="security.remember_days" label="Angemeldet bleiben: Ablauf ohne Nutzung" help="1 bis 180 Tage seit der letzten Nutzung." unit={t('admin.common.days')} />
          <NumField k="security.mfa_remember_days" label="Gerät für Zwei-Faktor merken" help="1 bis 90 Tage ab der Code-Eingabe." unit={t('admin.common.days')} />
        </FieldGrid>
      </SectionCard>
      <SectionCard title="Sicherheitsmeldungen" description="Bei Kontosperren, benutzten Wiederherstellungscodes, vergebenen oder entzogenen Admin-Rechten, zurückgesetzter oder abgeschalteter Zwei-Faktor-Anmeldung, geänderten Sicherheitseinstellungen, falschen Website-, FE2- oder API-Schlüsseln, neuen Website-Kopplungen und auffälligen Mengen." bodyClassName="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <SwitchField k="security.alert_inapp" label="Benachrichtigung an die Administration" description="In BlaulichtCMS an alle mit „Sicherheitseinstellungen ändern“ (Konten- und Rechteereignisse an die Rechte der Benutzerverwaltung)." />
          <SwitchField k="security.alert_mail_admins" label="Zusätzlich per E-Mail an die Administration" description="Nur wenn der E-Mail-Versand eingerichtet ist (Einstellungen → E-Mail & Push)." />
          <SwitchField k="security.alert_mail_user" label="Betroffene Person per E-Mail informieren" description="Bei Passwortänderung, Zwei-Faktor-Änderungen, Wiederherstellungscode und Sperre (in BlaulichtCMS immer). Nur mit eingerichtetem E-Mail-Versand." />
        </div>
        <FieldGrid className={grid}>
          <NumField k="security.alert_failed_logins" label="Meldung ab Fehlversuchen" help="Über alle Konten in 15 Minuten; 0 = aus." unit="in 15 Min." />
          <NumField k="security.alert_downloads" label="Meldung ab Downloads" help="Originale oder Exportdateien einer Person pro Stunde; 0 = aus." unit="pro Std." />
        </FieldGrid>
      </SectionCard>
      <SectionCard title="Netz" bodyClassName="flex flex-col gap-4">
        <PrivateHosts />
      </SectionCard>
    </>
  );
}

export function SecurityPage() {
  return (
    <SettingsForm keys={SECURITY_KEYS} label="Sicherheit">
      <SecurityFields />
    </SettingsForm>
  );
}

/* --------------------------------------------------------------------------------------------------- Workflows */

export function WorkflowsPage() {
  return (
    <SettingsForm keys={['automations.enabled', 'automations.max_runs_per_minute']} label="Workflows">
      <SectionCard title="Ausführung" description="Gilt für alle Workflows; die Abläufe selbst stehen unter Einrichtung → Workflows." bodyClassName="flex flex-col gap-4">
        <SwitchField k="automations.enabled" label="Workflows ausführen" description="Globaler Schalter für alle Workflows. Aus: Ereignisse und Zeitpläne starten keine Läufe mehr, offene Läufe werden abgebrochen. Die Abläufe selbst bleiben erhalten." />
        <FieldGrid>
          <NumField k="automations.max_runs_per_minute" label="Läufe je Workflow und Minute höchstens" help="Schutz gegen Schleifen und Fluten: darüber werden Ereignisse verworfen und die Verwaltung benachrichtigt (1 bis 600)." min={1} max={600} />
        </FieldGrid>
        <p className="m-0 text-sm text-fg-muted">
          Laufprotokolle werden nach der Frist unter <Link to="/einstellungen/loeschfristen">Löschfristen</Link> gelöscht.
        </p>
      </SectionCard>
    </SettingsForm>
  );
}

/* ------------------------------------------------------------------------------------------------------ System */

function OpsTiles() {
  const q = useSystemStatus(30_000);
  const d = q.data;
  const db = d?.services.find((s) => s.id === 'db');
  const worker = d?.services.find((s) => s.id === 'worker');
  const queueSvc = d?.services.find((s) => s.id === 'queue');
  const live = d ? d.workers.filter((w) => Date.now() - new Date(w.last_seen_at).getTime() < 45_000).length : 0;
  const tiles: { k: string; v: ReactNode; sub: ReactNode; state: string }[] = d
    ? [
        { k: t('admin.settings.uptime'), v: fmtUptime(d.uptimeSec), sub: `v${d.version} · Node ${d.node.replace(/^v/, '')}`, state: 'ok' },
        { k: t('admin.settings.database'), v: db?.detail ?? '–', sub: `${fmtBytes(d.dbSize)} · ${t(`admin.common.state.${db?.state ?? 'warning'}`)}`, state: db?.state ?? 'warning' },
        { k: t('admin.settings.queue'), v: t('admin.settings.queueVal', { n: fmtNumber(d.queue.ready + d.queue.scheduled + d.queue.running) }), sub: t('admin.settings.queueSub', { workers: live }), state: worker?.state === 'error' ? 'error' : (queueSvc?.state ?? 'ok') },
        {
          k: t('admin.settings.lastBackup'),
          v: d.lastBackup ? fmtRelative(d.lastBackup.started_at) : t('admin.system.noBackup'),
          sub: d.lastBackup ? `${t(`admin.settings.backupStatus.${d.lastBackup.status}`)}${d.lastBackup.size_bytes ? ' · ' + fmtBytes(d.lastBackup.size_bytes) : ''}` : '–',
          state: !d.lastBackup ? 'warning' : d.lastBackup.status === 'failed' ? 'error' : d.lastBackup.status === 'ok' ? 'ok' : 'warning',
        },
      ]
    : [];
  const dot: Record<string, string> = { ok: 'bg-ok', warning: 'bg-warn', error: 'bg-err' };
  if (q.isError) return <LoadError error={q.error} onRetry={() => q.refetch()} />;
  if (!d)
    return (
      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))]">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-[84px] rounded-node" />
        ))}
      </div>
    );
  return (
    <dl className="m-0 grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))]">
      {tiles.map((x) => (
        <div key={String(x.k)} className="bg-raised rounded-node px-3.5 py-3 flex flex-col gap-1 min-w-0">
          <dt className="text-meta text-fg-muted">{x.k}</dt>
          <dd className="m-0 flex items-center gap-2 font-semibold text-base min-w-0">
            <span aria-hidden="true" className={cx('w-2 h-2 rounded-full shrink-0', dot[x.state] ?? 'bg-fg-muted')} />
            <span className="truncate">{x.v}</span>
            <span className="sr-only">({t(`admin.common.state.${x.state}`)})</span>
          </dd>
          <dd className="m-0 text-meta text-fg-muted truncate">{x.sub}</dd>
        </div>
      ))}
    </dl>
  );
}

function SystemInfo() {
  const { me, can } = useAuth();
  const q = useSettingsQuery();
  const status = useSystemStatus(false, can('system.status'));
  const env = q.data?.env;
  return (
    <dl className="m-0 grid gap-x-6 gap-y-2 grid-cols-[max-content_1fr] text-sm">
      <dt className="text-fg-muted">{t('admin.settings.version')}</dt>
      <dd className="m-0 font-mono">{me?.version ?? '–'}</dd>
      <dt className="text-fg-muted">{t('admin.settings.node')}</dt>
      <dd className="m-0 font-mono">{status.data?.node ?? '–'}</dd>
      {env?.dataDir && (
        <>
          <dt className="text-fg-muted">{t('admin.settings.dataDir')}</dt>
          <dd className="m-0 font-mono text-meta break-all">{env.dataDir}</dd>
        </>
      )}
      {env?.trustedProxies && (
        <>
          <dt className="text-fg-muted">{t('admin.settings.trustedProxies')}</dt>
          <dd className="m-0 font-mono text-meta break-all">{env.trustedProxies.length ? env.trustedProxies.join(', ') : t('admin.settings.trustedProxiesNone')}</dd>
        </>
      )}
    </dl>
  );
}

export function SystemPage() {
  const { can } = useAuth();
  return (
    <>
      <SettingsForm keys={['jobs.concurrency']} label="System">
        <SectionCard title="Hintergrundaufträge" bodyClassName="flex flex-col gap-4">
          <FieldGrid>
            <NumField k="jobs.concurrency" label="Parallele Hintergrundaufträge" help="1 bis 32 (Medienprüfung, Exporte, Versand). Ein Viertel (mindestens einer) bleibt immer frei für Warnversand, Benachrichtigungen und Medienprüfung – Social-Posts, Workflows, Presseversand und Sicherung außer Haus belegen höchstens den Rest." min={1} max={32} />
          </FieldGrid>
        </SectionCard>
      </SettingsForm>
      <SectionCard
        title="Betrieb und Systeminformationen"
        description="Kurzüberblick – Dienste, Protokolle und Wartungsmodus stehen im Systemstatus."
        action={can('system.status') ? <LinkButton to={navPath('status')} size="sm" variant="ghost" icon="Activity">{t('admin.settings.statusPage')}</LinkButton> : undefined}
        bodyClassName="flex flex-col gap-4"
      >
        {can('system.status') && <OpsTiles />}
        <SystemInfo />
        <div className="flex gap-2 flex-wrap">
          <LinkButton to="/hilfe" icon="BookOpen">
            {t('admin.settings.openHelp')}
          </LinkButton>
          {can('update.view') && (
            <LinkButton to="/einstellungen/updates" icon="Download">
              Updates & Wartung
            </LinkButton>
          )}
        </div>
      </SectionCard>
    </>
  );
}
