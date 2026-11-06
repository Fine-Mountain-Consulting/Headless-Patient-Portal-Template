/**
 * The app model: Knack's objects and fields, given friendly names.
 *
 * Everything outside the Knack client speaks in entity and field *slugs*
 * ("appointments", "dateOfAppointment"), never `object_N` / `field_N`. The
 * slugs are derived from the names in the customer's Knack app, so a field the
 * customer adds shows up with a sensible name without anyone editing code.
 */
import type { AppSnapshot, LoaderField, LoaderObject } from '../knack/loader.js';

export type FieldKind =
  | 'short_text'
  | 'paragraph_text'
  | 'rich_text'
  | 'number'
  | 'currency'
  | 'choice'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'connection'
  | 'file'
  | 'image'
  | 'name'
  | 'email'
  | 'phone'
  | 'address'
  | 'link'
  | 'roles'
  | 'password'
  | 'computed'
  | 'other';

export interface FieldModel {
  key: string;
  slug: string;
  name: string;
  kind: FieldKind;
  knackType: string;
  required: boolean;
  /** Computed by Knack (equations, auto-increment, system fields). Never written. */
  readOnly: boolean;
  /** Choice fields. */
  options?: string[];
  multiple?: boolean;
  /** Connection fields: the object the field points at. */
  targetObject?: string;
  /** Date fields with no time part. */
  dateOnly?: boolean;
}

export interface EntityModel {
  slug: string;
  name: string;
  objectKey: string;
  /** A Knack user-role object (Patients, Doctors…) or the Accounts object. */
  isUser: boolean;
  /** `profile_N` for role objects, `all_users` for Accounts. */
  profileKey?: string;
  identifierKey?: string;
  fields: FieldModel[];
  byKey: Map<string, FieldModel>;
  bySlug: Map<string, FieldModel>;
}

export interface AppModel {
  appId: string;
  appName: string;
  timezone: string;
  entities: EntityModel[];
  byObject: Map<string, EntityModel>;
  bySlug: Map<string, EntityModel>;
  byProfile: Map<string, EntityModel>;
  /** The Accounts object (profile `all_users`): every user has a record here. */
  accounts: EntityModel;
}

const COMPUTED = new Set([
  'equation',
  'concatenation',
  'auto_increment',
  'sum',
  'min',
  'max',
  'average',
  'count',
  'timer',
  'signature',
]);

/** System fields Knack maintains itself. Readable, never writable. */
const SYSTEM_FIELD_NAMES = new Set(['Record ID', 'Created On', 'Updated On', 'Created By', 'Updated By', 'Owned By']);

const KIND: Record<string, FieldKind> = {
  short_text: 'short_text',
  paragraph_text: 'paragraph_text',
  rich_text: 'rich_text',
  number: 'number',
  currency: 'currency',
  rating: 'number',
  multiple_choice: 'choice',
  boolean: 'boolean',
  date_time: 'datetime',
  connection: 'connection',
  file: 'file',
  image: 'image',
  name: 'name',
  email: 'email',
  phone: 'phone',
  address: 'address',
  link: 'link',
  user_roles: 'roles',
  password: 'password',
};

const words = (name: string): string[] =>
  name
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, ' ')
    .split(/[\s_-]+/)
    .filter(Boolean);

export const toEntitySlug = (name: string): string => words(name).join('-').toLowerCase() || 'entity';

export const toFieldSlug = (name: string): string => {
  const parts = words(name).map((w) => w.toLowerCase());
  if (parts.length === 0) return 'field';
  const slug = parts[0]! + parts.slice(1).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
  return /^\d/.test(slug) ? `f${slug}` : slug;
};

/** Names a DTO already uses for its own purposes. */
const RESERVED_FIELD_SLUGS = new Set(['id', '_meta']);

const isDateOnly = (field: LoaderField): boolean => {
  const tf = String(field.format?.time_format ?? '');
  return tf === 'Ignore Time' || tf === 'ignore' || /ignore/i.test(tf);
};

/** A unique, name-derived slug for a field nobody has locked yet. */
const freshFieldSlug = (field: LoaderField, used: Set<string>): string => {
  let slug = toFieldSlug(field.name);
  if (RESERVED_FIELD_SLUGS.has(slug)) slug = `${slug}Field`;
  if (used.has(slug)) slug = `${slug}_${field.key.replace('field_', '')}`;
  return slug;
};

const buildField = (field: LoaderField, slug: string): FieldModel => {

  const computed = COMPUTED.has(field.type);
  let kind: FieldKind = computed ? 'computed' : (KIND[field.type] ?? 'other');
  const model: FieldModel = {
    key: field.key,
    slug,
    name: field.name,
    kind,
    knackType: field.type,
    required: Boolean(field.required),
    readOnly: computed || SYSTEM_FIELD_NAMES.has(field.name) || field.type === 'user_roles',
  };

  if (kind === 'choice') {
    model.options = Array.isArray(field.format?.options) ? field.format.options.map(String) : [];
    model.multiple = field.format?.type === 'multi' || field.format?.type === 'checkboxes';
  }
  if (kind === 'connection') {
    model.targetObject = field.relationship?.object;
    model.multiple = field.relationship?.has === 'many';
  }
  if (kind === 'datetime' && isDateOnly(field)) {
    model.kind = kind = 'date';
    model.dateOnly = true;
  }
  return model;
};

