import { useState } from "react";
import { Link } from "react-router";
import { download, get, post, qs } from "../../api/client";
import { Badge, Button, Card, EmptyState, ErrorBox, Input, Notice, PageHeader } from "../../components/ui/core";
import { useConfirm, useErrorToast, useToast } from "../../components/ui/overlays";
import { fmtDateTime } from "../../lib/format";

type HitKind = "user" | "media" | "upload_session" | "warning" | "responsibility" | "fe2_event" | "post" | "session" | "audit";
interface Hit {
  kind: HitKind;
  id: string;
  title: string;
  at: string | null;
  fields: Record<string, unknown>;
  actions: ("delete" | "pseudonymize")[];
  note?: string;
  link?: string;
}

const KIND_LABEL: Record<HitKind, string> = {
  user: "Konten",
  media: "Hochgeladene Dateien",
  upload_session: "Unterbrochene Uploads",
  warning: "Warnvorgänge",
  responsibility: "Zuständigkeiten (Warnempfänger)",
  fe2_event: "FE2-Meldungen",
  post: "Beiträge",
  session: "Sitzungen",
  audit: "Audit-Protokoll",
};
const ORDER: HitKind[] = ["media", "upload_session", "warning", "responsibility", "fe2_event", "post", "user", "session", "audit"];

function fieldText(v: unknown): string {
  if (v == null || v === "") return "–";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "–";
  if (typeof v === "boolean") return v ? "ja" : "nein";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Auskunft und Löschung je Person (#141, Art. 15/17 DSGVO). */
export default function PrivacyRequests() {
  const ask = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  const [term, setTerm] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (q = term.trim()) => {
    if (q.length < 3) return setError("Bitte mindestens 3 Zeichen eingeben.");
    setBusy(true);
    setError(null);
    try {
      const r = await get<{ hits: Hit[] }>(`/privacy/search${qs({ q })}`);
      setHits(r.hits);
      setSearched(q);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (h: Hit, action: "delete" | "pseudonymize") => {
    const text =
      action === "pseudonymize"
        ? "Dateiname und Hinweis werden durch neutrale Angaben ersetzt; die Datei selbst bleibt."
        : h.kind === "warning"
          ? "Der ganze Vorgang wird mit Aktualisierungen, Entwarnung, PDF und Versandnachweisen endgültig gelöscht."
          : "Der Eintrag wird endgültig gelöscht (Dateien samt aller Fassungen). In Sicherungen bleibt er bis zu deren Ablauf.";
    if (!(await ask({ title: action === "delete" ? "Endgültig löschen?" : "Pseudonymisieren?", text, confirmLabel: action === "delete" ? "Löschen" : "Pseudonymisieren" }))) return;
    try {
      await post("/privacy/action", { kind: h.kind, id: h.id, action });
      toast({ tone: "success", title: action === "delete" ? "Gelöscht" : "Pseudonymisiert" });
      if (searched) await search(searched);
    } catch (e) {
      toastError(e);
    }
  };

  const groups = ORDER.map((k) => ({ kind: k, items: (hits ?? []).filter((h) => h.kind === k) })).filter((g) => g.items.length);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Datenschutzanfragen" subtitle="Auskunft (Art. 15) und Löschung (Art. 17 DSGVO): gespeicherte Daten zu einer Person finden, exportieren und löschen." />
      <Card>
        <form
          className="flex flex-col sm:flex-row gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <Input aria-label="Suchbegriff" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Name, E-Mail, Telefonnummer, Vorgangsnummer (z. B. K7M2-Q9XD), Dateiname oder IP-Adresse" className="flex-1" maxLength={200} />
          <Button type="submit" variant="primary" icon="Search" loading={busy} disabled={busy}>
            Suchen
          </Button>
          {searched && hits && hits.length > 0 && (
            <Button type="button" icon="Download" onClick={() => download(`/privacy/export${qs({ q: searched })}`)}>
              Auskunft als ZIP
            </Button>
          )}
        </form>
        <p className="m-0 mt-3 text-sm text-fg-muted">
          Gesucht wird in Uploads (Hinweis, Dateiname, Vorgangsnummer), Warnvorgängen (Rückrufkontakt, Empfänger), Zuständigkeiten, FE2-Meldungen, Beiträgen, Konten, Sitzungen und im Audit. Suche, Export und jede Löschung werden protokolliert. Die ZIP-Datei enthält alle Treffer und die hochgeladenen Originale – vor der Herausgabe prüfen, ob sie Daten anderer Personen enthält.
        </p>
      </Card>
      {error && <ErrorBox title="Suche nicht möglich">{error}</ErrorBox>}
      {hits && hits.length === 0 && <EmptyState icon="SearchX" title="Keine Treffer" text={`Zu „${searched}“ sind keine Daten gespeichert. Sicherungen enthalten gelöschte Daten noch bis zu deren Ablauf.`} />}
      {groups.map((g) => (
        <Card key={g.kind} title={KIND_LABEL[g.kind]} subtitle={`${g.items.length} Treffer${g.items.length >= 200 ? " (gekürzt – Suche genauer fassen)" : ""}`}>
          <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
            {g.items.map((h) => (
              <li key={`${h.kind}-${h.id}`} className="py-3 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{h.link ? <Link to={h.link}>{h.title}</Link> : h.title}</span>
                  {h.at && <span className="text-meta text-fg-muted">{fmtDateTime(h.at)}</span>}
                  <span className="flex-1" />
                  {h.actions.includes("pseudonymize") && (
                    <Button size="sm" icon="EyeOff" onClick={() => act(h, "pseudonymize")}>
                      Pseudonymisieren
                    </Button>
                  )}
                  {h.actions.includes("delete") && (
                    <Button size="sm" variant="danger" icon="Trash2" onClick={() => act(h, "delete")}>
                      Löschen
                    </Button>
                  )}
                  {!h.actions.length && <Badge tone="neutral">nur Auskunft</Badge>}
                </div>
                <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-sm">
                  {Object.entries(h.fields).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-fg-muted">{k.replace(/_/g, " ")}</dt>
                      <dd className="m-0 break-words min-w-0">{fieldText(v)}</dd>
                    </div>
                  ))}
                </dl>
                {h.note && <p className="m-0 text-sm text-fg-muted">{h.note}</p>}
              </li>
            ))}
          </ul>
        </Card>
      ))}
      {hits && hits.length > 0 && (
        <Notice>
          Was nicht gelöscht wird: Audit-Einträge bleiben bis zum Ablauf der Audit-Frist (Nachweispflicht), IP-Adressen ohne Konto werden nach der eingestellten Frist entfernt. Bereits veröffentlichte Inhalte auf Website und sozialen Medien im Beitrag zurückziehen. Einzelheiten: Hilfe → Sicherheit.
        </Notice>
      )}
    </div>
  );
}
