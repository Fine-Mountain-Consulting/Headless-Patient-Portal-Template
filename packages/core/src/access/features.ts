/**
 * Portal features: abilities this portal adds that the stock Knack template
 * has no page for (patients booking online, doctors keeping their own hours).
 *
 * Everything else comes from the customer's Knack pages (derive.ts). A
 * feature is the one other source of access, and it is deliberately narrow:
 *
 *  - Each feature is defined in the template manifest, by Knack table and
 *    field NAME, so it works on any copy of the template.
 *  - Every grant is scoped to the signed-in user's own records ("own"): a
 *    feature can never open up other people's data.
 *  - Every feature is OFF until a Headless Admin switches it on. Who switched
 *    it on, and when, is stored and shown in the Access map, and the switch is
 *    written to the activity log.
 *  - A feature whose tables or fields are missing from the Knack app can't be
 *    switched on, and stops applying if they disappear.
 *
 * Grants are added on top of the derived policy, with the source
 * `feature:<id>`, so the Access map shows exactly where they came from.
 */
import type { TemplateManifest } from '../knack/loader.js';
import type { AppModel, EntityModel } from '../model/model.js';
import { grantKey, type Action, type DerivedPolicy, type EntityAccess, type FormRule, type Grant } from './derive.js';

export interface FeatureGrantSpec {
  /** Template role key ("patient", "doctor"), resolved through manifest.roles. */
  role: string;
  /** Knack table name. */
  entity: string;
  actions: Action[];
  /**
   * Whose records: "self" (the role's own record, for its own table) or the
   * name of a connection field that must point at the signed-in user.
   */
  own: string;
  /** Field names: shown for read, inputs for create/update. */
  fields: string[];
  /** Values set on create (form record rules), by field name. */
  set?: Record<string, unknown>;
}

export interface FeatureSpec {
  title: string;
  description: string;
  grants: FeatureGrantSpec[];
}

export interface FeatureState {
  on: boolean;
  /** Who last switched it, and when. */
  by?: string;
  at?: string;
}

export type FeatureStates = Record<string, FeatureState>;

export interface FeatureStore {
  load(): Promise<FeatureStates>;
  save(states: FeatureStates): Promise<void>;
}

/** Development and tests. Every feature starts off. */
export class MemoryFeatureStore implements FeatureStore {
  private states: FeatureStates = {};
  async load(): Promise<FeatureStates> {
    return structuredClone(this.states);
  }
  async save(states: FeatureStates): Promise<void> {
    this.states = structuredClone(states);
  }
}

export interface FeatureReport {
  id: string;
  title: string;
  description: string;
  on: boolean;
  by?: string;
  at?: string;
  /** False when the Knack app lacks something the feature needs. */
  available: boolean;
  problems: string[];
  /** What switching it on grants, in words. */
  grants: string[];
}

interface ResolvedGrant {
  roleEntity: EntityModel;
  entity: EntityModel;
  actions: Action[];
  grant: Grant;
  fields: string[];
  rules: FormRule[];
  describe: string;
}

const ACTION_WORDS: Record<Action, string> = { read: 'see', create: 'add', update: 'edit', delete: 'delete' };

const findEntity = (model: AppModel, name: string): EntityModel | undefined => model.entities.find((e) => e.name === name);

