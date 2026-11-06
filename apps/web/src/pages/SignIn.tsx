import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { CalendarDaysIcon, ChatBubbleLeftRightIcon, EyeIcon, EyeSlashIcon, LockClosedIcon, BeakerIcon } from '@heroicons/react/24/outline';
import { Button, FormField, TextInput } from '@fmc/knack-ui';
import { ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { useConfig } from '../lib/config';
import { Brand } from '../components/Shell';
import { useTitle } from '../lib/hooks';

const REASONS: Record<string, string> = {
  idle: 'You were signed out after a period of inactivity, to keep your health information private.',
  expired: 'Your session ended. Please sign in again.',
  'signed-out': 'You’ve signed out. It’s safe to close this window.',
};

export const SignIn = () => {
  const { me, signIn, endReason } = useSession();
  const config = useConfig();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const appName = config.data?.appName ?? 'Patient Portal';
  useTitle('Sign in', appName);

  if (me) return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      navigate((location.state as { from?: string } | null)?.from ?? '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed. Try again.');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-white">
      <aside className="relative hidden w-[44%] max-w-xl overflow-hidden bg-gradient-to-br from-brand-700 via-brand-800 to-brand-900 p-12 text-white lg:flex lg:flex-col">
        <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/5" aria-hidden="true" />
        <div className="absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-white/5" aria-hidden="true" />
        <div className="relative flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/25" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor">
              <path d="M9.5 4h5v5.5H20v5h-5.5V20h-5v-5.5H4v-5h5.5z" />
            </svg>
          </span>
          <span className="text-lg font-semibold">{appName}</span>
        </div>
        <div className="relative mt-auto space-y-8">
          <h1 className="text-3xl font-semibold leading-tight">Your care, in one place.</h1>
          <ul className="space-y-5 text-brand-50">
            {[
              [CalendarDaysIcon, 'See your upcoming appointments at a glance'],
              [BeakerIcon, 'Read test results as soon as they’re released'],
              [ChatBubbleLeftRightIcon, 'Message your care team securely'],
            ].map(([Icon, text]) => {
              const I = Icon as typeof CalendarDaysIcon;
              return (
                <li key={text as string} className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10">
                    <I className="h-5 w-5" aria-hidden="true" />
                  </span>
                  {text as string}
                </li>
              );
            })}
          </ul>
          <p className="flex items-center gap-2 text-sm text-brand-100/80">
            <LockClosedIcon className="h-4 w-4" aria-hidden="true" /> Private and encrypted. You’ll be signed out automatically when you step away.
          </p>
        </div>
      </aside>

      <main className="flex flex-1 items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Brand appName={appName} />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-steel-900">Sign in</h2>
          <p className="mt-1 text-sm text-steel-500">Use the email and password for your {appName.toLowerCase()} account.</p>

          {endReason && REASONS[endReason] && !error && (
            <div role="status" className="mt-6 rounded-xl border border-steel-200 bg-steel-50 px-4 py-3 text-sm text-steel-700">
              {REASONS[endReason]}
            </div>
          )}
          {error && (
            <div role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </div>
          )}

          <form onSubmit={submit} className="mt-6 space-y-5" noValidate>
            <FormField label="Email" htmlFor="email">
              <TextInput
                id="email"
                type="email"
                autoComplete="username"
                inputMode="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                invalid={Boolean(error) && !email}
              />
            </FormField>
            <FormField label="Password" htmlFor="password" error={capsLock ? 'Caps Lock is on.' : undefined}>
              <div className="relative">
                <TextInput
                  id="password"
                  type={show ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  className="pr-11"
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyUp={(e) => setCapsLock(e.getModifierState?.('CapsLock') ?? false)}
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-steel-400 hover:text-steel-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  aria-label={show ? 'Hide password' : 'Show password'}
                  aria-pressed={show}
                >
                  {show ? <EyeSlashIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
                </button>
              </div>
            </FormField>
            <Button type="submit" variant="primary" className="w-full" loading={busy}>
              Sign in
            </Button>
          </form>

          {config.data?.passwordResetUrl && (
            <p className="mt-6 text-center text-sm">
              <a href={config.data.passwordResetUrl} className="font-medium text-brand-700 hover:underline" rel="noopener noreferrer">
                Forgot your password?
              </a>
            </p>
          )}
          <p className="mt-10 text-center text-xs text-steel-400">
            For a medical emergency, call 911. Don’t use this portal for urgent needs.
          </p>
        </div>
      </main>
    </div>
  );
};
