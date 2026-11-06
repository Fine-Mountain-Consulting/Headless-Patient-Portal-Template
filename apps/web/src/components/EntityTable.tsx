import { useMemo, useState, type ReactNode } from 'react';
import { PlusIcon } from '@heroicons/react/24/outline';
import { Button, DataTable, SearchInput, type Column, type SortState } from '@fmc/knack-ui';
import { useList, type Filter, type Rec } from '../lib/records';
import { fieldOf, isSystemField, type EntityInfo } from '../lib/schema';
import { FieldValue } from './fields';
import { useDebounced } from '../lib/hooks';

export interface EntityTableProps {
  entity: EntityInfo;
  /** List within a parent record (child tables on a details page). */
  parent?: { field: string; id: string } | null;
  /** Column field slugs. Defaults to the first readable, non-system fields. */
  columns?: string[];
  maxColumns?: number;
  defaultSort?: SortState;
  filters?: Filter[];
  onOpen?: (record: Rec) => void;
  onCreate?: () => void;
  createLabel?: string;
  toolbar?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  pageSize?: number;
  source?: string;
}

export const EntityTable = ({
  entity,
  parent,
  columns,
  maxColumns = 6,
  defaultSort,
  filters,
  onOpen,
  onCreate,
  createLabel,
  toolbar,
  emptyTitle,
  emptyDescription,
  pageSize = 25,
  source,
}: EntityTableProps) => {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState(pageSize);
  const [sort, setSort] = useState<SortState | undefined>(defaultSort);
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);

  const parentSlug = parent?.field;
  const cols = useMemo<Array<Column<Rec>>>(() => {
    const slugs =
      columns ??
      entity.readFields.filter((s) => {
        const f = fieldOf(entity, s);
        return f && !isSystemField(f) && f.slug !== parentSlug && f.kind !== 'password' && f.kind !== 'rich_text';
      }).slice(0, maxColumns);
    return slugs
      .map((s) => fieldOf(entity, s))
      .filter((f) => f !== undefined)
      .map((f, i) => ({
        key: f.slug,
        header: f.name,
        sortable: f.kind !== 'connection' && f.kind !== 'file' && f.kind !== 'address',
        className: i > 2 ? 'hidden md:table-cell' : undefined,
        align: f.kind === 'number' || f.kind === 'currency' ? ('right' as const) : undefined,
        render: (r: Rec) => <FieldValue field={f} value={r[f.slug]} entity={entity.slug} recordId={r.id} compact />,
      }));
  }, [entity, columns, maxColumns, parentSlug]);

  const list = useList(entity.slug, {
    page,
    rows,
    sort: sort?.field,
    order: sort?.order,
    q: entity.identifier ? q : undefined,
    filters,
    parent: parent ?? null,
    source: source ?? entity.slug,
  });

  const canSearch = Boolean(entity.identifier && entity.readFields.includes(entity.identifier));

  return (
    <div className="space-y-3">
      {(canSearch || onCreate || toolbar) && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {canSearch && (
            <SearchInput
              value={search}
              onChange={(v) => {
                setSearch(v);
                setPage(1);
              }}
              placeholder={`Search ${entity.name.toLowerCase()} by ${fieldOf(entity, entity.identifier!)?.name.toLowerCase() ?? 'name'}…`}
              className="sm:max-w-xs"
            />
          )}
          <div className="flex flex-1 items-center justify-end gap-2">
            {toolbar}
            {onCreate && (
              <Button variant="primary" icon={<PlusIcon className="h-4 w-4" />} onClick={onCreate}>
                {createLabel ?? 'New'}
              </Button>
            )}
          </div>
        </div>
      )}
      <DataTable
        columns={cols}
        rows={list.data?.records ?? []}
        getRowId={(r) => r.id}
        loading={list.isLoading}
        error={list.error as { message?: string } | null}
        onRetry={() => void list.refetch()}
        onRowClick={onOpen}
        sort={sort}
        onSortChange={(s) => {
          setSort(s);
          setPage(1);
        }}
        page={page}
        totalPages={list.data?.pages ?? 1}
        totalRecords={list.data?.total}
        onPageChange={setPage}
        pageSize={rows}
        onPageSizeChange={(n) => {
          setRows(n);
          setPage(1);
        }}
        skeletonRows={Math.min(rows, 8)}
        emptyTitle={q ? `No ${entity.name.toLowerCase()} match “${q}”` : (emptyTitle ?? `No ${entity.name.toLowerCase()} yet`)}
        emptyDescription={emptyDescription}
      />
    </div>
  );
};
