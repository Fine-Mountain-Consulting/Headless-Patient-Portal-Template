import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  CalendarDaysIcon,
  ChatBubbleLeftRightIcon,
  ChevronLeftIcon,
  EnvelopeIcon,
  MapPinIcon,
  PencilSquareIcon,
  PhoneIcon,
  UserGroupIcon,
  ListBulletIcon,
  ClockIcon,
} from '@heroicons/react/24/outline';
import { Button, cx, MonthCalendar, PageHeader, SearchInput, StatTile, Tabs, type CalendarEvent } from '@fmc/knack-ui';
import { useSession } from '../../lib/session';
import { asAddress, asName, asText, refName, useCreate, useList, useRecord, type Rec } from '../../lib/records';
import { entityOf, parentFieldFor, useSchema, type EntityInfo } from '../../lib/schema';
import { addDays, age, dayKey, formatDate, formatDateLong, formatTime, greeting, todayKey } from '../../lib/format';
import { useDebounced, useTitle } from '../../lib/hooks';
import { RecordForm } from '../../components/fields';
import { CreateDrawer, RecordDrawer } from '../../components/RecordDrawer';
import { Avatar, Empty, InlineError, Page, Panel, Section, SkeletonRows, StatusPill, TextLink, toneFor, useToast } from '../../components/ui';
import { AppointmentRow, Row, isCancelled } from '../shared/cards';
import { NotAvailable, RelatedList } from '../shared/EntityPages';
import { MessageRow } from '../patient/Home';
import { DetailList } from '../patient/Pages';

const useMyAppointments = (enabled: boolean, source: string) =>
  useList('appointments', { rows: 1000, sort: 'dateOfAppointment', order: 'asc', source }, enabled);

// ── Today ─────────────────────────────────────────────────────────────────

