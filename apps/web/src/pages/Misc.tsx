import { Link, useNavigate } from 'react-router-dom';
import { ClockIcon } from '@heroicons/react/24/outline';
import { Button } from '@fmc/knack-ui';
import { useSession } from '../lib/session';
import { useConfig } from '../lib/config';
import { Brand, DevelopedBy } from '../components/Shell';
import { useTitle } from '../lib/hooks';

/** Signed in, but no role in this app yet (Knack's generic "all users" only). */
export const Welcome = () => {
  const { me, signOut } = useSession();
  const config = useConfig();
  const navigate = useNavigate();
  useTitle('Welcome');
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-steel-50 px-6">
      <Brand appName={config.data?.appName ?? 'Patient Portal'} />
      <div className="mt-8 w-full max-w-md rounded-2xl border border-steel-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-700">
          <ClockIcon className="h-6 w-6" aria-hidden="true" />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-steel-900">Your account is almost ready</h1>
        <p className="mt-2 text-sm text-steel-600">
          You’re signed in as <strong>{me?.user.email}</strong>, but your account hasn’t been given access to the portal yet. The office will set this up. Once it’s done, sign in again.
        </p>
        <Button className="mt-6 w-full" variant="secondary" onClick={() => void signOut('signed-out').then(() => navigate('/signin'))}>
          Sign out
        </Button>
      </div>
      <DevelopedBy className="mt-8" />
    </div>
  );
};

export const NotFound = () => {
  useTitle('Not found');
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <p className="text-sm font-semibold text-brand-700">404</p>
      <h1 className="mt-2 text-2xl font-semibold text-steel-900">We can’t find that page</h1>
      <p className="mt-2 text-sm text-steel-600">It may have moved, or your account may not include it.</p>
      <Link to="/" className="mt-6 inline-block text-sm font-medium text-brand-700 hover:underline">
        Go to your home page
      </Link>
      <DevelopedBy className="mt-16" />
    </div>
  );
};
