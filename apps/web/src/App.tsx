import { useEffect, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  BeakerIcon,
  CalendarDaysIcon,
  ChatBubbleLeftRightIcon,
  ClipboardDocumentListIcon,
  DocumentDuplicateIcon,
  HomeIcon,
  UserCircleIcon,
  UserGroupIcon,
  ShieldCheckIcon,
  ClockIcon,
  BoltIcon,
  Squares2X2Icon,
  TableCellsIcon,
  IdentificationIcon,
} from '@heroicons/react/24/outline';
import { Spinner } from '@fmc/knack-ui';
import { useSession } from './lib/session';
import { useConfig } from './lib/config';
import { entityOf, useSchema, type Schema } from './lib/schema';
import { experiencesFor, lastExperience, rememberExperience, type Experience, type ExperienceKind } from './lib/experiences';
import { useFocusOnNavigate } from './lib/hooks';
import { Shell, type ShellNavItem } from './components/Shell';
import { SignIn } from './pages/SignIn';
import { Welcome, NotFound } from './pages/Misc';
import { PatientHome } from './roles/patient/Home';
import { BookAppointment } from './roles/patient/Book';
import { PatientAppointments, PatientDocuments, PatientMedications, PatientMessages, PatientProfile, PatientResults } from './roles/patient/Pages';
import { DoctorPatients, DoctorSchedule, DoctorToday, PatientChart, StaffMessages } from './roles/doctor/Pages';
import { StaffDashboard } from './roles/staff/Pages';
import { DoctorAvailability } from './roles/doctor/Availability';
import { AccessMap, ActivityLog, AdminOverview, ApiUsage } from './roles/admin/Pages';
import { EntityListPage, RecordPage } from './roles/shared/EntityPages';

const FullPageSpinner = () => (
  <div className="flex min-h-screen items-center justify-center">
    <Spinner size="lg" />
  </div>
);

export const App = () => {
  const { me, loading } = useSession();
  useConfig();
  if (loading) return <FullPageSpinner />;
  return (
    <Routes>
      <Route path="/signin" element={<SignIn />} />
      <Route element={<RequireSession />}>
        <Route index element={<RoleRedirect />} />
        <Route path="/welcome" element={<Welcome />} />
        {me &&
          experiencesFor(me.roles).map((x) => (
            <Route key={x.base} path={`${x.base}/*`} element={<ExperienceRoutes experience={x} />} />
          ))}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
};

const RequireSession = () => {
  const { me } = useSession();
  const location = useLocation();
  if (!me) return <Navigate to="/signin" replace state={{ from: location.pathname === '/' ? undefined : location.pathname + location.search }} />;
  return <Outlet />;
};

/** After sign-in: the last view used this session, else the first role. No roles: welcome page. */
const RoleRedirect = () => {
  const { me } = useSession();
  const list = experiencesFor(me?.roles ?? []);
  if (!list.length) return <Navigate to="/welcome" replace />;
  const last = lastExperience();
  const target = list.find((x) => x.base === last) ?? list.find((x) => x.kind === 'admin') ?? list[0]!;
  return <Navigate to={target.base} replace />;
};

const ExperienceRoutes = ({ experience }: { experience: Experience }) => {
  const { data: schema, error, refetch } = useSchema();
  const config = useConfig();
  useFocusOnNavigate();
  useEffect(() => rememberExperience(experience.base), [experience.base]);
  if (error)
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="text-center">
          <p className="font-medium">We couldn’t load your portal.</p>
          <button type="button" className="mt-2 text-sm font-medium text-brand-700 underline" onClick={() => void refetch()}>
            Try again
          </button>
        </div>
      </div>
    );
  if (!schema) return <FullPageSpinner />;
  const appName = config.data?.appName ?? schema.appName;
  return (
    <Shell experience={experience} appName={appName} sections={navFor(experience, schema)}>
      <div className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <Routes>{routesFor(experience.kind, experience.base)}</Routes>
      </div>
    </Shell>
  );
};

const routesFor = (kind: ExperienceKind, base: string): ReactNode => {
  switch (kind) {
    case 'patient':
      return (
        <>
          <Route index element={<PatientHome />} />
          <Route path="appointments" element={<PatientAppointments />} />
          <Route path="book" element={<BookAppointment />} />
          <Route path="results" element={<PatientResults />} />
          <Route path="medications" element={<PatientMedications />} />
          <Route path="messages" element={<PatientMessages />} />
          <Route path="documents" element={<PatientDocuments />} />
          <Route path="profile" element={<PatientProfile />} />
          <Route path="*" element={<NotFound />} />
        </>
      );
    case 'doctor':
      return (
        <>
          <Route index element={<DoctorToday />} />
          <Route path="schedule" element={<DoctorSchedule />} />
          <Route path="patients" element={<DoctorPatients />} />
          <Route path="patients/:id" element={<PatientChart />} />
          <Route path="availability" element={<DoctorAvailability />} />
          <Route path="messages" element={<StaffMessages source="doctor-messages" counterpart="patient" />} />
          <Route path="*" element={<NotFound />} />
        </>
      );
    case 'staff':
      return (
        <>
          <Route index element={<StaffDashboard />} />
          <Route path="messages" element={<StaffMessages source="staff-messages" counterpart="patient" />} />
          <Route path="data/:entity" element={<EntityListPage base={base} />} />
          <Route path="records/:entity/:id" element={<RecordPage base={base} />} />
          <Route path="*" element={<NotFound />} />
        </>
      );
    case 'admin':
      return (
        <>
          <Route index element={<AdminOverview />} />
          <Route path="access" element={<AccessMap />} />
          <Route path="activity" element={<ActivityLog />} />
          <Route path="usage" element={<ApiUsage />} />
          <Route path="data/:entity" element={<EntityListPage base={base} />} />
          <Route path="records/:entity/:id" element={<RecordPage base={base} />} />
          <Route path="*" element={<NotFound />} />
        </>
      );
    default:
      return (
        <>
          <Route index element={<GenericHome base={base} />} />
          <Route path="data/:entity" element={<EntityListPage base={base} />} />
          <Route path="records/:entity/:id" element={<RecordPage base={base} />} />
          <Route path="*" element={<NotFound />} />
        </>
      );
  }
};

