import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../../api/client';
import { useAuth } from '../../lib/auth';
import { Button, FieldWrap, Input, Notice, Spinner } from '../../components/ui/core';
import { CopyButton } from '../../components/ui/overlays';
import { Icon } from '../../components/ui/Icon';

function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-fg flex items-center justify-center p-4">
      <main className="w-full max-w-[420px] flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-node bg-primary-solid flex items-center justify-center">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <circle cx="7.5" cy="12" r="3.5" />
              <circle cx="16.5" cy="12" r="3.5" />
              <path d="M11 12h2" />
            </svg>
          </span>
          <span className="text-title font-semibold tracking-[-0.01em]">LifeLink</span>
        </div>
        <div className="bg-card border border-line rounded-card p-6 flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <h1 className="m-0 text-title font-semibold">{title}</h1>
            {subtitle && <p className="m-0 text-sm text-fg-muted">{subtitle}</p>}
          </div>
          {children}
        </div>
        <p className="m-0 text-meta text-fg-muted text-center">
          Probleme bei der Anmeldung? Ein Admin kann dir einen neuen Link erzeugen. <Link to="/hilfe/anmeldung">Hilfe</Link>
        </p>
      </main>
    </div>
  );
}

function useAfterLogin() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  return async (next: string) => {
    await refresh();
    if (next === 'mfa') navigate('/2fa', { replace: true });
    else if (next === 'mfa_setup') navigate('/2fa/einrichten', { replace: true });
    else navigate('/', { replace: true });
  };
}

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const after = useAfterLogin();
  const navigate = useNavigate();
  const state = useQuery({ queryKey: ['auth-state'], queryFn: () => get('/auth/state') });
  useEffect(() => {
    if (state.data?.setupRequired) navigate('/einrichtung', { replace: true });
  }, [state.data, navigate]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post('/auth/login', { email, password });
      await after(r.next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout title="Anmelden" subtitle={state.data?.instanceName && state.data.instanceName !== 'LifeLink' ? state.data.instanceName : 'Integrations- und Automatisierungsplattform'}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldWrap label="E-Mail-Adresse" htmlFor="email">
          <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </FieldWrap>
        <FieldWrap label="Passwort" htmlFor="pw">
          <Input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </FieldWrap>
        {error && (
          <p role="alert" className="m-0 text-sm text-err">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" loading={busy}>
          Anmelden
        </Button>
      </form>
    </AuthLayout>
  );
}

export function MfaVerifyPage() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const after = useAfterLogin();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post('/auth/mfa', { code });
      await after(r.next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthLayout title="Zwei-Faktor-Anmeldung" subtitle={recovery ? 'Einen deiner Wiederherstellungscodes eingeben.' : 'Den 6-stelligen Code aus deiner Authenticator-App eingeben.'}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldWrap label={recovery ? 'Wiederherstellungscode' : 'Code'} htmlFor="code">
          <Input id="code" autoFocus inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" mono required value={code} onChange={(e) => setCode(e.target.value)} placeholder={recovery ? 'XXXXX-XXXXX' : '123456'} />
        </FieldWrap>
        {error && (
          <p role="alert" className="m-0 text-sm text-err">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" loading={busy}>
          Bestätigen
        </Button>
        <div className="flex justify-between text-sm">
          <button type="button" className="text-fg-link hover:text-fg" onClick={() => setRecovery((r) => !r)}>
            {recovery ? 'Authenticator-Code verwenden' : 'Wiederherstellungscode verwenden'}
          </button>
          <button type="button" className="text-fg-muted hover:text-fg" onClick={() => logout().then(() => navigate('/login'))}>
            Abbrechen
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}

export function MfaSetupPage({ embedded, onDone }: { embedded?: boolean; onDone?: () => void }) {
  const setup = useQuery({ queryKey: ['mfa-setup'], queryFn: () => get('/auth/mfa/setup'), staleTime: Infinity, retry: false });
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post('/auth/mfa/setup', { code });
      setCodes(r.recoveryCodes);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const content = codes ? (
    <div className="flex flex-col gap-4">
      <Notice tone="success" title="Zwei-Faktor-Anmeldung ist aktiv">
        Bewahre diese Wiederherstellungscodes sicher auf (z. B. im Passwort-Manager). Jeder Code funktioniert einmal, falls das Telefon verloren geht.
      </Notice>
      <div className="grid grid-cols-2 gap-2 font-mono text-sm bg-bg border border-line rounded-node p-3">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <CopyButton value={codes.join('\n')} label="Codes kopieren" />
      <Button
        variant="primary"
        onClick={async () => {
          await refresh();
          if (onDone) onDone();
          else navigate('/', { replace: true });
        }}
      >
        Codes gesichert – weiter
      </Button>
    </div>
  ) : setup.isLoading ? (
    <div className="flex justify-center py-8">
      <Spinner size={24} />
    </div>
  ) : setup.error ? (
    <Notice tone="error">{(setup.error as Error).message}</Notice>
  ) : (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ol className="m-0 pl-5 text-sm text-fg-muted flex flex-col gap-1">
        <li>Authenticator-App öffnen (z. B. Microsoft Authenticator, Google Authenticator, Aegis, 2FAS).</li>
        <li>QR-Code scannen oder den Schlüssel von Hand eingeben.</li>
        <li>Den angezeigten 6-stelligen Code unten eintragen.</li>
      </ol>
      <div className="flex flex-col items-center gap-3">
        <img src={setup.data.qr} alt="QR-Code für die Authenticator-App" width={200} height={200} className="rounded-node bg-white p-2" />
        <div className="flex items-center gap-2 font-mono text-meta text-fg-muted break-all">
          <Icon name="KeyRound" size={13} /> {setup.data.secret.replace(/(.{4})/g, '$1 ').trim()}
        </div>
      </div>
      <FieldWrap label="Code aus der App" htmlFor="totp">
        <Input id="totp" inputMode="numeric" autoComplete="one-time-code" mono required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
      </FieldWrap>
      {error && (
        <p role="alert" className="m-0 text-sm text-err">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" loading={busy}>
        Aktivieren
      </Button>
    </form>
  );
  if (embedded) return content;
  return (
    <AuthLayout title="Zwei-Faktor-Anmeldung einrichten" subtitle="Für deine Rolle ist ein zweiter Faktor vorgeschrieben. Das dauert etwa eine Minute.">
      {content}
    </AuthLayout>
  );
}

export function SetupPage() {
  const [form, setForm] = useState({ token: '', name: '', email: '', password: '', password2: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const after = useAfterLogin();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.password2) return setError('Die Passwörter stimmen nicht überein.');
    setBusy(true);
    setError(null);
    try {
      const r = await post('/auth/setup', { token: form.token, name: form.name, email: form.email, password: form.password });
      await after(r.next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const f = (k: keyof typeof form) => ({ value: form[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value }) });
  return (
    <AuthLayout title="LifeLink einrichten" subtitle="Lege das erste Konto an. Es erhält die Rolle Plattform-Admin.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldWrap label="Einrichtungsschlüssel" htmlFor="tok" help="Steht im Container-Protokoll und in der Datei data/setup-token.txt.">
          <Input id="tok" mono required autoComplete="off" {...f('token')} />
        </FieldWrap>
        <FieldWrap label="Name" htmlFor="name">
          <Input id="name" required autoComplete="name" {...f('name')} />
        </FieldWrap>
        <FieldWrap label="E-Mail-Adresse" htmlFor="email">
          <Input id="email" type="email" required autoComplete="username" {...f('email')} />
        </FieldWrap>
        <FieldWrap label="Passwort" htmlFor="pw" help="Mindestens 12 Zeichen. Ein langer Satz ist gut merkbar und sicher.">
          <Input id="pw" type="password" required autoComplete="new-password" {...f('password')} />
        </FieldWrap>
        <FieldWrap label="Passwort wiederholen" htmlFor="pw2">
          <Input id="pw2" type="password" required autoComplete="new-password" {...f('password2')} />
        </FieldWrap>
        {error && (
          <p role="alert" className="m-0 text-sm text-err">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" loading={busy}>
          Konto anlegen
        </Button>
      </form>
    </AuthLayout>
  );
}

export function InvitePage() {
  const { token = '' } = useParams();
  const info = useQuery({ queryKey: ['invite', token], queryFn: () => get(`/auth/invite/${token}`), retry: false });
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const after = useAfterLogin();
  useEffect(() => {
    if (info.data?.name) setName(info.data.name);
  }, [info.data]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) return setError('Die Passwörter stimmen nicht überein.');
    setBusy(true);
    setError(null);
    try {
      const r = await post(`/auth/invite/${token}`, { name, password: pw });
      await after(r.next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (info.error)
    return (
      <AuthLayout title="Link ungültig">
        <Notice tone="error">{(info.error as Error).message}</Notice>
        <Link to="/login">Zur Anmeldung</Link>
      </AuthLayout>
    );
  if (!info.data)
    return (
      <AuthLayout title="Einen Moment …">
        <Spinner />
      </AuthLayout>
    );
  return (
    <AuthLayout title={info.data.reset ? 'Neues Passwort festlegen' : 'Einladung annehmen'} subtitle={info.data.email}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldWrap label="Name" htmlFor="name">
          <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </FieldWrap>
        <FieldWrap label="Passwort" htmlFor="pw" help={`Mindestens ${info.data.minLength} Zeichen.`}>
          <Input id="pw" type="password" required autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </FieldWrap>
        <FieldWrap label="Passwort wiederholen" htmlFor="pw2">
          <Input id="pw2" type="password" required autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </FieldWrap>
        {error && (
          <p role="alert" className="m-0 text-sm text-err">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" loading={busy}>
          Speichern und anmelden
        </Button>
      </form>
    </AuthLayout>
  );
}
