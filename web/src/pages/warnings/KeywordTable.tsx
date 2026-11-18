import { Fragment, useState } from 'react';
import { post, put } from '../../api/client';
import { Badge, Button, Card, Chip, cx, FieldWrap, Input, Notice, Select, StatusBadge, Switch } from '../../components/ui/core';
import { Icon } from '../../components/ui/Icon';
import { Dialog, Menu, useConfirm, type MenuItem } from '../../components/ui/overlays';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { normalizeCode, STATE_OPTIONS } from '../../lib/keywords';
import { KeywordCatalogInfo, useKeywordCatalogActions } from './KeywordCatalog';

/**
 * Reiter „Stichwörter & Fragen“ (#269): eine kompakte Zeile je Stichwort mit Suche und Filtern direkt darüber,
 * Lagefragen und Regeln aufklappbar je Zeile, Aktionen im „⋯“-Menü (Deaktivieren mit Rückfrage), Anlegen als
 * Dialog, Import/Export im Menü. Am Handy Karten mit denselben Angaben.
 */

const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const NO_Q = { key: '', text: '', options: 'ja, nein, unbekannt' };
const NO_KW = { code: '', label: '', category: '', aliases: '' };

type Act = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
interface EditKw {
  id: string;
  code: string;
  label: string;
  category: string;
  aliases: string;
  active: boolean;
  source: string;
}

