/**
 * A doctor's own schedule: weekly hours, appointment length, whether patients
 * can book online, and time off. Online booking reads all of it.
 *
 * What a doctor can change here comes from the server's policy: the portal
 * feature "Doctor availability" (switched on by an admin), or equivalent Knack
 * pages (an edit form on their own Doctors record, a Doctor Time Off table and
 * form connected to the logged-in doctor). Either way, only their own.
 */
import { useEffect, useMemo, useState } from 'react';
import { CalendarDaysIcon, ClockIcon, PlusIcon, TrashIcon, SunIcon } from '@heroicons/react/24/outline';
import { Button, ConfirmDialog, cx, FormField, PageHeader, Select, Switch, TextInput } from '../../ui';
import { useSession } from '../../lib/session';
import { asText, useCreate, useDelete, useList, useRecord, useUpdate, type Rec } from '../../lib/records';
import { entityOf, fieldOf, useSchema } from '../../lib/schema';
import { addDays, formatDate, formatTime, todayKey, timezone } from '../../lib/format';
import { useTitle } from '../../lib/hooks';
import { ApiError } from '../../lib/api';
import { CreateDrawer } from '../../components/RecordDrawer';
import { Empty, InlineError, Page, Panel, Section, SkeletonRows, useToast } from '../../components/ui';
import { DEFAULT_HOURS, hoursFrom, WEEKDAYS, weekdayOf } from '../../../../../packages/core/src/booking/slots';

const HOUR_FIELDS = ['availableDays', 'dayStarts', 'dayEnds', 'appointmentLength', 'onlineBooking'];
const LENGTHS = [10, 15, 20, 30, 45, 60, 90];
const clock = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

export const DoctorAvailability = () => {
  useTitle('My availability');
  const { me } = useSession();
  const { data: schema } = useSchema();
  const doctors = entityOf(schema, 'doctors');
  const timeOff = entityOf(schema, 'doctor-time-off');
  const myId = me?.roles.find((r) => r.slug === 'doctors')?.recordId ?? null;
  const editable = Boolean(doctors?.can.update && HOUR_FIELDS.some((f) => doctors.updateFields.includes(f)));
  const rec = useRecord('doctors', editable ? myId : null, 'doctor-availability');

  if (!schema) return null;
  return (
    <Page>
      <PageHeader title="My availability" description="When patients can book you online. Changes apply to new bookings right away; existing appointments aren’t moved." />
      {!editable && !timeOff?.can.read && <SetupNeeded />}
      {editable && (rec.isLoading ? <SkeletonRows rows={2} /> : rec.error ? <InlineError error={rec.error} onRetry={() => void rec.refetch()} /> : rec.data && <WeeklyHours record={rec.data.record} />)}
      {timeOff?.can.read && <TimeOff />}
    </Page>
  );
};

