/**
 * Derive the access policy from the Knack app's own pages.
 *
 * The customer already decided who sees what when they built their Knack
 * pages: which roles may log in to each page, which tables show "records
 * connected to the logged-in user", which forms and delete links each role is
 * given, and which fields each page displays. This module reads those
 * decisions out of the page tree and turns them into a policy the server
 * enforces. Nothing here is invented: if no page grants it, it is denied.
 *
 * The one addition is the "Headless Admin" role, which has no Knack pages and
 * is granted everything (see ADMIN_ROLE_NAME).
 *
 * Rules, in Knack's terms:
 *
 *  - Page roles come from the nearest login view up the page tree. A login
 *    view with "limit access to specific roles" grants those roles; one
 *    without grants every logged-in user.
 *  - A page with no login view above it is public. Public pages grant
 *    NOTHING: this app has no anonymous data access, by design.
 *  - A page whose parent no longer exists (an orphan) grants nothing.
 *  - View source "connected to the logged-in user" / criteria operator
 *    "user"  -> the record's connection must contain the caller's record.
 *  - View source connected to the page's record (a child table on a details
 *    page)  -> the record's connection must point at a parent record the
 *    caller can read.
 *  - A details view or edit form for the page's own record  -> any record of
 *    that object the caller can otherwise read.
 *  - Tables/lists/details/calendars/searches grant read; forms grant create or
 *    update; a delete link in a table grants delete on the rows it shows.
 *  - Readable fields are the fields the role's pages display; writable fields
 *    are the inputs on the role's forms.
 */
import type { AppSnapshot, LoaderScene, LoaderView } from '../knack/loader.js';
import type { AppModel } from '../model/model.js';

export const ADMIN_ROLE_NAME = 'Headless Admin';
/** Grants that apply to every signed-in role. */
export const ANY_ROLE = '*';

export type Action = 'read' | 'create' | 'update' | 'delete';
export const ACTIONS: Action[] = ['read', 'create', 'update', 'delete'];

export type Condition =
  /** record[field] contains the caller's own record in `userObject`. */
  | { type: 'user'; field: string; userObject: string }
  /** The record is the caller's own record (a user-role object). */
  | { type: 'self' }
  /** record[field] contains a record of `parentObject` the caller can read. */
  | { type: 'parent'; field: string; parentObject: string }
  /** Any record the caller can otherwise read (details/edit of the page record). */
  | { type: 'readable' }
  /** A fixed filter from the page's criteria. */
  | { type: 'match'; field: string; operator: string; value: unknown };

/** All conditions must hold. An empty grant is unconditional. */
export type Grant = Condition[];

/**
 * A value a Knack form sets on submit ("record rules" in the Builder), which
 * the server applies the same way.
 */
export type FormRule =
  /** Set `field` to the signed-in user's record in the field's target object. */
  | { type: 'user'; field: string; userObject: string }
  /** Set `field` to a fixed value. */
  | { type: 'value'; field: string; value: unknown }
  /** Copy `sourceField` from the record(s) `via` points at into `field`. */
  | { type: 'copy'; field: string; via: string; sourceField: string };

export interface EntityAccess {
  grants: Record<Action, Grant[]>;
  /** Form rules per create/update grant, keyed by grantKey(grant). */
  rules: { create: Map<string, FormRule[]>; update: Map<string, FormRule[]> };
  readFields: Set<string>;
  createFields: Set<string>;
  updateFields: Set<string>;
  /** Knack view keys that contributed, for the access report. */
  sources: Set<string>;
}

export interface RolePolicy {
  profileKey: string;
  roleName: string;
  admin: boolean;
  entities: Map<string, EntityAccess>;
}

export interface DerivedPolicy {
  roles: Map<string, RolePolicy>;
  warnings: string[];
}

const READ_VIEWS = new Set(['table', 'list', 'details', 'calendar', 'search', 'map', 'gallery']);
/** Operators we can both send to Knack and evaluate in memory on a single record. */
const MATCH_OPERATORS = new Set(['is', 'is not', 'contains', 'does not contain', 'is blank', 'is not blank']);

const emptyAccess = (): EntityAccess => ({
  grants: { read: [], create: [], update: [], delete: [] },
  rules: { create: new Map(), update: new Map() },
  readFields: new Set(),
  createFields: new Set(),
  updateFields: new Set(),
  sources: new Set(),
});

export const grantKey = (g: Grant): string => JSON.stringify(g);

