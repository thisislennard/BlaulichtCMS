/** Datum/Zahl über Intl mit de-DE (Dezimalkomma, Tausenderpunkt), Zeitzone der Instanz. */
let timeZone = 'Europe/Berlin';
export function setTimeZone(tz: string) {
  timeZone = tz || 'Europe/Berlin';
}
export function getTimeZone() {
  return timeZone;
}

const toDate = (v: string | number | Date | null | undefined) => (v == null ? null : v instanceof Date ? v : new Date(v));

export function fmtDateTime(v: string | number | Date | null | undefined, opts: { seconds?: boolean } = {}): string {
  const d = toDate(v);
  if (!d || Number.isNaN(d.getTime())) return '–';
  return new Intl.DateTimeFormat('de-DE', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', ...(opts.seconds ? { second: '2-digit' } : {}) }).format(d);
}

export function fmtDate(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  if (!d || Number.isNaN(d.getTime())) return '–';
  return new Intl.DateTimeFormat('de-DE', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

export function fmtTime(v: string | number | Date | null | undefined, seconds = false): string {
  const d = toDate(v);
  if (!d || Number.isNaN(d.getTime())) return '–';
  return new Intl.DateTimeFormat('de-DE', { timeZone, hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) }).format(d);
}

/** „Sa., 21.11., 09:00“ – kurze Zeitangabe mit Wochentag (geplante Veröffentlichung, #260). */
export function fmtWeekdayDateTime(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  if (!d || Number.isNaN(d.getTime())) return '–';
  return new Intl.DateTimeFormat('de-DE', { timeZone, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
}

/**
 * ISO-Zeitpunkte in gespeicherten Texten (z. B. Verlauf einer Presseanfrage: „Frist: 2026-11-15T22:26:51.000Z → …“)
 * lesbar in der eingestellten Zeitzone. Der Server speichert bewusst ISO (zeitzonenneutral), damit ältere Einträge
 * nach einem Wechsel der Zeitzone ebenfalls richtig erscheinen. Nur vollständige Zeitpunkte mit Zeitzone (Z oder ±hh:mm).
 */
export function fmtIsoInText(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/(?<![\w-])\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})(?![\w:])/g, (m) => {
    const d = new Date(m);
    return Number.isNaN(d.getTime()) ? m : fmtDateTime(d);
  });
}

/** „vor 12 Sekunden“, „vor 2 Std.“, „Gestern, 19:42“, sonst Datum */
export function fmtRelative(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  if (!d || Number.isNaN(d.getTime())) return '–';
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  const p = (s: string) => (future ? `in ${s}` : `vor ${s}`);
  if (abs < 45_000) return future ? 'gleich' : 'gerade eben';
  if (abs < 3_600_000) return p(`${Math.round(abs / 60_000)} Min.`);
  if (abs < 86_400_000) return p(`${Math.round(abs / 3_600_000)} Std.`);
  const yesterday = new Date(Date.now() - 86_400_000);
  if (!future && fmtDate(d) === fmtDate(yesterday)) return `Gestern, ${fmtTime(d)}`;
  if (abs < 7 * 86_400_000) return p(`${Math.round(abs / 86_400_000)} Tagen`);
  return fmtDate(d);
}

export function fmtNumber(n: number | null | undefined, digits = 0): string {
  if (n == null || Number.isNaN(n)) return '–';
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
}

/**
 * Zahl mit Einzahl oder Mehrzahl statt Behelfsplural (#257): plural(1, 'Datei', 'Dateien') → „1 Datei“,
 * plural(3, 'Datei', 'Dateien') → „3 Dateien“, plural(0, …) → „0 Dateien“. Tausender mit Punkt.
 */
export function plural(n: number, one: string, many: string): string {
  return `${fmtNumber(n)} ${n === 1 ? one : many}`;
}

/** 640 ms · 1,8 s · 2 Min. 5 s */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${fmtNumber(ms / 1000, ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (m < 60) return s ? `${m} Min. ${s} s` : `${m} Min.`;
  const h = Math.floor(m / 60);
  return `${h} Std. ${m % 60} Min.`;
}

export function fmtBytes(b: number | null | undefined): string {
  if (b == null) return '–';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${fmtNumber(b / 1024, 1)} KB`;
  if (b < 1024 ** 3) return `${fmtNumber(b / 1024 ** 2, 1)} MB`;
  return `${fmtNumber(b / 1024 ** 3, 1)} GB`;
}

export function fmtPercent(n: number | null | undefined, digits = 1): string {
  if (n == null) return '–';
  return `${fmtNumber(n, digits)} %`;
}

/** Wert für <input type="datetime-local"> in der Instanz-Zeitzone */
export function toLocalInput(v: string | Date | null | undefined): string {
  const d = toDate(v);
  if (!d || Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** <input type="datetime-local"> (Instanz-Zeitzone) → ISO UTC */
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const offset = (t: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(t))
        .map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return new Date(t).toISOString();
}
