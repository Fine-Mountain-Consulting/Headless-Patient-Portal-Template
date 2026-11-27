import { useMemo, useState, type ReactNode } from 'react';
import { PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { Button, DataTable, SearchInput, Select, type Column, type ColumnEdit, type SortState } from '@fmc/knack-ui';
import { refName, useList, useUpdate, type Filter, type Rec } from '../lib/records';
import { fieldOf, isSystemField, type EntityInfo, type FieldInfo } from '../lib/schema';
import { useTablePrefs } from '../lib/tablePrefs';
import { FieldValue } from './fields';
import { useDebounced } from '../lib/hooks';

export interface EntityTableProps {
  entity: EntityInfo;
  /** List within a parent record (child tables on a details page). */
  parent?: { field: string; id: string } | null;
  /** Field slugs shown at first. The reader can add any other readable field. */
  columns?: string[];
  maxColumns?: number;
  defaultSort?: SortState;
  /** Fixed filters from the screen (always applied, not shown as chips). */
  filters?: Filter[];
  onOpen?: (record: Rec) => void;
  onCreate?: () => void;
  createLabel?: string;
  toolbar?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  pageSize?: number;
  source?: string;
  /** Edit cells in place where the role may update the field. Default true. */
  inlineEdit?: boolean;
}

/** Fields that can be columns at all. Rich text and passwords never are. */
const columnable = (f: FieldInfo) => !isSystemField(f) && f.kind !== 'password' && f.kind !== 'rich_text' && f.kind !== 'roles';
const sortable = (f: FieldInfo) => !['connection', 'file', 'image', 'address', 'computed', 'other'].includes(f.kind);
const searchable = (f: FieldInfo) => ['short_text', 'name', 'email', 'phone', 'paragraph_text'].includes(f.kind);
/** Choice fields with a short list make good filters; free text makes a worse search box. */
const filterable = (f: FieldInfo) => f.kind === 'choice' && (f.options?.length ?? 0) > 0 && (f.options?.length ?? 0) <= 30;
const MAX_FILTERS = 3;

/** Cells that can be edited in place, and with which editor. */
const editorFor = (f: FieldInfo): ColumnEdit<Rec> | undefined => {
  switch (f.kind) {
    case 'short_text':
    case 'paragraph_text':
    case 'number':
    case 'currency':
    case 'boolean':
    case 'email':
    case 'phone':
    case 'link':
      return { type: f.kind };
    case 'date':
      return { type: 'date' };
    case 'choice':
      return f.multiple ? undefined : { type: 'multiple_choice', options: f.options ?? [] };
    default:
      // Names, addresses, connections, files and date-times have richer
      // editors in the record form; a cell is the wrong place for them.
      return undefined;
  }
};

/** The group a row falls in, for fields worth grouping by. */
const groupValueFor = (f: FieldInfo): ((r: Rec) => string) | undefined => {
  switch (f.kind) {
    case 'choice':
      return (r) => {
        const v = r[f.slug];
        return (Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '') || 'None';
      };
    case 'boolean':
      return (r) => (r[f.slug] ? 'Yes' : 'No');
    case 'connection':
      return (r) => refName(r[f.slug]) || 'None';
    default:
      return undefined;
  }
};

export const EntityTable = ({
  entity,
  parent,
  columns,
  maxColumns = 6,
  defaultSort,
  filters: fixedFilters,
  onOpen,
  onCreate,
  createLabel,
  toolbar,
  emptyTitle,
  emptyDescription,
  pageSize = 25,
  source,
  inlineEdit = true,
}: EntityTableProps) => {
  const parentSlug = parent?.field;
  const tableSource = source ?? entity.slug;

  /** Every field the role can read that can be a column, minus the parent link. */
  const fields = useMemo(
    () =>
      entity.readFields
        .map((s) => fieldOf(entity, s))
        .filter((f): f is FieldInfo => f !== undefined && columnable(f) && f.slug !== parentSlug),
    [entity, parentSlug],
  );

  /*
   * What's on screen at first: the screen's chosen columns, or the first few.
   * Everything else readable is still a column, just hidden, so the reader can
   * add it from the column menu. A column added in Knack later shows up there
   * too, without a code change.
   */
  const defaults = useMemo(() => {
    const initial = columns ?? fields.slice(0, maxColumns).map((f) => f.slug);
    return {
      layout: { order: initial, hidden: fields.map((f) => f.slug).filter((s) => !initial.includes(s)) },
      sort: defaultSort,
      pageSize,
      groupBy: null,
      filters: {},
    };
  }, [columns, fields, maxColumns, defaultSort, pageSize]);

  const { prefs, update: setPrefs, reset } = useTablePrefs(`${entity.slug}:${tableSource}`, defaults);
  const [page, setPage] = useState(1);
  /** Held in memory only: never in the URL or browser storage (it may be a patient's name). */
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);

  const searchFields = fields.filter(searchable);
  const defaultSearchField =
    entity.identifier && searchFields.some((f) => f.slug === entity.identifier) ? entity.identifier : searchFields[0]?.slug;
  const [searchField, setSearchField] = useState<string | undefined>(defaultSearchField);
  const activeSearchField = searchFields.some((f) => f.slug === searchField) ? searchField : defaultSearchField;

  const filterFields = fields.filter(filterable).slice(0, MAX_FILTERS);
  const choiceFilters = Object.entries(prefs.filters).filter(
    ([slug, value]) => value && filterFields.some((f) => f.slug === slug),
  );

  const groupOptions = fields.filter((f) => groupValueFor(f)).map((f) => ({ value: f.slug, label: `Group by ${f.name.toLowerCase()}` }));
  const groupBy = prefs.groupBy && groupOptions.some((o) => o.value === prefs.groupBy) ? prefs.groupBy : null;

  const canEditCells = inlineEdit && entity.can.update;
  const update = useUpdate(entity.slug);
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set());
  const [editError, setEditError] = useState<string | null>(null);

  const cols = useMemo<Array<Column<Rec>>>(
    () =>
      fields.map((f) => ({
        key: f.slug,
        header: f.name,
        sortable: sortable(f),
        align: f.kind === 'number' || f.kind === 'currency' ? ('right' as const) : undefined,
        render: (r: Rec) => <FieldValue field={f} value={r[f.slug]} entity={entity.slug} recordId={r.id} compact />,
        groupValue: groupValueFor(f),
        // Offered only where the role may update this field. The server
        // re-checks every write against the record, so this is courtesy.
        edit: canEditCells && entity.updateFields.includes(f.slug) && !f.readOnly ? editorFor(f) : undefined,
      })),
    [fields, entity, canEditCells],
  );

  const filters: Filter[] = [
    ...(fixedFilters ?? []),
    ...choiceFilters.map(([slug, value]) => {
      const f = fieldOf(entity, slug);
      return { field: slug, operator: f?.multiple ? 'contains' : 'is', value };
    }),
  ];

  const list = useList(entity.slug, {
    page,
    rows: prefs.pageSize,
    sort: prefs.sort?.field,
    order: prefs.sort?.order,
    q: activeSearchField ? q : undefined,
    searchField: activeSearchField,
    filters,
    parent: parent ?? null,
    source: tableSource,
  });

  const rows = list.data?.records ?? [];
  const totalPages = list.data?.pages ?? 1;
  const narrowed = Boolean(q) || choiceFilters.length > 0;
  const showControls = searchFields.length > 0 || filterFields.length > 0 || groupOptions.length > 0 || onCreate || toolbar;

  /** Changes that reshape the query start again at page 1. */
  const change = (patch: Parameters<typeof setPrefs>[0]) => {
    setPrefs(patch);
    setPage(1);
  };

  return (
    <div className="space-y-3">
      {showControls && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            {searchFields.length > 0 && (
              <div className="flex w-full gap-2 sm:w-[28rem] sm:shrink-0">
                <div className="flex-1">
                  <SearchInput
                    value={search}
                    onChange={(v) => {
                      setSearch(v);
                      setPage(1);
                    }}
                    placeholder={`Search ${entity.name.toLowerCase()}…`}
                  />
                </div>
                {searchFields.length > 1 && (
                  <div className="w-44 shrink-0">
                    <Select
                      aria-label="Search in"
                      value={activeSearchField ?? ''}
                      onChange={(e) => {
                        setSearchField(e.target.value);
                        setPage(1);
                      }}
                      options={searchFields.map((f) => ({ value: f.slug, label: `in ${f.name.toLowerCase()}` }))}
                    />
                  </div>
                )}
              </div>
            )}

            {filterFields.map((f) => (
              <div key={f.slug} className="w-40 shrink-0">
                <Select
                  aria-label={`Filter by ${f.name.toLowerCase()}`}
                  value={prefs.filters[f.slug] ?? ''}
                  onChange={(e) => change({ filters: { ...prefs.filters, [f.slug]: e.target.value } })}
                  options={f.options ?? []}
                  placeholder={`All ${f.name.toLowerCase()}`}
                />
              </div>
            ))}

            {groupOptions.length > 0 && (
              <div className="w-44 shrink-0">
                <Select
                  aria-label="Group rows by"
                  value={groupBy ?? ''}
                  onChange={(e) => setPrefs({ groupBy: e.target.value || null })}
                  options={groupOptions}
                  placeholder="No grouping"
                />
              </div>
            )}

            {(narrowed || groupBy) && (
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch('');
                  reset();
                  setPage(1);
                }}
              >
                Clear
              </Button>
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

          {choiceFilters.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {choiceFilters.map(([slug, value]) => {
                const label = fieldOf(entity, slug)?.name ?? slug;
                return (
                  <button
                    key={slug}
                    type="button"
                    onClick={() => change({ filters: { ...prefs.filters, [slug]: '' } })}
                    className="inline-flex items-center gap-1 rounded-full bg-steel-100 py-1 pl-2.5 pr-1.5 text-xs font-medium text-steel-700 hover:bg-steel-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    {label}: {value}
                    <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="sr-only">Remove {label} filter</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Grouping works on the rows already loaded; say so when that's not all of them. */}
          {groupBy && totalPages > 1 && (
            <p className="text-xs text-steel-500">
              Grouping the {rows.length} rows on this page, not all {(list.data?.total ?? 0).toLocaleString()}. Show more rows per page to widen
              it.
            </p>
          )}
        </div>
      )}

      {editError && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          That change wasn’t saved, so the value has gone back. {editError}
        </p>
      )}

      <DataTable
        columns={cols}
        rows={rows}
        getRowId={(r) => r.id}
        loading={list.isLoading}
        error={list.error as { message?: string } | null}
        onRetry={() => void list.refetch()}
        onRowClick={onOpen}
        sort={prefs.sort}
        onSortChange={(s) => change({ sort: s })}
        page={page}
        totalPages={totalPages}
        totalRecords={list.data?.total}
        onPageChange={setPage}
        pageSize={prefs.pageSize}
        onPageSizeChange={(n) => change({ pageSize: n })}
        skeletonRows={Math.min(prefs.pageSize, 8)}
        layout={prefs.layout}
        onLayoutChange={(layout) => setPrefs({ layout })}
        groupBy={groupBy}
        onGroupByChange={(g) => setPrefs({ groupBy: g })}
        showGroupControl={false}
        savingIds={savingIds}
        onCellEdit={
          canEditCells
            ? ({ row, column, value }) => {
                setEditError(null);
                setSavingIds((prev) => new Set(prev).add(row.id));
                update.mutate(
                  { id: row.id, values: { [column.key]: value }, source: `${tableSource}-inline` },
                  {
                    onError: (e) => setEditError((e as Error).message),
                    onSettled: () =>
                      setSavingIds((prev) => {
                        const next = new Set(prev);
                        next.delete(row.id);
                        return next;
                      }),
                  },
                );
              }
            : undefined
        }
        emptyTitle={
          narrowed ? `No ${entity.name.toLowerCase()} match the search and filters` : (emptyTitle ?? `No ${entity.name.toLowerCase()} yet`)
        }
        emptyDescription={narrowed ? 'Clear them to see everything.' : emptyDescription}
      />
    </div>
  );
};
