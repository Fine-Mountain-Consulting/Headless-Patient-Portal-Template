/**
 * Schema-driven display and input for every Knack field kind.
 */
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDownTrayIcon, CloudArrowUpIcon, DocumentIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { Button, cx, FormField, SearchableSelect, Select, Switch, TextArea, TextInput, type SearchOption } from '@fmc/knack-ui';
import { uploadWithProgress, ApiError } from '../lib/api';
import { formatDate, formatDateTime, fileSize, toWallClock } from '../lib/format';
import {
  asAddress,
  asFile,
  asName,
  fetchOptions,
  fileHref,
  refs,
  type AddressValue,
  type FileValue,
  type PersonName,
  type Rec,
} from '../lib/records';
import type { EntityInfo, FieldInfo } from '../lib/schema';
import { htmlToText, SafeHtml, StatusPill, textToHtml } from './ui';

// ── Display ───────────────────────────────────────────────────────────────

export const FieldValue = ({
  field,
  value,
  entity,
  recordId,
  compact,
}: {
  field: FieldInfo;
  value: unknown;
  entity: string;
  recordId: string;
  compact?: boolean;
}): ReactNode => {
  const empty = <span className="text-steel-400">—</span>;
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return empty;

  switch (field.kind) {
    case 'name':
      return asName(value)?.full || empty;
    case 'address':
      return asAddress(value)?.full || empty;
    case 'connection':
      return refs(value).map((r) => r.identifier).join(', ') || empty;
    case 'date':
      return formatDate(value);
    case 'datetime':
      return formatDateTime(value);
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'choice':
      return Array.isArray(value) ? value.join(', ') : /status|priority|type/i.test(field.name) ? <StatusPill value={value} /> : String(value);
    case 'rich_text':
      return compact ? <span className="line-clamp-2">{htmlToText(value)}</span> : <SafeHtml html={value} />;
    case 'paragraph_text':
      return <span className={cx('whitespace-pre-line', compact && 'line-clamp-2')}>{String(value)}</span>;
    case 'email':
      return (
        <a href={`mailto:${String(value)}`} className="text-brand-700 hover:underline">
          {String(value)}
        </a>
      );
    case 'phone':
      return (
        <a href={`tel:${String(value).replace(/[^\d+]/g, '')}`} className="text-brand-700 hover:underline">
          {String(value)}
        </a>
      );
    case 'link':
      return /^https?:\/\//.test(String(value)) ? (
        <a href={String(value)} target="_blank" rel="noopener noreferrer" className="text-brand-700 hover:underline">
          {String(value)}
        </a>
      ) : (
        String(value)
      );
    case 'file':
    case 'image': {
      const f = asFile(value);
      if (!f) return empty;
      return (
        <a
          href={fileHref(entity, recordId, field.slug, { source: 'record' })}
          className="inline-flex items-center gap-1.5 text-brand-700 hover:underline"
        >
          <ArrowDownTrayIcon className="h-4 w-4" aria-hidden="true" />
          {f.filename}
          {f.size ? <span className="text-steel-400">({fileSize(f.size)})</span> : null}
        </a>
      );
    }
    case 'roles':
      return Array.isArray(value) ? value.join(', ') : empty;
    case 'number':
    case 'currency':
      return typeof value === 'number' ? value.toLocaleString() : String(value);
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
};

