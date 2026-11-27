import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { ClockIcon } from '@heroicons/react/24/outline';
import { Button } from '../ui';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';

/** Automatic logoff warning (HIPAA §164.312(a)(2)(iii)). */
export const IdleWarning = () => {
  const { warningSeconds, stayActive, signOut } = useSession();
  const navigate = useNavigate();
  const open = warningSeconds !== null;
  const m = Math.floor((warningSeconds ?? 0) / 60);
  const s = String((warningSeconds ?? 0) % 60).padStart(2, '0');
  return (
    <Dialog open={open} onClose={stayActive} className="relative z-[70]">
      <DialogBackdrop className="fixed inset-0 bg-steel-900/50 backdrop-blur-sm" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-xl">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700">
            <ClockIcon className="h-6 w-6" aria-hidden="true" />
          </div>
          <DialogTitle className="mt-4 text-lg font-semibold text-steel-900">Are you still there?</DialogTitle>
          <p className="mt-2 text-sm text-steel-600">
            To protect your health information, you’ll be signed out in{' '}
            <span className="font-semibold tabular-nums text-steel-900" aria-live="polite">
              {m}:{s}
            </span>
            .
          </p>
          <div className="mt-6 flex flex-col gap-2">
            <Button variant="primary" onClick={stayActive} autoFocus>
              Stay signed in
            </Button>
            <Button variant="ghost" onClick={() => void signOut('signed-out').then(() => navigate('/signin'))}>
              Sign out now
            </Button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
};
