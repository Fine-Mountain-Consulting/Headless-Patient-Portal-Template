/**
 * Enforcement. This file is the permission system at runtime.
 *
 * Every Knack call goes through the master API key, which bypasses Knack's
 * own roles and record rules, so what this file decides is the only thing
 * protecting the data. The decisions themselves come from derive.ts, which
 * reads them out of the customer's Knack pages; this file applies them.
 *
 *  1. Scope is applied on the server, always, as a top-level AND. A filter the
 *     browser sends narrows results; it can never widen them.
 *  2. Knack silently IGNORES nested filter groups (verified: a nested and/or
 *     returned 23 rows where 3 were correct). Every filter built here is flat.
 *  3. get/update/delete re-check the stored record against the grants. Hiding
 *     a record from a list is not enough.
 *  4. "Not found" and "not yours" are the same answer.
 *  5. Unknown roles contribute nothing. No grant means no access.
 */
import type { KnackClient, FilterRule } from '../knack/client.js';
import { connectionIds, type KnackRecord } from '../knack/values.js';
import type { AppModel, EntityModel } from '../model/model.js';
import { ANY_ROLE, grantKey, type Action, type Condition, type DerivedPolicy, type FormRule, type Grant } from './derive.js';

export interface Caller {
  /** The Accounts record id. */
  accountId: string;
  email: string;
  name: string;
  /** Knack profile keys the caller holds (all_users included). */
  profiles: string[];
  /** The caller's own record id in each user-role object they belong to. */
  records: Record<string, string>;
}

export interface ResolvedAccess {
  grants: Grant[];
  fields: Set<string>;
  admin: boolean;
}

export class AccessDenied extends Error {
  constructor(readonly status: 403 | 404 | 400 = 404, message = 'Not found.') {
    super(message);
  }
}

const MAX_PARENT_DEPTH = 3;

export class Policy {
  constructor(
    readonly model: AppModel,
    readonly derived: DerivedPolicy,
  ) {}

  /** The caller's role policies: their profiles plus the any-signed-in-user grants. */
  private rolesOf(caller: Caller) {
    const keys = [...caller.profiles, ANY_ROLE];
    return keys.map((k) => this.derived.roles.get(k)).filter((r) => r !== undefined);
  }

  isAdmin(caller: Caller): boolean {
    return this.rolesOf(caller).some((r) => r.admin);
  }

  /** Grants and field allowlist for one action on one object (union over roles). */
  resolve(caller: Caller, objectKey: string, action: Action): ResolvedAccess {
    const grants: Grant[] = [];
    const fields = new Set<string>();
    let admin = false;
    for (const role of this.rolesOf(caller)) {
      const access = role.entities.get(objectKey);
      if (!access) continue;
      if (role.admin) admin = true;
      for (const g of access.grants[action]) {
        if (!grants.some((x) => JSON.stringify(x) === JSON.stringify(g))) grants.push(g);
      }
      const source =
        action === 'create' ? access.createFields : action === 'update' ? access.updateFields : access.readFields;
      for (const k of source) fields.add(k);
    }
    // An unconditional grant swallows the rest.
    if (grants.some((g) => g.length === 0)) return { grants: [[]], fields, admin };
    return { grants, fields, admin };
  }

  can(caller: Caller, objectKey: string, action: Action): boolean {
    return this.resolve(caller, objectKey, action).grants.length > 0;
  }

  /** Readable fields, for building DTOs. */
  readFields(caller: Caller, objectKey: string): Set<string> {
    return this.resolve(caller, objectKey, 'read').fields;
  }

  // ── Record checks ────────────────────────────────────────────────────────

  /**
   * Does `record` satisfy at least one grant for `action`?
   * `visited` stops parent chains from looping and bounds Knack calls.
   */
  async allows(
    caller: Caller,
    entity: EntityModel,
    record: KnackRecord,
    action: Action,
    knack: KnackClient,
    depth = 0,
  ): Promise<boolean> {
    const { grants } = this.resolve(caller, entity.objectKey, action);
    for (const grant of grants) {
      if (await this.satisfies(caller, entity, record, grant, knack, depth, action)) return true;
    }
    return false;
  }

  private async satisfies(
    caller: Caller,
    entity: EntityModel,
    record: KnackRecord,
    grant: Grant,
    knack: KnackClient,
    depth: number,
    action: Action,
  ): Promise<boolean> {
    for (const cond of grant) {
      if (!(await this.holds(caller, entity, record, cond, knack, depth, action))) return false;
    }
    return true;
  }

