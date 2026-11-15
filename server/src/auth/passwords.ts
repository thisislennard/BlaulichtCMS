import { hash, verify, Algorithm } from '@node-rs/argon2';
import { COMMON_PASSWORD_CORES, COMMON_PASSWORDS_LONG } from './common-passwords.js';

/**
 * Argon2id nach RFC 9106, zweite empfohlene Option (für Systeme mit begrenztem Speicher): m = 64 MiB, t = 3, p = 4.
 * BSI TR-02102-1 verweist auf diese Parameter (#129). Ältere Hashes (bis 0.1: m = 19 MiB, t = 2, p = 1) werden bei
 * der nächsten erfolgreichen Anmeldung neu berechnet (needsRehash).
 */
export const ARGON2_PARAMS = { memoryCost: 65_536, timeCost: 3, parallelism: 4 };
const OPTIONS = { algorithm: Algorithm.Argon2id, ...ARGON2_PARAMS };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(stored: string | null | undefined, password: string): Promise<boolean> {
  if (!stored) return false;
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** Stammt der Hash von einem anderen Verfahren oder schwächeren Parametern als den aktuellen? */
export function needsRehash(stored: string | null | undefined): boolean {
  if (!stored) return false;
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(stored);
  if (!m) return true;
  return Number(m[1]) < ARGON2_PARAMS.memoryCost || Number(m[2]) < ARGON2_PARAMS.timeCost || Number(m[3]) < ARGON2_PARAMS.parallelism;
}

/** Gleiche Rechenzeit für unbekannte Konten (kein Benutzer-Enumerieren über Antwortzeiten). */
let dummy: string | null = null;
export async function burnPasswordTime(password: string) {
  dummy ??= await hashPassword('blaulichtcms-dummy-password');
  await verifyPassword(dummy, password);
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };
const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };

/** Klein, Umlaute umschrieben, Ziffern und Zeichen am Anfang und Ende entfernt. */
function trimmedLower(password: string): string {
  return password
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => UMLAUTS[c])
    .replace(/^[^a-z]+|[^a-z]+$/g, '');
}

/**
 * Kern eines Passworts: wie trimmedLower, zusätzlich Leetspeak zurückübersetzt. „Sommer2026!!“ → „sommer“,
 * „P@ssw0rt1“ → „passwort“ (gleiches Verfahren wie beim Erzeugen der Liste in common-passwords.ts).
 */
export function passwordCore(password: string): string {
  return trimmedLower(password).replace(/[013457@$]/g, (c) => LEET[c]);
}

let lists: { cores: Set<string>; longs: Set<string> } | null = null;
function commonLists() {
  lists ??= { cores: new Set(COMMON_PASSWORD_CORES.split('\n')), longs: new Set(COMMON_PASSWORDS_LONG.split('\n')) };
  return lists;
}

/**
 * Prüft ein neues Passwort (#131): Länge, triviale Muster und eine im Programm enthaltene Liste häufiger Passwörter
 * (ohne Netzabruf). Abgelehnt werden auch bekannte Wörter mit angehängten Zahlen oder Zeichen (Jahreszahl, „112“,
 * „!“) sowie Passwörter, die im Wesentlichen aus Name, E-Mail-Adresse oder Organisation bestehen (context).
 */
export function passwordProblems(password: string, minLength: number, context: (string | null | undefined)[] = []): string | null {
  if (password.length < minLength) return `Das Passwort muss mindestens ${minLength} Zeichen lang sein.`;
  if (password.length > 256) return 'Das Passwort ist zu lang (max. 256 Zeichen).';
  if (/^(.)\1+$/.test(password)) return 'Das Passwort darf nicht nur aus einem Zeichen bestehen.';
  if (/^(.{1,4})\1+$/.test(password)) return 'Das Passwort besteht nur aus einem wiederholten Muster. Bitte anders wählen.';
  if (/^\d+$/.test(password) && password.length < 20) return 'Ein Passwort nur aus Ziffern ist leicht zu erraten. Bitte Wörter oder einen Satz verwenden.';
  const { cores, longs } = commonLists();
  const core = passwordCore(password);
  const plain = trimmedLower(password);
  // Kurzer Wortkern (z. B. „abc“ + viele Ziffern) zählt ebenfalls als zu einfach
  const shortCore = core.length > 0 && core.length < 4 && password.length < minLength + 4;
  if (longs.has(password.toLowerCase()) || cores.has(core) || cores.has(plain) || shortCore) {
    return 'Das Passwort steht (ggf. mit Zahlen oder Zeichen ergänzt) auf einer Liste häufig verwendeter Passwörter. Bitte einen eigenen, längeren Satz wählen.';
  }
  const own = context
    .flatMap((c) => String(c ?? '').toLowerCase().split(/[@\s.,_-]+/))
    .map((w) => passwordCore(w))
    .filter((w) => w.length >= 4);
  // Eigene Begriffe: ohne sie bleiben vom Kern höchstens drei Buchstaben übrig
  const rest = own.sort((a, b) => b.length - a.length).reduce((r, w) => r.split(w).join(''), core);
  if (own.some((w) => core.includes(w)) && rest.replace(/[^a-z]/g, '').length < 4) {
    return 'Das Passwort besteht im Wesentlichen aus deinem Namen, deiner E-Mail-Adresse oder der Organisation. Bitte anders wählen.';
  }
  return null;
}
