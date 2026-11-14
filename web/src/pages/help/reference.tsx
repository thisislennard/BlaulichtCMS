/* Referenzkapitel aus dem Katalog (GET /catalog): Bausteine, Integrationen, Filter & Vergleiche.
   Bleiben automatisch aktuell, wenn neue Nodes oder Konnektoren dazukommen. */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Catalog, ConnectorInfo, Field, NodeTypeInfo } from '../../api/types';
import { Badge, Chip, Monogram, cx } from '../../components/ui/core';
import { NodeIcon } from '../../components/ui/data';
import { t } from '../../i18n';
import { slugify, type Heading, type ReferenceKind } from './chapters';
import { Markdown } from './Markdown';
import type { SearchDoc } from './search';

/** Hilfekapitel zu einem Konnektor. */
const CONNECTOR_CHAPTER: Record<string, string> = {
  alamos: 'alamos-fe2',
  wordpress: 'wordpress',
  smtp: 'e-mail',
  imap: 'e-mail',
  m365: 'e-mail',
  teams: 'teams',
  mqtt: 'mqtt',
  http: 'rest-api',
  webhook: 'webhooks',
};

export const nodeAnchor = (n: NodeTypeInfo) => slugify(`baustein ${n.title}`);
export const connectorAnchor = (c: ConnectorInfo) => slugify(`integration ${c.name}`);

function fieldType(f: Field): string {
  return t(`help.ref.fieldTypes.${f.type}`);
}

function defaultText(f: Field): string | null {
  const d = f.default;
  if (d == null || d === '' || (Array.isArray(d) && !d.length)) return null;
  if (f.type === 'switch') return d ? t('help.ref.on') : t('help.ref.off');
  if (f.options?.length) {
    const vals = Array.isArray(d) ? d : [d];
    return vals.map((v) => f.options!.find((o) => o.value === String(v))?.label ?? String(v)).join(', ');
  }
  if (typeof d === 'object') return null;
  const s = String(d);
  return s.includes('\n') ? null : s;
}

/** Felder mit gleichem Schlüssel (z. B. „body“ je nach Inhaltstyp) zusammenfassen. */
function uniqueFields(fields: Field[]): Field[] {
  const seen = new Map<string, Field>();
  for (const f of fields) if (!seen.has(`${f.key}|${f.label}`)) seen.set(`${f.key}|${f.label}`, f);
  return [...seen.values()];
}

