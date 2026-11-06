import { useNavigate } from 'react-router-dom';
import {
  BeakerIcon,
  CalendarDaysIcon,
  ChatBubbleLeftRightIcon,
  DocumentArrowUpIcon,
  ClipboardDocumentListIcon,
  PhoneIcon,
  ArrowRightIcon,
  ClockIcon,
  UserIcon,
} from '@heroicons/react/24/outline';
import { cx } from '@fmc/knack-ui';
import { useSession } from '../../lib/session';
import { useList, asText, refName, type Rec } from '../../lib/records';
import { entityOf, useSchema } from '../../lib/schema';
import { firstName, formatDate, formatDateLong, formatTime, greeting, relative, whenLabel } from '../../lib/format';
import { Empty, InlineError, Page, Panel, Section, SkeletonRows, StatusPill, TextLink } from '../../components/ui';
import { IconBubble, Row, isCancelled, splitAppointments } from '../shared/cards';
import { useBookingEnabled } from './Pages';
import { useTitle } from '../../lib/hooks';

export const PatientHome = () => {
  const { me } = useSession();
  const { data: schema } = useSchema();
  const navigate = useNavigate();
  useTitle('Home');
  const can = (slug: string) => Boolean(entityOf(schema, slug)?.can.read);

  const appts = useList('appointments', { rows: 500, sort: 'dateOfAppointment', order: 'asc', source: 'patient-home' }, can('appointments'));
  const results = useList('test-results', { rows: 5, sort: 'testDate', order: 'desc', source: 'patient-home' }, can('test-results'));
  const meds = useList('prescriptions', { rows: 100, sort: 'datePrescribed', order: 'desc', source: 'patient-home' }, can('prescriptions'));
  const messages = useList('messages', { rows: 5, sort: 'dateSent', order: 'desc', source: 'patient-home' }, can('messages'));

  const { upcoming } = splitAppointments((appts.data?.records ?? []).filter((r) => !isCancelled(r)));
  const next = upcoming[0];
  const activeMeds = (meds.data?.records ?? []).filter((m) => !asText(m.status) || /active|current/i.test(asText(m.status)));
  const unread = (messages.data?.records ?? []).filter((m) => m.readStatus === false).length;

  const booking = useBookingEnabled();
  const actions = [
    booking && { label: 'Book an appointment', icon: CalendarDaysIcon, to: '/patient/book', tone: 'brand' as const },
    can('messages') && entityOf(schema, 'messages')?.can.create && { label: 'Message my care team', icon: ChatBubbleLeftRightIcon, to: '/patient/messages?compose=1', tone: 'brand' as const },
    can('documents') && entityOf(schema, 'documents')?.can.create && { label: 'Upload a document', icon: DocumentArrowUpIcon, to: '/patient/documents?upload=1', tone: 'sky' as const },
    can('emergency-contacts') && { label: 'Emergency contacts', icon: PhoneIcon, to: '/patient/profile', tone: 'rose' as const },
  ].filter(Boolean) as Array<{ label: string; icon: typeof PhoneIcon; to: string; tone: 'brand' | 'sky' | 'rose' }>;

  return (
    <Page>
      <header>
        <p className="text-sm font-medium text-brand-700">{formatDateLong(new Date().toISOString())}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-steel-900 sm:text-3xl">
          {greeting()}, {firstName(me?.user.name ?? '')}
        </h1>
      </header>

      {/* Next appointment */}
      {can('appointments') && (
        <section aria-labelledby="next-appt">
          <h2 id="next-appt" className="sr-only">
            Next appointment
          </h2>
          {appts.isLoading ? (
            <div className="h-40 animate-pulse rounded-3xl bg-brand-100/60" />
          ) : appts.error ? (
            <InlineError error={appts.error} onRetry={() => void appts.refetch()} />
          ) : next ? (
            <button
              type="button"
              onClick={() => navigate(`/patient/appointments?open=${next.id}`)}
              className="group relative w-full overflow-hidden rounded-3xl bg-gradient-to-br from-brand-600 to-brand-800 p-6 text-left text-white shadow-md transition hover:shadow-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 sm:p-8"
            >
              <div className="absolute -right-10 -top-10 h-48 w-48 rounded-full bg-white/10" aria-hidden="true" />
              <p className="relative text-sm font-medium uppercase tracking-wide text-brand-100">Your next appointment</p>
              <p className="relative mt-2 text-2xl font-semibold sm:text-3xl">{whenLabel(next.dateOfAppointment)}</p>
              <div className="relative mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-brand-50">
                {refName(next.doctor) && (
                  <span className="flex items-center gap-1.5">
                    <UserIcon className="h-4 w-4" aria-hidden="true" /> {refName(next.doctor)}
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <ClockIcon className="h-4 w-4" aria-hidden="true" /> {relative(next.dateOfAppointment)}
                </span>
              </div>
              {asText(next.reasonForAppointment) && <p className="relative mt-3 line-clamp-2 text-sm text-brand-100">{asText(next.reasonForAppointment)}</p>}
              <span className="relative mt-5 inline-flex items-center gap-1 text-sm font-semibold">
                View details <ArrowRightIcon className="h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden="true" />
              </span>
            </button>
          ) : (
            <Panel className="flex items-center gap-4 p-6">
              <IconBubble icon={CalendarDaysIcon} />
              <div>
                <p className="font-semibold text-steel-900">No upcoming appointments</p>
                <p className="text-sm text-steel-500">{booking ? 'Pick a time that works for you.' : 'When your care team books a visit, it will show up here.'}</p>
              </div>
              {booking && (
                <button type="button" onClick={() => navigate('/patient/book')} className="ml-auto shrink-0 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
                  Book now
                </button>
              )}
            </Panel>
          )}
        </section>
      )}

      {/* Quick actions */}
      {actions.length > 0 && (
        <nav aria-label="Quick actions" className={cx('grid grid-cols-1 gap-3 sm:grid-cols-2', actions.length >= 3 && 'lg:grid-cols-3', actions.length >= 4 && 'xl:grid-cols-4')}>
          {actions.map((a) => (
            <button
              key={a.to}
              type="button"
              onClick={() => navigate(a.to)}
              className="flex items-center gap-3 rounded-2xl border border-steel-200 bg-white p-4 text-left shadow-sm transition hover:border-brand-300 hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <IconBubble icon={a.icon} tone={a.tone} />
              <span className="font-medium text-steel-800">{a.label}</span>
            </button>
          ))}
        </nav>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {can('test-results') && (
          <Section title="Recent test results" action={<TextLink to="/patient/results">See all</TextLink>}>
            {results.isLoading ? (
              <SkeletonRows rows={2} />
            ) : results.error ? (
              <InlineError error={results.error} onRetry={() => void results.refetch()} />
            ) : results.data?.records.length ? (
              <Panel>
                {results.data.records.slice(0, 3).map((r) => (
                  <Row key={r.id} onClick={() => navigate(`/patient/results?open=${r.id}`)}>
                    <IconBubble icon={BeakerIcon} tone="violet" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-steel-900">{asText(r.testType) || 'Test result'}</p>
                      <p className="text-sm text-steel-500">{formatDate(r.testDate)}</p>
                    </div>
                    <StatusPill value={r.status} />
                  </Row>
                ))}
              </Panel>
            ) : (
              <Empty icon={<BeakerIcon className="h-6 w-6" />} title="No results yet">
                Results appear here once your care team releases them.
              </Empty>
            )}
          </Section>
        )}

        {can('prescriptions') && (
          <Section title="Current medications" action={<TextLink to="/patient/medications">See all</TextLink>}>
            {meds.isLoading ? (
              <SkeletonRows rows={2} />
            ) : meds.error ? (
              <InlineError error={meds.error} onRetry={() => void meds.refetch()} />
            ) : activeMeds.length ? (
              <Panel>
                {activeMeds.slice(0, 3).map((m) => (
                  <Row key={m.id} onClick={() => navigate(`/patient/medications?open=${m.id}`)}>
                    <IconBubble icon={ClipboardDocumentListIcon} tone="amber" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-steel-900">{asText(m.medicationName)}</p>
                      <p className="truncate text-sm text-steel-500">{asText(m.dosage)}</p>
                    </div>
                    <RefillPill refills={m.refillsRemaining} />
                  </Row>
                ))}
              </Panel>
            ) : (
              <Empty icon={<ClipboardDocumentListIcon className="h-6 w-6" />} title="No current medications" />
            )}
          </Section>
        )}

        {can('messages') && (
          <Section
            title={
              <span className="flex items-center gap-2">
                Messages {unread > 0 && <span className="rounded-full bg-brand-600 px-2 py-0.5 text-xs font-semibold text-white">{unread} new</span>}
              </span>
            }
            action={<TextLink to="/patient/messages">Open inbox</TextLink>}
            className="lg:col-span-2"
          >
            {messages.isLoading ? (
              <SkeletonRows rows={2} />
            ) : messages.data?.records.length ? (
              <Panel>
                {messages.data.records.slice(0, 3).map((m) => (
                  <MessageRow key={m.id} message={m} onOpen={() => navigate(`/patient/messages?open=${m.id}`)} />
                ))}
              </Panel>
            ) : (
              <Empty icon={<ChatBubbleLeftRightIcon className="h-6 w-6" />} title="No messages yet" />
            )}
          </Section>
        )}
      </div>
    </Page>
  );
};

export const RefillPill = ({ refills }: { refills: unknown }) => {
  if (typeof refills !== 'number') return null;
  const low = refills <= 1;
  return (
    <span
      className={cx(
        'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium',
        refills === 0 ? 'bg-red-100 text-red-800' : low ? 'bg-amber-100 text-amber-800' : 'bg-steel-100 text-steel-700',
      )}
    >
      {refills === 0 ? 'No refills' : `${refills} refill${refills === 1 ? '' : 's'}`}
    </span>
  );
};

export const MessageRow = ({ message: m, onOpen, counterpart = 'doctor' }: { message: Rec; onOpen?: () => void; counterpart?: 'doctor' | 'patient' }) => {
  const unread = m.readStatus === false;
  const who = refName(m[counterpart]) || refName(m.medicalStaff) || 'Care team';
  return (
    <Row onClick={onOpen}>
      <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full', unread ? 'bg-brand-600' : 'bg-transparent')} aria-label={unread ? 'Unread' : undefined} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className={cx('truncate text-sm', unread ? 'font-semibold text-steel-900' : 'font-medium text-steel-700')}>{who}</p>
          <span className="shrink-0 text-xs text-steel-500">{formatShortWhen(m.dateSent)}</span>
        </div>
        <p className={cx('truncate text-sm', unread ? 'text-steel-900' : 'text-steel-600')}>{asText(m.subject) || '(No subject)'}</p>
      </div>
      {/^(high|urgent)/i.test(asText(m.priority)) && <StatusPill value={m.priority} />}
    </Row>
  );
};

const formatShortWhen = (v: unknown) => {
  const s = asText(v);
  if (!s) return '';
  const diff = Date.now() - new Date(s).getTime();
  return diff < 864e5 && diff >= 0 ? formatTime(s) : formatDate(s);
};