export const DoctorToday = () => {
  useTitle('Today');
  const { me } = useSession();
  const { data: schema } = useSchema();
  const navigate = useNavigate();
  const appts = entityOf(schema, 'appointments');
  const list = useMyAppointments(Boolean(appts?.can.read), 'doctor-today');
  const patients = useList('patients', { rows: 1, source: 'doctor-today' }, Boolean(entityOf(schema, 'patients')?.can.read));
  const messages = useList('messages', { rows: 20, sort: 'dateSent', order: 'desc', source: 'doctor-today' }, Boolean(entityOf(schema, 'messages')?.can.read));
  const [openId, setOpenId] = useState<string | null>(null);

  const today = todayKey();
  const all = list.data?.records ?? [];
  const todays = all.filter((a) => dayKey(a.dateOfAppointment) === today);
  const weekEnd = addDays(today, 7);
  const week = all.filter((a) => {
    const d = dayKey(a.dateOfAppointment);
    return d >= today && d < weekEnd && !isCancelled(a);
  });
  const nextUp = todays.find((a) => !isCancelled(a) && new Date(asText(a.dateOfAppointment)).getTime() > Date.now() - 15 * 60_000);
  const unread = (messages.data?.records ?? []).filter((m) => m.readStatus === false).length;

  if (!schema) return null;
  return (
    <Page>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-brand-700">{formatDateLong(new Date().toISOString())}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            {greeting()}, {me?.user.name}
          </h1>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Today" value={todays.filter((a) => !isCancelled(a)).length} icon={<CalendarDaysIcon className="h-5 w-5" />} loading={list.isLoading} />
        <StatTile label="Next 7 days" value={week.length} icon={<ClockIcon className="h-5 w-5" />} loading={list.isLoading} />
        <StatTile label="My patients" value={patients.data?.total ?? '—'} icon={<UserGroupIcon className="h-5 w-5" />} loading={patients.isLoading} />
        <StatTile label="Unread messages" value={unread} icon={<ChatBubbleLeftRightIcon className="h-5 w-5" />} loading={messages.isLoading} />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Section title="Today’s schedule" action={<TextLink to="/doctor/schedule">Full schedule</TextLink>} className="lg:col-span-3">
          {list.isLoading ? (
            <SkeletonRows rows={3} />
          ) : list.error ? (
            <InlineError error={list.error} onRetry={() => void list.refetch()} />
          ) : todays.length === 0 ? (
            <Empty icon={<CalendarDaysIcon className="h-6 w-6" />} title="Nothing on the books today">
              {week.length ? `Your next visit is ${formatDate(week[0]!.dateOfAppointment)}.` : 'No visits in the next 7 days.'}
            </Empty>
          ) : (
            <Panel>
              <ol>
                {todays.map((a) => (
                  <li key={a.id} className={cx(nextUp?.id === a.id && 'bg-brand-50/60')}>
                    <Row onClick={() => setOpenId(a.id)}>
                      <div className="w-16 shrink-0 text-right">
                        <p className={cx('text-sm font-semibold tabular-nums', isCancelled(a) ? 'text-steel-400 line-through' : 'text-steel-900')}>{formatTime(a.dateOfAppointment)}</p>
                        {typeof a.duration === 'number' && <p className="text-xs text-steel-500">{a.duration} min</p>}
                      </div>
                      <div className={cx('h-10 w-1 shrink-0 rounded-full', { danger: 'bg-red-400', success: 'bg-green-500', warning: 'bg-amber-400', info: 'bg-blue-400', brand: 'bg-brand-500', neutral: 'bg-steel-300' }[toneFor(a.status)])} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-steel-900">
                          {refName(a.patient)}
                          {nextUp?.id === a.id && <span className="ml-2 rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-semibold text-white">Next</span>}
                        </p>
                        <p className="truncate text-sm text-steel-500">{asText(a.reasonForAppointment)}</p>
                      </div>
                      <StatusPill value={a.status} />
                    </Row>
                  </li>
                ))}
              </ol>
            </Panel>
          )}
        </Section>

        <Section title="Recent messages" action={<TextLink to="/doctor/messages">Inbox</TextLink>} className="lg:col-span-2">
          {messages.isLoading ? (
            <SkeletonRows rows={3} />
          ) : messages.data?.records.length ? (
            <Panel>
              {messages.data.records.slice(0, 5).map((m) => (
                <MessageRow key={m.id} message={m} counterpart="patient" onOpen={() => navigate(`/doctor/messages?open=${m.id}`)} />
              ))}
            </Panel>
          ) : (
            <Empty icon={<ChatBubbleLeftRightIcon className="h-6 w-6" />} title="No messages" />
          )}
        </Section>
      </div>
      {appts && <AppointmentDrawer entity={appts} id={openId} onClose={() => setOpenId(null)} />}
    </Page>
  );
};

/** Appointment details with its notes, for clinicians. */
export const AppointmentDrawer = ({ entity, id, onClose }: { entity: EntityInfo; id: string | null; onClose: () => void }) => {
  const { data: schema } = useSchema();
  const notes = entityOf(schema, 'notes');
  const noteParent = notes ? parentFieldFor(notes, 'appointments') : undefined;
  return (
    <RecordDrawer
      entity={entity}
      id={id}
      onClose={onClose}
      source="doctor-appointment"
      title={(r) => `${refName(r.patient)} · ${formatTime(r.dateOfAppointment)}`}
      renderBody={(r) => (
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <StatusPill value={r.status} />
            <span className="text-sm text-steel-500">{formatDateLong(r.dateOfAppointment)}</span>
          </div>
          <DetailList
            items={[
              ['Patient', r.patient ? <PatientLink r={r} /> : ''],
              ['Doctor', refName(r.doctor)],
              ['Reason', asText(r.reasonForAppointment)],
              ['Length', typeof r.duration === 'number' ? `${r.duration} minutes` : ''],
              ['Notes', asText(r.notes)],
            ]}
          />
        </div>
      )}
    >
      {(r) =>
        notes?.can.read && noteParent ? (
          <div className="border-t border-steel-100 pt-5">
            <RelatedList parentEntity={entity} parentId={r.id} entity={notes} field={noteParent.slug} columns={['date', 'note']} title="Visit notes" />
          </div>
        ) : null
      }
    </RecordDrawer>
  );
};

