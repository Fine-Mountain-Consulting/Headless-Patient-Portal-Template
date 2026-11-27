import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import {
  ArrowDownTrayIcon,
  BeakerIcon,
  CalendarDaysIcon,
  ChatBubbleLeftRightIcon,
  ClipboardDocumentListIcon,
  DocumentIcon,
  DocumentTextIcon,
  EnvelopeIcon,
  MapPinIcon,
  PencilSquareIcon,
  PhoneIcon,
  PhotoIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { Button, ConfirmDialog, cx, MonthCalendar, PageHeader, type CalendarEvent } from '../../ui';
import { useSession } from '../../lib/session';
import { asAddress, asFile, asText, fileHref, refName, useCreate, useDelete, useList, type Rec } from '../../lib/records';
import { entityOf, useSchema, type EntityInfo } from '../../lib/schema';
import { age, dayKey, fileSize, formatDate, formatDateLong, formatTime, relative } from '../../lib/format';
import { useTitle } from '../../lib/hooks';
import { RecordForm } from '../../components/fields';
import { CreateDrawer, RecordDrawer } from '../../components/RecordDrawer';
import { Avatar, Empty, InlineError, Page, Panel, SafeHtml, SkeletonRows, StatusPill, useToast } from '../../components/ui';
import { AppointmentRow, IconBubble, Row, isCancelled, splitAppointments } from '../shared/cards';
import { MessageRow, RefillPill } from './Home';
import { NotAvailable } from '../shared/EntityPages';

/** Opens the drawer named in ?open=… and keeps the URL in step. */
const useOpenParam = (key = 'open') => {
  const [params, setParams] = useSearchParams();
  const id = params.get(key);
  const set = (next: string | null) =>
    setParams(
      (p) => {
        const q = new URLSearchParams(p);
        if (next) q.set(key, next);
        else q.delete(key);
        return q;
      },
      { replace: true },
    );
  return [id, set] as const;
};

const Segmented = <T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: Array<{ id: T; label: string; count?: number }> }) => (
  <div role="tablist" className="inline-flex rounded-xl bg-steel-100 p-1">
    {options.map((o) => (
      <button
        key={o.id}
        role="tab"
        type="button"
        aria-selected={value === o.id}
        onClick={() => onChange(o.id)}
        className={cx(
          'rounded-lg px-4 py-1.5 text-sm font-medium transition',
          value === o.id ? 'bg-white text-steel-900 shadow-sm' : 'text-steel-600 hover:text-steel-900',
        )}
      >
        {o.label}
        {o.count !== undefined && <span className="ml-1.5 text-steel-400">{o.count}</span>}
      </button>
    ))}
  </div>
);

/** Whether this user can book online (the Online booking feature, or a Knack booking form). */
export const useBookingEnabled = (): boolean => {
  const q = useQuery({ queryKey: ['booking'], queryFn: () => api<{ enabled: boolean }>('/booking'), staleTime: 60_000 });
  return Boolean(q.data?.enabled);
};

const usePatientEntity = (slug: string) => {
  const { data: schema } = useSchema();
  return { schema, entity: entityOf(schema, slug) };
};

const Loading = () => <SkeletonRows rows={4} />;

// ── Appointments ──────────────────────────────────────────────────────────