const WeeklyHours = ({ record }: { record: Rec }) => {
  const { data: schema } = useSchema();
  const doctors = entityOf(schema, 'doctors')!;
  const update = useUpdate('doctors');
  const toast = useToast();
  const startOptions = fieldOf(doctors, 'dayStarts')?.options ?? [];
  const endOptions = fieldOf(doctors, 'dayEnds')?.options ?? [];
  const can = (f: string) => doctors.updateFields.includes(f);

  const initial = useMemo(
    () => ({
      days: Array.isArray(record.availableDays) && record.availableDays.length ? (record.availableDays as string[]) : DEFAULT_HOURS.days.map((d) => WEEKDAYS[d]!),
      start: asText(record.dayStarts) || clock(DEFAULT_HOURS.start),
      end: asText(record.dayEnds) || clock(DEFAULT_HOURS.end),
      length: typeof record.appointmentLength === 'number' ? record.appointmentLength : DEFAULT_HOURS.length,
      online: record.onlineBooking !== false,
    }),
    [record],
  );
  const [v, setV] = useState(initial);
  useEffect(() => setV(initial), [initial]);
  const dirty = JSON.stringify(v) !== JSON.stringify(initial);
  const hours = hoursFrom({ days: v.days, start: v.start, end: v.end, length: v.length });
  const invalid = hours.end <= hours.start ? 'Your day has to end after it starts.' : !v.days.length ? 'Pick at least one day.' : null;
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const values: Record<string, unknown> = {};
    if (can('availableDays')) values.availableDays = v.days;
    if (can('dayStarts')) values.dayStarts = v.start;
    if (can('dayEnds')) values.dayEnds = v.end;
    if (can('appointmentLength')) values.appointmentLength = v.length;
    if (can('onlineBooking')) values.onlineBooking = v.online;
    setSaving(true);
    try {
      await update.mutateAsync({ id: record.id, values, source: 'doctor-availability' });
      toast('Availability saved');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not save.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <Panel className="space-y-6 p-6">
        {can('onlineBooking') && (
          <div className="flex items-center justify-between gap-4 rounded-xl bg-steel-50 px-4 py-3">
            <div>
              <p className="font-medium text-steel-900">Online booking</p>
              <p className="text-sm text-steel-500">{v.online ? 'Patients can book you in the portal.' : 'You’re hidden from online booking.'}</p>
            </div>
            <Switch checked={v.online} onChange={(online) => setV((s) => ({ ...s, online }))} label="Online booking" />
          </div>
        )}
        {can('availableDays') && (
          <fieldset>
            <legend className="text-sm font-medium text-steel-800">Days you see patients</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                const name = WEEKDAYS[d]!;
                const on = v.days.includes(name);
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setV((s) => ({ ...s, days: on ? s.days.filter((x) => x !== name) : [...s.days, name] }))}
                    className={cx(
                      'h-11 w-14 rounded-xl border text-sm font-medium transition',
                      on ? 'border-brand-600 bg-brand-600 text-white' : 'border-steel-300 bg-white text-steel-600 hover:bg-steel-50',
                    )}
                  >
                    {name.slice(0, 3)}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          {can('dayStarts') && (
            <FormField label="Day starts" htmlFor="ds">
              <Select id="ds" value={v.start} onChange={(e) => setV((s) => ({ ...s, start: e.target.value }))} options={startOptions.length ? startOptions : [v.start]} />
            </FormField>
          )}
          {can('dayEnds') && (
            <FormField label="Day ends" htmlFor="de">
              <Select id="de" value={v.end} onChange={(e) => setV((s) => ({ ...s, end: e.target.value }))} options={endOptions.length ? endOptions : [v.end]} />
            </FormField>
          )}
          {can('appointmentLength') && (
            <FormField label="Appointment length" htmlFor="al">
              <Select
                id="al"
                value={String(v.length)}
                onChange={(e) => setV((s) => ({ ...s, length: Number(e.target.value) }))}
                options={[...new Set([...LENGTHS, v.length])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: `${n} minutes` }))}
              />
            </FormField>
          )}
        </div>
        {invalid && <p className="text-sm text-red-700">{invalid}</p>}
        <div className="flex justify-end gap-2 border-t border-steel-100 pt-4">
          <Button variant="ghost" disabled={!dirty || saving} onClick={() => setV(initial)}>
            Reset
          </Button>
          <Button variant="primary" disabled={!dirty || Boolean(invalid)} loading={saving} onClick={() => void save()}>
            Save availability
          </Button>
        </div>
      </Panel>
      <Panel className="h-fit p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-steel-900">
          <ClockIcon className="h-4 w-4" /> At a glance
        </h2>
        <p className="mt-3 text-3xl font-semibold tabular-nums text-steel-900">{invalid ? '—' : Math.floor((hours.end - hours.start) / hours.length)}</p>
        <p className="text-sm text-steel-500">appointments per day, at most</p>
        <p className="mt-4 text-sm text-steel-700">
          {v.days.length ? WEEKDAYS.filter((w) => v.days.includes(w)).map((w) => w.slice(0, 3)).join(', ') : 'No days'} · {v.start}–{v.end}
        </p>
        <p className="mt-1 text-xs text-steel-500">Times are in the practice’s time zone ({timezone().replace('_', ' ')}).</p>
      </Panel>
    </div>
  );
};

