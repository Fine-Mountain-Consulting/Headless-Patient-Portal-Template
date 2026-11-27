import { useState } from 'react';
import { CalendarDaysIcon, CheckCircleIcon, UserGroupIcon, XCircleIcon, ClockIcon } from '@heroicons/react/24/outline';
import { cx, PageHeader, Select, StatTile } from '../../ui';
import { useSession } from '../../lib/session';
import { asText, refName, useList, useUpdate, type Rec } from '../../lib/records';
import { entityOf, fieldOf, useSchema } from '../../lib/schema';
import { addDays, dayKey, formatDateLong, formatTime, greeting, todayKey } from '../../lib/format';
import { useTitle } from '../../lib/hooks';
import { Empty, InlineError, Page, Panel, Section, SkeletonRows, TextLink, useToast } from '../../components/ui';
import { isCancelled } from '../shared/cards';
import { AppointmentDrawer } from '../doctor/Pages';

/** Front-desk view: today across every clinician, with one-tap status changes. */
export const StaffDashboard = () => {
  useTitle('Today');
  const { me } = useSession();
  const { data: schema } = useSchema();
  const appts = entityOf(schema, 'appointments');
  const today = todayKey();
  const list = useList(
    'appointments',
    {
      rows: 500,
      sort: 'dateOfAppointment',
      order: 'asc',
      filters: [
        { field: 'dateOfAppointment', operator: 'is after', value: addDays(today, -1) },
        { field: 'dateOfAppointment', operator: 'is before', value: addDays(today, 8) },
      ],
      source: 'staff-today',
    },
    Boolean(appts?.can.read),
  );
  const patients = useList('patients', { rows: 1, source: 'staff-today' }, Boolean(entityOf(schema, 'patients')?.can.read));
  const update = useUpdate('appointments');
  const toast = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const [doctor, setDoctor] = useState('');

  if (!schema) return null;
  const all = list.data?.records ?? [];
  const doctors = [...new Map(all.flatMap((a) => (a.doctor as Array<{ id: string; identifier: string }>) ?? []).map((d) => [d.id, d.identifier])).entries()];
  const todays = all.filter((a) => dayKey(a.dateOfAppointment) === today && (!doctor || (a.doctor as Array<{ id: string }>)?.some((d) => d.id === doctor)));
  const statusField = fieldOf(appts, 'status');
  const canSetStatus = Boolean(appts?.updateFields.includes('status'));

  const setStatus = async (a: Rec, status: string) => {
    try {
      await update.mutateAsync({ id: a.id, values: { status }, source: 'staff-today' });
      toast(`${refName(a.patient)}: ${status}`);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const count = (re: RegExp) => todays.filter((a) => re.test(asText(a.status))).length;

  return (
    <Page>
      <header>
        <p className="text-sm font-medium text-brand-700">{formatDateLong(new Date().toISOString())}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          {greeting()}, {me?.user.name.split(' ')[0]}
        </h1>
      </header>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Appointments today" value={todays.filter((a) => !isCancelled(a)).length} icon={<CalendarDaysIcon className="h-5 w-5" />} loading={list.isLoading} />
        <StatTile label="Completed" value={count(/complete/i)} icon={<CheckCircleIcon className="h-5 w-5" />} loading={list.isLoading} />
        <StatTile label="Cancelled" value={count(/cancel/i)} icon={<XCircleIcon className="h-5 w-5" />} loading={list.isLoading} />
        <StatTile label="Patients" value={patients.data?.total ?? '—'} icon={<UserGroupIcon className="h-5 w-5" />} loading={patients.isLoading} />
      </div>

      <Section
        title="Today’s appointments"
        action={
          <div className="flex items-center gap-3">
            {doctors.length > 1 && (
              <Select
                aria-label="Filter by clinician"
                value={doctor}
                onChange={(e) => setDoctor(e.target.value)}
                options={[{ value: '', label: 'All clinicians' }, ...doctors.map(([id, name]) => ({ value: id, label: name }))]}
                className="w-48"
              />
            )}
            <TextLink to="/staff/data/appointments">All appointments</TextLink>
          </div>
        }
      >
        {list.isLoading ? (
          <SkeletonRows rows={4} />
        ) : list.error ? (
          <InlineError error={list.error} onRetry={() => void list.refetch()} />
        ) : todays.length === 0 ? (
          <Empty icon={<CalendarDaysIcon className="h-6 w-6" />} title="No appointments today" />
        ) : (
          <Panel>
            <table className="w-full text-sm">
              <thead className="hidden border-b border-steel-200 bg-steel-50 text-left text-xs font-semibold uppercase tracking-wide text-steel-500 sm:table-header-group">
                <tr>
                  <th className="px-5 py-3">Time</th>
                  <th className="px-3 py-3">Patient</th>
                  <th className="hidden px-3 py-3 md:table-cell">Clinician</th>
                  <th className="hidden px-3 py-3 lg:table-cell">Reason</th>
                  <th className="px-5 py-3 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-steel-100">
                {todays.map((a) => (
                  <tr key={a.id} className="hover:bg-steel-50">
                    <td className="whitespace-nowrap px-5 py-3 font-semibold tabular-nums">
                      <button type="button" onClick={() => setOpenId(a.id)} className="flex items-center gap-1.5 hover:text-brand-700">
                        <ClockIcon className="h-4 w-4 text-steel-400" aria-hidden="true" />
                        {formatTime(a.dateOfAppointment)}
                      </button>
                    </td>
                    <td className="px-3 py-3">
                      <button type="button" onClick={() => setOpenId(a.id)} className="text-left font-medium text-steel-900 hover:text-brand-700">
                        {refName(a.patient)}
                      </button>
                      <p className="text-xs text-steel-500 md:hidden">{refName(a.doctor)}</p>
                    </td>
                    <td className="hidden px-3 py-3 text-steel-600 md:table-cell">{refName(a.doctor)}</td>
                    <td className="hidden max-w-xs truncate px-3 py-3 text-steel-500 lg:table-cell">{asText(a.reasonForAppointment)}</td>
                    <td className="px-5 py-3 text-right">
                      {canSetStatus && statusField?.options ? (
                        <select
                          aria-label={`Status for ${refName(a.patient)}`}
                          value={asText(a.status)}
                          onChange={(e) => void setStatus(a, e.target.value)}
                          className={cx(
                            'rounded-full border-0 py-1 pl-3 pr-8 text-xs font-medium ring-1 ring-inset focus:ring-2 focus:ring-brand-500',
                            /cancel/i.test(asText(a.status)) ? 'bg-red-50 text-red-800 ring-red-200' : /complete/i.test(asText(a.status)) ? 'bg-green-50 text-green-800 ring-green-200' : /progress/i.test(asText(a.status)) ? 'bg-brand-50 text-brand-800 ring-brand-200' : 'bg-blue-50 text-blue-800 ring-blue-200',
                          )}
                        >
                          {statusField.options.map((o) => (
                            <option key={o}>{o}</option>
                          ))}
                        </select>
                      ) : (
                        asText(a.status)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </Section>
      {appts && <AppointmentDrawer entity={appts} id={openId} onClose={() => setOpenId(null)} />}
    </Page>
  );
};

export const StaffHeader = ({ title }: { title: string }) => <PageHeader title={title} />;