export const PatientAppointments = () => {
  useTitle('Appointments');
  const { schema, entity } = usePatientEntity('appointments');
  const navigate = useNavigate();
  const [tab, setTab] = useState<'upcoming' | 'past' | 'calendar'>('upcoming');
  const [month, setMonth] = useState(() => new Date());
  const [openId, setOpen] = useOpenParam();
  const booking = useBookingEnabled();
  const list = useList('appointments', { rows: 1000, sort: 'dateOfAppointment', order: 'asc', source: 'patient-appointments' }, Boolean(entity?.can.read));
  const { upcoming, past } = useMemo(() => splitAppointments(list.data?.records ?? []), [list.data]);
  const events = useMemo<CalendarEvent[]>(
    () =>
      (list.data?.records ?? []).map((a) => ({
        id: a.id,
        date: dayKey(a.dateOfAppointment),
        label: `${formatTime(a.dateOfAppointment)} ${refName(a.doctor)}`,
        tone: isCancelled(a) ? 'danger' : /complete/i.test(asText(a.status)) ? 'success' : 'info',
      })),
    [list.data],
  );
  if (!schema) return null;
  if (!entity?.can.read) return <NotAvailable />;
  const shown = tab === 'upcoming' ? upcoming : past;

  return (
    <Page>
      <PageHeader
        title="Appointments"
        description={booking ? 'Your visits with your care team.' : 'Visits booked with your care team. To book or change one, send a message or call the office.'}
        actions={
          booking && (
            <Button variant="primary" icon={<PlusIcon className="h-4 w-4" />} onClick={() => navigate('/patient/book')}>
              Book appointment
            </Button>
          )
        }
      />
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { id: 'upcoming', label: 'Upcoming', count: upcoming.filter((a) => !isCancelled(a)).length },
          { id: 'past', label: 'Past', count: past.length },
          { id: 'calendar', label: 'Calendar' },
        ]}
      />
      {tab === 'calendar' ? (
        <MonthCalendar month={month} onMonthChange={setMonth} events={events} loading={list.isLoading} onEventClick={(e) => setOpen(e.id)} />
      ) : list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <InlineError error={list.error} onRetry={() => void list.refetch()} />
      ) : shown.length === 0 ? (
        <Empty
          icon={<CalendarDaysIcon className="h-6 w-6" />}
          title={tab === 'upcoming' ? 'No upcoming appointments' : 'No past appointments'}
          action={tab === 'upcoming' && booking && <Button variant="primary" onClick={() => navigate('/patient/book')}>Book an appointment</Button>}
        >
          {tab === 'upcoming' ? (booking ? 'Pick a time that works for you.' : 'When your care team books a visit, it will show up here.') : undefined}
        </Empty>
      ) : (
        <GroupedByMonth records={shown} dateKey="dateOfAppointment" render={(a) => <AppointmentRow key={a.id} appt={a} onOpen={() => setOpen(a.id)} />} />
      )}
      <RecordDrawer
        entity={entity}
        id={openId}
        onClose={() => setOpen(null)}
        source="patient-appointments"
        title={(r) => formatDateLong(r.dateOfAppointment)}
        renderBody={(r) => (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <StatusPill value={r.status} />
              {!isCancelled(r) && <span className="text-sm text-steel-500">{relative(r.dateOfAppointment)}</span>}
            </div>
            <DetailList
              items={[
                ['Time', formatTime(r.dateOfAppointment)],
                ['With', refName(r.doctor)],
                ['Reason', asText(r.reasonForAppointment)],
                ['Length', typeof r.duration === 'number' ? `${r.duration} minutes` : ''],
                ['Notes', asText(r.notes)],
              ]}
            />
          </div>
        )}
      />
    </Page>
  );
};

const GroupedByMonth = ({ records, dateKey, render }: { records: Rec[]; dateKey: string; render: (r: Rec) => ReactNode }) => {
  const groups = useMemo(() => {
    const map = new Map<string, Rec[]>();
    for (const r of records) {
      const label = asText(r[dateKey]) ? new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(asText(r[dateKey]))) : 'No date';
      map.set(label, [...(map.get(label) ?? []), r]);
    }
    return [...map.entries()];
  }, [records, dateKey]);
  return (
    <div className="space-y-6">
      {groups.map(([label, rows]) => (
        <section key={label} aria-label={label}>
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-steel-500">{label}</h2>
          <Panel>{rows.map(render)}</Panel>
        </section>
      ))}
    </div>
  );
};

export const DetailList = ({ items }: { items: Array<[string, ReactNode]> }) => (
  <dl className="divide-y divide-steel-100 rounded-xl border border-steel-200">
    {items
      .filter(([, v]) => v !== '' && v !== null && v !== undefined)
      .map(([k, v]) => (
        <div key={k} className="grid grid-cols-3 gap-4 px-4 py-3">
          <dt className="text-sm text-steel-500">{k}</dt>
          <dd className="col-span-2 whitespace-pre-line text-sm text-steel-900">{v}</dd>
        </div>
      ))}
  </dl>
);

// ── Test results ──────────────────────────────────────────────────────────

