import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AdjustmentsHorizontalIcon, ArrowPathIcon, CheckIcon, ExclamationTriangleIcon, ShieldCheckIcon, CircleStackIcon, BoltIcon, ArrowsRightLeftIcon } from '@heroicons/react/24/outline';
import { Button, cx, PageHeader, Select, StatTile, Switch } from '@fmc/knack-ui';
import { api, ApiError } from '../../lib/api';
import { useList } from '../../lib/records';
import { useSchema } from '../../lib/schema';
import { formatDateTime, relative } from '../../lib/format';
import { useTitle } from '../../lib/hooks';
import { Empty, InlineError, Page, Panel, Section, SkeletonRows, StatusPill, useToast } from '../../components/ui';

interface AccessReport {
  roles: Array<{
    profileKey: string;
    name: string;
    admin: boolean;
    entities: Array<{
      entity: string;
      name: string;
      actions: Record<'read' | 'create' | 'update' | 'delete', string[]>;
      readFields: string[];
      createFields: string[];
      updateFields: string[];
      sources: string[];
    }>;
  }>;
  warnings: string[];
  features: Feature[];
}

interface Feature {
  id: string;
  title: string;
  description: string;
  on: boolean;
  by?: string;
  at?: string;
  available: boolean;
  problems: string[];
  grants: string[];
}

const useAccess = () => useQuery({ queryKey: ['admin', 'access'], queryFn: () => api<AccessReport>('/admin/access'), staleTime: 60_000 });

export const AdminOverview = () => {
  useTitle('Overview');
  const { data: schema } = useSchema();
  const access = useAccess();
  const usage = useQuery({ queryKey: ['admin', 'usage'], queryFn: () => api<{ rows: Array<{ count: number; day: string }>; lastMinute: number }>('/admin/usage'), refetchInterval: 15_000 });
  const today = new Date().toISOString().slice(0, 10);
  const todayCalls = (usage.data?.rows ?? []).filter((r) => r.day === today).reduce((a, r) => a + r.count, 0);
  return (
    <Page>
      <PageHeader title="Administration" description={schema?.appName} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Tables" value={schema?.entities.length ?? '—'} icon={<CircleStackIcon className="h-5 w-5" />} />
        <StatTile label="Roles" value={access.data ? access.data.roles.filter((r) => r.profileKey !== 'all_users' && r.profileKey !== '*').length : '—'} icon={<ShieldCheckIcon className="h-5 w-5" />} />
        <StatTile label="Knack calls today" value={todayCalls} icon={<BoltIcon className="h-5 w-5" />} loading={usage.isLoading} />
        <StatTile label="Calls last minute" value={usage.data?.lastMinute ?? '—'} icon={<BoltIcon className="h-5 w-5" />} loading={usage.isLoading} />
      </div>
      <FeaturesPanel />
      <SyncPanel />
      {access.data && access.data.warnings.length > 0 && (
        <Section title="Things to fix in Knack">
          <Panel as="ul">
            {access.data.warnings.map((w) => (
              <li key={w} className="flex gap-3 border-b border-steel-100 px-5 py-3 text-sm last:border-b-0">
                <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
                {w}
              </li>
            ))}
          </Panel>
        </Section>
      )}
      <Section title="Data" description="Every table in the Knack app. Headless Admins can view and change all of it.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {schema?.entities.map((e) => (
            <EntityCount key={e.slug} slug={e.slug} name={e.name} />
          ))}
        </div>
      </Section>
    </Page>
  );
};

const EntityCount = ({ slug, name }: { slug: string; name: string }) => {
  const list = useList(slug, { rows: 1, source: 'admin-overview' });
  return (
    <Link to={`/admin/data/${slug}`} className="flex items-center justify-between rounded-2xl border border-steel-200 bg-white px-5 py-4 shadow-sm transition hover:border-brand-300 hover:shadow">
      <span className="font-medium text-steel-800">{name}</span>
      <span className="text-lg font-semibold tabular-nums text-steel-900">{list.isLoading ? '…' : (list.data?.total ?? '—')}</span>
    </Link>
  );
};

