/**
 * Cards shared by the patient and clinician views.
 */
import type { ReactNode } from 'react';
import { ChevronRightIcon, ClockIcon, UserIcon } from '@heroicons/react/24/outline';
import { cx } from '@fmc/knack-ui';
import { formatTime, isPast, relative } from '../../lib/format';
import { asText, refName, type Rec } from '../../lib/records';
import { DateTile, StatusPill } from '../../components/ui';

export const isCancelled = (r: Rec) => /cancel/i.test(asText(r.status));

export const AppointmentRow = ({
  appt,
  onOpen,
  showPatient,
  showDoctor = true,
}: {
  appt: Rec;
  onOpen?: () => void;
  showPatient?: boolean;
  showDoctor?: boolean;
}) => {
  const when = appt.dateOfAppointment;
  const past = isPast(when);
  const cancelled = isCancelled(appt);
  const who = showPatient ? refName(appt.patient) : refName(appt.doctor);
  return (
    <Row onClick={onOpen}>
      <DateTile value={when} muted={past || cancelled} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className={cx('font-semibold text-steel-900', cancelled && 'text-steel-500 line-through decoration-steel-300')}>
            {formatTime(when) || 'Time to be confirmed'}
          </p>
          <StatusPill value={appt.status} />
        </div>
        {(showDoctor || showPatient) && who && (
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-steel-700">
            <UserIcon className="h-4 w-4 shrink-0 text-steel-400" aria-hidden="true" />
            {who}
          </p>
        )}
        {asText(appt.reasonForAppointment) && <p className="mt-0.5 line-clamp-1 text-sm text-steel-500">{asText(appt.reasonForAppointment)}</p>}
      </div>
      {!past && !cancelled && (
        <span className="hidden shrink-0 items-center gap-1 text-xs font-medium text-brand-700 sm:flex">
          <ClockIcon className="h-4 w-4" aria-hidden="true" />
          {relative(when)}
        </span>
      )}
    </Row>
  );
};

/** A tappable list row with a chevron. Renders as a button when clickable. */
export const Row = ({ children, onClick, className }: { children: ReactNode; onClick?: () => void; className?: string }) => {
  const inner = (
    <>
      {children}
      {onClick && <ChevronRightIcon className="h-5 w-5 shrink-0 text-steel-300" aria-hidden="true" />}
    </>
  );
  const cls = cx(
    'flex w-full items-center gap-4 border-b border-steel-100 px-4 py-3.5 text-left last:border-b-0 sm:px-5',
    onClick && 'transition-colors hover:bg-steel-50 focus-visible:bg-steel-50 focus-visible:outline-none',
    className,
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={cls}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
};

export const IconBubble = ({ icon: Icon, tone = 'brand' }: { icon: React.ComponentType<{ className?: string }>; tone?: 'brand' | 'sky' | 'violet' | 'amber' | 'rose' }) => {
  const tones = {
    brand: 'bg-brand-50 text-brand-700',
    sky: 'bg-sky-50 text-sky-700',
    violet: 'bg-violet-50 text-violet-700',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700',
  };
  return (
    <span className={cx('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', tones[tone])} aria-hidden="true">
      <Icon className="h-5 w-5" />
    </span>
  );
};

/** Split appointments into upcoming (soonest first) and past (latest first). */
export const splitAppointments = (records: Rec[]) => {
  const upcoming: Rec[] = [];
  const past: Rec[] = [];
  for (const r of records) (isPast(r.dateOfAppointment) ? past : upcoming).push(r);
  const t = (r: Rec) => new Date(asText(r.dateOfAppointment) || 0).getTime();
  upcoming.sort((a, b) => t(a) - t(b));
  past.sort((a, b) => t(b) - t(a));
  return { upcoming, past };
};