const PatientLink = ({ r }: { r: Rec }) => {
  const p = (r.patient as Array<{ id: string; identifier: string }>)[0];
  return p ? (
    <Link to={`/doctor/patients/${p.id}`} className="font-medium text-brand-700 hover:underline">
      {p.identifier}
    </Link>
  ) : null;
};

// ── Schedule ──────────────────────────────────────────────────────────────

export const DoctorSchedule = () => {
  useTitle('Schedule');
  const { data: schema } = useSchema();
  const entity = entityOf(schema, 'appointments');
  const list = useMyAppointments(Boolean(entity?.can.read), 'doctor-schedule');
  const [month, setMonth] = useState(() => new Date());
  const [day, setDay] = useState(todayKey());
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [openId, setOpenId] = useState<string | null>(null);
  const records = list.data?.records ?? [];

  const events = useMemo<CalendarEvent[]>(
    () =>
      records.map((a) => ({
        id: a.id,
        date: dayKey(a.dateOfAppointment),
        label: `${formatTime(a.dateOfAppointment)} ${refName(a.patient)}`,
        tone: (({ danger: 'danger', success: 'success', warning: 'warning', info: 'info', brand: 'info', neutral: 'neutral' }) as const)[toneFor(a.status)],
      })),
    [records],
  );
  const dayRecords = records.filter((a) => dayKey(a.dateOfAppointment) === day);
  const upcoming = records.filter((a) => dayKey(a.dateOfAppointment) >= todayKey());

  if (!schema) return null;
  if (!entity?.can.read) return <NotAvailable />;
  return (
    <Page>
      <PageHeader
        title="Schedule"
        actions={
          <div className="inline-flex rounded-xl bg-steel-100 p-1">
            {(['calendar', 'list'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={cx('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium', view === v ? 'bg-white shadow-sm' : 'text-steel-600')}
              >
                {v === 'calendar' ? <CalendarDaysIcon className="h-4 w-4" /> : <ListBulletIcon className="h-4 w-4" />}
                {v === 'calendar' ? 'Calendar' : 'Upcoming'}
              </button>
            ))}
          </div>
        }
      />
      {list.error && <InlineError error={list.error} onRetry={() => void list.refetch()} />}
      {view === 'calendar' ? (
        <div className="grid gap-6 xl:grid-cols-3">
          <div className="xl:col-span-2">
            <MonthCalendar month={month} onMonthChange={setMonth} events={events} loading={list.isLoading} onEventClick={(e) => setOpenId(e.id)} onDayClick={setDay} />
          </div>
          <Section title={formatDateLong(day)}>
            {dayRecords.length === 0 ? (
              <Empty title="No appointments this day" />
            ) : (
              <Panel>
                {dayRecords.map((a) => (
                  <AppointmentRow key={a.id} appt={a} showPatient showDoctor={false} onOpen={() => setOpenId(a.id)} />
                ))}
              </Panel>
            )}
          </Section>
        </div>
      ) : list.isLoading ? (
        <SkeletonRows rows={5} />
      ) : upcoming.length === 0 ? (
        <Empty icon={<CalendarDaysIcon className="h-6 w-6" />} title="No upcoming appointments" />
      ) : (
        <Panel>
          {upcoming.map((a) => (
            <AppointmentRow key={a.id} appt={a} showPatient showDoctor={false} onOpen={() => setOpenId(a.id)} />
          ))}
        </Panel>
      )}
      <AppointmentDrawer entity={entity} id={openId} onClose={() => setOpenId(null)} />
    </Page>
  );
};

// ── Patients ──────────────────────────────────────────────────────────────

