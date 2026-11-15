import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { post, setReauthHandler } from '../api/client';
import { useAuth } from '../lib/auth';
import { Button, FieldWrap, Input } from './ui/core';
import { Dialog } from './ui/overlays';

/**
 * Dialog für die erneute Bestätigung kritischer Aktionen (Admin-Rechte vergeben, Zwei-Faktor zurücksetzen,
 * Sicherheitseinstellungen …). Wird von der API-Hülle bei „reauth_required“ geöffnet; nach Bestätigung wird die
 * ursprüngliche Anfrage automatisch wiederholt. Die Bestätigung gilt einige Minuten für diese Sitzung.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<((ok: boolean) => void) | null>(null);
  const needCode = !!me?.user.totp_enabled;

  useEffect(() => {
    setReauthHandler(
      () =>
        new Promise<boolean>((resolve) => {
          pending.current?.(false);
          pending.current = resolve;
          setPw('');
          setCode('');
          setError(null);
          setOpen(true);
        }),
    );
    return () => setReauthHandler(null);
  }, []);

  const finish = (ok: boolean) => {
    pending.current?.(ok);
    pending.current = null;
    setOpen(false);
    setPw('');
    setCode('');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/reauth', { password: pw, ...(needCode ? { code: code.replace(/\s/g, '') } : {}) });
      finish(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {children}
      <Dialog
        open={open}
        onClose={() => finish(false)}
        title="Aktion bestätigen"
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={() => finish(false)}>
              Abbrechen
            </Button>
            <Button variant="primary" type="submit" form="reauth-form" loading={busy} disabled={!pw || (needCode && code.replace(/\s/g, '').length < 6)}>
              Bestätigen
            </Button>
          </>
        }
      >
        <form id="reauth-form" onSubmit={submit} className="flex flex-col gap-3">
          <p className="m-0 text-sm text-fg-muted">
            Diese Änderung ist sicherheitskritisch. Bitte mit deinem Passwort{needCode ? ' und einem aktuellen Code aus der Authenticator-App' : ''} bestätigen. Die Bestätigung gilt 10 Minuten.
          </p>
          <FieldWrap label="Passwort" required htmlFor="reauth-pw">
            <Input id="reauth-pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus invalid={!!error} />
          </FieldWrap>
          {needCode && (
            <FieldWrap label="Aktueller Code aus der Authenticator-App" required htmlFor="reauth-code">
              <Input id="reauth-code" mono inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
            </FieldWrap>
          )}
          {error && (
            <p role="alert" className="m-0 text-sm text-err">
              {error}
            </p>
          )}
        </form>
      </Dialog>
    </>
  );
}