/** Where a role's access came from: Knack pages, or a portal feature an admin switched on. */
const Sources = ({ sources, features }: { sources: string[]; features: Feature[] }) => {
  const pages = sources.filter((s) => !s.startsWith('feature:'));
  const added = sources.filter((s) => s.startsWith('feature:')).map((s) => features.find((f) => `feature:${f.id}` === s)?.title ?? s.slice(8));
  return (
    <div className="mt-3 space-y-1 text-xs">
      {pages.length > 0 && <p className="text-steel-400">From Knack: {pages.join(', ')}</p>}
      {added.length > 0 && (
        <p className="flex items-center gap-1 text-brand-700">
          <AdjustmentsHorizontalIcon className="h-3.5 w-3.5" aria-hidden="true" />
          Portal feature: {added.join(', ')}
        </p>
      )}
    </div>
  );
};

/**
 * Abilities the portal adds that the Knack template has no page for. Each is
 * off until an admin switches it on, and only ever covers the signed-in
 * user's own records.
 */
const FeaturesPanel = () => {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['admin', 'features'], queryFn: () => api<{ features: Feature[] }>('/admin/features') });
  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api<{ features: Feature[] }>(`/admin/features/${id}`, { method: 'PUT', body: { on } }),
    onSuccess: (data, { on }) => {
      qc.setQueryData(['admin', 'features'], data);
      // Access changed: everything derived from it is stale.
      void qc.invalidateQueries({ queryKey: ['admin', 'access'] });
      void qc.invalidateQueries({ queryKey: ['schema'] });
      void qc.invalidateQueries({ queryKey: ['booking'] });
      toast(on ? 'Feature switched on' : 'Feature switched off');
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not change the feature.', 'error'),
  });
  const features = q.data?.features ?? [];
  if (!q.isLoading && !q.error && features.length === 0) return null;
  return (
    <Section title="Portal features" description="Things this portal adds that the Knack template has no page for. Each one is off until you switch it on, and only ever covers people’s own records. Everything else follows your Knack pages.">
      {q.isLoading && <SkeletonRows rows={2} />}
      {q.error && <InlineError error={q.error} onRetry={() => void q.refetch()} />}
      <div className="grid gap-3 lg:grid-cols-2">
        {features.map((f) => (
          <Panel key={f.id} className="flex flex-col gap-3 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold text-steel-900">{f.title}</h3>
                <p className="mt-1 text-sm text-steel-600">{f.description}</p>
              </div>
              <Switch
                checked={f.on && f.available}
                disabled={(!f.available && !f.on) || toggle.isPending}
                onChange={(on) => toggle.mutate({ id: f.id, on })}
                label={`${f.title}: ${f.on ? 'on' : 'off'}`}
              />
            </div>
            {f.available ? (
              <ul className="space-y-1 text-xs text-steel-500">
                {f.grants.map((g) => (
                  <li key={g} className="flex gap-1.5">
                    <ShieldCheckIcon className="h-3.5 w-3.5 shrink-0 translate-y-px" aria-hidden="true" />
                    {g}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <p className="font-medium">Your Knack app is missing something this needs:</p>
                <ul className="mt-1 list-disc pl-4">
                  {f.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            {f.at && (
              <p className="text-xs text-steel-400">
                Switched {f.on ? 'on' : 'off'} by {f.by ?? 'an admin'} {relative(f.at)}
              </p>
            )}
          </Panel>
        ))}
      </div>
    </Section>
  );
};

const ACTION_LABEL = { read: 'View', create: 'Add', update: 'Edit', delete: 'Delete' } as const;

export const AccessMap = () => {
  useTitle('Access map');
  const access = useAccess();
  const roles = (access.data?.roles ?? []).filter((r) => r.profileKey !== 'all_users');
  const [roleKey, setRoleKey] = useState<string>('');
  const role = roles.find((r) => r.profileKey === roleKey) ?? roles.find((r) => !r.admin && r.profileKey !== '*') ?? roles[0];
  return (
    <Page>
      <PageHeader
        title="Access map"
        description="What each role can see and do. It is read from your Knack pages (change a page in the Knack Builder and this follows at the next sync), plus any portal features switched on under Administration."
        actions={
          roles.length > 0 && (
            <Select aria-label="Role" value={role?.profileKey ?? ''} onChange={(e) => setRoleKey(e.target.value)} options={roles.map((r) => ({ value: r.profileKey, label: r.name }))} className="w-56" />
          )
        }
      />
      {access.isLoading && <SkeletonRows rows={4} />}
      {access.error && <InlineError error={access.error} onRetry={() => void access.refetch()} />}
      {role?.admin && (
        <Panel className="p-6 text-sm text-steel-700">
          <strong>{role.name}</strong> has full access to every table and field. It has no Knack pages; it exists for administering this app.
        </Panel>
      )}
      {role && !role.admin && role.entities.length === 0 && <Empty title={`${role.name} can’t see any data`}>No Knack page grants this role access.</Empty>}
      {role && !role.admin && role.entities.length > 0 && (
        <div className="space-y-4">
          {role.entities.map((e) => (
            <Panel key={e.entity} className="p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold text-steel-900">{e.name}</h2>
                <div className="flex gap-1.5">
                  {(['read', 'create', 'update', 'delete'] as const).map((a) => (
                    <span
                      key={a}
                      className={cx(
                        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
                        e.actions[a].length ? 'bg-green-50 text-green-800' : 'bg-steel-100 text-steel-400 line-through',
                      )}
                    >
                      {e.actions[a].length > 0 && <CheckIcon className="h-3.5 w-3.5" />}
                      {ACTION_LABEL[a]}
                    </span>
                  ))}
                </div>
              </div>
              <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                {(['read', 'create', 'update', 'delete'] as const)
                  .filter((a) => e.actions[a].length)
                  .map((a) => (
                    <div key={a}>
                      <dt className="text-xs font-medium uppercase tracking-wide text-steel-500">{ACTION_LABEL[a]} which records</dt>
                      <dd className="mt-1 space-y-0.5 text-steel-700">
                        {e.actions[a].map((g) => (
                          <p key={g}>{g}</p>
                        ))}
                      </dd>
                    </div>
                  ))}
                <div className="md:col-span-2">
                  <dt className="text-xs font-medium uppercase tracking-wide text-steel-500">Fields they can see</dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {e.readFields.map((f) => (
                      <span key={f} className="rounded-md bg-steel-100 px-2 py-0.5 text-xs text-steel-700">
                        {f}
                      </span>
                    ))}
                  </dd>
                </div>
              </dl>
              <Sources sources={e.sources} features={access.data?.features ?? []} />
            </Panel>
          ))}
        </div>
      )}
    </Page>
  );
};

interface AuditEvent {
  at: string;
  kind: string;
  actor: { name: string; email: string };
  entity?: string;
  recordId?: string;
  fields?: string[];
  count?: number;
  source?: string;
  reason?: string;
  ip?: string;
}

const KIND_LABEL: Record<string, string> = {
  create: 'Created',
  update: 'Edited',
  delete: 'Deleted',
  view: 'Viewed',
  list: 'Listed',
  download: 'Downloaded',
  upload: 'Uploaded',
  'sign-in': 'Signed in',
  'sign-out': 'Signed out',
  setting: 'Changed setting',
};

export const ActivityLog = () => {
  useTitle('Activity log');
  const [kinds, setKinds] = useState('');
  const q = useQuery({
    queryKey: ['admin', 'audit', kinds],
    queryFn: () => api<{ events: AuditEvent[] }>('/admin/audit', { query: { kinds, limit: 200 } }),
    refetchInterval: 30_000,
  });
  return (
    <Page>
      <PageHeader
        title="Activity log"
        description="Who signed in, viewed, downloaded or changed what, and when. Append-only."
        actions={
          <Select
            aria-label="Filter activity"
            value={kinds}
            onChange={(e) => setKinds(e.target.value)}
            options={[
              { value: '', label: 'All activity' },
              { value: 'create,update,delete', label: 'Changes' },
              { value: 'view,list,download', label: 'Access to records' },
              { value: 'sign-in,sign-out', label: 'Sign-ins' },
            ]}
            className="w-52"
          />
        }
      />
      {q.isLoading && <SkeletonRows rows={6} />}
      {q.error && <InlineError error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && q.data.events.length === 0 && <Empty title="No activity yet" />}
      {q.data && q.data.events.length > 0 && (
        <Panel>
          <table className="w-full text-sm">
            <thead className="border-b border-steel-200 bg-steel-50 text-left text-xs font-semibold uppercase tracking-wide text-steel-500">
              <tr>
                <th className="px-5 py-3">When</th>
                <th className="px-3 py-3">Who</th>
                <th className="px-3 py-3">Action</th>
                <th className="hidden px-3 py-3 md:table-cell">What</th>
                <th className="hidden px-5 py-3 lg:table-cell">Where</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-steel-100">
              {q.data.events.map((e, i) => (
                <tr key={`${e.at}-${i}`}>
                  <td className="whitespace-nowrap px-5 py-2.5 text-steel-500">{formatDateTime(e.at)}</td>
                  <td className="px-3 py-2.5">
                    <p className="font-medium text-steel-900">{e.actor.name}</p>
                    <p className="text-xs text-steel-500">{e.actor.email}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusPill value={KIND_LABEL[e.kind] ?? e.kind} />
                  </td>
                  <td className="hidden px-3 py-2.5 text-steel-600 md:table-cell">
                    {e.reason}
                    {e.entity}
                    {e.recordId && <span className="ml-1 font-mono text-xs text-steel-400">{e.recordId.slice(-6)}</span>}
                    {e.count !== undefined && ` (${e.count})`}
                    {e.fields?.length ? <p className="text-xs text-steel-400">{e.fields.join(', ')}</p> : null}
                  </td>
                  <td className="hidden px-5 py-2.5 text-xs text-steel-500 lg:table-cell">{e.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </Page>
  );
};

export const ApiUsage = () => {
  useTitle('API usage');
  const q = useQuery({
    queryKey: ['admin', 'usage'],
    queryFn: () => api<{ rows: Array<{ day: string; method: string; objectKey: string; outcome: string; count: number }>; lastMinute: number }>('/admin/usage'),
    refetchInterval: 10_000,
  });
  return (
    <Page>
      <PageHeader title="Knack API usage" description="Knack allows about 10 requests per second for the whole app, shared by every user. Counts reset when the server restarts." />
      {q.data && (
        <div className="grid grid-cols-2 gap-3">
          <StatTile label="Calls in the last minute" value={q.data.lastMinute} />
          <StatTile label="Calls recorded" value={q.data.rows.reduce((a, r) => a + r.count, 0)} />
        </div>
      )}
      {q.data && (
        <Panel>
          <table className="w-full text-sm">
            <thead className="border-b border-steel-200 bg-steel-50 text-left text-xs font-semibold uppercase tracking-wide text-steel-500">
              <tr>
                <th className="px-5 py-3">Day</th>
                <th className="px-3 py-3">Method</th>
                <th className="px-3 py-3">Object</th>
                <th className="px-3 py-3">Outcome</th>
                <th className="px-5 py-3 text-right">Calls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-steel-100">
              {q.data.rows.map((r) => (
                <tr key={`${r.day}${r.method}${r.objectKey}${r.outcome}`}>
                  <td className="px-5 py-2">{r.day}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.method}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.objectKey}</td>
                  <td className="px-3 py-2">{r.outcome}</td>
                  <td className="px-5 py-2 text-right tabular-nums">{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </Page>
  );
};

interface SyncStatus {
  intervalMinutes: number;
  lastSuccessAt: string | null;
  lastError: string | null;
  structureFrom: string;
  history: Array<{ at: string; changes: string[] }>;
  template: { problems: string[]; missingOptional: string[]; renamed: string[] };
}

/** How current the headless app is with the Knack app, and what changed. */
const SyncPanel = () => {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['admin', 'sync'], queryFn: () => api<SyncStatus>('/admin/sync'), refetchInterval: 60_000 });
  const sync = useMutation({
    mutationFn: () => api<{ changed: boolean; changes: string[]; error?: string; status: SyncStatus }>('/admin/sync', { method: 'POST' }),
    onSuccess: (r) => {
      qc.setQueryData(['admin', 'sync'], r.status);
      if (r.changed) {
        void qc.invalidateQueries({ queryKey: ['schema'] });
        void qc.invalidateQueries({ queryKey: ['admin', 'access'] });
        void qc.invalidateQueries({ queryKey: ['records'] });
      }
    },
  });
  const s = status.data;
  const t = s?.template;
  const last = sync.data;
  return (
    <Section
      title="Knack sync"
      description={
        s
          ? s.intervalMinutes
            ? `Fields, pages and access are re-read from Knack every ${s.intervalMinutes} minutes. Last checked ${s.lastSuccessAt ? relative(s.lastSuccessAt) : 'never'}.`
            : 'Automatic sync is off. Use Sync now after changing the Knack app.'
          : undefined
      }
      action={
        <Button variant="secondary" icon={<ArrowPathIcon className={cx('h-4 w-4', sync.isPending && 'animate-spin')} />} loading={false} disabled={sync.isPending} onClick={() => sync.mutate()}>
          {sync.isPending ? 'Syncing…' : 'Sync now'}
        </Button>
      }
    >
      <Panel className="divide-y divide-steel-100">
        {last && (
          <p className={cx('px-5 py-3 text-sm', last.error ? 'text-red-700' : 'text-steel-700')}>
            {last.error ? `Couldn’t reach Knack: ${last.error}. The last good version is still in use.` : last.changed ? `Applied ${last.changes.length} change${last.changes.length === 1 ? '' : 's'} from Knack.` : 'Already up to date with Knack.'}
          </p>
        )}
        {s?.lastError && !last && <p className="px-5 py-3 text-sm text-red-700">Last attempt failed: {s.lastError}. The last good version is still in use.</p>}
        {t?.problems.map((p) => (
          <p key={p} className="flex gap-3 px-5 py-3 text-sm text-red-800">
            <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-red-500" aria-hidden="true" />
            <span>
              {p} <span className="text-steel-500">Screens that use it will show blanks until it’s restored in Knack.</span>
            </span>
          </p>
        ))}
        {t?.missingOptional.map((p) => (
          <p key={p} className="flex gap-3 px-5 py-3 text-sm text-amber-800">
            <ExclamationTriangleIcon className="h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
            <span>
              {p} <span className="text-steel-500">The feature that uses it is switched off.</span>
            </span>
          </p>
        ))}
        {t?.renamed.map((r) => (
          <p key={r} className="flex gap-3 px-5 py-3 text-sm text-steel-700">
            <ArrowsRightLeftIcon className="h-5 w-5 shrink-0 text-steel-400" aria-hidden="true" />
            <span>
              {r} <span className="text-steel-500">Still connected; nothing to do.</span>
            </span>
          </p>
        ))}
        {s?.history.slice(0, 5).map((h) => (
          <div key={h.at} className="px-5 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-steel-500">Changes applied {formatDateTime(h.at)}</p>
            <ul className="mt-1 space-y-0.5 text-sm text-steel-700">
              {h.changes.slice(0, 12).map((c) => (
                <li key={c}>· {c}</li>
              ))}
              {h.changes.length > 12 && <li className="text-steel-500">…and {h.changes.length - 12} more</li>}
            </ul>
          </div>
        ))}
        {s && !t?.problems.length && !t?.missingOptional.length && !t?.renamed.length && !s.history.length && !last && (
          <p className="flex items-center gap-2 px-5 py-3 text-sm text-steel-600">
            <CheckIcon className="h-4 w-4 text-green-600" /> In step with Knack. No changes since this server started.
          </p>
        )}
      </Panel>
    </Section>
  );
};