  private async holds(
    caller: Caller,
    entity: EntityModel,
    record: KnackRecord,
    cond: Condition,
    knack: KnackClient,
    depth: number,
    action: Action,
  ): Promise<boolean> {
    switch (cond.type) {
      case 'user': {
        const mine = caller.records[cond.userObject];
        return Boolean(mine) && connectionIds(record, cond.field).includes(mine!);
      }
      case 'self':
        return caller.records[entity.objectKey] === record.id;
      case 'readable':
        // The page-record grant: allowed on anything the caller can read some
        // other way. Never satisfied by itself when checking reads.
        if (action === 'read') return false;
        return this.allowsWithout(caller, entity, record, knack, depth);
      case 'parent': {
        if (depth >= MAX_PARENT_DEPTH) return false;
        const parent = this.model.byObject.get(cond.parentObject);
        if (!parent) return false;
        for (const id of connectionIds(record, cond.field)) {
          if (await this.canRead(caller, parent, id, knack, depth + 1)) return true;
        }
        return false;
      }
      case 'match':
        return matches(record, cond);
    }
  }

  /** Read check that ignores `readable` grants (used to resolve them). */
  private async allowsWithout(
    caller: Caller,
    entity: EntityModel,
    record: KnackRecord,
    knack: KnackClient,
    depth: number,
  ): Promise<boolean> {
    const { grants } = this.resolve(caller, entity.objectKey, 'read');
    for (const grant of grants) {
      if (grant.some((c) => c.type === 'readable')) continue;
      if (await this.satisfies(caller, entity, record, grant, knack, depth, 'read')) return true;
    }
    return false;
  }

  /** Fetch a record by id and check read access. */
  async canRead(caller: Caller, entity: EntityModel, id: string, knack: KnackClient, depth = 0): Promise<boolean> {
    const { grants } = this.resolve(caller, entity.objectKey, 'read');
    if (!grants.length) return false;
    if (grants.some((g) => g.length === 0)) return true;
    if (grants.every((g) => g.every((c) => c.type === 'self'))) return caller.records[entity.objectKey] === id;
    const record = await knack.get(entity.objectKey, id);
    return record ? this.allows(caller, entity, record, 'read', knack, depth) : false;
  }

  // ── List scoping ─────────────────────────────────────────────────────────

  /**
   * Turn the caller's read grants into a flat Knack filter for a list.
   *
   * `parent` is the context a child list is shown in ("this patient's test
   * results"): which connection field, and which record. When given, a grant
   * that needs that parent is used, and the parent itself is checked.
   *
   * Returns:
   *  - { kind: 'filter', match, rules } — AND these (or OR, if match is 'or'
   *    and there are no client filters) with the client's filters;
   *  - { kind: 'self' } — the list is just the caller's own record;
   *  - throws AccessDenied when no grant applies.
   */
  async listScope(
    caller: Caller,
    entity: EntityModel,
    parent: { field: string; id: string } | null,
    knack: KnackClient,
  ): Promise<ListScope> {
    const { grants } = this.resolve(caller, entity.objectKey, 'read');
    const listable = grants.filter((g) => !g.some((c) => c.type === 'readable'));
    if (!listable.length) throw new AccessDenied(403, 'You do not have access to this list.');

    const parentRule = (p: { field: string; id: string }): FilterRule => ({ field: p.field, operator: 'is', value: p.id });

    if (listable.some((g) => g.length === 0)) {
      if (parent) {
        this.assertConnection(entity, parent.field);
        return { kind: 'filter', match: 'and', rules: [parentRule(parent)] };
      }
      return { kind: 'filter', match: 'and', rules: [] };
    }

    if (parent) {
      this.assertConnection(entity, parent.field);
      const fieldModel = entity.byKey.get(parent.field)!;
      const parentEntity = this.model.byObject.get(fieldModel.targetObject!)!;
      // Grants this parent context can satisfy: its parent condition is on this
      // field, or it has no parent condition at all.
      for (const grant of listable) {
        const parentConds = grant.filter((c) => c.type === 'parent');
        if (parentConds.some((c) => c.type === 'parent' && c.field !== parent.field)) continue;
        if (parentConds.length && !(await this.canRead(caller, parentEntity, parent.id, knack))) continue;
        const rules = this.flatRules(caller, grant);
        if (!rules) continue;
        return { kind: 'filter', match: 'and', rules: [parentRule(parent), ...rules] };
      }
      throw new AccessDenied(404);
    }

    // No parent context: only grants without parent conditions apply.
    const topLevel = listable.filter((g) => !g.some((c) => c.type === 'parent'));
    if (!topLevel.length) {
      throw new AccessDenied(400, 'This list is only available within a parent record.');
    }
    if (topLevel.every((g) => g.length === 1 && g[0]!.type === 'self')) return { kind: 'self' };

    const candidates = topLevel
      .filter((g) => !g.some((c) => c.type === 'self'))
      .map((g) => this.flatRules(caller, g))
      .filter((r): r is FilterRule[] => r !== null);
    if (!candidates.length) throw new AccessDenied(403, 'You do not have access to this list.');
    if (candidates.length === 1) return { kind: 'filter', match: 'and', rules: candidates[0]! };

    // Several grants: a flat OR is only possible when each is a single rule.
    if (candidates.every((r) => r.length === 1)) {
      return { kind: 'filter', match: 'or', rules: candidates.map((r) => r[0]!) };
    }
    return { kind: 'filter', match: 'and', rules: candidates[0]! };
  }

