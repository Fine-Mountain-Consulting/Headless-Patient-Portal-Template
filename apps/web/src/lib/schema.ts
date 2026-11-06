/**
 * What the signed-in user may see and do, as the server derived it from the
 * Knack pages. The UI uses it to decide what to offer; the server enforces it
 * regardless, so nothing here is a security boundary.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

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

export interface FieldInfo {
  slug: string;
  name: string;
  kind: FieldKind;
  required: boolean;
  readOnly: boolean;
  options?: string[];
  multiple?: boolean;
  /** Entity slug a connection points at. */
  target?: string;
}

export interface EntityInfo {
  slug: string;
  name: string;
  isUser: boolean;
  identifier?: string;
  can: { read: boolean; create: boolean; update: boolean; delete: boolean };
  listable: boolean;
  parents: string[];
  readFields: string[];
  createFields: string[];
  updateFields: string[];
  forcedOnCreate: string[];
  fields: FieldInfo[];
}

export interface Schema {
  appName: string;
  timezone: string;
  entities: EntityInfo[];
}

export const useSchema = () =>
  useQuery({
    queryKey: ['schema'],
    queryFn: () => api<Schema>('/schema'),
    staleTime: Infinity,
  });

export const entityOf = (schema: Schema | undefined, slug: string): EntityInfo | undefined =>
  schema?.entities.find((e) => e.slug === slug);

export const fieldOf = (entity: EntityInfo | undefined, slug: string): FieldInfo | undefined =>
  entity?.fields.find((f) => f.slug === slug);

/** System fields Knack maintains. Hidden from generic tables and forms. */
const SYSTEM = new Set(['Record ID', 'Created On', 'Updated On', 'Created By', 'Updated By', 'Owned By']);
export const isSystemField = (f: FieldInfo): boolean => SYSTEM.has(f.name);

/** The connection field on `entity` that points at `parentSlug`, if listable under it. */
export const parentFieldFor = (entity: EntityInfo, parentSlug: string): FieldInfo | undefined =>
  entity.fields.find((f) => f.kind === 'connection' && f.target === parentSlug && entity.parents.includes(f.slug));
