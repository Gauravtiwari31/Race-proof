import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api';
import { Button, Field, Wordmark } from '../components/ui';
import { AvailabilityFields, TimezoneField, minutesToTime, timeToMinutes } from './Profile';

/** Fifty people, one seat: the guarantee the product is built on, drawn as a seat map. */
function Poster() {
  return (
    <div aria-hidden="true" className="relative hidden overflow-hidden border-r border-line-soft bg-surface lg:flex lg:flex-col lg:justify-between lg:p-12">
      <Wordmark />
      <div>
        <p className="eyebrow">Race-proof team formation</p>
        <p className="display mt-4 text-7xl leading-[0.9]">
          Fifty clicks.
          <br />
          One seat.
          <br />
          <span className="text-accent">Exactly one</span> winner.
        </p>
        <div className="mt-10 grid w-max grid-cols-10 gap-2">
          {Array.from({ length: 50 }, (_, i) => (
            <span key={i} className={`h-4 w-4 rounded-[3px] ${i === 23 ? 'bot-won bg-accent' : 'bg-raised'}`} />
          ))}
        </div>
      </div>
      <p className="font-mono text-xs text-ink-mute">Every seat is decided by one Postgres transaction, and shown to everyone live.</p>
    </div>
  );
}

function AuthFrame({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <Poster />
      <main id="main" tabIndex={-1} className="flex flex-col justify-center px-4 py-10 outline-none sm:px-10">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-10 lg:hidden"><Wordmark /></div>
          <h1 className="display text-5xl">{title}</h1>
          <div className="mt-6">{children}</div>
          <p className="mt-6 text-sm text-ink-mute">{footer}</p>
        </div>
      </main>
    </div>
  );
}

const linkClass = 'text-accent underline underline-offset-4 hover:text-accent-hi';

/**
 * Invalidating only refetches mounted queries, and nothing on these forms mounts `['me']`. Without
 * the explicit refetch, the route guard reads its cached "signed out" and redirects back here.
 */
async function refreshSession(client: QueryClient) {
  await client.invalidateQueries();
  await client.refetchQueries({ queryKey: ['me'], type: 'all' });
}

export function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', body: { email, password } });
      await refreshSession(client);
      navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Sign in" footer={<>New here? <Link className={linkClass} to="/signup">Create an account</Link></>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} error={error} />
        <Button type="submit" tone="primary" busy={busy}>Sign in</Button>
      </form>
    </AuthFrame>
  );
}

export function Signup() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    skills: '',
    primaryRole: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    start: minutesToTime(540),
    end: minutesToTime(1020),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/signup', {
        method: 'POST',
        body: {
          name: form.name,
          email: form.email,
          password: form.password,
          skills: form.skills.split(',').map((s) => s.trim()).filter(Boolean),
          ...(form.primaryRole.trim() ? { primaryRole: form.primaryRole.trim() } : {}),
          timezone: form.timezone,
          availStartMin: timeToMinutes(form.start),
          availEndMin: timeToMinutes(form.end),
        },
      });
      await refreshSession(client);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Create your account" footer={<>Already registered? <Link className={linkClass} to="/login">Sign in</Link></>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name" autoComplete="name" required maxLength={80} value={form.name} onChange={(e) => set('name')(e.target.value)} />
        <Field label="Email" type="email" autoComplete="email" required value={form.email} onChange={(e) => set('email')(e.target.value)} />
        <Field label="Password" type="password" autoComplete="new-password" required minLength={10} hint="At least 10 characters." value={form.password} onChange={(e) => set('password')(e.target.value)} />
        <Field label="Skills" hint="Comma separated, for example react, postgres, figma." value={form.skills} onChange={(e) => set('skills')(e.target.value)} />
        <Field label="Main role" hint="For example frontend, backend, design, ml." value={form.primaryRole} onChange={(e) => set('primaryRole')(e.target.value)} />
        <TimezoneField value={form.timezone} onChange={set('timezone')} />
        <AvailabilityFields start={form.start} end={form.end} onStart={set('start')} onEnd={set('end')} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Button type="submit" tone="primary" busy={busy}>Create account</Button>
      </form>
    </AuthFrame>
  );
}