const ENTITY_ICONS: Record<string, ShellNavItem['icon']> = {
  appointments: CalendarDaysIcon,
  patients: UserGroupIcon,
  doctors: IdentificationIcon,
  'test-results': BeakerIcon,
  prescriptions: ClipboardDocumentListIcon,
  documents: DocumentDuplicateIcon,
  messages: ChatBubbleLeftRightIcon,
};

/** Nav items only for what this role can actually open. */
const navFor = (x: Experience, schema: Schema): Array<{ label?: string; items: ShellNavItem[] }> => {
  const can = (slug: string) => Boolean(entityOf(schema, slug)?.can.read);
  const b = x.base;
  const item = (cond: boolean, i: ShellNavItem) => (cond ? [i] : []);
  const dataItems = (filter: (slug: string) => boolean = () => true) =>
    schema.entities
      .filter((e) => e.can.read && e.listable && filter(e.slug))
      .map((e) => ({ label: e.name, to: `${b}/data/${e.slug}`, icon: ENTITY_ICONS[e.slug] ?? TableCellsIcon }));

  switch (x.kind) {
    case 'patient':
      return [
        {
          items: [
            { label: 'Home', to: b, icon: HomeIcon, tab: true, end: true },
            ...item(can('appointments'), { label: 'Appointments', to: `${b}/appointments`, icon: CalendarDaysIcon, tab: true }),
            ...item(can('messages'), { label: 'Messages', to: `${b}/messages`, icon: ChatBubbleLeftRightIcon, tab: true }),
            ...item(can('test-results'), { label: 'Test results', to: `${b}/results`, icon: BeakerIcon, tab: true }),
            ...item(can('prescriptions'), { label: 'Medications', to: `${b}/medications`, icon: ClipboardDocumentListIcon }),
            ...item(can('documents'), { label: 'Documents', to: `${b}/documents`, icon: DocumentDuplicateIcon }),
            { label: 'My profile', to: `${b}/profile`, icon: UserCircleIcon },
          ],
        },
      ];
    case 'doctor':
      return [
        {
          items: [
            { label: 'Today', to: b, icon: HomeIcon, tab: true, end: true },
            ...item(can('appointments'), { label: 'Schedule', to: `${b}/schedule`, icon: CalendarDaysIcon, tab: true }),
            ...item(can('patients'), { label: 'My patients', to: `${b}/patients`, icon: UserGroupIcon, tab: true }),
            ...item(can('messages'), { label: 'Messages', to: `${b}/messages`, icon: ChatBubbleLeftRightIcon, tab: true }),
            ...item(Boolean(entityOf(schema, 'doctors')?.can.update) || can('doctor-time-off'), { label: 'My availability', to: `${b}/availability`, icon: ClockIcon }),
          ],
        },
      ];
    case 'staff':
      return [
        {
          items: [
            { label: 'Today', to: b, icon: HomeIcon, end: true },
            ...item(can('messages'), { label: 'Messages', to: `${b}/messages`, icon: ChatBubbleLeftRightIcon }),
          ],
        },
        { label: 'Records', items: dataItems((s) => s !== 'messages') },
      ];
    case 'admin':
      return [
        {
          items: [
            { label: 'Overview', to: b, icon: Squares2X2Icon, end: true },
            { label: 'Access map', to: `${b}/access`, icon: ShieldCheckIcon },
            { label: 'Activity log', to: `${b}/activity`, icon: ClockIcon },
            { label: 'API usage', to: `${b}/usage`, icon: BoltIcon },
          ],
        },
        { label: 'Data', items: dataItems() },
      ];
    default:
      return [{ items: [{ label: 'Home', to: b, icon: HomeIcon, end: true }, ...dataItems()] }];
  }
};

const GenericHome = ({ base }: { base: string }) => {
  const { data: schema } = useSchema();
  const navigate = useNavigate();
  const first = schema?.entities.find((e) => e.can.read && e.listable);
  useEffect(() => {
    if (first) navigate(`${base}/data/${first.slug}`, { replace: true });
  }, [first, base, navigate]);
  return first ? null : <Welcome />;
};
