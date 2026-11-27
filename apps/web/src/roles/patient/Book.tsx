/**
 * Book an appointment: date -> time -> doctor -> reason -> confirm.
 *
 * Availability comes from the server as busy intervals only (no other
 * patient's details ever reach the browser). The slot arithmetic is the same
 * module the server validates with, so a time offered here is a time the
 * server accepts, unless someone else takes it first, which the server
 * catches and we explain.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownTrayIcon,
  CalendarDaysIcon,
  CheckCircleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  SparklesIcon,
  SunIcon,
  MoonIcon,
} from '@heroicons/react/24/outline';
import { Button, cx, Select, TextArea } from '../../ui';
import { api, ApiError } from '../../lib/api';
import { asText, refId, useList } from '../../lib/records';
import { addDays, timezone, todayKey } from '../../lib/format';
import { useTitle } from '../../lib/hooks';
import { Avatar, Empty, InlineError, Page, Panel, useToast } from '../../components/ui';
import {
  HORIZON_DAYS,
  LEAD_MS,
  slotsForDay,
  WEEKDAYS,
  zoned,
  type DoctorHours,
  type Interval,
} from '../../../../../packages/core/src/booking/slots';

interface Doctor {
  id: string;
  name: string;
  specialty: string | null;
  hours: DoctorHours;
}
interface BookingInfo {
  enabled: boolean;
  doctors: Doctor[];
  timezone: string;
  horizonDays: number;
  leadMinutes: number;
  reasonRequired: boolean;
}
interface Availability {
  busy: Record<string, Interval[]>;
  mine: Interval[];
}

const fmtTime = (ms: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: timezone() }).format(ms);
const fmtDay = (ymd: string, opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' }) =>
  new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' }).format(new Date(`${ymd}T12:00:00Z`));
const fmtWhen = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone() }).format(ms);

const monthStart = (ymd: string) => `${ymd.slice(0, 7)}-01`;
const monthEnd = (ymd: string) => {
  const d = new Date(`${monthStart(ymd)}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};
const shiftMonth = (ymd: string, n: number) => {
  const d = new Date(`${monthStart(ymd)}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

const REASONS = ['Follow-up visit', 'New concern', 'Annual physical', 'Prescription question', 'Test results review'];

type Step = 'when' | 'who' | 'details' | 'done';

export const BookAppointment = () => {
  useTitle('Book an appointment');
  const qc = useQueryClient();
  const toast = useToast();
  const tz = timezone();
  const today = todayKey();
  const lastDay = addDays(today, HORIZON_DAYS);

  const info = useQuery({ queryKey: ['booking'], queryFn: () => api<BookingInfo>('/booking'), staleTime: 60_000 });
  const history = useList('appointments', { rows: 1000, source: 'booking' });

  const [month, setMonth] = useState(monthStart(today));
  const [day, setDay] = useState<string | null>(null);
  const [time, setTime] = useState<number | null>(null);
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [specialty, setSpecialty] = useState('');
  const [reason, setReason] = useState('');
  const [step, setStep] = useState<Step>('when');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<{ when: number; doctor: Doctor; reason: string } | null>(null);

  const from = month < today ? today : month;
  const to = monthEnd(month) > lastDay ? lastDay : monthEnd(month);
  const avail = useQuery({
    queryKey: ['booking', 'availability', from, to],
    queryFn: () => api<Availability>('/booking/availability', { query: { from, to } }),
    enabled: Boolean(info.data?.enabled) && from <= to,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const doctors = useMemo(() => (info.data?.doctors ?? []).filter((d) => !specialty || d.specialty === specialty), [info.data, specialty]);
  const specialties = useMemo(() => [...new Set((info.data?.doctors ?? []).map((d) => d.specialty).filter(Boolean) as string[])].sort(), [info.data]);
  const seenBefore = useMemo(() => new Set((history.data?.records ?? []).map((a) => refId(a.doctor)).filter(Boolean) as string[]), [history.data]);

  // slots[ymd] = Map<startMs, doctorIds[]>
  const slots = useMemo(() => {
    const out = new Map<string, Map<number, string[]>>();
    if (!avail.data) return out;
    const now = Date.now();
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const byTime = new Map<number, string[]>();
      for (const doc of doctors) {
        for (const t of slotsForDay(d, doc.hours, avail.data.busy[doc.id] ?? [], avail.data.mine, tz, now)) {
          byTime.set(t, [...(byTime.get(t) ?? []), doc.id]);
        }
      }
      if (byTime.size) out.set(d, new Map([...byTime.entries()].sort((a, b) => a[0] - b[0])));
    }
    return out;
  }, [avail.data, doctors, from, to, tz]);

  // Pick the first available day once data arrives.
  useEffect(() => {
    if (!day && slots.size) setDay([...slots.keys()][0]!);
  }, [slots, day]);

  const firstAvailable = useMemo(() => {
    for (const [d, m] of slots) {
      const [t] = m.keys();
      if (t !== undefined) return { day: d, time: t };
    }
    return null;
  }, [slots]);

  if (info.isLoading) return <Page><div className="h-96 animate-pulse rounded-3xl bg-steel-100" /></Page>;
  if (info.error) return <Page><InlineError error={info.error} onRetry={() => void info.refetch()} /></Page>;
  if (!info.data?.enabled) {
    return (
      <Page>
        <BackLink />
        <Empty icon={<CalendarDaysIcon className="h-6 w-6" />} title="Online booking isn’t available yet">
          Please call the office to book an appointment.
        </Empty>
      </Page>
    );
  }

  const doctor = info.data.doctors.find((d) => d.id === doctorId) ?? null;
  const daySlots = day ? slots.get(day) : undefined;
  const available = time !== null && daySlots ? (daySlots.get(time) ?? []) : [];

  const submit = async () => {
    if (!doctor || time === null) return;
    if (info.data?.reasonRequired && !reason.trim()) {
      setError('Tell us briefly what the visit is for.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api('/booking', { method: 'POST', body: { doctorId: doctor.id, start: time, reason: reason.trim() } });
      void qc.invalidateQueries({ queryKey: ['records', 'appointments'] });
      void qc.invalidateQueries({ queryKey: ['booking'] });
      setBooked({ when: time, doctor, reason: reason.trim() });
      setStep('done');
      toast('Appointment booked');
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Booking failed. Please try again.';
      if (e instanceof ApiError && e.status === 409) {
        void avail.refetch();
        setTime(null);
        setStep('when');
        toast(msg, 'error');
      } else setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (step === 'done' && booked) return <Booked booked={booked} />;

  return (
    <Page className="max-w-5xl">
      <BackLink />
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-steel-900 sm:text-3xl">Book an appointment</h1>
        <Stepper step={step} />
      </header>

      {step === 'when' && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            {specialties.length > 1 && (
              <Select
                aria-label="Specialty"
                value={specialty}
                onChange={(e) => {
                  setSpecialty(e.target.value);
                  setTime(null);
                  setDay(null);
                }}
                options={[{ value: '', label: 'Any specialty' }, ...specialties.map((s) => ({ value: s, label: s }))]}
                className="w-56"
              />
            )}
            {firstAvailable && (
              <button
                type="button"
                onClick={() => {
                  setDay(firstAvailable.day);
                  setTime(firstAvailable.time);
                  setStep('who');
                }}
                className="inline-flex items-center gap-2 rounded-full bg-brand-50 px-4 py-2 text-sm font-medium text-brand-800 ring-1 ring-brand-200 hover:bg-brand-100"
              >
                <SparklesIcon className="h-4 w-4" />
                First available: {fmtWhen(firstAvailable.time)}
              </button>
            )}
          </div>
          {avail.error && <InlineError error={avail.error} onRetry={() => void avail.refetch()} />}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_1fr]">
            <Panel className="p-4">
              <MonthPicker
                month={month}
                onMonth={(m) => {
                  setMonth(m);
                  setDay(null);
                  setTime(null);
                }}
                canPrev={month > monthStart(today)}
                canNext={shiftMonth(month, 1) <= lastDay}
                selected={day}
                onSelect={(d) => {
                  setDay(d);
                  setTime(null);
                }}
                isAvailable={(d) => slots.has(d)}
                isInRange={(d) => d >= today && d <= lastDay}
                loading={avail.isLoading}
              />
              <p className="mt-3 flex items-center gap-2 px-1 text-xs text-steel-500">
                <span className="h-2 w-2 rounded-full bg-brand-500" /> Has open times
              </p>
            </Panel>
            <Panel className="p-5">
              {!day ? (
                <p className="py-12 text-center text-sm text-steel-500">{avail.isLoading ? 'Checking availability…' : 'Pick a day to see open times.'}</p>
              ) : (
                <TimeGrid
                  day={day}
                  slots={daySlots}
                  selected={time}
                  onSelect={(t) => {
                    setTime(t);
                    setDoctorId(null);
                    setStep('who');
                  }}
                />
              )}
            </Panel>
          </div>
          <p className="text-xs text-steel-500">
            Times are shown in the practice’s time zone ({tz.replace('_', ' ')}). Online booking opens {Math.round(LEAD_MS / 3_600_000)} hours ahead and up to {HORIZON_DAYS} days out.
          </p>
        </>
      )}

      {step === 'who' && time !== null && (
        <>
          <SelectionBar time={time} onChange={() => setStep('when')} />
          <section aria-labelledby="who" className="space-y-3">
            <h2 id="who" className="text-base font-semibold text-steel-900">
              {available.length ? `${available.length} doctor${available.length === 1 ? ' is' : 's are'} available` : 'No one is free at this time'}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {doctors
                .filter((d) => available.includes(d.id))
                .sort((a, b) => Number(seenBefore.has(b.id)) - Number(seenBefore.has(a.id)))
                .map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => {
                      setDoctorId(d.id);
                      setStep('details');
                    }}
                    className="flex items-center gap-4 rounded-2xl border border-steel-200 bg-white p-4 text-left shadow-sm transition hover:border-brand-400 hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <Avatar name={d.name} size="lg" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-steel-900">{d.name}</p>
                      <p className="truncate text-sm text-steel-500">{d.specialty ?? 'Clinician'}</p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        <span className="inline-flex items-center gap-1 rounded-full bg-steel-100 px-2 py-0.5 text-xs text-steel-700">
                          <ClockIcon className="h-3.5 w-3.5" /> {d.hours.length} min
                        </span>
                        {seenBefore.has(d.id) && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-800">Seen before</span>}
                      </div>
                    </div>
                    <ChevronRightIcon className="h-5 w-5 text-steel-300" aria-hidden="true" />
                  </button>
                ))}
            </div>
          </section>
          <OtherDoctors doctors={doctors.filter((d) => !available.includes(d.id))} slots={slots} after={time} onPick={(d, t) => {
            setDay(zoned(t, tz).ymd);
            setTime(t);
            setDoctorId(d);
            setStep('details');
          }} />
        </>
      )}

      {step === 'details' && time !== null && doctor && (
        <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
          <Panel className="space-y-5 p-6">
            <div>
              <label htmlFor="reason" className="text-sm font-medium text-steel-800">
                What’s the visit for?{info.data.reasonRequired ? '' : ' (optional)'}
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                {REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setReason(r)}
                    className={cx(
                      'rounded-full border px-3 py-1.5 text-sm transition',
                      reason === r ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-steel-300 text-steel-700 hover:bg-steel-50',
                    )}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <TextArea id="reason" className="mt-3" rows={4} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="A few words help your doctor prepare. Please don’t include anything urgent; call the office instead." />
            </div>
            {error && (
              <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-800">
                {error}
              </p>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button variant="ghost" onClick={() => setStep('who')}>
                Back
              </Button>
              <Button variant="primary" loading={submitting} onClick={() => void submit()}>
                Confirm booking
              </Button>
            </div>
          </Panel>
          <Summary time={time} doctor={doctor} />
        </div>
      )}
    </Page>
  );
};

const BackLink = () => (
  <Link to="/patient/appointments" className="inline-flex items-center gap-1 text-sm font-medium text-steel-500 hover:text-steel-800">
    <ChevronLeftIcon className="h-4 w-4" /> Appointments
  </Link>
);

const Stepper = ({ step }: { step: Step }) => {
  const steps: Array<[Step, string]> = [
    ['when', 'Date & time'],
    ['who', 'Doctor'],
    ['details', 'Confirm'],
  ];
  const index = steps.findIndex(([s]) => s === step);
  return (
    <ol className="mt-4 flex items-center gap-2 text-sm" aria-label="Progress">
      {steps.map(([s, label], i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            aria-current={i === index ? 'step' : undefined}
            className={cx(
              'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold',
              i < index ? 'bg-brand-600 text-white' : i === index ? 'bg-brand-100 text-brand-800 ring-2 ring-brand-500' : 'bg-steel-100 text-steel-500',
            )}
          >
            {i < index ? '✓' : i + 1}
          </span>
          <span className={cx('hidden sm:inline', i === index ? 'font-medium text-steel-900' : 'text-steel-500')}>{label}</span>
          {i < steps.length - 1 && <span className="h-px w-6 bg-steel-200 sm:w-10" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
};

const MonthPicker = ({
  month,
  onMonth,
  canPrev,
  canNext,
  selected,
  onSelect,
  isAvailable,
  isInRange,
  loading,
}: {
  month: string;
  onMonth: (m: string) => void;
  canPrev: boolean;
  canNext: boolean;
  selected: string | null;
  onSelect: (d: string) => void;
  isAvailable: (d: string) => boolean;
  isInRange: (d: string) => boolean;
  loading: boolean;
}) => {
  const first = monthStart(month);
  const lead = new Date(`${first}T12:00:00Z`).getUTCDay();
  const days = Number(monthEnd(month).slice(8, 10));
  const cells: Array<string | null> = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => addDays(first, i))];
  const today = todayKey();
  return (
    <div>
      <div className="flex items-center justify-between px-1 pb-3">
        <button type="button" disabled={!canPrev} onClick={() => onMonth(shiftMonth(month, -1))} className="rounded-lg p-2 text-steel-600 hover:bg-steel-100 disabled:opacity-30" aria-label="Previous month">
          <ChevronLeftIcon className="h-5 w-5" />
        </button>
        <p className="font-semibold text-steel-900" aria-live="polite">
          {fmtDay(first, { month: 'long', year: 'numeric' })}
        </p>
        <button type="button" disabled={!canNext} onClick={() => onMonth(shiftMonth(month, 1))} className="rounded-lg p-2 text-steel-600 hover:bg-steel-100 disabled:opacity-30" aria-label="Next month">
          <ChevronRightIcon className="h-5 w-5" />
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-xs font-medium text-steel-500">
        {WEEKDAYS.map((w) => (
          <span key={w} className="py-1" aria-hidden="true">
            {w.slice(0, 2)}
          </span>
        ))}
      </div>
      <div className={cx('grid grid-cols-7 gap-1', loading && 'animate-pulse')} role="grid">
        {cells.map((d, i) => {
          if (!d) return <span key={`e${i}`} />;
          const open = isAvailable(d);
          const inRange = isInRange(d);
          const sel = d === selected;
          return (
            <button
              key={d}
              type="button"
              disabled={!open}
              onClick={() => onSelect(d)}
              aria-pressed={sel}
              aria-label={`${fmtDay(d)}${open ? ', has open times' : ', no open times'}`}
              className={cx(
                'relative flex aspect-square flex-col items-center justify-center rounded-xl text-sm transition',
                sel
                  ? 'bg-brand-600 font-semibold text-white shadow'
                  : open
                    ? 'font-medium text-steel-900 hover:bg-brand-50'
                    : inRange
                      ? 'text-steel-300'
                      : 'text-steel-200',
                d === today && !sel && 'ring-1 ring-steel-300',
              )}
            >
              {Number(d.slice(8, 10))}
              {open && !sel && <span className="absolute bottom-1.5 h-1 w-1 rounded-full bg-brand-500" />}
            </button>
          );
        })}
      </div>
    </div>
  );
};

const TimeGrid = ({ day, slots, selected, onSelect }: { day: string; slots?: Map<number, string[]>; selected: number | null; onSelect: (t: number) => void }) => {
  const tz = timezone();
  const groups: Array<[string, typeof SunIcon, Array<[number, string[]]>]> = [
    ['Morning', SunIcon, []],
    ['Afternoon', SunIcon, []],
    ['Evening', MoonIcon, []],
  ];
  for (const entry of slots ?? new Map()) {
    const m = zoned(entry[0], tz).minutes;
    groups[m < 12 * 60 ? 0 : m < 17 * 60 ? 1 : 2]![2].push(entry);
  }
  return (
    <div className="space-y-5">
      <h2 className="font-semibold text-steel-900">{fmtDay(day)}</h2>
      {!slots?.size && <p className="text-sm text-steel-500">No open times this day.</p>}
      {groups
        .filter(([, , list]) => list.length)
        .map(([label, Icon, list]) => (
          <div key={label}>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-steel-500">
              <Icon className="h-4 w-4" /> {label}
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
              {list.map(([t, ids]) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => onSelect(t)}
                  aria-pressed={selected === t}
                  className={cx(
                    'rounded-xl border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                    selected === t ? 'border-brand-600 bg-brand-600 text-white' : 'border-steel-200 bg-white hover:border-brand-400 hover:bg-brand-50',
                  )}
                >
                  <span className="block text-sm font-semibold tabular-nums">{fmtTime(t)}</span>
                  <span className={cx('block text-xs', selected === t ? 'text-brand-100' : 'text-steel-500')}>
                    {ids.length} doctor{ids.length === 1 ? '' : 's'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
};

const SelectionBar = ({ time, onChange }: { time: number; onChange: () => void }) => (
  <div className="flex items-center justify-between gap-3 rounded-2xl bg-brand-50 px-5 py-3 ring-1 ring-brand-100">
    <p className="flex items-center gap-2 text-sm font-medium text-brand-900">
      <CalendarDaysIcon className="h-5 w-5" /> {fmtWhen(time)}
    </p>
    <button type="button" onClick={onChange} className="text-sm font-medium text-brand-700 hover:underline">
      Change
    </button>
  </div>
);

/** Doctors not free at the chosen time, with their next opening. */
const OtherDoctors = ({
  doctors,
  slots,
  after,
  onPick,
}: {
  doctors: Doctor[];
  slots: Map<string, Map<number, string[]>>;
  after: number;
  onPick: (doctorId: string, time: number) => void;
}) => {
  if (!doctors.length) return null;
  const next = (id: string): number | null => {
    for (const m of slots.values()) for (const [t, ids] of m) if (t > after && ids.includes(id)) return t;
    return null;
  };
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-steel-600">Not available at this time</h2>
      <Panel>
        {doctors.map((d) => {
          const n = next(d.id);
          return (
            <div key={d.id} className="flex items-center gap-4 border-b border-steel-100 px-4 py-3 last:border-b-0">
              <Avatar name={d.name} size="sm" className="opacity-70" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-steel-700">{d.name}</p>
                <p className="truncate text-xs text-steel-500">{d.specialty ?? 'Clinician'}</p>
              </div>
              {n ? (
                <button type="button" onClick={() => onPick(d.id, n)} className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-brand-700 hover:bg-brand-50">
                  Next: {fmtWhen(n)}
                </button>
              ) : (
                <span className="shrink-0 text-xs text-steel-400">No openings this month</span>
              )}
            </div>
          );
        })}
      </Panel>
    </section>
  );
};

