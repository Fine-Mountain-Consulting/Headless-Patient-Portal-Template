/**
 * Record hooks over the API. Query keys start with the entity, so a write
 * refreshes every view of it.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export interface ConnectionRef {
  id: string;
  identifier: string;
}
export interface PersonName {
  first: string;
  last: string;
  full: string;
}
export interface AddressValue {
  street: string;
  street2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  full: string;
}
export interface FileValue {
  id: string;
  filename: string;
  size: number | null;
  type: string | null;
}

export type Rec = { id: string } & Record<string, unknown>;

export interface Filter {
  field: string;
  operator: string;
  value?: unknown;
}

export interface ListParams {
  page?: number;
  rows?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  q?: string;
  searchField?: string;
  filters?: Filter[];
  parent?: { field: string; id: string } | null;
  /** Screen name, for the access log. */
  source?: string;
}

export interface ListResult<T extends Rec = Rec> {
  records: T[];
  total: number;
  pages: number;
  page: number;
}

const listQuery = (entity: string, p: ListParams) => ({
  page: p.page,
  rows: p.rows,
  sort: p.sort,
  order: p.order,
  q: p.q,
  searchField: p.searchField,
  filters: p.filters?.length ? JSON.stringify(p.filters) : undefined,
  parentField: p.parent?.field,
  parentId: p.parent?.id,
  source: p.source ?? entity,
});

export const useList = <T extends Rec = Rec>(entity: string, params: ListParams = {}, enabled = true) =>
  useQuery({
    queryKey: ['records', entity, params],
    queryFn: ({ signal }) => api<ListResult<T>>(`/records/${entity}`, { query: listQuery(entity, params), signal }),
    placeholderData: keepPreviousData,
    enabled,
    staleTime: 30_000,
  });

export const useRecord = <T extends Rec = Rec>(entity: string, id: string | null | undefined, source?: string) =>
  useQuery({
    queryKey: ['record', entity, id],
    queryFn: ({ signal }) =>
      api<{ record: T; can: { update: boolean; delete: boolean } }>(`/records/${entity}/${id}`, {
        query: { source },
        signal,
      }),
    enabled: Boolean(id),
    staleTime: 30_000,
  });

const useInvalidate = () => {
  const qc = useQueryClient();
  return (entity: string) => {
    void qc.invalidateQueries({ queryKey: ['records', entity] });
    void qc.invalidateQueries({ queryKey: ['record', entity] });
  };
};

export const useCreate = (entity: string) => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { values: Record<string, unknown>; source?: string; reason?: string }) =>
      api<{ record: Rec }>(`/records/${entity}`, { method: 'POST', body: input }),
    onSuccess: () => invalidate(entity),
  });
};

export const useUpdate = (entity: string) => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { id: string; values: Record<string, unknown>; source?: string; reason?: string }) =>
      api<{ record: Rec }>(`/records/${entity}/${input.id}`, {
        method: 'PUT',
        body: { values: input.values, source: input.source, reason: input.reason },
      }),
    onSuccess: () => invalidate(entity),
  });
};

export const useDelete = (entity: string) => {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { id: string; source?: string; reason?: string }) =>
      api<{ ok: true }>(`/records/${entity}/${input.id}`, { method: 'DELETE', body: { source: input.source, reason: input.reason } }),
    onSuccess: () => invalidate(entity),
  });
};

export const fetchOptions = (entity: string, field: string, q: string) =>
  api<{ options: Array<{ id: string; label: string }> }>(`/options/${entity}/${field}`, { query: { q } }).then((r) => r.options);

/** Same-origin download link: the server checks access and logs it. */
export const fileHref = (entity: string, id: string, field: string, opts: { inline?: boolean; source?: string } = {}) =>
  `/api/files/${entity}/${id}/${field}?${new URLSearchParams({
    ...(opts.inline ? { inline: '1' } : {}),
    ...(opts.source ? { source: opts.source } : {}),
  })}`;

// ── Value helpers ─────────────────────────────────────────────────────────

export const refs = (v: unknown): ConnectionRef[] => (Array.isArray(v) ? (v as ConnectionRef[]) : []);
export const refName = (v: unknown): string => refs(v).map((r) => r.identifier).filter(Boolean).join(', ');
export const refId = (v: unknown): string | undefined => refs(v)[0]?.id;
export const asName = (v: unknown): PersonName | null => (v && typeof v === 'object' && 'full' in (v as object) ? (v as PersonName) : null);
export const asText = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
export const asFile = (v: unknown): FileValue | null => (v && typeof v === 'object' && 'filename' in (v as object) ? (v as FileValue) : null);
export const asAddress = (v: unknown): AddressValue | null => (v && typeof v === 'object' && 'full' in (v as object) ? (v as AddressValue) : null);
