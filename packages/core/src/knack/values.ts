/**
 * Translation between Knack records and the friendly-named DTOs the browser
 * sees. No `field_N` crosses this boundary in either direction.
 *
 * Knack answers with `field_N` (HTML-formatted for display) and `field_N_raw`
 * (structured). `_raw` is the usable one for everything; the formatted value
 * will hand back `<a href="mailto:…">` where a string was expected.
 */
import type { EntityModel, FieldModel } from '../model/model.js';

export interface KnackRecord {
  id: string;
  [key: string]: unknown;
}

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

/**
 * A file as the browser sees it. Deliberately no URL: Knack's asset links
 * download without any credential (verified, even for "secure" file fields),
 * so they are bearer links to PHI. Downloads go through the server, which
 * checks access and writes the access log first.
 */
export interface FileValue {
  id: string;
  filename: string;
  size: number | null;
  type: string | null;
}

export type Dto = { id: string } & Record<string, unknown>;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** "MM/DD/YYYY" -> "YYYY-MM-DD". */
const usDateToIso = (value: string): string | null => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  return m ? `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}` : null;
};

/** "YYYY-MM-DD…" -> "MM/DD/YYYY". Knack silently mismatches ISO in filters. */
export const toKnackDate = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return iso ? `${iso[2]}/${iso[3]}/${iso[1]}` : value;
};

const readName = (value: unknown): PersonName | null => {
  if (value && typeof value === 'object') {
    const p = value as Record<string, unknown>;
    const first = str(p.first);
    const last = str(p.last);
    const full = str(p.full) || [p.title, first, p.middle, last].map(str).filter(Boolean).join(' ');
    return { first, last, full };
  }
  if (typeof value === 'string' && value) {
    const parts = value.trim().split(/\s+/);
    return { first: parts.slice(0, -1).join(' ') || value, last: parts.length > 1 ? parts.at(-1)! : '', full: value };
  }
  return null;
};

const readAddress = (value: unknown): AddressValue | null => {
  if (!value || typeof value !== 'object') return null;
  const a = value as Record<string, unknown>;
  const street = str(a.street);
  const street2 = str(a.street2);
  const city = str(a.city);
  const state = str(a.state);
  const zip = str(a.zip);
  const country = str(a.country);
  const line1 = [street, street2].filter(Boolean).join(', ');
  const line2 = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const full = str(a.full) || [line1, line2, country].filter(Boolean).join(', ');
  if (!full) return null;
  return { street, street2, city, state, zip, country, full };
};

const readFile = (value: unknown): FileValue | null => {
  if (!value || typeof value !== 'object') return null;
  const f = value as Record<string, unknown>;
  if (!f.id && !f.filename) return null;
  return {
    id: str(f.id),
    filename: str(f.filename) || 'file',
    size: typeof f.size === 'number' ? f.size : null,
    type: f.type ? str(f.type) : null,
  };
};

/** The raw asset URL, for the server's download proxy only. Never put in a DTO. */
export const fileUrl = (record: KnackRecord, field: FieldModel): string | null => {
  const raw = record[`${field.key}_raw`];
  if (raw && typeof raw === 'object') {
    const f = raw as Record<string, unknown>;
    if (typeof f.url === 'string') return f.url;
  }
  if (typeof raw === 'string' && /^https:\/\//.test(raw)) return raw;
  return null;
};

export const readField = (record: KnackRecord, field: FieldModel): unknown => {
  const raw = record[`${field.key}_raw`];
  const value = raw ?? record[field.key];

  switch (field.kind) {
    case 'connection':
      if (!Array.isArray(value)) return [];
      return value.map((c): ConnectionRef =>
        c && typeof c === 'object'
          ? { id: str((c as ConnectionRef).id), identifier: stripTags(str((c as ConnectionRef).identifier)) }
          : { id: str(c), identifier: '' },
      );
    case 'file':
    case 'image':
      return readFile(value);
    case 'roles':
      return Array.isArray(value) ? value.map(str) : value ? [str(value)] : [];
    case 'name':
      return readName(value);
    case 'address':
      return readAddress(value);
    case 'email':
    case 'phone':
    case 'link': {
      if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        return str(v.email ?? v.formatted ?? v.full ?? v.number ?? v.url ?? v.label) || null;
      }
      return value ? str(value) : null;
    }
    case 'date': {
      if (value && typeof value === 'object') {
        const d = value as Record<string, unknown>;
        return usDateToIso(str(d.date)) ?? null;
      }
      return typeof value === 'string' ? (usDateToIso(value) ?? value) : null;
    }
    case 'datetime': {
      // `iso_timestamp` is real UTC, converted from the app's time zone
      // (verified: 1:30 PM in an Eastern app reads back as 18:30Z).
      if (value && typeof value === 'object') {
        const d = value as Record<string, unknown>;
        return str(d.iso_timestamp ?? d.proper_iso_timestamp) || null;
      }
      return value ? str(value) : null;
    }
    case 'boolean':
      return value === true || value === 'Yes' || value === 'true';
    case 'number':
    case 'currency': {
      if (value === '' || value === null || value === undefined) return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'choice':
      if (field.multiple) return Array.isArray(value) ? value.map(str) : value ? [str(value)] : [];
      return Array.isArray(value) ? str(value[0]) || null : value ? str(value) : null;
    case 'password':
      return undefined;
    default:
      return value ?? null;
  }
};

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, '');

/** Field kinds whose value is legitimately an object or array in a DTO. */
const STRUCTURED = new Set(['connection', 'file', 'image', 'roles', 'name', 'address']);