export function KeywordsTab({ c, act, refresh }: { c: any; act: Act; refresh: () => void }) {
  const ask = useConfirm();
  const { can, me } = useAuth();
  const mayRules = can('warning.rules');
  const mayApprove = can('warning.approve');
  const myId = me?.user.id;
  const catalog = useKeywordCatalogActions(refresh);

  const [filter, setFilter] = useState('');
  const [cat, setCat] = useState('');
  const [inactive, setInactive] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [create, setCreate] = useState<typeof NO_KW | null>(null);
  const [question, setQuestion] = useState<(typeof NO_Q & { kw: any }) | null>(null);
  const [edit, setEdit] = useState<EditKw | null>(null);

  const cats = [...new Set<string>(c.keywords.map((k: any) => k.category).filter(Boolean))].sort();
  const sourceName = (src: string) => (src === 'eigen' ? 'eigen' : (STATE_OPTIONS.find((x) => x.id === src)?.name ?? src));
  const needle = filter.trim().toLowerCase();
  const shown = c.keywords.filter(
    (k: any) =>
      (inactive || k.active) &&
      (!cat || k.category === cat) &&
      (!needle || normalizeCode(k.code).startsWith(normalizeCode(needle)) || `${k.label} ${k.details} ${k.aliases.join(' ')}`.toLowerCase().includes(needle)),
  );
  const questionsOf = (id: string) => c.questions.filter((x: any) => x.keyword_id === id);
  const rulesOf = (id: string) => c.rules.filter((r: any) => r.keyword_id === id && r.status !== 'retired');
  const toggle = (id: string, to?: boolean) =>
    setOpen((s) => {
      const n = new Set(s);
      if (to ?? !n.has(id)) n.add(id);
      else n.delete(id);
      return n;
    });

  const setActive = async (k: any, active: boolean) => {
    if (!active) {
      const ok = await ask({
        title: `Stichwort „${k.code}“ deaktivieren?`,
        text: 'Es wird in neuen Warnentwürfen und beim Zuordnen von Einsatzmeldungen nicht mehr angeboten. Lagefragen und Regeln bleiben erhalten; „Aktivieren“ macht es rückgängig.',
        confirmLabel: 'Deaktivieren',
      });
      if (!ok) return;
    }
    await act(() => put(`/warning-keywords/${k.id}`, { label: k.label, aliases: k.aliases, active }), active ? 'Stichwort aktiviert' : 'Stichwort deaktiviert');
  };
  const rowMenu = (k: any): MenuItem[] => [
    mayRules && { label: 'Bearbeiten', icon: 'Pencil', onClick: () => setEdit({ id: k.id, code: k.code, label: k.label, category: k.category ?? '', aliases: k.aliases.join(', '), active: k.active, source: k.source }) },
    mayRules && k.active && { label: 'Lagefrage hinzufügen', icon: 'Plus', onClick: () => setQuestion({ ...NO_Q, kw: k }) },
    mayRules && (k.active ? { label: 'Deaktivieren …', icon: 'EyeOff', onClick: () => void setActive(k, false) } : { label: 'Aktivieren', icon: 'Eye', onClick: () => void setActive(k, true) }),
  ];

  /** Zähler für Lagefragen bzw. Regeln: Anzahl, offene Freigaben als Hinweis. */
  const counts = (k: any) => {
    const qs = questionsOf(k.id).filter((x: any) => !x.retired_at);
    const rs = rulesOf(k.id);
    const qOpen = qs.filter((x: any) => !x.approved_at).length;
    const rOpen = rs.filter((r: any) => r.status === 'draft').length;
    return { qs: qs.length, rs: rs.length, qOpen, rOpen };
  };
  const countText = (n: number, open: number) => (
    <span className="font-mono tabular">
      {n || '–'}
      {open > 0 && <span className="ml-1 text-warn" title={`${open} ohne fachliche Freigabe`}>({open} offen)</span>}
    </span>
  );
  const expander = (k: any, size = 'w-8 h-8') => {
    const isOpen = open.has(k.id);
    return (
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={`kw-detail-${k.id}`}
        aria-label={`Lagefragen und Regeln zu ${k.code} ${isOpen ? 'zuklappen' : 'aufklappen'}`}
        onClick={() => toggle(k.id)}
        className={cx(size, 'shrink-0 inline-flex items-center justify-center rounded-chip text-fg-muted hover:bg-raised hover:text-fg')}
      >
        <Icon name="ChevronRight" size={15} className={cx('transition-transform', isOpen && 'rotate-90')} />
      </button>
    );
  };

  /** Aufgeklappt: Meldebild/Aliase, Lagefragen mit Freigabe, Regeln des Stichworts. */
  const detail = (k: any) => {
    const qs = questionsOf(k.id);
    const rs = rulesOf(k.id);
    const info = [k.details && k.details !== k.label ? k.details : '', k.aliases.length ? `Aliase: ${k.aliases.join(', ')}` : ''].filter(Boolean).join(' · ');
    return (
      <div id={`kw-detail-${k.id}`} className="flex flex-col gap-3 py-1">
        {info && <p className="m-0 text-meta text-fg-muted">{info}</p>}
        <div className="flex flex-col gap-1.5">
          <span className="text-label uppercase text-fg-muted">Lagefragen</span>
          {qs.length === 0 ? (
            <p className="m-0 text-sm text-fg-muted">Keine Lagefragen.</p>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
              {qs.map((x: any) => (
                <li key={x.id} className="py-1.5 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono text-meta">{x.key}</span>
                  <span className="flex-1 min-w-[200px]">
                    {x.text} <span className="text-fg-muted text-meta">({x.options.join(' / ')})</span>
                  </span>
                  {x.retired_at ? <Badge>außer Kraft</Badge> : x.approved_at ? <Badge tone="success" title={`${x.approved_by_name}, ${fmtDateTime(x.approved_at)}`}>fachlich freigegeben</Badge> : <Badge tone="warning">nicht freigegeben</Badge>}
                  {!x.approved_at && !x.retired_at && mayApprove && x.created_by !== myId && (
                    <Button size="sm" icon="Check" onClick={() => act(() => post(`/keyword-questions/${x.id}/approve`), 'Frage freigegeben')}>
                      Freigeben
                    </Button>
                  )}
                  {!x.retired_at && mayRules && (
                    <Button size="sm" onClick={async () => (await ask({ title: 'Lagefrage außer Kraft setzen?', text: `„${x.text}“ wird in neuen Warnentwürfen nicht mehr gefragt.`, confirmLabel: 'Außer Kraft setzen' })) && act(() => post(`/keyword-questions/${x.id}/retire`), 'Lagefrage außer Kraft gesetzt')}>
                      Außer Kraft
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {mayRules && k.active && (
            <div>
              <Button size="sm" icon="Plus" onClick={() => setQuestion({ ...NO_Q, kw: k })}>
                Lagefrage
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-label uppercase text-fg-muted">Regeln</span>
          {rs.length === 0 ? (
            <p className="m-0 text-sm text-fg-muted">Keine Regeln. Regeln werden im Reiter „Regeln“ angelegt und fachlich freigegeben.</p>
          ) : (
            <ul className="m-0 p-0 list-none flex flex-col divide-y divide-line">
              {rs.map((r: any) => (
                <li key={r.id} className="py-1.5 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{r.name}</span>
                  <span className="text-meta text-fg-muted">Version {r.version}</span>
                  <Badge tone={r.level === 1 ? 'error' : r.level === 2 ? 'warning' : 'neutral'}>Warnstufe {r.level}</Badge>
                  <StatusBadge status={r.status} labels={{ draft: 'Entwurf – nicht wirksam', approved: 'Fachlich freigegeben' }} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  };

  const status = (k: any) => (k.active ? <Badge tone="success">aktiv</Badge> : <Badge>inaktiv</Badge>);
  const label = (k: any) => (normalizeCode(k.label) !== normalizeCode(k.code) ? k.label : k.details || k.label);
  /** Meldebild leise hinter der Bezeichnung – ohne die Bezeichnung zu wiederholen („Brand (eines Waldes …)“). */
  const detailText = (k: any) => {
    const base = label(k);
    const d = String(k.details ?? '').trim();
    if (!d || d === base) return '';
    return d.startsWith(base) ? d.slice(base.length) : ` – ${d}`;
  };
  const fullLabel = (k: any) => `${label(k)}${detailText(k)}`;

  return (
    <div className="flex flex-col gap-4">
      <KeywordCatalogInfo />
      <Card
        title={
          <span>
            Stichwörter <span className="font-mono text-fg-muted font-normal">({shown.length === c.keywords.filter((k: any) => inactive || k.active).length ? shown.length : `${shown.length} von ${c.keywords.filter((k: any) => inactive || k.active).length}`})</span>
          </span>
        }
        action={
          <span className="flex gap-2 flex-wrap">
            {mayRules && (
              <Button variant="primary" icon="Plus" onClick={() => setCreate({ ...NO_KW })}>
                Stichwort
              </Button>
            )}
            <Menu text="Import/Export" icon="FileDown" label="Import und Export der Stichwortliste" items={catalog.items} />
            {catalog.input}
          </span>
        }
        bodyClassName="!px-0 !pb-0"
      >
        <div className="flex flex-wrap gap-3 items-center px-5 pb-3">
          <Input type="search" aria-label="Stichwörter durchsuchen" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Suchen: Kürzel, Bezeichnung, Meldebild …" className="!w-full sm:!w-[300px]" />
          <div className="w-full sm:w-[200px]">
            <Select aria-label="Kategorie" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">Alle Kategorien</option>
              {cats.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </div>
          <Switch checked={inactive} onChange={setInactive} label="Inaktive zeigen" />
        </div>
        {shown.length === 0 ? (
          <p className="m-0 px-5 pb-5 text-sm text-fg-muted">Keine passenden Stichwörter.</p>
        ) : (
          <>
            {/* Rechner: Tabelle */}
            <div className="hidden md:block overflow-x-auto border-t border-line">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-left text-meta text-fg-muted">
                    <th className="w-10 py-2 pl-3 font-medium">
                      <span className="sr-only">Aufklappen</span>
                    </th>
                    <th className="py-2 px-2 font-medium">Kürzel</th>
                    <th className="py-2 px-2 font-medium">Bezeichnung</th>
                    <th className="py-2 px-2 font-medium">Kategorie</th>
                    <th className="py-2 px-2 font-medium hidden lg:table-cell">Herkunft</th>
                    <th className="py-2 px-2 font-medium">Lagefragen</th>
                    <th className="py-2 px-2 font-medium">Regeln</th>
                    <th className="py-2 px-2 font-medium">Status</th>
                    <th className="w-12 py-2 pr-3">
                      <span className="sr-only">Aktionen</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((k: any) => {
                    const n = counts(k);
                    const menu = rowMenu(k).filter(Boolean);
                    return (
                      <Fragment key={k.id}>
                        <tr className={cx('border-t border-line', open.has(k.id) && 'bg-raised', !k.active && 'text-fg-muted')}>
                          <td className="py-0.5 pl-3">{expander(k)}</td>
                          <td className="py-1.5 px-2 whitespace-nowrap">
                            <Chip mono>{k.code}</Chip>
                          </td>
                          <td className="py-1.5 px-2 max-w-[420px]">
                            <span className="block truncate" title={fullLabel(k)}>
                              {label(k)}
                              {detailText(k) && <span className="text-fg-muted">{detailText(k)}</span>}
                            </span>
                          </td>
                          <td className="py-1.5 px-2 whitespace-nowrap">{k.category || '–'}</td>
                          <td className="py-1.5 px-2 whitespace-nowrap hidden lg:table-cell" title={k.source === 'eigen' ? 'Selbst gepflegt oder importiert' : 'Aus dem Landesverzeichnis'}>
                            {sourceName(k.source)}
                          </td>
                          <td className="py-1.5 px-2 whitespace-nowrap">{countText(n.qs, n.qOpen)}</td>
                          <td className="py-1.5 px-2 whitespace-nowrap">{countText(n.rs, n.rOpen)}</td>
                          <td className="py-1.5 px-2 whitespace-nowrap">{status(k)}</td>
                          <td className="py-0.5 pr-3 text-right">{menu.length > 0 && <Menu size="sm" label={`Aktionen für ${k.code}`} items={menu} />}</td>
                        </tr>
                        {open.has(k.id) && (
                          <tr className="bg-raised">
                            <td />
                            <td colSpan={8} className="pb-3 pr-3 pl-2">
                              {detail(k)}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* Handy: Karten mit denselben Angaben */}
            <ul className="md:hidden m-0 p-0 list-none border-t border-line divide-y divide-line">
              {shown.map((k: any) => {
                const n = counts(k);
                const menu = rowMenu(k).filter(Boolean);
                return (
                  <li key={k.id} className={cx('pl-1 pr-3 py-1.5 flex flex-col gap-1', open.has(k.id) && 'bg-raised')}>
                    <div className="flex items-center gap-1">
                      {expander(k, 'w-10 h-10')}
                      <div className="flex-1 min-w-0 flex flex-col">
                        <span className="flex items-center gap-2 min-w-0">
                          <Chip mono className="shrink-0">{k.code}</Chip>
                          <span className={cx('text-sm truncate', !k.active && 'text-fg-muted')} title={fullLabel(k)}>
                            {label(k)}
                            {detailText(k) && <span className="text-fg-muted">{detailText(k)}</span>}
                          </span>
                        </span>
                        <span className="text-meta text-fg-muted truncate">
                          {[k.category, sourceName(k.source), k.active ? '' : 'inaktiv'].filter(Boolean).join(' · ')} · Fragen {n.qs || '–'}
                          {n.qOpen ? ` (${n.qOpen} offen)` : ''} · Regeln {n.rs || '–'}
                          {n.rOpen ? ` (${n.rOpen} offen)` : ''}
                        </span>
                      </div>
                      {menu.length > 0 && <Menu label={`Aktionen für ${k.code}`} items={menu} />}
                    </div>
                    {open.has(k.id) && <div className="pl-11">{detail(k)}</div>}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>

      <datalist id="kw-cats">
        {cats.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>

      {create && (
        <Dialog
          open
          onClose={() => setCreate(null)}
          title="Stichwort anlegen"
          footer={
            <>
              {!create.code.trim() || create.label.trim().length < 2 && <span id="kc-why" className="mr-auto self-center text-meta text-fg-muted">Kürzel und Bezeichnung (mindestens 2 Zeichen) angeben.</span>}
          <Button onClick={() => setCreate(null)}>Abbrechen</Button>
              <Button
                variant="primary"
                icon="Plus"
                disabled={!create.code.trim() || create.label.trim().length < 2}
            aria-describedby={!create.code.trim() || create.label.trim().length < 2 ? 'kc-why' : undefined}
                onClick={async () => (await act(() => post('/warning-keywords', { code: create.code, label: create.label, category: create.category, aliases: csv(create.aliases) }), 'Stichwort angelegt')) && setCreate(null)}
              >
                Anlegen
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <p className="m-0 text-sm text-fg-muted">Eigene Einträge ergänzen das Landesverzeichnis oder ersetzen gleichnamige Einträge.</p>
            <div className="grid sm:grid-cols-2 gap-3">
              <FieldWrap label="Kürzel" required htmlFor="kw-code">
                <Input id="kw-code" mono value={create.code} maxLength={40} onChange={(e) => setCreate({ ...create, code: e.target.value })} placeholder="z. B. F-WALD-2" />
              </FieldWrap>
              <FieldWrap label="Kategorie" htmlFor="kw-cat">
                <Input id="kw-cat" value={create.category} maxLength={60} list="kw-cats" onChange={(e) => setCreate({ ...create, category: e.target.value })} placeholder="z. B. Brand" />
              </FieldWrap>
            </div>
            <FieldWrap label="Bezeichnung" required htmlFor="kw-label" help="Mindestens 2 Zeichen.">
              <Input id="kw-label" value={create.label} maxLength={300} onChange={(e) => setCreate({ ...create, label: e.target.value })} />
            </FieldWrap>
            <FieldWrap label="Aliase (Komma-getrennt)" htmlFor="kw-alias" help="Weitere Begriffe, unter denen das Stichwort gefunden wird, z. B. Kurzformen aus FE2.">
              <Input id="kw-alias" value={create.aliases} onChange={(e) => setCreate({ ...create, aliases: e.target.value })} />
            </FieldWrap>
          </div>
        </Dialog>
      )}

      {question && (
        <Dialog
          open
          onClose={() => setQuestion(null)}
          title={`Lagefrage zu ${question.kw.code}`}
          footer={
            <>
              {!question.key.trim() || question.text.trim().length < 5 && <span id="kq-why" className="mr-auto self-center text-meta text-fg-muted">Schlüssel und Frage (mindestens 5 Zeichen) angeben.</span>}
          <Button onClick={() => setQuestion(null)}>Abbrechen</Button>
              <Button
                variant="primary"
                icon="Plus"
                disabled={!question.key.trim() || question.text.trim().length < 5}
            aria-describedby={!question.key.trim() || question.text.trim().length < 5 ? 'kq-why' : undefined}
                onClick={async () => {
                  const kwId = question.kw.id;
                  if (await act(() => post(`/warning-keywords/${kwId}/questions`, { key: question.key, text: question.text, options: csv(question.options) }), 'Frage angelegt – braucht fachliche Freigabe')) {
                    setQuestion(null);
                    toggle(kwId, true);
                  }
                }}
              >
                Lagefrage anlegen
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <FieldWrap label="Schlüssel" required htmlFor="q-key" help="Kurzname für Regeln, z. B. „rauch_wohngebiet“.">
              <Input id="q-key" mono value={question.key} maxLength={60} onChange={(e) => setQuestion({ ...question, key: e.target.value })} placeholder="rauch_wohngebiet" />
            </FieldWrap>
            <FieldWrap label="Frage" required htmlFor="q-text" help="Mindestens 5 Zeichen.">
              <Input id="q-text" value={question.text} maxLength={300} onChange={(e) => setQuestion({ ...question, text: e.target.value })} placeholder="Zieht Rauch in ein Wohngebiet?" />
            </FieldWrap>
            <FieldWrap label="Antworten (Komma-getrennt)" htmlFor="q-options">
              <Input id="q-options" value={question.options} onChange={(e) => setQuestion({ ...question, options: e.target.value })} />
            </FieldWrap>
            <Notice>Neue Lagefragen wirken erst nach fachlicher Freigabe durch eine andere Person.</Notice>
          </div>
        </Dialog>
      )}

      {edit && (
        <Dialog
          open
          onClose={() => setEdit(null)}
          title={`Stichwort ${edit.code} bearbeiten`}
          footer={
            <>
              {edit.label.trim().length < 2 && <span id="ke-why" className="mr-auto self-center text-meta text-fg-muted">Die Bezeichnung braucht mindestens 2 Zeichen.</span>}
          <Button onClick={() => setEdit(null)}>Abbrechen</Button>
              <Button
                variant="primary"
                disabled={edit.label.trim().length < 2}
            aria-describedby={edit.label.trim().length < 2 ? 'ke-why' : undefined}
                onClick={async () => (await act(() => put(`/warning-keywords/${edit.id}`, { label: edit.label.trim(), category: edit.category.trim(), aliases: csv(edit.aliases), active: edit.active }), 'Stichwort gespeichert')) && setEdit(null)}
              >
                Speichern
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <FieldWrap label="Kürzel" help="Das Kürzel bleibt fest – Regeln und Vorgänge beziehen sich darauf.">
              <Input value={edit.code} mono disabled />
            </FieldWrap>
            <FieldWrap label="Bezeichnung" required htmlFor="kw-elabel" error={edit.label.trim().length < 2 ? 'Mindestens 2 Zeichen.' : null}>
              <Input id="kw-elabel" value={edit.label} maxLength={300} onChange={(e) => setEdit({ ...edit, label: e.target.value })} />
            </FieldWrap>
            <FieldWrap label="Kategorie" htmlFor="kw-ecat">
              <Input id="kw-ecat" value={edit.category} maxLength={60} list="kw-cats" onChange={(e) => setEdit({ ...edit, category: e.target.value })} />
            </FieldWrap>
            {edit.source !== 'eigen' && <Notice>Eintrag aus dem Landesverzeichnis: Wer Bezeichnung oder Kategorie ändert, macht ihn zum eigenen Eintrag – er bleibt dann auch beim erneuten Übernehmen des Verzeichnisses so.</Notice>}
            <FieldWrap label="Aliase (Komma-getrennt)" help="Weitere Begriffe, unter denen das Stichwort gefunden wird, z. B. Kurzformen aus FE2." htmlFor="kw-aliases">
              <Input id="kw-aliases" value={edit.aliases} onChange={(e) => setEdit({ ...edit, aliases: e.target.value })} />
            </FieldWrap>
          </div>
        </Dialog>
      )}
    </div>
  );
}