export const DoctorPatients = () => {
  useTitle('My patients');
  const { data: schema } = useSchema();
  const entity = entityOf(schema, 'patients');
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);
  const list = useList('patients', { rows: 200, sort: 'name', order: 'asc', q, source: 'doctor-patients' }, Boolean(entity?.can.read));
  if (!schema) return null;
  if (!entity?.can.read) return <NotAvailable />;
  const records = list.data?.records ?? [];
  return (
    <Page>
      <PageHeader title="My patients" description={list.data ? `${list.data.total} patient${list.data.total === 1 ? '' : 's'} under your care` : undefined} />
      <SearchInput value={search} onChange={setSearch} placeholder="Search by name…" className="max-w-md" />
      {list.isLoading ? (
        <SkeletonRows rows={5} />
      ) : list.error ? (
        <InlineError error={list.error} onRetry={() => void list.refetch()} />
      ) : records.length === 0 ? (
        <Empty icon={<UserGroupIcon className="h-6 w-6" />} title={q ? `No patients match “${q}”` : 'No patients yet'} />
      ) : (
        <Panel>
          {records.map((p) => {
            const name = asName(p.name)?.full ?? '';
            const a = age(p.dateOfBirth);
            return (
              <Row key={p.id} onClick={() => navigate(`/doctor/patients/${p.id}`)}>
                <Avatar name={name} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-steel-900">{name}</p>
                  <p className="truncate text-sm text-steel-500">
                    {[a !== null ? `${a} yrs` : '', asText(p.dateOfBirth) && `DOB ${formatDate(p.dateOfBirth)}`, asText(p.phone)].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </Row>
            );
          })}
        </Panel>
      )}
    </Page>
  );
};

const CHART_TABS = ['test-results', 'prescriptions', 'documents', 'notes', 'appointments', 'emergency-contacts', 'messages'];
const CHART_COLUMNS: Record<string, string[]> = {
  'test-results': ['testType', 'testDate', 'status', 'labReferenceNumber'],
  prescriptions: ['medicationName', 'dosage', 'datePrescribed', 'refillsRemaining', 'status'],
  documents: ['documentType', 'uploadDate', 'file', 'description'],
  notes: ['date', 'note', 'doctor'],
  appointments: ['dateOfAppointment', 'reasonForAppointment', 'status'],
  messages: ['dateSent', 'subject', 'priority'],
};

export const PatientChart = () => {
  const { id = '' } = useParams();
  const { data: schema } = useSchema();
  const patients = entityOf(schema, 'patients');
  const q = useRecord('patients', id, 'doctor-chart');
  const [params, setParams] = useSearchParams();
  const p = q.data?.record;
  const name = asName(p?.name)?.full ?? '';
  useTitle(name || 'Patient');

  const tabs = useMemo(() => {
    if (!schema) return [];
    return CHART_TABS.map((slug) => entityOf(schema, slug))
      .filter((e): e is EntityInfo => Boolean(e?.can.read))
      .map((e) => ({ entity: e, field: parentFieldFor(e, 'patients') }))
      .filter((x): x is { entity: EntityInfo; field: NonNullable<typeof x.field> } => Boolean(x.field));
  }, [schema]);
  const active = params.get('tab') ?? tabs[0]?.entity.slug ?? '';

  if (!schema || !patients) return null;
  const a = age(p?.dateOfBirth);
  return (
    <Page>
      <Link to="/doctor/patients" className="no-print inline-flex items-center gap-1 text-sm font-medium text-steel-500 hover:text-steel-800">
        <ChevronLeftIcon className="h-4 w-4" /> My patients
      </Link>
      {q.error && <InlineError error={q.error} onRetry={() => void q.refetch()} />}
      {q.isLoading && <div className="h-36 animate-pulse rounded-2xl bg-steel-100" />}
      {p && (
        <>
          <Panel className="p-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
              <Avatar name={name} size="xl" />
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-2xl font-semibold tracking-tight text-steel-900">{name}</h1>
                <p className="mt-0.5 text-sm text-steel-600">
                  {[a !== null ? `${a} years old` : '', asText(p.dateOfBirth) && `Born ${formatDate(p.dateOfBirth)}`].filter(Boolean).join(' · ')}
                </p>
                <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-steel-600">
                  {asText(p.phone) && (
                    <li className="flex items-center gap-1.5">
                      <PhoneIcon className="h-4 w-4 text-steel-400" aria-hidden="true" />
                      <a href={`tel:${asText(p.phone).replace(/[^\d+]/g, '')}`} className="hover:underline">
                        {asText(p.phone)}
                      </a>
                    </li>
                  )}
                  {asText(p.email) && (
                    <li className="flex items-center gap-1.5">
                      <EnvelopeIcon className="h-4 w-4 text-steel-400" aria-hidden="true" />
                      {asText(p.email)}
                    </li>
                  )}
                  {asAddress(p.address)?.full && (
                    <li className="flex items-center gap-1.5">
                      <MapPinIcon className="h-4 w-4 text-steel-400" aria-hidden="true" />
                      {asAddress(p.address)?.full}
                    </li>
                  )}
                </ul>
              </div>
            </div>
            {(asText(p.emergencyContact) || asText(p.emergencyPhone)) && (
              <p className="mt-5 rounded-xl bg-rose-50 px-4 py-2.5 text-sm text-rose-900">
                <span className="font-medium">Emergency contact:</span> {asText(p.emergencyContact)} {asText(p.emergencyPhone) && `· ${asText(p.emergencyPhone)}`}
              </p>
            )}
          </Panel>
          {tabs.length > 0 && (
            <>
              <Tabs
                tabs={tabs.map((t) => ({ id: t.entity.slug, label: t.entity.name }))}
                active={active}
                onChange={(t) => setParams({ tab: t }, { replace: true })}
              />
              {tabs.map((t) =>
                t.entity.slug === active ? (
                  <RelatedList key={t.entity.slug} parentEntity={patients} parentId={p.id} entity={t.entity} field={t.field.slug} columns={CHART_COLUMNS[t.entity.slug]?.filter((c) => t.entity.readFields.includes(c))} />
                ) : null,
              )}
            </>
          )}
        </>
      )}
    </Page>
  );
};

