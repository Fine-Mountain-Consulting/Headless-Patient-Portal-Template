/**
 * Knack's application metadata ("the loader").
 *
 * `https://loader.knack.com/v1/applications/{appId}` is public: it is what the
 * Knack-hosted live app downloads to render itself, so it needs no key. It
 * carries the schema (objects, fields) and the page tree (scenes, views), and
 * the page tree is where the app's access rules are written down. That makes
 * it the single source of truth this server is built from.
 *
 * We keep a reduced snapshot of it: objects, scenes and a few settings. Users,
 * sessions, billing and design are dropped.
 */

import type { FeatureSpec } from '../access/features.js';

export interface LoaderField {
  key: string;
  name: string;
  type: string;
  required?: boolean;
  user?: boolean;
  immutable?: boolean;
  format?: {
    options?: string[];
    type?: string;
    default?: unknown;
    secure?: boolean;
    date_format?: string;
    time_format?: string;
    [key: string]: unknown;
  };
  relationship?: { object?: string; has?: 'one' | 'many'; belongs_to?: 'one' | 'many' };
}

export interface LoaderObject {
  key: string;
  name: string;
  user?: boolean;
  profile_key?: string;
  identifier?: string;
  fields: LoaderField[];
}

export interface LoaderView {
  key: string;
  type: string;
  name?: string;
  title?: string;
  action?: string;
  source?: {
    object?: string;
    connection_key?: string;
    relationship_type?: string;
    authenticated_user?: boolean;
    parent_source?: { connection?: string; field?: string };
    criteria?: {
      match?: string;
      rules?: Array<{ field?: string; operator?: string; value?: unknown }>;
      groups?: Array<Array<{ field?: string; operator?: string; value?: unknown }>>;
    };
  };
  limit_profile_access?: boolean;
  allowed_profiles?: string[];
  [key: string]: unknown;
}

export interface LoaderScene {
  key: string;
  slug: string;
  name: string;
  parent?: string | null;
  object?: string | null;
  authenticated?: boolean;
  authentication_profiles?: string[];
  limit_profile_access?: boolean;
  views: LoaderView[];
}

export interface AppSnapshot {
  id: string;
  name: string;
  slug: string;
  accountSlug: string;
  settings: {
    timezone?: string;
    inactivity_timeout_enabled?: boolean;
    inactivity_timeout?: number | null;
  };
  objects: LoaderObject[];
  scenes: LoaderScene[];
  /** When the snapshot was taken (ISO). */
  takenAt: string;
  /** The template manifest this deployment was synced against. */
  template?: TemplateManifest;
  /** Friendly names pinned to Knack keys (see model.ts SlugLock). */
  slugs?: Record<string, { slug: string; fields: Record<string, string> }>;
}

export interface BookingConfig {
  appointments: string;
  date: string;
  doctor: string;
  patient?: string;
  reason?: string;
  duration?: string;
  status?: string;
  cancelledStatuses?: string[];
  doctors: string;
  specialty?: string;
  availableDays?: string;
  dayStarts?: string;
  dayEnds?: string;
  appointmentLength?: string;
  onlineBooking?: string;
  timeOff?: string;
  timeOffStarts?: string;
  timeOffEnds?: string;
  timeOffDoctor?: string;
}

export interface TemplateManifest {
  template: string;
  roles: Record<string, string>;
  /** Tables and fields the template's screens need. Missing = the screens break. */
  entities: Record<string, string[]>;
  /** Tables and fields the screens use when present (features switch off without them). */
  optional?: Record<string, string[]>;
  booking?: BookingConfig;
  /** Abilities the portal adds, each off until an admin switches it on (access/features.ts). */
  features?: Record<string, FeatureSpec>;
}

/**
 * The commercial loader. A GovCloud tenant may be served from a different
 * loader host; that has not been verified yet, so it is a setting
 * (KNACK_LOADER_URL) rather than a guess baked in here.
 */
export const DEFAULT_LOADER_BASE = 'https://loader.knack.com/v1';

export const loaderUrl = (appId: string, loaderBase = DEFAULT_LOADER_BASE): string =>
  `${loaderBase.replace(/\/+$/, '')}/applications/${appId}`;

/** Fetch the loader and reduce it to a snapshot. Build/sync time only. */
export const fetchSnapshot = async (appId: string, loaderBase?: string): Promise<AppSnapshot> => {
  const response = await fetch(loaderUrl(appId, loaderBase), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`Knack loader answered ${response.status} for app ${appId}.`);
  }
  const body = (await response.json()) as { application?: Record<string, unknown> };
  const app = body.application;
  if (!app || !Array.isArray(app.objects) || !Array.isArray(app.scenes)) {
    throw new Error('Knack loader response had no application objects/scenes.');
  }
  return reduceLoader(app);
};

export const reduceLoader = (app: Record<string, unknown>): AppSnapshot => {
  const settings = (app.settings ?? {}) as Record<string, unknown>;
  const account = (app.account ?? {}) as { slug?: string };
  return {
    id: String(app.id ?? ''),
    name: String(app.name ?? ''),
    slug: String(app.slug ?? ''),
    accountSlug: String(account.slug ?? ''),
    settings: {
      timezone: typeof settings.timezone === 'string' ? settings.timezone : undefined,
      inactivity_timeout_enabled: Boolean(settings.inactivity_timeout_enabled),
      inactivity_timeout:
        typeof settings.inactivity_timeout === 'number' ? settings.inactivity_timeout : null,
    },
    objects: app.objects as LoaderObject[],
    scenes: app.scenes as LoaderScene[],
    takenAt: new Date().toISOString(),
  };
};