const Summary = ({ time, doctor }: { time: number; doctor: Doctor }) => (
  <Panel className="h-fit p-5">
    <h2 className="text-xs font-semibold uppercase tracking-wide text-steel-500">Your appointment</h2>
    <p className="mt-3 text-lg font-semibold text-steel-900">{fmtWhen(time)}</p>
    <div className="mt-4 flex items-center gap-3">
      <Avatar name={doctor.name} />
      <div>
        <p className="font-medium text-steel-900">{doctor.name}</p>
        <p className="text-sm text-steel-500">
          {doctor.specialty ?? 'Clinician'} · {doctor.hours.length} min
        </p>
      </div>
    </div>
  </Panel>
);

const ics = (when: number, minutes: number, title: string) => {
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const body = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Headless Patient Portal//EN',
    'BEGIN:VEVENT',
    `UID:${when}-${Math.random().toString(36).slice(2)}@portal`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(when)}`,
    `DTEND:${stamp(when + minutes * 60_000)}`,
    `SUMMARY:${title.replace(/[,;\\]/g, ' ')}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  return URL.createObjectURL(new Blob([body], { type: 'text/calendar' }));
};

const Booked = ({ booked }: { booked: { when: number; doctor: Doctor; reason: string } }) => {
  const navigate = useNavigate();
  const href = useMemo(() => ics(booked.when, booked.doctor.hours.length, `Appointment with ${booked.doctor.name}`), [booked]);
  useEffect(() => () => URL.revokeObjectURL(href), [href]);
  return (
    <Page className="max-w-lg">
      <Panel className="p-8 text-center">
        <CheckCircleIcon className="mx-auto h-14 w-14 text-green-600" aria-hidden="true" />
        <h1 className="mt-4 text-2xl font-semibold text-steel-900">You’re booked</h1>
        <p className="mt-2 text-steel-600">{fmtWhen(booked.when)}</p>
        <p className="text-steel-600">
          with {booked.doctor.name}
          {booked.doctor.specialty ? ` (${booked.doctor.specialty})` : ''}
        </p>
        {booked.reason && <p className="mt-3 text-sm text-steel-500">“{asText(booked.reason)}”</p>}
        <div className="mt-6 flex flex-col gap-2">
          <a href={href} download="appointment.ics" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-steel-300 bg-white px-4 text-sm font-medium text-steel-700 shadow-sm hover:bg-steel-50">
            <ArrowDownTrayIcon className="h-4 w-4" /> Add to my calendar
          </a>
          <Button variant="primary" onClick={() => navigate('/patient/appointments')}>
            View my appointments
          </Button>
        </div>
        <p className="mt-6 text-xs text-steel-500">Need to change it? Send your care team a message or call the office.</p>
      </Panel>
    </Page>
  );
};
