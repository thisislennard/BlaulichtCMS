import { hash, verify, Algorithm } from '@node-rs/argon2';

const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

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

/** Gleiche Rechenzeit für unbekannte Konten (kein Benutzer-Enumerieren über Antwortzeiten). */
let dummy: string | null = null;
export async function burnPasswordTime(password: string) {
  dummy ??= await hashPassword('lifelink-dummy-password');
  await verifyPassword(dummy, password);
}

export function passwordProblems(password: string, minLength: number): string | null {
  if (password.length < minLength) return `Das Passwort muss mindestens ${minLength} Zeichen lang sein.`;
  if (password.length > 256) return 'Das Passwort ist zu lang (max. 256 Zeichen).';
  if (/^(.)\1+$/.test(password)) return 'Das Passwort darf nicht nur aus einem Zeichen bestehen.';
  const common = ['passwort', 'password', '123456', 'qwertz', 'qwerty', 'feuerwehr', 'lifelink', 'admin'];
  if (common.some((c) => password.toLowerCase().includes(c) && password.length < minLength + 6)) {
    return 'Das Passwort enthält ein zu bekanntes Wort. Bitte länger oder anders wählen.';
  }
  return null;
}