/** Field keys a view displays or collects, ignoring its data source and rules. */
export const viewFieldKeys = (view: LoaderView): Set<string> => {
  const keys = new Set<string>();
  const walk = (node: unknown, parentKey: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, parentKey);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const field = obj.field as { key?: unknown } | undefined;
    if (field && typeof field.key === 'string' && /^field_\d+$/.test(field.key)) keys.add(field.key);
    if (obj.type === 'field' && typeof obj.key === 'string' && /^field_\d+$/.test(obj.key)) keys.add(obj.key);
    if (/_field$/.test(parentKey) && typeof obj.key === 'string' && /^field_\d+$/.test(obj.key)) keys.add(obj.key);
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'source' || k === 'rules' || k === 'filters') continue;
      walk(v, k);
    }
  };
  walk(view, '');
  return keys;
};

const hasDeleteLink = (view: LoaderView): boolean => {
  const columns = (view.columns ?? []) as Array<Record<string, unknown>>;
  return columns.some((c) => c.type === 'delete' || c.link_type === 'delete');
};

interface SceneRoles {
  /** Profile keys, or [ANY_ROLE]. Empty means the page grants nothing. */
  roles: string[];
  reason?: 'public' | 'orphan';
}

const sceneRoles = (scene: LoaderScene, bySlug: Map<string, LoaderScene>): SceneRoles => {
  const seen = new Set<string>();
  let current: LoaderScene | undefined = scene;
  while (current) {
    if (seen.has(current.key)) return { roles: [], reason: 'orphan' };
    seen.add(current.key);

    const login = current.views.find((v) => v.type === 'login');
    if (login) {
      return login.limit_profile_access
        ? { roles: [...(login.allowed_profiles ?? [])] }
        : { roles: [ANY_ROLE] };
    }
    if (current.limit_profile_access && current.authentication_profiles?.length) {
      return { roles: [...current.authentication_profiles] };
    }
    if (!current.parent) {
      return current.authenticated ? { roles: [ANY_ROLE] } : { roles: [], reason: 'public' };
    }
    const parent = bySlug.get(current.parent);
    if (!parent) return { roles: [], reason: 'orphan' };
    current = parent;
  }
  return { roles: [], reason: 'public' };
};

/** Conditions from a view's source. `null` means: cannot be mirrored safely, grant nothing. */
const sourceGrants = (
  view: LoaderView,
  scene: LoaderScene,
  model: AppModel,
  warn: (msg: string) => void,
): Grant[] | null => {
  const src = view.source ?? {};
  const objectKey = src.object!;
  const entity = model.byObject.get(objectKey);
  const base: Condition[] = [];
  const where = `${scene.slug}/${view.key}`;

  if (src.connection_key) {
    const conn = model.byObject.get(objectKey)?.byKey.get(src.connection_key);
    const relationship = src.relationship_type ?? 'foreign';
    if (relationship !== 'foreign') {
      // "local": the parent record's own connection lists the rows. Not yet
      // mirrored; denying is the safe default.
      warn(`${where}: "${relationship}" connections are not supported yet; this view grants nothing.`);
      return null;
    }
    if (!conn || conn.kind !== 'connection' || !conn.targetObject) {
      warn(`${where}: connection ${src.connection_key} not found on ${objectKey}; this view grants nothing.`);
      return null;
    }
    if (src.authenticated_user) {
      base.push({ type: 'user', field: conn.key, userObject: conn.targetObject });
    } else {
      base.push({ type: 'parent', field: conn.key, parentObject: conn.targetObject });
    }
  } else if (src.authenticated_user) {
    if (!entity?.isUser) {
      warn(`${where}: "logged-in user" source on a non-user object; this view grants nothing.`);
      return null;
    }
    base.push({ type: 'self' });
  } else if (src.parent_source?.connection || src.parent_source?.field) {
    warn(`${where}: parent_source views are not supported yet; this view grants nothing.`);
    return null;
  } else if (
    scene.object &&
    scene.object === objectKey &&
    (view.type === 'details' || (view.type === 'form' && view.action === 'update'))
  ) {
    // The page's own record: details of, or edit form for, the record clicked.
    base.push({ type: 'readable' });
  }

  // Criteria: top-level rules (match all/any) and groups (OR of AND-groups).
  const crit = src.criteria ?? {};
  const toCondition = (rule: { field?: string; operator?: string; value?: unknown }): Condition | null | 'skip' => {
    if (!rule.field || !rule.operator) return 'skip';
    if (rule.operator === 'user') {
      const f = entity?.byKey.get(rule.field);
      if (!f?.targetObject) return null;
      return { type: 'user', field: rule.field, userObject: f.targetObject };
    }
    if (!MATCH_OPERATORS.has(rule.operator)) return null;
    return { type: 'match', field: rule.field, operator: rule.operator, value: rule.value };
  };

  const ruleConds: Condition[] = [];
  const rules = crit.rules ?? [];
  if (rules.length) {
    if (crit.match === 'any' && rules.length > 1) {
      warn(`${where}: "any" criteria rules are not supported yet; this view grants nothing.`);
      return null;
    }
    for (const rule of rules) {
      const c = toCondition(rule);
      if (c === 'skip') continue;
      if (c === null) {
        warn(`${where}: criteria operator "${rule.operator}" cannot be mirrored; this view grants nothing.`);
        return null;
      }
      ruleConds.push(c);
    }
  }

  const groups = (crit.groups ?? []).filter((g) => Array.isArray(g) && g.length);
  if (groups.length === 0) return [[...base, ...ruleConds]];

  const grants: Grant[] = [];
  for (const group of groups) {
    const conds: Condition[] = [];
    for (const rule of group) {
      const c = toCondition(rule);
      if (c === 'skip') continue;
      if (c === null) {
        warn(`${where}: criteria operator "${rule.operator}" cannot be mirrored; this view grants nothing.`);
        return null;
      }
      conds.push(c);
    }
    grants.push([...base, ...ruleConds, ...conds]);
  }
  return grants;
};