function FieldTable({ fields, secretFields = [] }: { fields: Field[]; secretFields?: Field[] }) {
  if (!fields.length && !secretFields.length) return null;
  const rows = [...uniqueFields(fields).map((f) => ({ f, secret: false })), ...uniqueFields(secretFields).map((f) => ({ f, secret: true }))];
  return (
    <div className="overflow-x-auto mb-3.5">
      <table style={{ display: 'table', marginBottom: 0 }}>
        <thead>
          <tr>
            <th scope="col">{t('help.ref.field')}</th>
            <th scope="col">{t('help.ref.type')}</th>
            <th scope="col">{t('help.ref.details')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ f, secret }) => {
            const def = defaultText(f);
            return (
              <tr key={`${secret ? 's' : 'f'}-${f.key}-${f.label}`}>
                <td className="min-w-[140px]">
                  <strong className="font-semibold">{f.label}</strong>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {f.required && <Badge tone="warning" dot={false}>{t('help.ref.required')}</Badge>}
                    {f.advanced && <Badge tone="neutral" dot={false}>{t('help.ref.advanced')}</Badge>}
                    {secret && <Badge tone="primary" dot={false}>{t('help.ref.secret')}</Badge>}
                  </div>
                </td>
                <td className="whitespace-nowrap text-fg-muted">{secret ? t('help.ref.fieldTypes.secret') : fieldType(f)}</td>
                <td>
                  {f.help && <p className="!mb-1">{f.help}</p>}
                  {f.options?.length ? (
                    <p className="!mb-1">
                      <span className="text-fg-muted">{t('help.ref.options')}: </span>
                      {f.options.map((o, i) => (
                        <span key={o.value}>
                          {i > 0 && ' · '}
                          {o.label}
                          {o.hint && f.type !== 'color' ? <span className="text-fg-muted"> ({o.hint})</span> : null}
                        </span>
                      ))}
                    </p>
                  ) : null}
                  {def && (
                    <p className="!mb-1">
                      <span className="text-fg-muted">{t('help.ref.default')}: </span>
                      {def}
                    </p>
                  )}
                  {f.min != null && f.max != null && f.type === 'number' && (
                    <p className="!mb-1 text-fg-muted">{t('help.ref.range', { min: f.min, max: f.max })}</p>
                  )}
                  {f.showIf && <p className="!mb-0 text-fg-muted">{t('help.ref.conditional')}</p>}
                  {!f.help && !f.options?.length && !def && !f.showIf && <span className="text-fg-muted">–</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function retryBadge(n: NodeTypeInfo): ReactNode {
  if (!n.sideEffect) return null;
  if (n.idempotent === true) return <Badge tone="success">{t('help.ref.idempotentYes')}</Badge>;
  if (n.idempotent === false) return <Badge tone="warning">{t('help.ref.idempotentNo')}</Badge>;
  return <Badge tone="neutral">{t('help.ref.idempotentDepends')}</Badge>;
}

function NodeEntry({ n, catalog }: { n: NodeTypeInfo; catalog: Catalog }) {
  const conn = n.connector ? catalog.connectors.find((c) => c.id === n.connector) : undefined;
  const isTrigger = n.category === 'trigger';
  return (
    <section className="border border-line rounded-card p-4 mb-4 bg-card">
      <h3 id={nodeAnchor(n)} className="!mt-0 flex items-center gap-2.5 scroll-mt-20">
        <NodeIcon icon={n.icon} category={n.category} size={28} />
        <span>{n.title}</span>
      </h3>
      <p>{n.description}</p>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {n.trigger && <Badge tone="primary">{t(`help.ref.trigger.${n.trigger}`)}</Badge>}
        {conn && (
          <Badge tone="neutral" dot={false}>
            {n.connectionOptional ? t('help.ref.connectionOptional', { name: conn.name }) : t('help.ref.connectionNeeded', { name: conn.name })}
          </Badge>
        )}
        {n.sideEffect && <Badge tone="cyan">{t('help.ref.sideEffect')}</Badge>}
        {retryBadge(n)}
        <Chip mono>{n.type}</Chip>
      </div>
      {n.help && <Markdown source={n.help} className="mb-2" />}

      {n.fields.length > 0 && (
        <>
          <h4>{t('help.ref.settings')}</h4>
          <FieldTable fields={n.fields} />
        </>
      )}

      <h4>{t('help.ref.outputs')}</h4>
      {n.dynamicOutputs ? (
        <p>{t('help.ref.dynamicOutputs')}</p>
      ) : n.outputs && n.outputs.length ? (
        <p className="flex flex-wrap gap-1.5 items-center">
          {n.outputs.map((o) => (
            <Chip key={o.id}>{o.label}</Chip>
          ))}
        </p>
      ) : (
        <p>{t('help.ref.noOutputs')}</p>
      )}

      {n.outputFields.length > 0 && (
        <>
          <h4>{t('help.ref.outputFields')}</h4>
          <div className="overflow-x-auto mb-3.5">
            <table style={{ display: 'table', marginBottom: 0 }}>
              <thead>
                <tr>
                  <th scope="col">{t('help.ref.variable')}</th>
                  <th scope="col">{t('help.ref.type')}</th>
                  <th scope="col">{t('help.ref.meaning')}</th>
                </tr>
              </thead>
              <tbody>
                {n.outputFields.map((f) => (
                  <tr key={f.path}>
                    <td className="whitespace-nowrap">
                      <code>{isTrigger ? `{{ trigger.${f.path} }}` : f.path}</code>
                    </td>
                    <td className="text-fg-muted whitespace-nowrap">{t(`help.ref.valueTypes.${f.type}`)}</td>
                    <td>{f.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-fg-muted text-sm">{isTrigger ? t('help.ref.keyHintTrigger') : t('help.ref.keyHint')}</p>
        </>
      )}
    </section>
  );
}

function ConnectorEntry({ c, catalog }: { c: ConnectorInfo; catalog: Catalog }) {
  const nodes = catalog.nodes.filter((n) => c.nodes.includes(n.type));
  const chapter = CONNECTOR_CHAPTER[c.id];
  return (
    <section className="border border-line rounded-card p-4 mb-4 bg-card">
      <h3 id={connectorAnchor(c)} className="!mt-0 flex items-center gap-3 scroll-mt-20">
        <Monogram text={c.monogram} color={c.color} size={34} />
        <span className="flex flex-col">
          <span>{c.name}</span>
          <span className="text-meta text-fg-muted font-normal">{c.kind}</span>
        </span>
      </h3>
      <p>{c.description}</p>
      <div className="flex flex-wrap gap-1.5 mb-3">
        <Badge tone="neutral" dot={false}>{t('help.ref.setupMinutes', { n: c.setupMinutes })}</Badge>
        <Badge tone={c.needsConnection ? 'primary' : 'success'} dot={false}>
          {c.needsConnection ? t('help.ref.needsConnection') : t('help.ref.noConnectionNeeded')}
        </Badge>
        {chapter && (
          <Link to={`/hilfe/${chapter}`} className="text-sm self-center ml-1">
            {t('help.ref.guide')} →
          </Link>
        )}
      </div>
      {c.help && <Markdown source={c.help} className="mb-2" />}

      {(c.fields.length > 0 || c.secretFields.length > 0) && (
        <>
          <h4>{t('help.ref.connectionFields')}</h4>
          <FieldTable fields={c.fields} secretFields={c.secretFields} />
        </>
      )}

      {c.securityNotes.length > 0 && (
        <>
          <h4>{t('help.ref.security')}</h4>
          <ul>
            {c.securityNotes.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      )}

      <h4>{t('help.ref.test')}</h4>
      {c.testable && c.testInfo.length ? (
        <ol>
          {c.testInfo.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      ) : (
        <p>{t('help.ref.noTest')}</p>
      )}

      {nodes.length > 0 && (
        <>
          <h4>{t('help.ref.nodes')}</h4>
          <ul className="!pl-0 list-none flex flex-col gap-1.5">
            {nodes.map((n) => (
              <li key={n.type} className="flex items-center gap-2">
                <NodeIcon icon={n.icon} category={n.category} size={22} />
                <Link to={`/hilfe/bausteine#${nodeAnchor(n)}`}>{n.title}</Link>
                <span className="text-fg-muted text-sm">– {n.description}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function FilterReference({ catalog }: { catalog: Catalog }) {
  return (
    <div className="ll-prose help-prose">
      <p>{t('help.ref.filterIntro')}</p>
      <h2 id="filter" className="scroll-mt-20">{t('help.ref.filters')}</h2>
      <div className="overflow-x-auto mb-3.5">
        <table style={{ display: 'table', marginBottom: 0 }}>
          <thead>
            <tr>
              <th scope="col">{t('help.ref.filter')}</th>
              <th scope="col">{t('help.ref.args')}</th>
              <th scope="col">{t('help.ref.meaning')}</th>
              <th scope="col">{t('help.ref.example')}</th>
            </tr>
          </thead>
          <tbody>
            {catalog.filters.map((f) => (
              <tr key={f.name}>
                <td>
                  <code>{f.name}</code>
                </td>
                <td className="whitespace-nowrap">{f.args ? <code>{f.args}</code> : <span className="text-fg-muted">–</span>}</td>
                <td>{f.description}</td>
                <td>
                  <span className="flex flex-col gap-1 items-start">
                    {f.example.split(' · ').map((ex) => (
                      <code key={ex} className="whitespace-nowrap">{ex}</code>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 id="vergleiche" className="scroll-mt-20">{t('help.ref.operators')}</h2>
      <p>{t('help.ref.operatorIntro')}</p>
      <div className="overflow-x-auto mb-3.5">
        <table style={{ display: 'table', marginBottom: 0 }}>
          <thead>
            <tr>
              <th scope="col">{t('help.ref.operator')}</th>
              <th scope="col">{t('help.ref.rightSide')}</th>
              <th scope="col">{t('help.ref.meaning')}</th>
            </tr>
          </thead>
          <tbody>
            {catalog.operators.map((o) => (
              <tr key={o.id}>
                <td className="whitespace-nowrap">
                  <strong className="font-semibold">{o.label}</strong>
                </td>
                <td className="whitespace-nowrap text-fg-muted">{o.unary ? t('help.ref.noRight') : t('help.ref.withRight')}</td>
                <td>{t(`help.ref.ops.${o.id}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        {t('help.ref.moreAbout')} <Link to="/hilfe/variablen">{t('help.chapters.variablen.title')}</Link> · <Link to="/hilfe/bedingungen">{t('help.chapters.bedingungen.title')}</Link>
      </p>
    </div>
  );
}

export function ReferenceChapter({ kind, catalog }: { kind: ReferenceKind; catalog: Catalog }) {
  if (kind === 'filter') return <FilterReference catalog={catalog} />;
  if (kind === 'integrationen') {
    const groups = [...new Set(catalog.connectors.map((c) => c.group))];
    return (
      <div className="ll-prose help-prose">
        <p>{t('help.ref.connectorIntro')}</p>
        {groups.map((g) => (
          <div key={g}>
            <h2 id={slugify(g)} className="scroll-mt-20">{g}</h2>
            {catalog.connectors
              .filter((c) => c.group === g)
              .map((c) => (
                <ConnectorEntry key={c.id} c={c} catalog={catalog} />
              ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="ll-prose help-prose">
      <p>{t('help.ref.nodeIntro')}</p>
      <ul>
        <li>{t('help.ref.nodeIntroIdem')}</li>
        <li>{t('help.ref.nodeIntroError')}</li>
      </ul>
      {catalog.categories.map((cat) => {
        const nodes = catalog.nodes.filter((n) => n.category === cat.id);
        if (!nodes.length) return null;
        return (
          <div key={cat.id}>
            <h2 id={slugify(cat.label)} className={cx('scroll-mt-20')}>
              {cat.label} <span className="text-fg-muted font-normal text-sm">({nodes.length})</span>
            </h2>
            <p className="text-fg-muted">{t(`help.ref.categoryText.${cat.id}`)}</p>
            {nodes.map((n) => (
              <NodeEntry key={n.type} n={n} catalog={catalog} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Inhaltsverzeichnis eines Referenzkapitels. */
export function referenceHeadings(kind: ReferenceKind, catalog: Catalog): Heading[] {
  if (kind === 'filter') {
    return [
      { level: 2, text: t('help.ref.filters'), id: 'filter' },
      { level: 2, text: t('help.ref.operators'), id: 'vergleiche' },
    ];
  }
  if (kind === 'integrationen') {
    const out: Heading[] = [];
    for (const g of [...new Set(catalog.connectors.map((c) => c.group))]) {
      out.push({ level: 2, text: g, id: slugify(g) });
      for (const c of catalog.connectors.filter((x) => x.group === g)) out.push({ level: 3, text: c.name, id: connectorAnchor(c) });
    }
    return out;
  }
  const out: Heading[] = [];
  for (const cat of catalog.categories) {
    const nodes = catalog.nodes.filter((n) => n.category === cat.id);
    if (!nodes.length) continue;
    out.push({ level: 2, text: cat.label, id: slugify(cat.label) });
    for (const n of nodes) out.push({ level: 3, text: n.title, id: nodeAnchor(n) });
  }
  return out;
}

/** Suchdokumente aus dem Katalog. */
export function referenceDocs(catalog: Catalog): SearchDoc[] {
  const docs: SearchDoc[] = [];
  const fieldText = (fs: Field[]) => fs.map((f) => [f.label, f.help ?? '', ...(f.options ?? []).map((o) => o.label)].join(' ')).join(' · ');
  for (const n of catalog.nodes) {
    docs.push({
      chapter: 'bausteine',
      anchor: nodeAnchor(n),
      heading: n.title,
      text: [n.description, n.help ?? '', fieldText(n.fields), n.outputFields.map((f) => `${f.path} ${f.description}`).join(' · ')].join(' · '),
    });
  }
  for (const c of catalog.connectors) {
    docs.push({
      chapter: 'integrationen',
      anchor: connectorAnchor(c),
      heading: c.name,
      text: [c.kind, c.description, c.help ?? '', fieldText([...c.fields, ...c.secretFields]), ...c.securityNotes, ...c.testInfo].join(' · '),
    });
  }
  docs.push({ chapter: 'filter', anchor: 'filter', heading: t('help.ref.filters'), text: catalog.filters.map((f) => `${f.name} ${f.description} ${f.example}`).join(' · ') });
  docs.push({ chapter: 'filter', anchor: 'vergleiche', heading: t('help.ref.operators'), text: catalog.operators.map((o) => o.label).join(' · ') });
  return docs;
}
