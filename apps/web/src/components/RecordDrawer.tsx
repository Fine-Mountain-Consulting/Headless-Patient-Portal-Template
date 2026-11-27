import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowTopRightOnSquareIcon, PencilSquareIcon, TrashIcon } from '@heroicons/react/24/outline';
import { Button, ConfirmDialog, SlideOver } from '../ui';
import { useDelete, useRecord, useUpdate, type Rec } from '../lib/records';
import type { EntityInfo } from '../lib/schema';
import { RecordFields, RecordForm } from './fields';
import { InlineError, useToast } from './ui';
import { asName } from '../lib/records';

export const recordTitle = (entity: EntityInfo, record: Rec | undefined): string => {
  if (!record) return entity.name;
  const v = entity.identifier ? record[entity.identifier] : undefined;
  if (v && typeof v === 'object') {
    if (Array.isArray(v)) return v.map((x) => (x as { identifier?: string }).identifier).join(', ') || entity.name;
    return asName(v)?.full || entity.name;
  }
  return v ? String(v) : entity.name;
};

/**
 * Slide-over for one record: details, edit and delete, each offered only if
 * the server says this user may do it to this record.
 */
export const RecordDrawer = ({
  entity,
  id,
  onClose,
  title,
  fields,
  editFields,
  fullHref,
  source,
  children,
  renderBody,
}: {
  entity: EntityInfo;
  id: string | null;
  onClose: () => void;
  title?: (r: Rec) => ReactNode;
  fields?: string[];
  editFields?: string[];
  fullHref?: string;
  source?: string;
  children?: (r: Rec) => ReactNode;
  renderBody?: (r: Rec) => ReactNode;
}) => {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const q = useRecord(entity.slug, id, source ?? entity.slug);
  const update = useUpdate(entity.slug);
  const del = useDelete(entity.slug);
  const record = q.data?.record;
  const can = q.data?.can;

  const close = () => {
    setEditing(false);
    onClose();
  };

  return (
    <>
      <SlideOver
        open={Boolean(id)}
        onClose={close}
        width="lg"
        title={record ? (title ? title(record) : recordTitle(entity, record)) : entity.name}
        description={editing ? `Edit ${entity.name.replace(/s$/, '').toLowerCase()}` : undefined}
        footer={
          record && !editing && (can?.update || can?.delete || fullHref) ? (
            <div className="flex w-full items-center gap-2">
              {can?.delete && (
                <Button variant="ghost" className="text-red-700 hover:bg-red-50" icon={<TrashIcon className="h-4 w-4" />} onClick={() => setConfirming(true)}>
                  Delete
                </Button>
              )}
              <div className="ml-auto flex gap-2">
                {fullHref && (
                  <Link to={fullHref} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-steel-300 bg-white px-4 text-sm font-medium text-steel-700 shadow-sm hover:bg-steel-50">
                    <ArrowTopRightOnSquareIcon className="h-4 w-4" /> Open
                  </Link>
                )}
                {can?.update && entity.updateFields.length > 0 && (
                  <Button variant="primary" icon={<PencilSquareIcon className="h-4 w-4" />} onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                )}
              </div>
            </div>
          ) : undefined
        }
      >
        {q.isLoading && <div className="h-40 animate-pulse rounded-xl bg-steel-100" />}
        {q.error && <InlineError error={q.error} onRetry={() => void q.refetch()} />}
        {record && !editing && (
          <div className="space-y-6">
            {renderBody ? renderBody(record) : <RecordFields entity={entity} record={record} only={fields} />}
            {children?.(record)}
          </div>
        )}
        {record && editing && (
          <RecordForm
            entity={entity}
            mode="update"
            record={record}
            fields={editFields}
            onCancel={() => setEditing(false)}
            onSubmit={async (values) => {
              await update.mutateAsync({ id: record.id, values, source: source ?? entity.slug });
              toast('Changes saved');
              setEditing(false);
            }}
          />
        )}
      </SlideOver>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        destructive
        title={`Delete this ${entity.name.replace(/s$/, '').toLowerCase()}?`}
        message="This permanently removes the record. It can't be undone."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!record) return;
          try {
            await del.mutateAsync({ id: record.id, source: source ?? entity.slug });
            toast('Deleted');
            setConfirming(false);
            close();
          } catch (e) {
            toast((e as Error).message, 'error');
          }
        }}
      />
    </>
  );
};

/** Slide-over with a create form. */
export const CreateDrawer = ({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
}) => (
  <SlideOver open={open} onClose={onClose} title={title} description={description} width="lg">
    {children}
  </SlideOver>
);
