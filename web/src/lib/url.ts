/**
 * Nur http(s)-Adressen als Link verwenden (#87). Adressen aus Fremdquellen (RSS, Rückmeldungen der Bridge, soziale
 * Kanäle) könnten sonst javascript:- oder data:-Links einschleusen.
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}
