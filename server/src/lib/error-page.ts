/*
 * Einfache HTML-Rückmeldeseite für Antworten außerhalb der App (#194): fehlende Dateien, ungültige Alt-Links.
 * Ohne Skripte und ohne <style>-Element (CSP: nur style-Attribute erlaubt), hell/dunkel über color-scheme.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function simplePage(title: string, text: string, opts: { code?: string; link?: { href: string; label: string } } = {}): string {
  const link = opts.link ? `<p style="margin:20px 0 0"><a href="${esc(opts.link.href)}" style="color:inherit">${esc(opts.link.label)}</a></p>` : '';
  const code = opts.code ? `<p style="margin:0 0 8px;font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.65">${esc(opts.code)}</p>` : '';
  return (
    '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>` +
    '<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.55">' +
    `<main style="max-width:560px;margin:12vh auto 0;padding:0 20px">${code}<h1 style="margin:0 0 10px;font-size:24px;font-weight:600">${esc(title)}</h1>` +
    `<p style="margin:0;opacity:.8">${esc(text)}</p>${link}</main></body></html>`
  );
}
