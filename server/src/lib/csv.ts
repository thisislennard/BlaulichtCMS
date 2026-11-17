/**
 * CSV-Ausgabe für alle Exporte (Medien-Metadaten, Presseverteiler, Stichwortliste) – eine gemeinsame Zellfunktion.
 *
 * Schutz vor Formel-Injektion: Tabellenprogramme werten Zellen, die mit „=“, „+“, „-“, „@“ (auch in voller Breite),
 * Tab, Wagenrücklauf oder Zeilenumbruch beginnen, als Formel aus (z. B. HYPERLINK oder DDE). Solche Werte bekommen ein
 * vorangestelltes Apostroph und erscheinen dadurch als Text. Danach Quoting nach RFC 4180 (Semikolon als Trenner,
 * Komma mit gequotet, damit die Datei auch mit Komma als Trenner lesbar bleibt).
 */
const FORMULA_START = /^[=+\-@\t\r\n＝＋－＠]/;

export function csvCell(v: unknown): string {
  let s = v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[";,\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Gegenstück beim Wiedereinlesen eines eigenen Exports: das vorangestellte Schutz-Apostroph vor einem Formelzeichen
 * wieder entfernen, damit Export und Import verlustfrei zusammenpassen. Andere Werte bleiben unverändert.
 */
export function csvUncell(s: string): string {
  return s.startsWith("'") && FORMULA_START.test(s.slice(1)) ? s.slice(1) : s;
}