  /** A grant as flat filter rules, or null if the caller can't satisfy it. */
  private flatRules(caller: Caller, grant: Grant): FilterRule[] | null {
    const rules: FilterRule[] = [];
    for (const c of grant) {
      if (c.type === 'user') {
        const mine = caller.records[c.userObject];
        if (!mine) return null;
        rules.push({ field: c.field, operator: 'is', value: mine });
      } else if (c.type === 'match') {
        rules.push({ field: c.field, operator: c.operator, value: c.value });
      } else if (c.type === 'parent') {
        // Handled by the caller (needs a parent context).
        continue;
      } else {
        return null;
      }
    }
    return rules;
  }

  private assertConnection(entity: EntityModel, fieldKey: string): void {
    const f = entity.byKey.get(fieldKey);
    if (!f || f.kind !== 'connection' || !f.targetObject) {
      throw new AccessDenied(400, 'Unknown parent connection.');
    }
  }

  // ── Create scoping ───────────────────────────────────────────────────────

  /**
   * Pick the create grant that applies and return the connection values the
   * server must force onto the new record.
   *
   * A "connected to the logged-in user" form gets the caller's record written
   * into that connection, whatever the client sent. A form on a parent page
   * needs the parent the client named, and the caller must be able to read it.
   */
  async createScope(
    caller: Caller,
    entity: EntityModel,
    requested: Record<string, string[]>,
    knack: KnackClient,
  ): Promise<{ forced: Record<string, string[]>; rules: FormRule[] }> {
    const { grants } = this.resolve(caller, entity.objectKey, 'create');
    if (!grants.length) throw new AccessDenied(403, 'You cannot create these records.');

    grantLoop: for (const grant of grants) {
      const forced: Record<string, string[]> = {};
      for (const c of grant) {
        if (c.type === 'user') {
          const mine = caller.records[c.userObject];
          if (!mine) continue grantLoop;
          forced[c.field] = [mine];
        } else if (c.type === 'parent') {
          const ids = requested[c.field] ?? [];
          if (ids.length !== 1) continue grantLoop;
          const parent = this.model.byObject.get(c.parentObject);
          if (!parent || !(await this.canRead(caller, parent, ids[0]!, knack))) continue grantLoop;
          forced[c.field] = ids;
        } else if (c.type === 'match') {
          if (c.operator === 'is') forced[c.field] = [String(c.value)];
          else continue grantLoop;
        } else {
          continue grantLoop;
        }
      }
      return { forced, rules: this.rulesFor(caller, entity, 'create', grant) };
    }
    throw new AccessDenied(403, 'You cannot create this record here.');
  }

  /** Form rules attached to a grant, across the caller's roles. */
  rulesFor(caller: Caller, entity: EntityModel, action: 'create' | 'update', grant: Grant): FormRule[] {
    const key = grantKey(grant);
    const out: FormRule[] = [];
    for (const role of this.rolesOf(caller)) {
      const rules = role.entities.get(entity.objectKey)?.rules[action].get(key) ?? [];
      for (const r of rules) if (!out.some((x) => JSON.stringify(x) === JSON.stringify(r))) out.push(r);
    }
    return out;
  }

  /** The update grant a stored record satisfies, and that grant's form rules. */
  async updateRules(caller: Caller, entity: EntityModel, record: KnackRecord, knack: KnackClient): Promise<FormRule[]> {
    const { grants } = this.resolve(caller, entity.objectKey, 'update');
    for (const grant of grants) {
      if (await this.satisfies(caller, entity, record, grant, knack, 0, 'update')) {
        return this.rulesFor(caller, entity, 'update', grant);
      }
    }
    return [];
  }
}

export type ListScope =
  | { kind: 'filter'; match: 'and' | 'or'; rules: FilterRule[] }
  | { kind: 'self' };

/** In-memory evaluation of the few criteria operators we mirror. */
const matches = (record: KnackRecord, cond: Extract<Condition, { type: 'match' }>): boolean => {
  const raw = record[`${cond.field}_raw`] ?? record[cond.field];
  const values: string[] = Array.isArray(raw)
    ? raw.map((v) => (v && typeof v === 'object' ? String((v as { id?: unknown }).id ?? '') : String(v)))
    : raw === null || raw === undefined
      ? []
      : [typeof raw === 'object' ? JSON.stringify(raw) : String(raw)];
  const want = Array.isArray(cond.value) ? cond.value.map(String) : [String(cond.value ?? '')];
  const blank = values.length === 0 || values.every((v) => v === '');
  switch (cond.operator) {
    case 'is':
      return want.some((w) => values.includes(w));
    case 'is not':
      return !want.some((w) => values.includes(w));
    case 'contains':
      return want.some((w) => values.some((v) => v.toLowerCase().includes(w.toLowerCase())));
    case 'does not contain':
      return !want.some((w) => values.some((v) => v.toLowerCase().includes(w.toLowerCase())));
    case 'is blank':
      return blank;
    case 'is not blank':
      return !blank;
    default:
      return false;
  }
};