/** Resolve one feature against the Knack app. Problems mean it can't apply. */
const resolveFeature = (model: AppModel, manifest: TemplateManifest, spec: FeatureSpec) => {
  const problems: string[] = [];
  const grants: ResolvedGrant[] = [];
  for (const g of spec.grants) {
    const roleName = manifest.roles[g.role];
    const roleEntity = roleName ? findEntity(model, roleName) : undefined;
    if (!roleEntity?.isUser || !roleEntity.profileKey) {
      problems.push(`No "${roleName ?? g.role}" user role in Knack.`);
      continue;
    }
    const entity = findEntity(model, g.entity);
    if (!entity) {
      problems.push(`No "${g.entity}" table in Knack.`);
      continue;
    }
    let grant: Grant;
    if (g.own === 'self') {
      if (entity.objectKey !== roleEntity.objectKey) {
        problems.push(`"${g.entity}" is not the ${roleEntity.name} table, so it has no "own record".`);
        continue;
      }
      grant = [{ type: 'self' }];
    } else {
      const conn = entity.fields.find((f) => f.name === g.own);
      if (!conn || conn.kind !== 'connection' || conn.targetObject !== roleEntity.objectKey) {
        problems.push(`"${g.entity}" needs a "${g.own}" field connected to ${roleEntity.name}.`);
        continue;
      }
      grant = [{ type: 'user', field: conn.key, userObject: roleEntity.objectKey }];
    }
    if (g.own === 'self' && g.actions.some((a) => a === 'create' || a === 'delete')) {
      problems.push(`A feature can't let ${roleEntity.name} add or delete their own account record.`);
      continue;
    }
    const fields: string[] = [];
    for (const name of g.fields) {
      const f = entity.fields.find((x) => x.name === name);
      if (!f) problems.push(`"${g.entity}" is missing the "${name}" field.`);
      else if (f.kind !== 'password') fields.push(f.key);
    }
    const rules: FormRule[] = [];
    for (const [name, value] of Object.entries(g.set ?? {})) {
      const f = entity.fields.find((x) => x.name === name);
      if (!f) problems.push(`"${g.entity}" is missing the "${name}" field.`);
      else rules.push({ type: 'value', field: f.key, value });
    }
    const whose = g.own === 'self' ? 'their own record' : `where ${g.own} is them`;
    grants.push({
      roleEntity,
      entity,
      actions: g.actions,
      grant,
      fields,
      rules,
      describe: `${roleEntity.name} can ${g.actions.map((a) => ACTION_WORDS[a]).join(', ')} ${entity.name} (${whose})` +
        (g.fields.length ? `: ${g.fields.join(', ')}` : '') +
        (rules.length ? `. Sets ${Object.entries(g.set ?? {}).map(([k, v]) => `${k} = ${String(v)}`).join(', ')}` : '') +
        '.',
    });
  }
  return { problems, grants };
};

const accessFor = (derived: DerivedPolicy, profileKey: string, objectKey: string): EntityAccess | undefined => {
  const role = derived.roles.get(profileKey);
  if (!role || role.admin) return undefined;
  let access = role.entities.get(objectKey);
  if (!access) {
    access = {
      grants: { read: [], create: [], update: [], delete: [] },
      rules: { create: new Map(), update: new Map() },
      readFields: new Set(),
      createFields: new Set(),
      updateFields: new Set(),
      sources: new Set(),
    };
    role.entities.set(objectKey, access);
  }
  return access;
};

/**
 * Add the grants of every feature that is switched on and available to the
 * derived policy (in place). Returns the report for every feature.
 */
export const applyFeatures = (
  derived: DerivedPolicy,
  model: AppModel,
  manifest: TemplateManifest | undefined,
  states: FeatureStates,
): FeatureReport[] => {
  const out: FeatureReport[] = [];
  for (const [id, spec] of Object.entries(manifest?.features ?? {})) {
    if (id.startsWith('$') || !spec || typeof spec !== 'object' || !Array.isArray(spec.grants)) continue;
    const { problems, grants } = resolveFeature(model, manifest!, spec);
    const state = states[id];
    const available = problems.length === 0;
    out.push({
      id,
      title: spec.title,
      description: spec.description,
      on: Boolean(state?.on),
      by: state?.by,
      at: state?.at,
      available,
      problems,
      grants: grants.map((g) => g.describe),
    });
    if (!state?.on || !available) continue;

    for (const g of grants) {
      const access = accessFor(derived, g.roleEntity.profileKey!, g.entity.objectKey);
      if (!access) continue;
      access.sources.add(`feature:${id}`);
      const key = grantKey(g.grant);
      const writable = g.fields.filter((k) => !g.entity.byKey.get(k)?.readOnly);
      for (const action of g.actions) {
        if (!access.grants[action].some((x) => grantKey(x) === key)) access.grants[action].push(g.grant);
        if (action === 'create' || action === 'update') {
          const list = access.rules[action].get(key) ?? [];
          for (const r of g.rules) if (!list.some((x) => JSON.stringify(x) === JSON.stringify(r))) list.push(r);
          access.rules[action].set(key, list);
          for (const k of writable) access[action === 'create' ? 'createFields' : 'updateFields'].add(k);
        }
        // Whatever a role may add, edit or delete it may also see: the same
        // records, the same fields.
        if (action !== 'read' && !access.grants.read.some((x) => grantKey(x) === key)) access.grants.read.push(g.grant);
      }
      for (const k of g.fields) access.readFields.add(k);
      // The connection that makes the record theirs is readable too.
      for (const c of g.grant) if (c.type === 'user') access.readFields.add(c.field);
      if (g.entity.identifierKey) access.readFields.add(g.entity.identifierKey);
    }
  }
  return out;
};