const buildEntity = (object: LoaderObject, slug: string, lock: SlugLock[string] | undefined): EntityModel => {
  // Locked slugs first, so a renamed field keeps the name the screens use,
  // then fresh ones for fields seen for the first time.
  const used = new Set<string>();
  const slugs = new Map<string, string>();
  for (const f of object.fields) {
    const locked = lock?.fields[f.key];
    if (locked && !used.has(locked)) {
      slugs.set(f.key, locked);
      used.add(locked);
    }
  }
  for (const f of object.fields) {
    if (slugs.has(f.key)) continue;
    const fresh = freshFieldSlug(f, used);
    slugs.set(f.key, fresh);
    used.add(fresh);
  }
  const fields = object.fields.map((f) => buildField(f, slugs.get(f.key)!));
  return {
    slug,
    name: object.name,
    objectKey: object.key,
    isUser: Boolean(object.user),
    profileKey: object.profile_key,
    identifierKey: object.identifier,
    fields,
    byKey: new Map(fields.map((f) => [f.key, f])),
    bySlug: new Map(fields.map((f) => [f.slug, f])),
  };
};

/**
 * Knack stores Rails time zone names ("Eastern Time (US & Canada)"). Browsers
 * and Intl want IANA names. This covers the zones a US clinic will use; an
 * unknown zone falls back to UTC and is reported by the sync script.
 */
const RAILS_TO_IANA: Record<string, string> = {
  'Eastern Time (US & Canada)': 'America/New_York',
  'Central Time (US & Canada)': 'America/Chicago',
  'Mountain Time (US & Canada)': 'America/Denver',
  Arizona: 'America/Phoenix',
  'Pacific Time (US & Canada)': 'America/Los_Angeles',
  Alaska: 'America/Anchorage',
  Hawaii: 'Pacific/Honolulu',
  'Atlantic Time (Canada)': 'America/Halifax',
  Newfoundland: 'America/St_Johns',
  'Puerto Rico': 'America/Puerto_Rico',
  'Indiana (East)': 'America/Indiana/Indianapolis',
  London: 'Europe/London',
  Dublin: 'Europe/Dublin',
  UTC: 'UTC',
};

export const ianaZone = (rails: string | undefined): string | null =>
  rails ? (RAILS_TO_IANA[rails] ?? (rails.includes('/') ? rails : null)) : null;

/**
 * Slugs pinned to Knack keys: `{object_N: {slug, fields: {field_N: slug}}}`.
 *
 * A slug is derived from the Knack name the first time a key is seen and then
 * kept, so renaming a field or table in Knack doesn't change the name the
 * screens (and saved layouts, and links) use. The lock travels in the
 * snapshot and is carried forward on every sync.
 */
export type SlugLock = Record<string, { slug: string; fields: Record<string, string> }>;

export const lockOf = (model: AppModel): SlugLock =>
  Object.fromEntries(
    model.entities.map((e) => [e.objectKey, { slug: e.slug, fields: Object.fromEntries(e.fields.map((f) => [f.key, f.slug])) }]),
  );

export const buildModel = (snapshot: AppSnapshot): AppModel => {
  const lock = snapshot.slugs ?? {};
  const usedSlugs = new Set<string>();
  const entitySlugs = new Map<string, string>();
  for (const o of snapshot.objects) {
    const locked = lock[o.key]?.slug;
    if (locked && !usedSlugs.has(locked)) {
      entitySlugs.set(o.key, locked);
      usedSlugs.add(locked);
    }
  }
  for (const o of snapshot.objects) {
    if (entitySlugs.has(o.key)) continue;
    let slug = toEntitySlug(o.name);
    if (usedSlugs.has(slug)) slug = `${slug}-${o.key.replace('object_', '')}`;
    entitySlugs.set(o.key, slug);
    usedSlugs.add(slug);
  }
  const entities = snapshot.objects.map((o) => buildEntity(o, entitySlugs.get(o.key)!, lock[o.key]));
  const accounts = entities.find((e) => e.profileKey === 'all_users');
  if (!accounts) throw new Error('The Knack app has no Accounts object (profile all_users).');

  return {
    appId: snapshot.id,
    appName: snapshot.name,
    timezone: ianaZone(snapshot.settings.timezone) ?? 'UTC',
    entities,
    byObject: new Map(entities.map((e) => [e.objectKey, e])),
    bySlug: new Map(entities.map((e) => [e.slug, e])),
    byProfile: new Map(entities.filter((e) => e.profileKey).map((e) => [e.profileKey!, e])),
    accounts,
  };
};

/** The email field of a user-role object: the link between it and Accounts. */
export const emailField = (entity: EntityModel): FieldModel | undefined =>
  entity.fields.find((f) => f.kind === 'email' && f.name === 'Email') ??
  entity.fields.find((f) => f.kind === 'email');

export const nameField = (entity: EntityModel): FieldModel | undefined =>
  entity.fields.find((f) => f.kind === 'name' && f.name === 'Name') ??
  entity.fields.find((f) => f.kind === 'name');

export const statusField = (entity: EntityModel): FieldModel | undefined =>
  entity.fields.find((f) => f.name === 'User Status' && f.kind === 'choice');
