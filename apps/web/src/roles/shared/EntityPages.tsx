/**
 * Generic list and record pages, driven entirely by what the server says the
 * signed-in role may do. Staff and admin screens use these, and so does any
 * role a customer adds in Knack that this template has never heard of.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeftIcon, PencilSquareIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Button, ConfirmDialog, PageHeader, Tabs } from '../../ui';
import { EntityTable } from '../../components/EntityTable';
import { CreateDrawer, RecordDrawer, recordTitle } from '../../components/RecordDrawer';
import { RecordFields, RecordForm } from '../../components/fields';
import { InlineError, Page, Panel, useToast } from '../../components/ui';
import { useCreate, useDelete, useRecord, useUpdate } from '../../lib/records';
import { entityOf, parentFieldFor, useSchema, type EntityInfo } from '../../lib/schema';
import { useTitle } from '../../lib/hooks';

const singular = (name: string) => name.replace(/ies$/, 'y').replace(/s$/, '');

export const EntityListPage = ({ base, slug: fixedSlug, title, description }: { base: string; slug?: string; title?: string; description?: string }) => {
  const params = useParams();
  const slug = fixedSlug ?? params.entity ?? '';
  const { data: schema } = useSchema();
  const entity = entityOf(schema, slug);
  const navigate = useNavigate();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const create = useCreate(slug);
  const toast = useToast();
  useTitle(title ?? entity?.name);

  if (!schema) return null;
  if (!entity || !entity.can.read) return <NotAvailable />;
  const hasChildren = schema.entities.some((e) => e.slug !== entity.slug && parentFieldFor(e, entity.slug));

  return (
    <Page>
      <PageHeader title={title ?? entity.name} description={description} />
      {entity.listable ? (
        <EntityTable
          key={entity.slug}
          entity={entity}
          onOpen={(r) => (hasChildren ? navigate(`${base}/records/${entity.slug}/${r.id}`) : setOpenId(r.id))}
          onCreate={entity.can.create && entity.createFields.length ? () => setCreating(true) : undefined}
          createLabel={`New ${singular(entity.name).toLowerCase()}`}
        />
      ) : (
        <Panel className="p-6 text-sm text-steel-600">
          {entity.name} are shown inside the record they belong to. Open the parent record to see them.
        </Panel>
      )}
      <RecordDrawer entity={entity} id={openId} onClose={() => setOpenId(null)} />
      <CreateDrawer open={creating} onClose={() => setCreating(false)} title={`New ${singular(entity.name).toLowerCase()}`}>
        <RecordForm
          entity={entity}
          mode="create"
          onCancel={() => setCreating(false)}
          onSubmit={async (values) => {
            const { record } = await create.mutateAsync({ values, source: `${entity.slug}-list` });
            toast(`${singular(entity.name)} created`);
            setCreating(false);
            if (hasChildren) navigate(`${base}/records/${entity.slug}/${record.id}`);
          }}
        />
      </CreateDrawer>
    </Page>
  );
};

/** One record with its related lists as tabs. */
export const RecordPage = ({
  base,
  header,
  hideTabs = [],
  tabOrder,
  backTo,
  backLabel,
}: {
  base: string;
  header?: (entity: EntityInfo, record: import('../../lib/records').Rec) => ReactNode;
  hideTabs?: string[];
  tabOrder?: string[];
  backTo?: string;
  backLabel?: string;
}) => {
  const { entity: slug = '', id = '' } = useParams();
  const { data: schema } = useSchema();
  const entity = entityOf(schema, slug);
  const q = useRecord(slug, id, `${slug}-record`);
  const update = useUpdate(slug);
  const del = useDelete(slug);
  const toast = useToast();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** Optional "why", kept in the activity log beside who deleted it and when. */
  const [reason, setReason] = useState('');
  const record = q.data?.record;
  useTitle(entity && record ? recordTitle(entity, record) : entity?.name);

  const related = useMemo(() => {
    if (!schema || !entity) return [];
    const list = schema.entities
      .filter((e) => e.slug !== entity.slug && e.can.read && !hideTabs.includes(e.slug))
      .map((e) => ({ entity: e, field: parentFieldFor(e, entity.slug) }))
      .filter((x): x is { entity: EntityInfo; field: NonNullable<typeof x.field> } => Boolean(x.field));
    if (tabOrder) list.sort((a, b) => (tabOrder.indexOf(a.entity.slug) + 1 || 99) - (tabOrder.indexOf(b.entity.slug) + 1 || 99));
    return list;
  }, [schema, entity, hideTabs, tabOrder]);

  const [tab, setTab] = useState<string>('details');
  if (!schema) return null;
  if (!entity) return <NotAvailable />;

  return (
    <Page>
      <Link to={backTo ?? `${base}/data/${entity.slug}`} className="no-print inline-flex items-center gap-1 text-sm font-medium text-steel-500 hover:text-steel-800">
        <ChevronLeftIcon className="h-4 w-4" /> {backLabel ?? entity.name}
      </Link>
      {q.error && <InlineError error={q.error} onRetry={() => void q.refetch()} />}
      {q.isLoading && <div className="h-32 animate-pulse rounded-2xl bg-steel-100" />}
      {record && (
        <>
          {header ? (
            header(entity, record)
          ) : (
            <PageHeader
              title={recordTitle(entity, record)}
              description={singular(entity.name)}
              actions={
                <div className="flex gap-2">
                  {q.data?.can.delete && (
                    <Button variant="ghost" className="text-red-700 hover:bg-red-50" icon={<TrashIcon className="h-4 w-4" />} onClick={() => setConfirming(true)}>
                      Delete
                    </Button>
                  )}
                  {q.data?.can.update && entity.updateFields.length > 0 && (
                    <Button variant="primary" icon={<PencilSquareIcon className="h-4 w-4" />} onClick={() => setEditing(true)}>
                      Edit
                    </Button>
                  )}
                </div>
              }
            />
          )}
          {related.length > 0 && (
            <Tabs
              tabs={[{ id: 'details', label: 'Details' }, ...related.map((r) => ({ id: r.entity.slug, label: r.entity.name }))]}
              active={tab}
              onChange={setTab}
            />
          )}
          {tab === 'details' && (
            <Panel className="p-6">
              {editing ? (
                <RecordForm
                  entity={entity}
                  mode="update"
                  record={record}
                  onCancel={() => setEditing(false)}
                  onSubmit={async (values) => {
                    await update.mutateAsync({ id: record.id, values, source: `${entity.slug}-record` });
                    toast('Changes saved');
                    setEditing(false);
                  }}
                />
              ) : (
                <RecordFields entity={entity} record={record} />
              )}
            </Panel>
          )}
          {related.map((r) =>
            tab === r.entity.slug ? <RelatedList key={r.entity.slug} parentEntity={entity} parentId={record.id} entity={r.entity} field={r.field.slug} /> : null,
          )}
        </>
      )}
      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          setReason('');
        }}
        destructive
        title={`Delete this ${singular(entity.name).toLowerCase()}?`}
        message={
          <>
            <p>This permanently removes the record. Related records are not deleted. This can’t be undone.</p>
            <label className="mt-3 block text-left">
              <span className="text-xs font-medium text-steel-700">Reason (optional)</span>
              <input
                type="text"
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this being deleted?"
                className="mt-1 block w-full rounded-lg border border-steel-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              />
              {/* Optional on purpose: a required reason gets "asdf", which is worse than an honest blank. */}
              <span className="mt-1 block text-xs text-steel-500">Kept in the activity log with who deleted it and when.</span>
            </label>
          </>
        }
        confirmLabel="Delete"
        onConfirm={async () => {
          try {
            await del.mutateAsync({ id, source: `${entity.slug}-record`, reason: reason.trim() || undefined });
            setReason('');
            toast('Deleted');
            navigate(backTo ?? `${base}/data/${entity.slug}`);
          } catch (e) {
            toast((e as Error).message, 'error');
          }
        }}
      />
    </Page>
  );
};