export const PatientResults = () => {
  useTitle('Test results');
  const { schema, entity } = usePatientEntity('test-results');
  const [openId, setOpen] = useOpenParam();
  const list = useList('test-results', { rows: 500, sort: 'testDate', order: 'desc', source: 'patient-results' }, Boolean(entity?.can.read));
  if (!schema) return null;
  if (!entity?.can.read) return <NotAvailable />;
  const records = list.data?.records ?? [];
  return (
    <Page>
      <PageHeader title="Test results" description="Lab and imaging results your care team has released to you." />
      {list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <InlineError error={list.error} onRetry={() => void list.refetch()} />
      ) : records.length === 0 ? (
        <Empty icon={<BeakerIcon className="h-6 w-6" />} title="No test results yet">
          Results appear here once your care team releases them.
        </Empty>
      ) : (
        <Panel>
          {records.map((r) => (
            <Row key={r.id} onClick={() => setOpen(r.id)}>
              <IconBubble icon={BeakerIcon} tone="violet" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-steel-900">{asText(r.testType) || 'Test result'}</p>
                <p className="truncate text-sm text-steel-500">
                  {formatDate(r.testDate)}
                  {refName(r.doctor) && ` · ${refName(r.doctor)}`}
                </p>
              </div>
              <StatusPill value={r.status} />
            </Row>
          ))}
        </Panel>
      )}
      <RecordDrawer
        entity={entity}
        id={openId}
        onClose={() => setOpen(null)}
        source="patient-results"
        title={(r) => asText(r.testType) || 'Test result'}
        renderBody={(r) => (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill value={r.status} />
              <span className="text-sm text-steel-500">{formatDateLong(r.testDate)}</span>
            </div>
            {asText(r.results) ? (
              <div className="rounded-xl border border-steel-200 bg-white p-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-steel-500">Results</h3>
                <SafeHtml html={r.results} className="text-[15px]" />
              </div>
            ) : (
              <p className="text-sm text-steel-500">No details have been added to this result.</p>
            )}
            <DetailList
              items={[
                ['Ordered by', refName(r.doctor)],
                ['Lab reference', asText(r.labReferenceNumber)],
              ]}
            />
            <p className="text-xs text-steel-500">Questions about a result? Send your care team a message. They’ll explain what it means for you.</p>
          </div>
        )}
      />
    </Page>
  );
};

// ── Medications ───────────────────────────────────────────────────────────

const isActiveMed = (m: Rec) => !asText(m.status) || /active|current/i.test(asText(m.status));

export const PatientMedications = () => {
  useTitle('Medications');
  const { schema, entity } = usePatientEntity('prescriptions');
  const [tab, setTab] = useState<'active' | 'past'>('active');
  const [openId, setOpen] = useOpenParam();
  const list = useList('prescriptions', { rows: 500, sort: 'datePrescribed', order: 'desc', source: 'patient-medications' }, Boolean(entity?.can.read));
  if (!schema) return null;
  if (!entity?.can.read) return <NotAvailable />;
  const records = list.data?.records ?? [];
  const active = records.filter(isActiveMed);
  const past = records.filter((m) => !isActiveMed(m));
  const shown = tab === 'active' ? active : past;
  return (
    <Page>
      <PageHeader title="Medications" description="Prescriptions from your care team. Always follow the instructions on your pharmacy label." />
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { id: 'active', label: 'Current', count: active.length },
          { id: 'past', label: 'Past', count: past.length },
        ]}
      />
      {list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <InlineError error={list.error} onRetry={() => void list.refetch()} />
      ) : shown.length === 0 ? (
        <Empty icon={<ClipboardDocumentListIcon className="h-6 w-6" />} title={tab === 'active' ? 'No current medications' : 'No past medications'} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setOpen(m.id)}
              className="flex flex-col rounded-2xl border border-steel-200 bg-white p-5 text-left shadow-sm transition hover:border-brand-300 hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold text-steel-900">{asText(m.medicationName)}</p>
                  <p className="text-sm text-steel-600">{asText(m.dosage)}</p>
                </div>
                <StatusPill value={m.status} />
              </div>
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-steel-100 pt-3 text-sm text-steel-500">
                <span className="truncate">
                  {refName(m.doctor) || 'Prescribed'} · {formatDate(m.datePrescribed)}
                </span>
                <RefillPill refills={m.refillsRemaining} />
              </div>
            </button>
          ))}
        </div>
      )}
      <RecordDrawer
        entity={entity}
        id={openId}
        onClose={() => setOpen(null)}
        source="patient-medications"
        title={(r) => asText(r.medicationName)}
        renderBody={(r) => (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill value={r.status} />
              <RefillPill refills={r.refillsRemaining} />
            </div>
            <DetailList
              items={[
                ['Dosage', asText(r.dosage)],
                ['Prescribed by', refName(r.doctor)],
                ['Prescribed on', formatDate(r.datePrescribed)],
              ]}
            />
            {asText(r.instructions) && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-800">How to take it</h3>
                <SafeHtml html={r.instructions} className="text-[15px] text-steel-800" />
              </div>
            )}
          </div>
        )}
      />
    </Page>
  );
};