/**
 * Last line of defence: a composite Knack value nobody has flattened yet
 * reaching React as an object blanks the page (React error #31). Degrade it to
 * a string and say so in the log, rather than take the screen down.
 */
const scalarise = (value: unknown, field: FieldModel, entity: EntityModel): unknown => {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (field.kind === 'choice' && Array.isArray(value)) return value;
  const o = value as Record<string, unknown>;
  console.warn(
    `${entity.name}.${field.name} (${field.knackType}) came back as an object; flatten it in readField. ` +
      `Keys: ${Object.keys(o).join(', ')}`,
  );
  const guess = o.full ?? o.label ?? o.url ?? o.value;
  return typeof guess === 'string' ? guess : JSON.stringify(value);
};

/**
 * Knack record -> DTO, limited to `allowed` field keys.
 *
 * The allowlist is the role's readable fields, derived from the columns and
 * inputs its Knack pages show. A field the role's pages never display does not
 * leave the server.
 */
export const toDto = (record: KnackRecord, entity: EntityModel, allowed: ReadonlySet<string>): Dto => {
  const dto: Dto = { id: record.id };
  for (const field of entity.fields) {
    if (!allowed.has(field.key) || field.kind === 'password') continue;
    const value = readField(record, field);
    if (value === undefined) continue;
    dto[field.slug] = STRUCTURED.has(field.kind) ? value : scalarise(value, field, entity);
  }
  return dto;
};

/** Wall-clock "YYYY-MM-DDTHH:mm" (in the app's time zone) -> Knack's date object. */
const toKnackDateTime = (value: string): unknown => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value);
  if (!m) return value;
  const date = `${m[2]}/${m[3]}/${m[1]}`;
  if (m[4] === undefined) return { date };
  const h24 = Number(m[4]);
  const hours = String(h24 % 12 === 0 ? 12 : h24 % 12);
  return { date, hours, minutes: m[5], am_pm: h24 < 12 ? 'AM' : 'PM' };
};

export class InvalidValue extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * DTO input -> Knack values, limited to `writable` field keys.
 *
 * Unknown or non-writable names are dropped, not passed through: the role's
 * form inputs are the write allowlist, so a client cannot reach a field its
 * Knack forms don't offer (`Owned By`, a status it can't set, …).
 */
export const toKnackValues = (
  input: Record<string, unknown>,
  entity: EntityModel,
  writable: ReadonlySet<string>,
): Record<string, unknown> => {
  const values: Record<string, unknown> = {};
  for (const [slug, value] of Object.entries(input)) {
    const field = entity.bySlug.get(slug);
    if (!field || !writable.has(field.key) || field.readOnly) continue;
    values[field.key] = toKnackValue(field, value);
  }
  return values;
};

export const toKnackValue = (field: FieldModel, value: unknown): unknown => {
  switch (field.kind) {
    case 'connection': {
      // Read as [{id, identifier}], written as [id].
      const list = Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value];
      return list.map((v) => (v && typeof v === 'object' ? str((v as ConnectionRef).id) : str(v))).filter(Boolean);
    }
    case 'file':
    case 'image':
      // The asset id returned by the upload step.
      if (value && typeof value === 'object') return str((value as FileValue).id);
      return typeof value === 'string' ? value : '';
    case 'name': {
      // A plain string "succeeds" and stores an empty name. Always send parts.
      if (value && typeof value === 'object') {
        const v = value as Partial<PersonName>;
        return { first: str(v.first).trim(), last: str(v.last).trim() };
      }
      const parts = str(value).trim().split(/\s+/).filter(Boolean);
      return { first: parts.slice(0, -1).join(' ') || (parts[0] ?? ''), last: parts.length > 1 ? parts.at(-1)! : '' };
    }
    case 'address': {
      if (value && typeof value === 'object') {
        const a = value as Partial<AddressValue>;
        return {
          street: str(a.street),
          street2: str(a.street2),
          city: str(a.city),
          state: str(a.state),
          zip: str(a.zip),
          country: str(a.country),
        };
      }
      return { street: str(value) };
    }
    case 'date':
      return value ? toKnackDate(value) : '';
    case 'datetime':
      return typeof value === 'string' && value ? toKnackDateTime(value) : '';
    case 'number':
    case 'currency': {
      // Numeric strings are stored as strings. Write numbers as numbers.
      if (value === '' || value === null || value === undefined) return '';
      const n = Number(value);
      if (!Number.isFinite(n)) throw new InvalidValue(field.slug, `${field.name} must be a number.`);
      return n;
    }
    case 'boolean':
      return value === true || value === 'true' || value === 'Yes';
    case 'choice':
      if (field.multiple) return Array.isArray(value) ? value.map(str) : value ? [str(value)] : [];
      if (value && field.options?.length && !field.options.includes(str(value))) {
        throw new InvalidValue(field.slug, `${field.name} must be one of: ${field.options.join(', ')}.`);
      }
      return value ? str(value) : '';
    case 'email':
      return value ? { email: str(value).trim() } : '';
    case 'phone':
      return value ? str(value).trim() : '';
    case 'password':
      return str(value);
    default:
      return value === null || value === undefined ? '' : value;
  }
};

/** Record ids a connection field points at. */
export const connectionIds = (record: KnackRecord, fieldKey: string): string[] => {
  const raw = record[`${fieldKey}_raw`] ?? record[fieldKey];
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => (c && typeof c === 'object' ? str((c as ConnectionRef).id) : str(c))).filter(Boolean);
};