export const RelatedList = ({
  parentEntity,
  parentId,
  entity,
  field,
  columns,
  title,
}: {
  parentEntity: EntityInfo;
  parentId: string;
  entity: EntityInfo;
  field: string;
  columns?: string[];
  title?: string;
}) => {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const create = useCreate(entity.slug);
  const toast = useToast();
  const canCreate = entity.can.create && entity.createFields.length > 0;
  return (
    <div className="space-y-3">
      {title && <h2 className="text-base font-semibold">{title}</h2>}
      <EntityTable
        entity={entity}
        parent={{ field, id: parentId }}
        columns={columns}
        onOpen={(r) => setOpenId(r.id)}
        onCreate={canCreate ? () => setCreating(true) : undefined}
        createLabel={`Add ${singular(entity.name).toLowerCase()}`}
        emptyTitle={`No ${entity.name.toLowerCase()} for this ${singular(parentEntity.name).toLowerCase()}`}
        source={`${parentEntity.slug}-${entity.slug}`}
      />
      <RecordDrawer entity={entity} id={openId} onClose={() => setOpenId(null)} source={`${parentEntity.slug}-${entity.slug}`} />
      <CreateDrawer open={creating} onClose={() => setCreating(false)} title={`Add ${singular(entity.name).toLowerCase()}`}>
        <RecordForm
          entity={entity}
          mode="create"
          fixed={{ [field]: [parentId] }}
          onCancel={() => setCreating(false)}
          onSubmit={async (values) => {
            await create.mutateAsync({ values, source: `${parentEntity.slug}-${entity.slug}` });
            toast(`${singular(entity.name)} added`);
            setCreating(false);
          }}
        />
      </CreateDrawer>
    </div>
  );
};

export const NotAvailable = () => (
  <Page>
    <Panel className="p-10 text-center">
      <p className="font-medium text-steel-900">This page isn’t available</p>
      <p className="mt-1 text-sm text-steel-500">It may not exist, or your role doesn’t include it.</p>
    </Panel>
  </Page>
);