/** Record rules on a form: the values Knack sets when it is submitted. */
const formRules = (view: LoaderView, scene: LoaderScene, model: AppModel, warn: (msg: string) => void): FormRule[] => {
  const entity = model.byObject.get(view.source?.object ?? '');
  const records = ((view.rules as { records?: unknown[] } | undefined)?.records ?? []) as Array<{
    action?: string;
    criteria?: unknown[];
    values?: Array<{ type?: string; field?: string; value?: unknown; connection_field?: string }>;
  }>;
  const out: FormRule[] = [];
  for (const rule of records) {
    const where = `${scene.slug}/${view.key}`;
    if (rule.action !== 'record') {
      warn(`${where}: form rule "${rule.action}" (changes other records) is not mirrored yet.`);
      continue;
    }
    if (rule.criteria?.length) {
      warn(`${where}: conditional form rules are not mirrored yet; that rule is skipped.`);
      continue;
    }
    for (const v of rule.values ?? []) {
      const field = v.field ? entity?.byKey.get(v.field) : undefined;
      if (!field) continue;
      if (v.type === 'user' && field.kind === 'connection' && field.targetObject) {
        out.push({ type: 'user', field: field.key, userObject: field.targetObject });
      } else if (v.type === 'value') {
        out.push({ type: 'value', field: field.key, value: v.value });
      } else if (v.type === 'connection' && v.connection_field) {
        const [via, sourceField] = v.connection_field.split('-');
        if (via && sourceField) out.push({ type: 'copy', field: field.key, via, sourceField });
      } else {
        warn(`${where}: form rule value type "${v.type}" is not mirrored yet.`);
      }
    }
  }
  return out;
};

const addRules = (map: Map<string, FormRule[]>, grant: Grant, rules: FormRule[]): void => {
  const key = grantKey(grant);
  const list = map.get(key) ?? [];
  for (const r of rules) if (!list.some((x) => JSON.stringify(x) === JSON.stringify(r))) list.push(r);
  map.set(key, list);
};

const addGrant = (list: Grant[], grant: Grant): void => {
  const key = grantKey(grant);
  if (!list.some((g) => grantKey(g) === key)) list.push(grant);
};