/** Definition list of a record's readable fields. */
export const RecordFields = ({
  entity,
  record,
  only,
  exclude = [],
}: {
  entity: EntityInfo;
  record: Rec;
  only?: string[];
  exclude?: string[];
}) => {
  const fields = entity.fields.filter(
    (f) => (only ? only.includes(f.slug) : entity.readFields.includes(f.slug)) && !exclude.includes(f.slug) && f.slug in record,
  );
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
      {fields.map((f) => {
        const wide = f.kind === 'rich_text' || f.kind === 'paragraph_text' || f.kind === 'address';
        return (
          <div key={f.slug} className={cx(wide && 'sm:col-span-2')}>
            <dt className="text-xs font-medium uppercase tracking-wide text-steel-500">{f.name}</dt>
            <dd className="mt-1 text-sm text-steel-900">
              <FieldValue field={f} value={record[f.slug]} entity={entity.slug} recordId={record.id} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
};

// ── Input ─────────────────────────────────────────────────────────────────

/** Form state value for a field, from a stored record value. */
export const toFormValue = (field: FieldInfo, value: unknown): unknown => {
  switch (field.kind) {
    case 'connection':
      return refs(value).map((r) => ({ id: r.id, label: r.identifier }));
    case 'datetime':
      return toWallClock(value);
    case 'rich_text':
      return htmlToText(value);
    case 'name':
      return asName(value) ?? { first: '', last: '', full: '' };
    case 'address':
      return asAddress(value) ?? { street: '', street2: '', city: '', state: '', zip: '', country: '', full: '' };
    case 'boolean':
      return Boolean(value);
    case 'number':
    case 'currency':
      return value === null || value === undefined ? '' : String(value);
    default:
      return value ?? (field.kind === 'choice' && field.multiple ? [] : '');
  }
};

/** Form state -> API value. */
export const fromFormValue = (field: FieldInfo, value: unknown): unknown => {
  switch (field.kind) {
    case 'connection':
      return (value as SearchOption[]).map((o) => o.id);
    case 'rich_text':
      return typeof value === 'string' && value.trim() ? textToHtml(value.trim()) : '';
    case 'file':
    case 'image':
      return value ? (value as FileValue).id : '';
    default:
      return typeof value === 'string' ? value.trim() : value;
  }
};

const isEmptyValue = (field: FieldInfo, v: unknown): boolean => {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (field.kind === 'name') return !(v as PersonName).first?.trim() && !(v as PersonName).last?.trim();
  if (field.kind === 'address') return !(v as AddressValue).street?.trim() && !(v as AddressValue).city?.trim();
  return false;
};

export const FieldInput = ({
  field,
  entity,
  value,
  onChange,
  invalid,
  id,
}: {
  field: FieldInfo;
  entity: string;
  value: unknown;
  onChange: (v: unknown) => void;
  invalid?: boolean;
  id: string;
}) => {
  const text = typeof value === 'string' ? value : '';
  switch (field.kind) {
    case 'paragraph_text':
    case 'rich_text':
      return <TextArea id={id} rows={field.kind === 'rich_text' ? 6 : 4} value={text} onChange={(e) => onChange(e.target.value)} invalid={invalid} />;
    case 'number':
    case 'currency':
      return <TextInput id={id} type="number" inputMode="decimal" step="any" value={text} onChange={(e) => onChange(e.target.value)} invalid={invalid} />;
    case 'email':
      return <TextInput id={id} type="email" autoComplete="email" value={text} onChange={(e) => onChange(e.target.value)} invalid={invalid} />;
    case 'phone':
      return <TextInput id={id} type="tel" autoComplete="tel" value={text} onChange={(e) => onChange(e.target.value)} invalid={invalid} />;
    case 'link':
      return <TextInput id={id} type="url" value={text} onChange={(e) => onChange(e.target.value)} invalid={invalid} placeholder="https://" />;
    case 'date':
      return <TextInput id={id} type="date" value={text} onChange={(e) => onChange(e.target.value)} invalid={invalid} />;
    case 'datetime':
      return <TextInput id={id} type="datetime-local" value={text} onChange={(e) => onChange(e.target.value)} invalid={invalid} />;
    case 'boolean':
      return <Switch checked={Boolean(value)} onChange={(v) => onChange(v)} label={field.name} />;
    case 'choice':
      if (field.multiple) {
        const list = Array.isArray(value) ? (value as string[]) : [];
        return (
          <div id={id} className="flex flex-wrap gap-2">
            {(field.options ?? []).map((o) => {
              const on = list.includes(o);
              return (
                <button
                  key={o}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange(on ? list.filter((x) => x !== o) : [...list, o])}
                  className={cx(
                    'rounded-full border px-3 py-1.5 text-sm transition-colors',
                    on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-steel-300 bg-white text-steel-700 hover:bg-steel-50',
                  )}
                >
                  {o}
                </button>
              );
            })}
          </div>
        );
      }
      return (
        <Select
          id={id}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          invalid={invalid}
          placeholder="Select…"
          options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
        />
      );
    case 'connection':
      return (
        <SearchableSelect
          id={id}
          value={(value as SearchOption[]) ?? []}
          onChange={onChange}
          multiple={field.multiple}
          invalid={invalid}
          placeholder={`Search ${field.name.toLowerCase()}…`}
          search={(q) => fetchOptions(entity, field.slug, q)}
        />
      );
    case 'name': {
      const v = (value as PersonName) ?? { first: '', last: '', full: '' };
      return (
        <div className="grid grid-cols-2 gap-2">
          <TextInput id={id} aria-label="First name" placeholder="First" autoComplete="given-name" value={v.first} onChange={(e) => onChange({ ...v, first: e.target.value })} invalid={invalid} />
          <TextInput aria-label="Last name" placeholder="Last" autoComplete="family-name" value={v.last} onChange={(e) => onChange({ ...v, last: e.target.value })} invalid={invalid} />
        </div>
      );
    }
    case 'address': {
      const v = (value as AddressValue) ?? { street: '', street2: '', city: '', state: '', zip: '', country: '', full: '' };
      const set = (k: keyof AddressValue) => (e: { target: { value: string } }) => onChange({ ...v, [k]: e.target.value });
      return (
        <div className="grid grid-cols-6 gap-2">
          <TextInput id={id} className="col-span-6" placeholder="Street address" autoComplete="address-line1" value={v.street} onChange={set('street')} invalid={invalid} />
          <TextInput className="col-span-6" placeholder="Apartment, suite (optional)" autoComplete="address-line2" value={v.street2} onChange={set('street2')} />
          <TextInput className="col-span-3" placeholder="City" autoComplete="address-level2" value={v.city} onChange={set('city')} />
          <TextInput className="col-span-1" placeholder="State" autoComplete="address-level1" value={v.state} onChange={set('state')} />
          <TextInput className="col-span-2" placeholder="ZIP" autoComplete="postal-code" inputMode="numeric" value={v.zip} onChange={set('zip')} />
        </div>
      );
    }
    case 'file':
    case 'image':
      return <FileDrop entity={entity} field={field} value={(value as FileValue) || null} onChange={onChange} accept={field.kind === 'image' ? 'image/*' : undefined} />;
    default:
      return <TextInput id={id} value={text} onChange={(e) => onChange(e.target.value)} invalid={invalid} />;
  }
};

// ── File drop with progress ───────────────────────────────────────────────

export const FileDrop = ({
  entity,
  field,
  value,
  onChange,
  accept,
}: {
  entity: string;
  field: FieldInfo;
  value: FileValue | null;
  onChange: (v: FileValue | null) => void;
  accept?: string;
}) => {
  const inputId = useId();
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > 20 * 1024 * 1024) {
      setError('Files must be 20 MB or smaller.');
      return;
    }
    setProgress(0);
    try {
      const asset = await uploadWithProgress(`/upload/${entity}/${field.slug}`, file, setProgress);
      onChange({ id: asset.id, filename: asset.filename, size: asset.size, type: asset.type });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Upload failed.');
    } finally {
      setProgress(null);
    }
  };

  if (value) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-steel-200 bg-steel-50 p-3">
        <DocumentIcon className="h-8 w-8 shrink-0 text-brand-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-steel-900">{value.filename}</p>
          {value.size ? <p className="text-xs text-steel-500">{fileSize(value.size)}</p> : null}
        </div>
        <button type="button" onClick={() => onChange(null)} className="rounded-lg p-1.5 text-steel-500 hover:bg-steel-200" aria-label="Remove file">
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>
    );
  }

  return (
    <div>
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void upload(e.dataTransfer.files[0]);
        }}
        className={cx(
          'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors',
          over ? 'border-brand-500 bg-brand-50' : 'border-steel-300 bg-white hover:border-brand-400 hover:bg-steel-50',
          'focus-within:ring-2 focus-within:ring-brand-500',
        )}
      >
        <CloudArrowUpIcon className="h-8 w-8 text-steel-400" aria-hidden="true" />
        {progress === null ? (
          <>
            <span className="mt-2 text-sm font-medium text-steel-800">
              Drop a file here or <span className="text-brand-700 underline">browse</span>
            </span>
            <span className="mt-1 text-xs text-steel-500">PDF, images or documents · up to 20 MB</span>
          </>
        ) : (
          <div className="mt-3 w-full max-w-xs">
            <div className="h-2 overflow-hidden rounded-full bg-steel-200" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-brand-600 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="mt-1 text-xs text-steel-500">Uploading… {Math.round(progress * 100)}%</p>
          </div>
        )}
        <input id={inputId} type="file" className="sr-only" accept={accept} disabled={progress !== null} onChange={(e) => void upload(e.target.files?.[0])} />
      </label>
      {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
};