// ── Messages ──────────────────────────────────────────────────────────────

export const PatientMessages = () => {
  useTitle('Messages');
  const { schema, entity } = usePatientEntity('messages');
  const [openId, setOpen] = useOpenParam();
  const [compose, setCompose] = useOpenParam('compose');
  const create = useCreate('messages');
  const toast = useToast();
  const list = useList('messages', { rows: 200, sort: 'dateSent', order: 'desc', source: 'patient-messages' }, Boolean(entity?.can.read));
  if (!schema) return null;
  if (!entity?.can.read) return <NotAvailable />;
  const records = list.data?.records ?? [];
  const canSend = entity.can.create;
  return (
    <Page>
      <PageHeader
        title="Messages"
        description="Secure messages with your care team. For anything urgent, call the office or 911."
        actions={
          canSend && (
            <Button variant="primary" icon={<PencilSquareIcon className="h-4 w-4" />} onClick={() => setCompose('1')}>
              New message
            </Button>
          )
        }
      />
      {list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <InlineError error={list.error} onRetry={() => void list.refetch()} />
      ) : records.length === 0 ? (
        <Empty
          icon={<ChatBubbleLeftRightIcon className="h-6 w-6" />}
          title="No messages yet"
          action={
            canSend && (
              <Button variant="primary" onClick={() => setCompose('1')}>
                Write to your care team
              </Button>
            )
          }
        >
          Ask a question, request a refill, or follow up on a visit.
        </Empty>
      ) : (
        <Panel>
          {records.map((m) => (
            <MessageRow key={m.id} message={m} onOpen={() => setOpen(m.id)} />
          ))}
        </Panel>
      )}
      <RecordDrawer
        entity={entity}
        id={openId}
        onClose={() => setOpen(null)}
        source="patient-messages"
        title={(r) => asText(r.subject) || '(No subject)'}
        renderBody={(r) => (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <Avatar name={refName(r.doctor) || 'Care team'} />
              <div>
                <p className="font-medium text-steel-900">{refName(r.doctor) || 'Care team'}</p>
                <p className="text-sm text-steel-500">{formatDateLong(r.dateSent)} {formatTime(r.dateSent) && `at ${formatTime(r.dateSent)}`}</p>
              </div>
              <StatusPill value={r.priority} className="ml-auto" />
            </div>
            {asText(r.messageContent) ? (
              <div className="rounded-xl border border-steel-200 bg-white p-4">
                <SafeHtml html={r.messageContent} className="text-[15px]" />
              </div>
            ) : (
              <p className="rounded-xl bg-steel-50 p-4 text-sm text-steel-500">The message text isn’t shown here.</p>
            )}
            {canSend && (
              <Button
                variant="secondary"
                icon={<PencilSquareIcon className="h-4 w-4" />}
                onClick={() => {
                  setOpen(null);
                  setCompose('1');
                }}
              >
                Write a reply
              </Button>
            )}
          </div>
        )}
      />
      <CreateDrawer open={Boolean(compose)} onClose={() => setCompose(null)} title="New message" description="Your care team usually replies within 2 business days.">
        <RecordForm
          entity={entity}
          mode="create"
          fields={['doctor', 'subject', 'messageContent']}
          labels={{ doctor: 'To', messageContent: 'Message' }}
          submitLabel="Send message"
          onCancel={() => setCompose(null)}
          onSubmit={async (values) => {
            await create.mutateAsync({ values, source: 'patient-messages' });
            toast('Message sent');
            setCompose(null);
          }}
        />
      </CreateDrawer>
    </Page>
  );
};

// ── Documents ─────────────────────────────────────────────────────────────

const docIcon = (type: string | null | undefined) => (type?.startsWith('image/') ? PhotoIcon : type === 'application/pdf' ? DocumentTextIcon : DocumentIcon);

