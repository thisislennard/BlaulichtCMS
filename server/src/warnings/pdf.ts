import PDFDocument from 'pdfkit';

/**
 * Serverseitige PDF-Erzeugung für Warnentwürfe. Deterministisch: gleiche Vorlage + gleiche Fassung ergeben
 * dasselbe Dokument (Erstellungszeit = Zeitstand der Fassung, keine Zufallswerte).
 */
export interface PdfInput {
  organization: string;
  template: { name: string; version: number; fields: any[]; level_labels: Record<string, string>; pdf_title: string; pdf_footer: string };
  warning: { case_no: string; kind: 'initial' | 'update' | 'all_clear'; parent_case_no?: string | null };
  revision: { number: number; created_at: Date | string; data: Record<string, any>; keyword: any; level_decision: any };
  approval?: { decided_by_name: string; decided_at: Date | string } | null;
  draft: boolean;
  timeZone: string;
}

export const KIND_LABEL = { initial: 'Erstmeldung', update: 'Aktualisierung', all_clear: 'Entwarnung' } as const;

function fmt(v: Date | string, tz: string) {
  return new Intl.DateTimeFormat('de-DE', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v));
}

export function renderWarningPdf(i: PdfInput): Promise<Buffer> {
  const created = new Date(i.revision.created_at);
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 56, bottom: 64, left: 56, right: 56 },
    info: { Title: `${i.template.pdf_title} ${i.warning.case_no}`, Author: i.organization, Creator: 'LifeLink', Producer: 'LifeLink', CreationDate: created, ModDate: created },
    bufferPages: true,
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const W = doc.page.width - 112;

  // Kopf
  doc.rect(0, 0, doc.page.width, 8).fill(i.warning.kind === 'all_clear' ? '#17692F' : '#C8102E');
  doc.fillColor('#0B1726').font('Helvetica').fontSize(10).text(i.organization, 56, 28);
  doc.font('Helvetica-Bold').fontSize(20).text(`${i.template.pdf_title} – ${KIND_LABEL[i.warning.kind]}`, 56, 48, { width: W });
  let y = doc.y + 6;
  if (i.draft) {
    doc.rect(56, y, W, 26).fill('#FDE8EA');
    doc.fillColor('#A3121C').font('Helvetica-Bold').fontSize(12).text('ENTWURF – nicht freigegeben, nicht zur Weitergabe', 64, y + 7, { width: W - 16, lineBreak: false });
    y += 26;
  }
  y += 16;

  // Metadaten (zweispaltig, Höhe je Zeile gemessen)
  const meta: [string, string][] = [
    ['Vorgangs-ID', i.warning.case_no],
    ['Art', KIND_LABEL[i.warning.kind] + (i.warning.parent_case_no ? ` (zu Vorgang ${i.warning.parent_case_no})` : '')],
    ['Fassung', `${i.revision.number} · Zeitstand ${fmt(created, i.timeZone)}`],
    ['Vorlage', `${i.template.name}, Version ${i.template.version}`],
  ];
  if (i.revision.keyword) meta.push(['Feuerwehrstichwort', `${i.revision.keyword.code} – ${i.revision.keyword.label}`]);
  if (i.approval) meta.push(['Freigabe', `${i.approval.decided_by_name}, ${fmt(i.approval.decided_at, i.timeZone)}`]);
  const boxTop = y;
  y += 8;
  doc.fontSize(10);
  for (const [k, v] of meta) {
    doc.font('Helvetica').fillColor('#0B1726');
    const h = Math.max(doc.heightOfString(v, { width: W - 150 }), 12);
    doc.font('Helvetica-Bold').fillColor('#44546A').text(k, 64, y, { width: 130, lineBreak: false });
    doc.font('Helvetica').fillColor('#0B1726').text(v, 196, y, { width: W - 150 });
    y += h + 4;
  }
  y += 4;
  doc.rect(56, boxTop, W, y - boxTop).lineWidth(0.8).strokeColor('#C7D0DB').stroke();
  y += 16;

  // Warnstufe (bestätigt) – bei Entwarnung keine Stufe
  let barText: string;
  let barColor: string;
  if (i.warning.kind !== 'all_clear') {
    const lvl = i.revision.level_decision?.level;
    barText = (lvl ? (i.template.level_labels[String(lvl)] ?? `Warnstufe ${lvl}`) : 'Warnstufe nicht bestätigt') + (lvl ? ' (bestätigt)' : '');
    barColor = lvl ? '#0E2440' : '#8F4A00';
  } else {
    barText = 'ENTWARNUNG';
    barColor = '#17692F';
  }
  doc.rect(56, y, W, 34).fill(barColor);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(15).text(barText, 68, y + 10, { width: W - 24, lineBreak: false });
  y += 34 + 20;
  doc.x = 56;
  doc.y = y;

  // Felder in Reihenfolge der Vorlage
  for (const f of i.template.fields) {
    let v = i.revision.data[f.key];
    if (v == null || v === '') v = '–';
    else if (f.type === 'datetime') v = fmt(v, i.timeZone);
    else if (f.type === 'checkbox') v = v ? 'ja' : 'nein';
    doc.fillColor('#44546A').font('Helvetica-Bold').fontSize(10).text(f.label, 56, doc.y, { width: W });
    doc.fillColor('#0B1726').font('Helvetica').fontSize(11.5).text(String(v), 56, doc.y + 2, { width: W, lineGap: 2 });
    doc.moveDown(0.8);
  }

  // Fußzeile auf jeder Seite
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    const fy = doc.page.height - 50;
    doc.page.margins.bottom = 0;
    doc.fillColor('#44546A').font('Helvetica').fontSize(8).text(i.template.pdf_footer, 56, fy, { width: W - 70 });
    doc.text(`${i.warning.case_no} · Fassung ${i.revision.number} · Seite ${p + 1}/${range.count}`, 56 + W - 160, fy + 18, { width: 160, align: 'right' });
    if (i.draft) {
      doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] }).fillColor('#C8102E').opacity(0.1).font('Helvetica-Bold').fontSize(84).text('ENTWURF', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false }).restore();
    }
  }
  doc.end();
  return done;
}