const TimeOff = () => {
  const { data: schema } = useSchema();
  const entity = entityOf(schema, 'doctor-time-off')!;
  const yesterday = addDays(todayKey(), -1);
  const list = useList('doctor-time-off', { rows: 200, sort: 'starts', order: 'asc', filters: [{ field: 'ends', operator: 'is after', value: yesterday }], source: 'doctor-availability' });
  const create = useCreate('doctor-time-off');
  const del = useDelete('doctor-time-off');
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Rec | null>(null);
  const records = list.data?.records ?? [];

  return (
    <Section
      title="Time off"
      description="Vacations, conferences, a blocked afternoon. Patients can’t book you during these times."
      action={
        entity.can.create && (
          <Button variant="secondary" icon={<PlusIcon className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Add time off
          </Button>
        )
      }
    >
      {list.isLoading ? (
        <SkeletonRows rows={2} />
      ) : list.error ? (
        <InlineError error={list.error} onRetry={() => void list.refetch()} />
      ) : records.length === 0 ? (
        <Empty icon={<SunIcon className="h-6 w-6" />} title="No upcoming time off" />
      ) : (
        <Panel>
          {records.map((r) => {
            const sameDay = formatDate(r.starts) === formatDate(r.ends);
            return (
              <div key={r.id} className="flex items-center gap-4 border-b border-steel-100 px-5 py-3.5 last:border-b-0">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700">
                  <CalendarDaysIcon className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-steel-900">
                    {sameDay ? `${formatDate(r.starts)}, ${formatTime(r.starts)} – ${formatTime(r.ends)}` : `${formatDate(r.starts)} – ${formatDate(r.ends)}`}
                  </p>
                  {asText(r.reason) && <p className="truncate text-sm text-steel-500">{asText(r.reason)}</p>}
                </div>
                {entity.can.delete && (
                  <Button size="sm" variant="ghost" className="text-red-700 hover:bg-red-50" icon={<TrashIcon className="h-4 w-4" />} onClick={() => setDeleting(r)}>
                    Remove
                  </Button>
                )}
              </div>
            );
          })}
        </Panel>
      )}
      <CreateDrawer open={adding} onClose={() => setAdding(false)} title="Add time off">
        <TimeOffForm
          onCancel={() => setAdding(false)}
          onSave={async (values) => {
            await create.mutateAsync({ values, source: 'doctor-availability' });
            toast('Time off added');
            setAdding(false);
          }}
        />
      </CreateDrawer>
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Remove this time off?"
        message="Patients will be able to book you during this time again."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await del.mutateAsync({ id: deleting.id, source: 'doctor-availability' });
            toast('Time off removed');
          } catch (e) {
            toast((e as Error).message, 'error');
          }
          setDeleting(null);
        }}
      />
    </Section>
  );
};

const TimeOffForm = ({ onSave, onCancel }: { onSave: (values: Record<string, unknown>) => Promise<void>; onCancel: () => void }) => {
  const today = todayKey();
  const [allDay, setAllDay] = useState(true);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [startTime, setStartTime] = useState('12:00');
  const [endTime, setEndTime] = useState('17:00');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const starts = `${from}T${allDay ? '00:00' : startTime}`;
    const ends = `${allDay ? to : from}T${allDay ? '23:59' : endTime}`;
    if (ends <= starts) {
      setError('The end has to be after the start.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ starts, ends, reason: reason.trim() });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const days = allDay ? Math.round((new Date(to).getTime() - new Date(from).getTime()) / 864e5) + 1 : 0;
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between rounded-xl border border-steel-200 px-4 py-3">
        <span className="text-sm font-medium text-steel-700">All day</span>
        <Switch checked={allDay} onChange={setAllDay} label="All day" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={allDay ? 'First day off' : 'Day'} htmlFor="to-from">
          <TextInput
            id="to-from"
            type="date"
            min={today}
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              if (to < e.target.value) setTo(e.target.value);
            }}
          />
        </FormField>
        {allDay ? (
          <FormField label="Last day off" htmlFor="to-to">
            <TextInput id="to-to" type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
          </FormField>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <FormField label="From" htmlFor="to-st">
              <TextInput id="to-st" type="time" step={1800} value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </FormField>
            <FormField label="Until" htmlFor="to-et">
              <TextInput id="to-et" type="time" step={1800} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </FormField>
          </div>
        )}
      </div>
      {allDay && days > 0 && (
        <p className="text-sm text-steel-500">
          {days} day{days === 1 ? '' : 's'}, {WEEKDAYS[weekdayOf(from)]} to {WEEKDAYS[weekdayOf(to)]}
        </p>
      )}
      <FormField label="Reason (optional, only staff see it)" htmlFor="to-r">
        <TextInput id="to-r" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Conference, vacation…" />
      </FormField>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" loading={saving} onClick={() => void submit()}>
          Save
        </Button>
      </div>
    </div>
  );
};

const SetupNeeded = () => (
  <Panel className="p-6">
    <p className="font-medium text-steel-900">Availability isn’t switched on for doctors yet</p>
    <p className="mt-1 text-sm text-steel-600">
      An administrator can switch on “Doctor availability” under Administration → Portal features. Until then, the office can set your hours for you.
    </p>
  </Panel>
);
