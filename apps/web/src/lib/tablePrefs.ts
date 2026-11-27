import { useCallback, useState } from 'react';
import type { ColumnLayout, SortState } from '@fmc/knack-ui';

/**
 * How someone likes to read one table, remembered in this browser.
 *
 * Kept: column order and visibility, sort, rows per page, grouping, and the
 * choice filters (picked from a list Knack defines, e.g. "Status: Scheduled").
 *
 * Never kept: the search box, or anything else a person typed. On the HIPAA
 * tier we don't put user input in browser storage (it can hold a patient's
 * name), and this store survives sign-out by design. Nor the page number:
 * coming back to page 7 of a list is disorienting, and its rows may have moved.
 *
 * Storage failing (private browsing, quota, blocked) must never break the
 * table: every read and write is guarded and falls back to the defaults.
 */
export interface TablePrefs {
  layout: ColumnLayout;
  sort?: SortState;
  pageSize: number;
  groupBy: string | null;
  /** Choice filters, keyed by field slug. */
  filters: Record<string, string>;
}

const PREFIX = 'hp.table.';

const read = (key: string, defaults: TablePrefs): TablePrefs => {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<TablePrefs>;
    return {
      layout: saved.layout && typeof saved.layout === 'object' ? saved.layout : defaults.layout,
      sort:
        saved.sort && typeof saved.sort.field === 'string' && (saved.sort.order === 'asc' || saved.sort.order === 'desc')
          ? saved.sort
          : defaults.sort,
      pageSize: typeof saved.pageSize === 'number' && saved.pageSize > 0 ? saved.pageSize : defaults.pageSize,
      groupBy: typeof saved.groupBy === 'string' ? saved.groupBy : null,
      filters: saved.filters && typeof saved.filters === 'object' ? saved.filters : {},
    };
  } catch {
    return defaults;
  }
};

export const useTablePrefs = (key: string, defaults: TablePrefs) => {
  const [entry, setEntry] = useState(() => ({ key, prefs: read(key, defaults) }));
  // A different table is a different preference: read it during render so the
  // first request for the new table is already the right one.
  if (entry.key !== key) setEntry({ key, prefs: read(key, defaults) });
  const prefs = entry.key === key ? entry.prefs : read(key, defaults);

  const update = useCallback(
    (patch: Partial<TablePrefs>) => {
      setEntry((current) => {
        const next = { ...(current.key === key ? current.prefs : read(key, defaults)), ...patch };
        try {
          localStorage.setItem(PREFIX + key, JSON.stringify(next));
        } catch {
          // A preference that fails to save isn't worth an error.
        }
        return { key, prefs: next };
      });
    },
    // defaults is recomputed by callers; the key is what identifies the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  /** Back to how the table first looked. Columns stay as the reader arranged them. */
  const reset = useCallback(() => update({ sort: defaults.sort, groupBy: null, filters: {} }), [update, defaults.sort]);

  return { prefs, update, reset };
};