// ── Messages ──────────────────────────────────────────────────────────────

export const StaffMessages = ({ source, counterpart }: { source: string; counterpart: 'patient' | 'doctor' }) => {
  useTitle('Messages');
  const { data: schema } = useSchema();
  const entity = entityOf(schema, 'messages');
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const [compose, setCompose] = useState(false);
  const create = useCreate('messages');
  const toast = useToast();
  const list = useList('messages', { rows: 200, sort: 'dateSent', order: 'desc', source }, Boolean(entity?.can.read));
  if (!schema) return null;
  if (!entity?.can.read) return <NotAvailable />;
  const records = list.data?.records ?? [];
  return (
    <Page>
      <PageHeader
        title="Messages"
        actions={
          entity.can.create && entity.listable && (
            <Button variant="primary" icon={<PencilSquareIcon className="h-4 w-4" />} onClick={() => setCompose(true)}>
              New message
            </Button>
          )
        }
      />
      {list.isLoading ? (
        <SkeletonRows rows={5} />
      ) : list.error ? (
        <InlineError error={list.error} onRetry={() => void list.refetch()} />
      ) : records.length === 0 ? (
        <Empty icon={<ChatBubbleLeftRightIcon className="h-6 w-6" />} title="No messages" />
      ) : (
        <Panel>
          {records.map((m) => (
            <MessageRow key={m.id} message={m} counterpart={counterpart} onOpen={() => setParams({ open: m.id }, { replace: true })} />
          ))}
        </Panel>
      )}
      <RecordDrawer entity={entity} id={openId} onClose={() => setParams({}, { replace: true })} source={source} title={(r) => asText(r.subject) || '(No subject)'} />
      <CreateDrawer open={compose} onClose={() => setCompose(false)} title="New message">
        <RecordForm
          entity={entity}
          mode="create"
          labels={{ patient: 'To', messageContent: 'Message' }}
          submitLabel="Send message"
          onCancel={() => setCompose(false)}
          onSubmit={async (values) => {
            await create.mutateAsync({ values, source });
            toast('Message sent');
            setCompose(false);
          }}
        />
      </CreateDrawer>
    </Page>
  );
};