// ── Record form ───────────────────────────────────────────────────────────

export interface RecordFormProps {
  entity: EntityInfo;
  mode: 'create' | 'update';
  record?: Rec;
  /** Field slugs to show, in order. Defaults to every writable field. */
  fields?: string[];
  /** Fixed values (e.g. the parent connection), sent but not shown. */
  fixed?: Record<string, unknown>;
  /** Labels to use instead of the Knack field names. */
  labels?: Record<string, string>;
  help?: Record<string, string>;
  defaults?: Record<string, unknown>;
  submitLabel?: string;
  onSubmit: (values: Record<string, unknown>) => Promise<unknown>;
  onCancel?: () => void;
  serverErrors?: Record<string, string>;
  children?: ReactNode;
}

export const RecordForm = ({
  entity,
  mode,
  record,
  fields,
  fixed = {},
  labels = {},
  help = {},
  defaults = {},
  submitLabel,
  onSubmit,
  onCancel,
  children,
}: RecordFormProps) => {
  const formId = useId();
  const writable = mode === 'create' ? entity.createFields : entity.updateFields;
  const shown = useMemo(() => {
    const order = fields ?? writable;
    return order
      .map((slug) => entity.fields.find((f) => f.slug === slug))
      .filter((f): f is FieldInfo => Boolean(f) && writable.includes(f!.slug) && !(f!.slug in fixed) && !entity.forcedOnCreate.includes(f!.slug));
  }, [entity, fields, writable, fixed]);

  const initial = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const f of shown) out[f.slug] = toFormValue(f, record ? record[f.slug] : defaults[f.slug]);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, record?.id]);

  const [values, setValues] = useState<Record<string, unknown>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setValues(initial), [initial]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    for (const f of shown) {
      if (f.required && isEmptyValue(f, values[f.slug])) next[f.slug] = `${labels[f.slug] ?? f.name} is required.`;
      if (f.kind === 'email' && values[f.slug] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(values[f.slug]))) next[f.slug] = 'Enter a valid email address.';
    }
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) {
      document.getElementById(`${formId}-${Object.keys(next)[0]}`)?.focus();
      return;
    }
    const payload: Record<string, unknown> = { ...fixed };
    for (const f of shown) {
      // On edit, only send what changed.
      if (mode === 'update' && JSON.stringify(values[f.slug]) === JSON.stringify(initial[f.slug])) continue;
      payload[f.slug] = fromFormValue(f, values[f.slug]);
    }
    if (mode === 'update' && !Object.keys(payload).length) {
      onCancel?.();
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(payload);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setFormError(err.message);
      } else setFormError('Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      {formError && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {formError}
        </div>
      )}
      {shown.map((f) => {
        const id = `${formId}-${f.slug}`;
        const label = labels[f.slug] ?? f.name;
        return f.kind === 'boolean' ? (
          <div key={f.slug} className="flex items-center justify-between gap-4 rounded-xl border border-steel-200 px-4 py-3">
            <span className="text-sm font-medium text-steel-700">{label}</span>
            <FieldInput field={f} entity={entity.slug} id={id} value={values[f.slug]} onChange={(v) => setValues((s) => ({ ...s, [f.slug]: v }))} />
          </div>
        ) : (
          <FormField key={f.slug} label={label} htmlFor={id} required={f.required} error={errors[f.slug]} help={help[f.slug]}>
            <FieldInput
              field={f}
              entity={entity.slug}
              id={id}
              value={values[f.slug]}
              invalid={Boolean(errors[f.slug])}
              onChange={(v) => {
                setValues((s) => ({ ...s, [f.slug]: v }));
                if (errors[f.slug]) setErrors(({ [f.slug]: _drop, ...rest }) => rest);
              }}
            />
          </FormField>
        );
      })}
      {children}
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" loading={submitting}>
          {submitLabel ?? (mode === 'create' ? 'Save' : 'Save changes')}
        </Button>
      </div>
    </form>
  );
};