export const derivePolicy = (snapshot: AppSnapshot, model: AppModel): DerivedPolicy => {
  const warnings: string[] = [];
  const warn = (msg: string) => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };

  const bySlug = new Map(snapshot.scenes.map((s) => [s.slug, s]));
  const roles = new Map<string, RolePolicy>();

  const roleFor = (profileKey: string): RolePolicy => {
    let role = roles.get(profileKey);
    if (!role) {
      const entity = model.byProfile.get(profileKey);
      role = {
        profileKey,
        roleName: profileKey === ANY_ROLE ? 'Any signed-in user' : (entity?.name ?? profileKey),
        admin: false,
        entities: new Map(),
      };
      roles.set(profileKey, role);
    }
    return role;
  };

  // Every known role gets an entry, even one with no pages, so it is visible
  // in the report as "no access" rather than missing.
  for (const entity of model.entities) if (entity.profileKey) roleFor(entity.profileKey);

  for (const scene of snapshot.scenes) {
    const dataViews = scene.views.filter((v) => v.source?.object && v.type !== 'login');
    if (!dataViews.length) continue;

    let { roles: sceneRoleKeys, reason } = sceneRoles(scene, bySlug);

    if (!sceneRoleKeys.length) {
      // A view sourced from "the logged-in user" can only ever work for a
      // signed-in user (Knack's Account Settings page is built this way), so it
      // is mirrored for every signed-in role. Everything else on a public or
      // orphaned page grants nothing.
      const userBound = dataViews.filter((v) => v.source?.authenticated_user);
      if (userBound.length) sceneRoleKeys = [ANY_ROLE];
      const label = reason === 'orphan' ? 'is orphaned (its parent page no longer exists)' : 'is public';
      warn(
        `Page "${scene.name}" (${scene.slug}) ${label}. ` +
          (userBound.length
            ? 'Only its logged-in-user views are mirrored, for signed-in users.'
            : 'It grants nothing in the headless app. Lock it down or delete it in Knack.'),
      );
      if (!userBound.length) continue;
    }

    for (const view of dataViews) {
      // On a public or orphaned page only the logged-in-user views survive.
      if (reason && !view.source?.authenticated_user) continue;
      const objectKey = view.source!.object!;
      if (!model.byObject.has(objectKey)) continue;

      const grants = sourceGrants(view, scene, model, warn);
      if (!grants) continue;

      const fields = viewFieldKeys(view);
      const entity = model.byObject.get(objectKey)!;
      const actions: Action[] = [];

      if (view.type === 'form') {
        if (view.action === 'create' || view.action === 'insert') actions.push('create');
        else if (view.action === 'update') actions.push('update');
        else continue;
      } else if (READ_VIEWS.has(view.type)) {
        actions.push('read');
        if (hasDeleteLink(view)) actions.push('delete');
      } else {
        continue;
      }

      for (const profileKey of sceneRoleKeys) {
        const role = roleFor(profileKey);
        let access = role.entities.get(objectKey);
        if (!access) {
          access = emptyAccess();
          role.entities.set(objectKey, access);
        }
        access.sources.add(`${scene.slug}/${view.key}`);
        for (const action of actions) for (const g of grants) addGrant(access.grants[action], g);
        // An edit form shows the record it edits, so whoever may update a
        // record may also read it (with the same conditions).
        if (actions.includes('update')) {
          for (const g of grants) if (!g.some((c) => c.type === 'readable')) addGrant(access.grants.read, g);
        }
        if (view.type === 'form') {
          const rules = formRules(view, scene, model, warn);
          const target = actions.includes('create') ? access.rules.create : access.rules.update;
          for (const g of grants) addRules(target, g, rules);
        }

        if (actions.includes('read')) for (const k of fields) access.readFields.add(k);
        if (actions.includes('create')) for (const k of fields) access.createFields.add(k);
        if (actions.includes('update')) {
          for (const k of fields) {
            access.updateFields.add(k);
            // An edit form shows the current values, so the role can read them.
            access.readFields.add(k);
          }
        }
        if (entity.identifierKey) access.readFields.add(entity.identifierKey);
      }
    }
  }

  // Headless Admin: no Knack pages, full access to everything.
  const adminEntity = model.entities.find((e) => e.isUser && e.name === ADMIN_ROLE_NAME);
  if (!adminEntity?.profileKey) {
    warn(`No "${ADMIN_ROLE_NAME}" role object in the Knack app. Create it so someone can administer the headless app.`);
  } else {
    const admin = roleFor(adminEntity.profileKey);
    admin.admin = true;
    admin.entities.clear();
    for (const entity of model.entities) {
      const access = emptyAccess();
      for (const action of ACTIONS) access.grants[action] = [[]];
      for (const f of entity.fields) {
        if (f.kind === 'password') continue;
        access.readFields.add(f.key);
        if (!f.readOnly) {
          access.createFields.add(f.key);
          access.updateFields.add(f.key);
        }
      }
      access.sources.add('headless-admin');
      admin.entities.set(entity.objectKey, access);
    }
  }

  // Simplify: an unconditional grant makes every other grant for that action redundant.
  for (const role of roles.values()) {
    for (const [objectKey, access] of role.entities) {
      for (const action of ACTIONS) {
        if (access.grants[action].some((g) => g.length === 0)) {
          if (action === 'create' || action === 'update') {
            // Collapsing to "unconditional" keeps the unconditional form's rules.
            const kept = access.rules[action].get(grantKey([])) ?? [];
            access.rules[action] = new Map([[grantKey([]), kept]]);
          }
          access.grants[action] = [[]];
        }
      }
      // Fields Knack computes or the platform owns are never writable.
      const entity = model.byObject.get(objectKey)!;
      for (const key of [...access.createFields, ...access.updateFields]) {
        const f = entity.byKey.get(key);
        if (!f || f.readOnly) {
          access.createFields.delete(key);
          access.updateFields.delete(key);
        }
      }
    }
  }

  return { roles, warnings };
};