export const PatientDocuments = () => {
  useTitle('Documents');
  const { schema, entity } = usePatientEntity('documents');
  const [openId, setOpen] = useOpenParam();
  const [upload, setUpload] = useOpenParam('upload');
  const create = useCreate('documents');
  const toast = useToast();
  const list = useList('documents', { rows: 500, sort: 'uploadDate', order: 'desc', source: 'patient-documents' }, Boolean(entity?.can.read));
  if (!schema) return null;
  if (!entity?.can.read) return <NotAvailable />;
  const records = list.data?.records ?? [];
  return (
    <Page>
      <PageHeader
        title="Documents"
        description="Forms, letters and files shared between you and your care team."
        actions={
          entity.can.create && (
            <Button variant="primary" icon={<PlusIcon className="h-4 w-4" />} onClick={() => setUpload('1')}>
              Upload
            </Button>
          )
        }
      />
      {list.isLoading ? (
        <Loading />
      ) : list.error ? (
        <InlineError error={list.error} onRetry={() => void list.refetch()} />
      ) : records.length === 0 ? (
        <Empty icon={<DocumentIcon className="h-6 w-6" />} title="No documents yet" action={entity.can.create && <Button variant="primary" onClick={() => setUpload('1')}>Upload a document</Button>}>
          Upload insurance cards, referral letters, or forms your care team asked for.
        </Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {records.map((d) => {
            const f = asFile(d.file);
            const Icon = docIcon(f?.type);
            return (
              <div key={d.id} className="flex flex-col rounded-2xl border border-steel-200 bg-white p-4 shadow-sm">
                <button type="button" onClick={() => setOpen(d.id)} className="flex items-start gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                  <IconBubble icon={Icon} tone="sky" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-steel-900">{asText(d.documentType) || f?.filename || 'Document'}</p>
                    <p className="truncate text-sm text-steel-500">{f?.filename}</p>
                  </div>
                </button>
                <div className="mt-4 flex items-center justify-between border-t border-steel-100 pt-3 text-xs text-steel-500">
                  <span>
                    {formatDate(d.uploadDate)}
                    {f?.size ? ` · ${fileSize(f.size)}` : ''}
                  </span>
                  {f && (
                    <a
                      href={fileHref('documents', d.id, 'file', { source: 'patient-documents' })}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-brand-700 hover:bg-brand-50"
                    >
                      <ArrowDownTrayIcon className="h-4 w-4" /> Download
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <RecordDrawer entity={entity} id={openId} onClose={() => setOpen(null)} source="patient-documents" title={(r) => asText(r.documentType) || 'Document'} />
      <CreateDrawer open={Boolean(upload)} onClose={() => setUpload(null)} title="Upload a document" description="Files are sent securely to your care team. Up to 20 MB.">
        <RecordForm
          entity={entity}
          mode="create"
          fields={['file', 'documentType', 'description']}
          labels={{ documentType: 'What is it?', description: 'Anything we should know? (optional)' }}
          submitLabel="Upload"
          onCancel={() => setUpload(null)}
          onSubmit={async (values) => {
            await create.mutateAsync({ values, source: 'patient-documents' });
            toast('Document uploaded');
            setUpload(null);
          }}
        />
      </CreateDrawer>
    </Page>
  );
};

// ── Profile & emergency contacts ──────────────────────────────────────────

export const PatientProfile = () => {
  useTitle('My profile');
  const { me } = useSession();
  const { schema, entity: patients } = usePatientEntity('patients');
  const contacts = entityOf(schema, 'emergency-contacts');
  const self = useList('patients', { source: 'patient-profile' }, Boolean(patients?.can.read));
  const record = self.data?.records[0];
  if (!schema) return null;

  return (
    <Page>
      <PageHeader title="My profile" />
      <Panel className="p-6">
        <div className="flex items-center gap-4">
          <Avatar name={me?.user.name ?? ''} size="xl" />
          <div className="min-w-0">
            <p className="truncate text-xl font-semibold text-steel-900">{me?.user.name}</p>
            <p className="truncate text-sm text-steel-500">{me?.user.email}</p>
          </div>
        </div>
        {record && (
          <dl className="mt-6 grid gap-4 border-t border-steel-100 pt-6 sm:grid-cols-2">
            {[
              ['Date of birth', asText(record.dateOfBirth) && `${formatDate(record.dateOfBirth)} (age ${age(record.dateOfBirth)})`],
              ['Phone', asText(record.phone)],
              ['Address', asAddress(record.address)?.full],
              ['Primary doctor', refName(record.doctor)],
            ]
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs font-medium uppercase tracking-wide text-steel-500">{k}</dt>
                  <dd className="mt-1 text-sm text-steel-900">{v}</dd>
                </div>
              ))}
          </dl>
        )}
        <p className="mt-6 text-sm text-steel-500">To update your personal details, contact the office. They keep your record accurate for your care and billing.</p>
      </Panel>
      {contacts?.can.read && <EmergencyContacts entity={contacts} />}
    </Page>
  );
};

const EmergencyContacts = ({ entity }: { entity: EntityInfo }) => {
  const toast = useToast();
  const list = useList('emergency-contacts', { rows: 50, sort: 'name', order: 'asc', source: 'patient-profile' });
  const create = useCreate('emergency-contacts');
  const del = useDelete('emergency-contacts');
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Rec | null>(null);
  const records = list.data?.records ?? [];

  return (
    <section className="space-y-3" aria-labelledby="ec">
      <div className="flex items-end justify-between">
        <div>
          <h2 id="ec" className="text-base font-semibold text-steel-900">
            Emergency contacts
          </h2>
          <p className="text-sm text-steel-500">People we can call if something happens.</p>
        </div>
        {entity.can.create && (
          <Button variant="secondary" icon={<PlusIcon className="h-4 w-4" />} onClick={() => setAdding(true)}>
            Add
          </Button>
        )}
      </div>
      {list.isLoading ? (
        <SkeletonRows rows={1} />
      ) : records.length === 0 ? (
        <Empty icon={<PhoneIcon className="h-6 w-6" />} title="No emergency contacts" action={entity.can.create && <Button variant="primary" onClick={() => setAdding(true)}>Add a contact</Button>}>
          Add at least one person we can reach in an emergency.
        </Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {records.map((c) => (
            <div key={c.id} className="rounded-2xl border border-steel-200 bg-white p-5 shadow-sm">
              <div className="flex items-start gap-3">
                <Avatar name={asText(c.name)} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-steel-900">{asText(c.name)}</p>
                  <ul className="mt-2 space-y-1 text-sm text-steel-600">
                    {asText(c.phone) && (
                      <li className="flex items-center gap-2">
                        <PhoneIcon className="h-4 w-4 text-steel-400" aria-hidden="true" />
                        <a href={`tel:${asText(c.phone).replace(/[^\d+]/g, '')}`} className="hover:underline">
                          {asText(c.phone)}
                        </a>
                      </li>
                    )}
                    {asText(c.email) && (
                      <li className="flex items-center gap-2 truncate">
                        <EnvelopeIcon className="h-4 w-4 text-steel-400" aria-hidden="true" />
                        {asText(c.email)}
                      </li>
                    )}
                    {asAddress(c.address)?.full && (
                      <li className="flex items-start gap-2">
                        <MapPinIcon className="mt-0.5 h-4 w-4 shrink-0 text-steel-400" aria-hidden="true" />
                        {asAddress(c.address)?.full}
                      </li>
                    )}
                  </ul>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-1 border-t border-steel-100 pt-3">
                {entity.can.update && (
                  <Button size="sm" variant="ghost" icon={<PencilSquareIcon className="h-4 w-4" />} onClick={() => setEditId(c.id)}>
                    Edit
                  </Button>
                )}
                {entity.can.delete && (
                  <Button size="sm" variant="ghost" className="text-red-700 hover:bg-red-50" icon={<TrashIcon className="h-4 w-4" />} onClick={() => setDeleting(c)}>
                    Remove
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <CreateDrawer open={adding} onClose={() => setAdding(false)} title="Add emergency contact">
        <RecordForm
          entity={entity}
          mode="create"
          fields={['name', 'phone', 'email', 'address']}
          onCancel={() => setAdding(false)}
          onSubmit={async (values) => {
            await create.mutateAsync({ values, source: 'patient-profile' });
            toast('Contact added');
            setAdding(false);
          }}
        />
      </CreateDrawer>
      <RecordDrawer entity={entity} id={editId} onClose={() => setEditId(null)} source="patient-profile" editFields={['name', 'phone', 'email', 'address']} />
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        destructive
        title={`Remove ${asText(deleting?.name)}?`}
        message="They’ll no longer be listed as one of your emergency contacts."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await del.mutateAsync({ id: deleting.id, source: 'patient-profile' });
            toast('Contact removed');
          } catch (e) {
            toast((e as Error).message, 'error');
          }
          setDeleting(null);
        }}
      />
    </section>
  );
};
