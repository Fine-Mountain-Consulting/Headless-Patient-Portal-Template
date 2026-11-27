/**
 * The HTTP API, written against the web-standard Request/Response so any
 * platform can host it. Adapters only translate their request type into a
 * Request and call `handle`.
 *
 * Every data route has the same shape:
 *   1. who:   the session cookie, verified (nothing else identifies a caller)
 *   2. what:  the entity must exist in the model
 *   3. may:   policy.ts decides, from grants derived from the Knack pages
 *   4. scope: applied on the server, before Knack is touched
 *   5. log:   access and change events to the audit store
 *
 * Only /api/config and /api/session/login answer without a session. There is
 * no anonymous data access.
 */
import { ACTIONS, type Action, type DerivedPolicy } from '../access/derive.js';
import { AccessDenied, Policy, type Caller } from '../access/policy.js';
import { login, LoginError } from '../auth/login.js';
import { readCookie, SESSION_COOKIE, SessionManager, type SessionPayload } from '../auth/session.js';
import type { CoreConfig } from '../config.js';
import { KnackClient, KnackError, type FilterRule } from '../knack/client.js';
import { fetchSnapshot, type AppSnapshot } from '../knack/loader.js';
import { carryForward, checkTemplate, diffSnapshots, type TemplateCheck } from '../model/sync.js';
import {
  connectionIds as connectionIdsOf,
  fileUrl,
  InvalidValue,
  readField,
  toDto,
  toKnackValue,
  toKnackValues,
  type KnackRecord,
} from '../knack/values.js';
import { buildModel, statusField, type AppModel, type EntityModel, type FieldModel } from '../model/model.js';
import { derivePolicy } from '../access/derive.js';
import { BookingError, BookingService } from '../booking/booking.js';
import { HORIZON_DAYS, LEAD_MS } from '../booking/slots.js';
import { UsageCounter, type AuditEvent, type AuditKind, type AuditStore } from '../store/audit.js';

export interface CoreDeps {
  config: CoreConfig;
  snapshot: AppSnapshot;
  audit: AuditStore;
  /** Persist a newer snapshot (Node writes it to disk). Optional. */
  onSnapshot?: (snapshot: AppSnapshot) => Promise<void>;
}

export interface SyncResult {
  changed: boolean;
  changes: string[];
  error?: string;
}

/** Short stable hash (FNV-1a) for the structure version. */
const hash = (text: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ROLE_RECHECK_MS = 2 * 60_000;
const MAX_FILTERS = 10;
const LIST_CACHE_MS = 20_000;
const FILTER_OPERATORS = new Set([
  'is',
  'is not',
  'contains',
  'does not contain',
  'starts with',
  'ends with',
  'is blank',
  'is not blank',
  'is before',
  'is after',
  'is today',
  'is during the current',
  'is during the previous',
  'is during the next',
  'is before the previous',
  'is after the next',
  'higher than',
  'lower than',
]);

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // Responses carry PHI: never cache them anywhere.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });

const errorBody = (message: string, fields?: Record<string, string>) => ({ error: { message, ...(fields ? { fields } : {}) } });

export class HeadlessApp {
  // Swapped together, synchronously, whenever the Knack structure changes.
  model!: AppModel;
  derived!: DerivedPolicy;
  policy!: Policy;
  private booking!: BookingService;
  private snapshot!: AppSnapshot;
  private template: TemplateCheck = { problems: [], missingOptional: [], renamed: [] };
  /** Changes when the structure changes; the browser refetches the schema. */
  private appVersion = '';

  readonly usage = new UsageCounter();
  private readonly knack: KnackClient;
  private readonly sessions: SessionManager;
  private readonly listCache = new Map<string, { at: number; body: unknown }>();

  private sync = {
    lastAttemptAt: 0,
    lastSuccessAt: 0,
    lastError: null as string | null,
    running: null as Promise<SyncResult> | null,
    history: [] as Array<{ at: string; changes: string[] }>,
  };

  constructor(private readonly deps: CoreDeps) {
    const { config, snapshot } = deps;
    if (snapshot.id !== config.knackAppId) {
      throw new Error(
        `The app snapshot is for ${snapshot.id} but KNACK_APP_ID is ${config.knackAppId}. Run "npm run sync" again.`,
      );
    }
    this.knack = new KnackClient(config.knackAppId, config.knackApiKey, config.knackApiHost, (c) => this.usage.record(c));

    // Knack's own inactivity timeout, when the customer set one, wins over
    // ours if it is stricter: same as Knack.
    const knackIdle = snapshot.settings.inactivity_timeout_enabled ? snapshot.settings.inactivity_timeout : null;
    const idleMinutes = knackIdle && knackIdle > 0 ? Math.min(knackIdle, config.sessionIdleMinutes) : config.sessionIdleMinutes;
    this.sessions = new SessionManager(config.sessionSecret, idleMinutes * 60_000, config.sessionMaxHours * 3_600_000);

    this.apply(carryForward(null, snapshot));
    this.sync.lastSuccessAt = Date.parse(snapshot.takenAt) || Date.now();
    this.sync.lastAttemptAt = Date.now();
  }

  /** Build everything from a snapshot and swap it in at once. */
  private apply(snapshot: AppSnapshot): void {
    const model = buildModel(snapshot);
    const derived = derivePolicy(snapshot, model);
    const policy = new Policy(model, derived);
    const booking = new BookingService(model, policy, this.knack, snapshot.template?.booking);
    const template = checkTemplate(model, snapshot.template);
    // No await between these lines: a request sees the old set or the new set, never a mix.
    this.snapshot = snapshot;
    this.model = model;
    this.derived = derived;
    this.policy = policy;
    this.booking = booking;
    this.template = template;
    this.appVersion = `${snapshot.objects.length}.${hash(JSON.stringify([snapshot.objects, snapshot.scenes, snapshot.slugs]))}`;
    this.listCache.clear();
    for (const w of derived.warnings) console.warn(`access: ${w}`);
    for (const p of template.problems) console.warn(`template: ${p}`);
  }

  /**
   * Re-read the Knack app's structure and apply any change. Access rules follow
   * Knack even if the template no longer matches (the admin is told what the
   * screens can't show). If Knack can't be reached, the last good copy stays.
   */
  async refresh(): Promise<SyncResult> {
    if (this.sync.running) return this.sync.running;
    this.sync.lastAttemptAt = Date.now();
    this.sync.running = (async (): Promise<SyncResult> => {
      try {
        const fresh = await fetchSnapshot(this.deps.config.knackAppId, this.deps.config.loaderUrl);
        if (fresh.id !== this.deps.config.knackAppId) throw new Error('Knack returned a different app.');
        const next = carryForward(this.snapshot, fresh);
        const changes = diffSnapshots(this.snapshot, next);
        this.sync.lastSuccessAt = Date.now();
        this.sync.lastError = null;
        if (!changes.length) return { changed: false, changes: [] };
        this.apply(next);
        this.sync.history.unshift({ at: new Date().toISOString(), changes });
        this.sync.history.splice(20);
        console.log(`sync: applied ${changes.length} change(s) from Knack: ${changes.slice(0, 5).join(' ')}`);
        await this.deps.onSnapshot?.(next).catch((e: unknown) => console.warn(`sync: could not persist snapshot (${(e as Error).message})`));
        return { changed: true, changes };
      } catch (error) {
        this.sync.lastError = (error as Error).message;
        console.warn(`sync: kept the last good structure (${this.sync.lastError})`);
        return { changed: false, changes: [], error: this.sync.lastError };
      } finally {
        this.sync.running = null;
      }
    })();
    return this.sync.running;
  }

  /** Kick off a background re-sync when due. Never blocks the request. */
  private maybeRefresh(): void {
    const every = this.deps.config.syncMinutes * 60_000;
    if (!every || this.sync.running || Date.now() - this.sync.lastAttemptAt < every) return;
    void this.refresh();
  }

  syncStatus() {
    return {
      intervalMinutes: this.deps.config.syncMinutes,
      lastSuccessAt: this.sync.lastSuccessAt ? new Date(this.sync.lastSuccessAt).toISOString() : null,
      lastAttemptAt: this.sync.lastAttemptAt ? new Date(this.sync.lastAttemptAt).toISOString() : null,
      lastError: this.sync.lastError,
      structureFrom: this.snapshot.takenAt,
      history: this.sync.history,
      template: this.template,
      accessWarnings: this.derived.warnings,
    };
  }

  /** Entry point for every adapter. */
  async handle(request: Request, clientIp = ''): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    this.maybeRefresh();
    const secure = url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';

    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') this.checkCsrf(request, url);

      if (path === '/api/config' && request.method === 'GET') return this.config();
      if (path === '/api/session/login' && request.method === 'POST') return await this.login(request, clientIp, secure);

      // Everything below needs a session.
      const session = await this.sessions.verify(readCookie(request.headers.get('cookie'), SESSION_COOKIE));
      if (!session) {
        if (path === '/api/session/logout') return json(200, { ok: true }, { 'Set-Cookie': this.sessions.clearCookie(secure) });
        return json(401, errorBody('Your session has ended. Sign in again.'), {
          'Set-Cookie': this.sessions.clearCookie(secure),
        });
      }
      // Roles are fixed at sign-in, but a revoked role or a deactivated account
      // must not survive until the next sign-in. Re-check against Knack every
      // couple of minutes of activity.
      let current: SessionPayload = session;
      let changed = false;
      if (Date.now() - (session.checked ?? session.iat) > ROLE_RECHECK_MS) {
        const rechecked = await this.recheck(session);
        if (!rechecked) {
          await this.log({ caller: session, ip: clientIp, url }, { kind: 'sign-out', reason: 'account no longer active' });
          return json(401, errorBody('Your session has ended. Sign in again.'), { 'Set-Cookie': this.sessions.clearCookie(secure) });
        }
        current = rechecked;
        changed = true;
      }

      const caller: Caller = current;
      const ctx: Ctx = { caller, ip: clientIp, url };

      let response = await this.route(request, path, ctx, current, secure);
      if ((changed || this.sessions.needsRefresh(current)) && path !== '/api/session/logout' && path !== '/api/session/ping') {
        const next = await this.sessions.sign({ ...current, last: Date.now() });
        response = withHeader(response, 'Set-Cookie', this.sessions.cookie(next, secure));
      }
      return response;
    } catch (error) {
      return this.toErrorResponse(error);
    }
  }

  /**
   * Re-read the caller's account and roles from Knack. Returns the updated
   * session, or null if the account is gone or no longer active.
   *
   * Removing a role in Knack deletes the user's record in that role object and
   * drops the profile key from the account (verified), so either signal is
   * enough to drop the role. Roles added since sign-in are picked up at the
   * next sign-in.
   */
  private async recheck(session: SessionPayload): Promise<SessionPayload | null> {
    try {
      const account = await this.knack.get(this.model.accounts.objectKey, session.accountId);
      if (!account) return null;
      const status = statusField(this.model.accounts);
      const statusValue = status ? String(account[`${status.key}_raw`] ?? account[status.key] ?? '') : 'active';
      if (statusValue && statusValue.toLowerCase() !== 'active') return null;

      const rolesField = this.model.accounts.fields.find((f) => f.kind === 'roles');
      const raw = rolesField ? account[`${rolesField.key}_raw`] : undefined;
      const accountRoles = Array.isArray(raw) ? raw.map(String) : [];

      const profiles: string[] = [];
      const records: Record<string, string> = { [this.model.accounts.objectKey]: session.accountId };
      for (const profile of session.profiles) {
        const entity = this.model.byProfile.get(profile);
        if (profile === 'all_users' || !entity) {
          profiles.push(profile);
          continue;
        }
        const id = session.records[entity.objectKey];
        if (!id) continue;
        const stillListed = accountRoles.length ? accountRoles.includes(profile) : true;
        const stillExists = stillListed && Boolean(await this.knack.get(entity.objectKey, id));
        if (stillExists) {
          profiles.push(profile);
          records[entity.objectKey] = id;
        } else {
          console.log(`session: role ${profile} no longer held; dropped`);
        }
      }
      return { ...session, profiles, records, checked: Date.now() };
    } catch {
      // Knack unreachable: keep the session as is and try again next request.
      return { ...session, checked: Date.now() - ROLE_RECHECK_MS + 15_000 };
    }
  }

  private checkCsrf(request: Request, url: URL): void {
    // SameSite=Strict already keeps the cookie off cross-site requests; the
    // custom header makes a forged simple request fail too.
    if (request.headers.get('x-requested-with') !== 'headless') {
      throw new HttpError(403, 'Missing request header.');
    }
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== url.host && new URL(origin).host !== request.headers.get('x-forwarded-host')) {
      throw new HttpError(403, 'Cross-origin request refused.');
    }
  }

  private toErrorResponse(error: unknown): Response {
    if (error instanceof HttpError) return json(error.status, errorBody(error.message, error.fields));
    if (error instanceof AccessDenied) return json(error.status, errorBody(error.message));
    if (error instanceof LoginError) return json(error.status, errorBody(error.message));
    if (error instanceof BookingError) return json(error.status, errorBody(error.message));
    if (error instanceof InvalidValue) return json(400, errorBody(error.message, { [error.field]: error.message }));
    if (error instanceof KnackError) {
      if (error.status === 400) {
        return json(400, errorBody(error.knackErrors[0]?.message ?? 'Knack rejected the change.', this.knackFieldErrors(error)));
      }
      if (error.status === 429) return json(503, errorBody('The database is busy. Try again in a moment.'));
      if (error.status === 404) return json(404, errorBody('Not found.'));
      return json(502, errorBody('The database did not respond. Try again.'));
    }
    console.error('unhandled error', error instanceof Error ? error.stack : 'unknown');
    return json(500, errorBody('Something went wrong. Try again.'));
  }

  private knackFieldErrors(error: KnackError): Record<string, string> | undefined {
    const out: Record<string, string> = {};
    for (const e of error.knackErrors) {
      if (!e.field) continue;
      for (const entity of this.model.entities) {
        const f = entity.byKey.get(e.field);
        if (f) out[f.slug] = e.message;
      }
    }
    return Object.keys(out).length ? out : undefined;
  }

  // ── Routing ─────────────────────────────────────────────────────────────

  private async route(request: Request, path: string, ctx: Ctx, session: SessionPayload, secure: boolean): Promise<Response> {
    const m = path.split('/').filter(Boolean); // ['api', ...]
    const method = request.method;

    if (path === '/api/session' && method === 'GET') return json(200, this.me(session));
    if (path === '/api/session/logout' && method === 'POST') {
      await this.log(ctx, { kind: 'sign-out' });
      return json(200, { ok: true }, { 'Set-Cookie': this.sessions.clearCookie(secure) });
    }
    if (path === '/api/session/ping' && method === 'POST') {
      // Explicit "I'm still here" from the idle warning. Always re-issues.
      const next = await this.sessions.sign({ ...session, last: Date.now() });
      return json(200, this.me({ ...session, last: Date.now() }), { 'Set-Cookie': this.sessions.cookie(next, secure) });
    }
    if (path === '/api/schema' && method === 'GET') return json(200, this.schemaFor(ctx.caller));

    if (m[1] === 'records' && m[2]) {
      const entity = this.entity(m[2]);
      if (m.length === 3 && method === 'GET') return this.list(ctx, entity);
      if (m.length === 3 && method === 'POST') return this.create(ctx, entity, await readJson(request));
      if (m.length === 4 && method === 'GET') return this.getOne(ctx, entity, m[3]!);
      if (m.length === 4 && method === 'PUT') return this.update(ctx, entity, m[3]!, await readJson(request));
      if (m.length === 4 && method === 'DELETE') return this.remove(ctx, entity, m[3]!, await readJson(request, true));
    }
    if (m[1] === 'booking') {
      if (m.length === 2 && method === 'GET') {
        const enabled = this.booking.canBook(ctx.caller);
        return json(200, {
          enabled,
          doctors: enabled ? await this.booking.doctors(ctx.caller) : [],
          timezone: this.model.timezone,
          horizonDays: HORIZON_DAYS,
          leadMinutes: LEAD_MS / 60_000,
          reasonRequired: Boolean(this.booking.resolved?.reason?.required),
        });
      }
      if (m[2] === 'availability' && method === 'GET') {
        const q = ctx.url.searchParams;
        return json(200, await this.booking.availability(ctx.caller, q.get('from') ?? '', q.get('to') ?? ''));
      }
      if (m.length === 2 && method === 'POST') {
        const body = await readJson(request);
        const r = this.booking.resolved!;
        const created = await this.booking.book(ctx.caller, { doctorId: body.doctorId, start: body.start, reason: body.reason, patientId: body.patientId }, this.model.timezone, (values, rules) =>
          this.applyFormRules(ctx.caller, r.appts, rules, values, null),
        );
        this.invalidate(r.appts);
        await this.log(ctx, { kind: 'create', entity: r.appts.slug, recordId: created.id, fields: [r.date.slug, r.doctor.slug], source: 'booking' });
        return json(201, { record: toDto(created, r.appts, this.policy.readFields(ctx.caller, r.appts.objectKey)) });
      }
    }
    if (m[1] === 'options' && m[2] && m[3] && method === 'GET') return this.options(ctx, this.entity(m[2]), m[3]);
    if (m[1] === 'upload' && m[2] && m[3] && method === 'POST') return this.upload(ctx, this.entity(m[2]), m[3], request);
    if (m[1] === 'files' && m[2] && m[3] && m[4] && method === 'GET') return this.download(ctx, this.entity(m[2]), m[3], m[4]);

    if (m[1] === 'admin') {
      if (!this.policy.isAdmin(ctx.caller)) throw new AccessDenied(404);
      if (m[2] === 'access' && method === 'GET') return json(200, this.accessReport());
      if (m[2] === 'sync' && method === 'GET') return json(200, this.syncStatus());
      if (m[2] === 'sync' && method === 'POST') {
        const result = await this.refresh();
        return json(200, { ...result, status: this.syncStatus() });
      }
      if (m[2] === 'usage' && method === 'GET') return json(200, this.usage.snapshot());
      if (m[2] === 'audit' && method === 'GET') {
        const q = ctx.url.searchParams;
        const events = await this.deps.audit.query({
          entity: q.get('entity') ?? undefined,
          recordId: q.get('recordId') ?? undefined,
          accountId: q.get('accountId') ?? undefined,
          kinds: (q.get('kinds') ?? '').split(',').filter(Boolean) as AuditKind[],
          limit: Number(q.get('limit') ?? 100),
        });
        return json(200, { events });
      }
    }
    throw new HttpError(404, 'Not found.');
  }

  private entity(slug: string): EntityModel {
    const entity = this.model.bySlug.get(slug);
    if (!entity) throw new AccessDenied(404);
    return entity;
  }

  // ── Public ──────────────────────────────────────────────────────────────

  private config(): Response {
    const { config } = this.deps;
    const reset =
      config.passwordResetUrl ||
      (this.snapshot.accountSlug && this.snapshot.slug
        ? `https://${this.snapshot.accountSlug}.knack.com/${this.snapshot.slug}#home/forgot-password`
        : '');
    return json(200, {
      appName: config.appName,
      passwordResetUrl: reset,
      tier: config.tier,
      timezone: this.model.timezone,
      demo: config.demoMode ? { logins: config.demoLogins } : null,
    });
  }

  private async login(request: Request, ip: string, secure: boolean): Promise<Response> {
    const body = await readJson(request);
    const caller = await login(this.knack, this.model, body.email, body.password, ip);
    const now = Date.now();
    const payload: SessionPayload = { ...caller, v: 1, iat: now, last: now, checked: now };
    const token = await this.sessions.sign(payload);
    await this.log({ caller, ip, url: new URL(request.url) }, { kind: 'sign-in' });
    return json(200, this.me(payload), { 'Set-Cookie': this.sessions.cookie(token, secure) });
  }

  private me(session: SessionPayload) {
    const roles = session.profiles
      .map((p) => {
        const role = this.derived.roles.get(p);
        const entity = this.model.byProfile.get(p);
        return entity ? { profileKey: p, name: entity.name, slug: entity.slug, admin: Boolean(role?.admin), recordId: session.records[entity.objectKey] ?? null } : null;
      })
      .filter((r) => r !== null && r.profileKey !== 'all_users');
    return {
      user: { accountId: session.accountId, name: session.name, email: session.email },
      roles,
      appVersion: this.appVersion,
      ...this.sessions.expiry(session),
    };
  }

  // ── Schema: what this caller may see and do ─────────────────────────────

  private schemaFor(caller: Caller) {
    const entities = [];
    for (const entity of this.model.entities) {
      const perms = Object.fromEntries(ACTIONS.map((a) => [a, this.policy.resolve(caller, entity.objectKey, a)])) as Record<
        Action,
        ReturnType<Policy['resolve']>
      >;
      if (!ACTIONS.some((a) => perms[a].grants.length)) continue;
      const readable = perms.read.fields;
      const fields = entity.fields
        .filter((f) => readable.has(f.key) || perms.create.fields.has(f.key) || perms.update.fields.has(f.key))
        .filter((f) => f.kind !== 'password')
        .map((f) => this.fieldInfo(f));
      const listGrants = perms.read.grants.filter((g) => !g.some((c) => c.type === 'readable'));
      entities.push({
        slug: entity.slug,
        name: entity.name,
        isUser: entity.isUser,
        identifier: entity.identifierKey ? entity.byKey.get(entity.identifierKey)?.slug : undefined,
        can: Object.fromEntries(ACTIONS.map((a) => [a, perms[a].grants.length > 0])),
        /** Can be listed without a parent record. */
        listable: listGrants.some((g) => !g.some((c) => c.type === 'parent')),
        /** Connection fields (slugs) this entity can be listed under. */
        parents: [
          ...new Set(
            listGrants.flatMap((g) =>
              g.length === 0
                ? entity.fields.filter((f) => f.kind === 'connection').map((f) => f.slug)
                : g.filter((c) => c.type === 'parent').map((c) => entity.byKey.get(c.type === 'parent' ? c.field : '')?.slug ?? ''),
            ),
          ),
        ].filter(Boolean),
        readFields: entity.fields.filter((f) => readable.has(f.key)).map((f) => f.slug),
        createFields: entity.fields.filter((f) => perms.create.fields.has(f.key)).map((f) => f.slug),
        updateFields: entity.fields.filter((f) => perms.update.fields.has(f.key)).map((f) => f.slug),
        /** Connection fields the server fills in on create (the caller's own record or the parent). */
        forcedOnCreate: [
          ...new Set(
            perms.create.grants.flatMap((g) => g.filter((c) => c.type === 'user').map((c) => (c.type === 'user' ? entity.byKey.get(c.field)?.slug : ''))),
          ),
        ].filter(Boolean),
        fields,
      });
    }
    return { appName: this.deps.config.appName, timezone: this.model.timezone, entities };
  }

  private fieldInfo(f: FieldModel) {
    return {
      slug: f.slug,
      name: f.name,
      kind: f.kind,
      required: f.required,
      readOnly: f.readOnly,
      ...(f.options ? { options: f.options } : {}),
      ...(f.multiple !== undefined ? { multiple: f.multiple } : {}),
      ...(f.targetObject ? { target: this.model.byObject.get(f.targetObject)?.slug } : {}),
    };
  }

  // ── Records ─────────────────────────────────────────────────────────────

  private async list(ctx: Ctx, entity: EntityModel): Promise<Response> {
    const q = ctx.url.searchParams;
    const readable = this.policy.readFields(ctx.caller, entity.objectKey);

    let parent: { field: string; id: string } | null = null;
    const parentSlug = q.get('parentField');
    if (parentSlug) {
      const f = entity.bySlug.get(parentSlug);
      const id = q.get('parentId') ?? '';
      if (!f || f.kind !== 'connection' || !/^[a-f0-9]{24}$/i.test(id)) throw new HttpError(400, 'Invalid parent.');
      parent = { field: f.key, id };
    }

    const scope = await this.policy.listScope(ctx.caller, entity, parent, this.knack);

    if (scope.kind === 'self') {
      const own = ctx.caller.records[entity.objectKey];
      const record = own ? await this.knack.get(entity.objectKey, own) : null;
      const records = record ? [toDto(record, entity, readable)] : [];
      await this.log(ctx, { kind: 'list', entity: entity.slug, count: records.length, source: q.get('source') ?? undefined });
      return json(200, { records, total: records.length, pages: 1, page: 1 });
    }

    const clientRules = this.clientFilters(q.get('filters'), entity, readable);
    const search = (q.get('q') ?? '').trim().slice(0, 100);
    if (search) {
      const field = this.searchField(entity, q.get('searchField'), readable);
      if (field) clientRules.push({ field: field.key, operator: 'contains', value: search });
    }

    // Scope is a top-level AND. A flat OR scope can only stand alone; with
    // client filters we narrow to its first branch rather than nest (Knack
    // ignores nested groups, which would silently widen the result).
    let match: 'and' | 'or' = 'and';
    let rules: FilterRule[];
    if (scope.match === 'or') {
      if (clientRules.length) rules = [scope.rules[0]!, ...clientRules];
      else {
        match = 'or';
        rules = scope.rules;
      }
    } else {
      rules = [...scope.rules, ...clientRules];
    }

    const sortSlug = q.get('sort');
    const sortField = sortSlug ? entity.bySlug.get(sortSlug) : undefined;
    if (sortField && !readable.has(sortField.key)) throw new HttpError(400, 'Cannot sort on that field.');
    const page = clampInt(q.get('page'), 1, 10_000, 1);
    const rowsPerPage = clampInt(q.get('rows'), 1, 1000, 25);

    const cacheKey = JSON.stringify([ctx.caller.accountId, ctx.caller.profiles, entity.objectKey, match, rules, sortField?.key, q.get('order'), page, rowsPerPage]);
    const cached = this.listCache.get(cacheKey);
    let body: unknown;
    if (cached && Date.now() - cached.at < LIST_CACHE_MS) {
      body = cached.body;
    } else {
      const result = await this.knack.list(entity.objectKey, {
        page,
        rowsPerPage,
        filters: rules.length ? { match, rules } : undefined,
        sortField: sortField?.key,
        sortOrder: q.get('order') === 'desc' ? 'desc' : 'asc',
      });
      body = {
        records: result.records.map((r) => toDto(r, entity, readable)),
        total: result.totalRecords,
        pages: result.totalPages,
        page: result.currentPage,
      };
      this.listCache.set(cacheKey, { at: Date.now(), body });
      if (this.listCache.size > 2000) this.listCache.clear();
    }
    await this.log(ctx, {
      kind: 'list',
      entity: entity.slug,
      count: (body as { records: unknown[] }).records.length,
      recordId: parent?.id,
      source: q.get('source') ?? undefined,
    });
    return json(200, body);
  }

  private searchField(entity: EntityModel, slug: string | null, readable: Set<string>): FieldModel | undefined {
    const f = slug ? entity.bySlug.get(slug) : entity.identifierKey ? entity.byKey.get(entity.identifierKey) : undefined;
    return f && readable.has(f.key) ? f : undefined;
  }

  private clientFilters(raw: string | null, entity: EntityModel, readable: Set<string>): FilterRule[] {
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'Invalid filters.');
    }
    if (!Array.isArray(parsed) || parsed.length > MAX_FILTERS) throw new HttpError(400, 'Invalid filters.');
    return parsed.map((r) => {
      const { field, operator, value } = (r ?? {}) as { field?: string; operator?: string; value?: unknown };
      const f = field ? entity.bySlug.get(field) : undefined;
      if (!f || !readable.has(f.key) || !operator || !FILTER_OPERATORS.has(operator)) throw new HttpError(400, 'Invalid filter.');
      // Connection filters compare record ids; dates are converted to
      // MM/DD/YYYY by the client layer.
      return { field: f.key, operator, value };
    });
  }

  /** Fetch a record and require `action` on it. Not-yours and missing are both 404. */
  private async loadFor(ctx: Ctx, entity: EntityModel, id: string, action: Action): Promise<KnackRecord> {
    if (!this.policy.can(ctx.caller, entity.objectKey, action)) throw new AccessDenied(404);
    const record = await this.knack.get(entity.objectKey, id);
    if (!record || !(await this.policy.allows(ctx.caller, entity, record, action, this.knack))) throw new AccessDenied(404);
    return record;
  }

  private async getOne(ctx: Ctx, entity: EntityModel, id: string): Promise<Response> {
    const record = await this.loadFor(ctx, entity, id, 'read');
    const readable = this.policy.readFields(ctx.caller, entity.objectKey);
    await this.log(ctx, { kind: 'view', entity: entity.slug, recordId: id, source: ctx.url.searchParams.get('source') ?? undefined });
    return json(200, {
      record: toDto(record, entity, readable),
      can: {
        update: await this.policy.allows(ctx.caller, entity, record, 'update', this.knack),
        delete: await this.policy.allows(ctx.caller, entity, record, 'delete', this.knack),
      },
    });
  }

  private async create(ctx: Ctx, entity: EntityModel, body: Record<string, unknown>): Promise<Response> {
    const { fields: writable } = this.policy.resolve(ctx.caller, entity.objectKey, 'create');
    const input = (body.values ?? {}) as Record<string, unknown>;

    // Connection ids the client named, for parent-scoped creates.
    const requested: Record<string, string[]> = {};
    for (const f of entity.fields) {
      if (f.kind !== 'connection' || !(f.slug in input)) continue;
      requested[f.key] = (toKnackValue(f, input[f.slug]) as string[]) ?? [];
    }
    const { forced, rules } = await this.policy.createScope(ctx.caller, entity, requested, this.knack);

    const values = toKnackValues(input, entity, writable);
    // Forced connections overwrite whatever the client sent for them.
    for (const [key, ids] of Object.entries(forced)) values[key] = ids;
    await this.applyFormRules(ctx.caller, entity, rules, values, null);
    this.requireRequired(entity, values, writable, { ...forced, ...Object.fromEntries(rules.map((r) => [r.field, []])) });

    // Validate any other connection the client set: the ids must exist.
    await this.checkConnections(entity, values, forced);

    const created = await this.knack.create(entity.objectKey, values);
    this.invalidate(entity);
    const readable = this.policy.readFields(ctx.caller, entity.objectKey);
    await this.log(ctx, {
      kind: 'create',
      entity: entity.slug,
      recordId: created.id,
      fields: this.slugs(entity, Object.keys(values)),
      after: this.deps.config.auditValues ? toDto(created, entity, new Set(Object.keys(values))) : undefined,
      source: str(body.source),
      reason: str(body.reason),
    });
    return json(201, { record: toDto(created, entity, readable) });
  }

  private async update(ctx: Ctx, entity: EntityModel, id: string, body: Record<string, unknown>): Promise<Response> {
    const record = await this.loadFor(ctx, entity, id, 'update');
    const { fields: writable } = this.policy.resolve(ctx.caller, entity.objectKey, 'update');
    const values = toKnackValues((body.values ?? {}) as Record<string, unknown>, entity, writable);
    if (!Object.keys(values).length) throw new HttpError(400, 'Nothing to change.');
    await this.applyFormRules(ctx.caller, entity, await this.policy.updateRules(ctx.caller, entity, record, this.knack), values, record);

    // The change must not move the record out of the caller's reach (e.g. a
    // doctor reassigning a patient's appointment to someone else's record).
    const after: KnackRecord = { ...record };
    for (const [key, v] of Object.entries(values)) {
      const f = entity.byKey.get(key);
      if (f?.kind === 'connection') after[`${key}_raw`] = (v as string[]).map((x) => ({ id: x, identifier: '' }));
    }
    if (!(await this.policy.allows(ctx.caller, entity, after, 'update', this.knack))) {
      throw new HttpError(403, 'That change would move the record outside what you can manage.');
    }
    await this.checkConnections(entity, values, {});

    const updated = await this.knack.update(entity.objectKey, id, values);
    this.invalidate(entity);
    const changedKeys = new Set(Object.keys(values));
    await this.log(ctx, {
      kind: 'update',
      entity: entity.slug,
      recordId: id,
      fields: this.slugs(entity, [...changedKeys]),
      before: this.deps.config.auditValues ? toDto(record, entity, changedKeys) : undefined,
      after: this.deps.config.auditValues ? toDto(updated, entity, changedKeys) : undefined,
      source: str(body.source),
      reason: str(body.reason),
    });
    return json(200, { record: toDto(updated, entity, this.policy.readFields(ctx.caller, entity.objectKey)) });
  }

  private async remove(ctx: Ctx, entity: EntityModel, id: string, body: Record<string, unknown>): Promise<Response> {
    const record = await this.loadFor(ctx, entity, id, 'delete');
    await this.knack.delete(entity.objectKey, id);
    this.invalidate(entity);
    await this.log(ctx, {
      kind: 'delete',
      entity: entity.slug,
      recordId: id,
      before: this.deps.config.auditValues ? toDto(record, entity, this.policy.readFields(ctx.caller, entity.objectKey)) : undefined,
      source: str(body.source),
      reason: str(body.reason),
    });
    return json(200, { ok: true });
  }

  /**
   * Apply the Knack form's record rules: the values Knack itself would set
   * when that form is submitted (e.g. "Doctor = the logged-in doctor").
   */
  private async applyFormRules(
    caller: Caller,
    entity: EntityModel,
    rules: import('../access/derive.js').FormRule[],
    values: Record<string, unknown>,
    existing: KnackRecord | null,
  ): Promise<void> {
    for (const rule of rules) {
      const field = entity.byKey.get(rule.field);
      if (!field) continue;
      if (rule.type === 'user') {
        const mine = caller.records[rule.userObject];
        if (mine) values[rule.field] = [mine];
      } else if (rule.type === 'value') {
        values[rule.field] = toKnackValue(field, rule.value);
      } else if (rule.type === 'copy') {
        const via = entity.byKey.get(rule.via);
        if (!via?.targetObject) continue;
        const ids = (values[rule.via] as string[] | undefined) ?? (existing ? connectionIdsOf(existing, rule.via) : []);
        const copied: string[] = [];
        for (const id of ids) {
          const source = await this.knack.get(via.targetObject, id);
          if (source) copied.push(...connectionIdsOf(source, rule.sourceField));
        }
        if (copied.length) values[rule.field] = [...new Set(copied)];
      }
    }
  }

  private requireRequired(entity: EntityModel, values: Record<string, unknown>, writable: Set<string>, forced: Record<string, string[]>): void {
    const missing: Record<string, string> = {};
    for (const f of entity.fields) {
      if (!f.required || f.readOnly || !writable.has(f.key) || f.key in forced) continue;
      const v = values[f.key];
      const empty = v === undefined || v === '' || v === null || (Array.isArray(v) && v.length === 0);
      if (empty) missing[f.slug] = `${f.name} is required.`;
    }
    if (Object.keys(missing).length) throw new HttpError(400, 'Some required fields are empty.', missing);
  }

  private async checkConnections(entity: EntityModel, values: Record<string, unknown>, forced: Record<string, string[]>): Promise<void> {
    for (const [key, v] of Object.entries(values)) {
      const f = entity.byKey.get(key);
      if (f?.kind !== 'connection' || key in forced || !f.targetObject) continue;
      for (const id of v as string[]) {
        if (!/^[a-f0-9]{24}$/i.test(id) || !(await this.knack.get(f.targetObject, id))) {
          throw new HttpError(400, `${f.name}: that record doesn't exist.`, { [f.slug]: 'Choose a valid option.' });
        }
      }
    }
  }

  // ── Connection options (dropdowns on forms) ─────────────────────────────

  /**
   * Choices for a connection input. Allowed only for a connection field the
   * caller can write (it is on one of their Knack forms), and answers with id
   * and display name only, which is what Knack's own form dropdown shows.
   */
  private async options(ctx: Ctx, entity: EntityModel, fieldSlug: string): Promise<Response> {
    const field = entity.bySlug.get(fieldSlug);
    if (!field || field.kind !== 'connection' || !field.targetObject) throw new AccessDenied(404);
    const writable =
      this.policy.resolve(ctx.caller, entity.objectKey, 'create').fields.has(field.key) ||
      this.policy.resolve(ctx.caller, entity.objectKey, 'update').fields.has(field.key);
    const filterable = this.policy.readFields(ctx.caller, entity.objectKey).has(field.key);
    if (!writable && !filterable) throw new AccessDenied(404);

    const target = this.model.byObject.get(field.targetObject)!;
    const identifier = target.identifierKey ? target.byKey.get(target.identifierKey) : undefined;
    const search = (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 100);

    // Readers who can't write the field only get options they can read.
    let scopeRules: FilterRule[] = [];
    let match: 'and' | 'or' = 'and';
    if (!writable) {
      const scope = await this.policy.listScope(ctx.caller, target, null, this.knack).catch(() => null);
      if (!scope || scope.kind === 'self') {
        const own = ctx.caller.records[target.objectKey];
        if (!own) return json(200, { options: [] });
        const rec = await this.knack.get(target.objectKey, own);
        return json(200, { options: rec ? [{ id: rec.id, label: labelOf(rec, identifier) }] : [] });
      }
      scopeRules = scope.rules;
      match = scope.match;
    }
    const rules = [...scopeRules];
    if (search && identifier && match === 'and') rules.push({ field: identifier.key, operator: 'contains', value: search });
    const result = await this.knack.list(target.objectKey, {
      rowsPerPage: 50,
      filters: rules.length ? { match, rules } : undefined,
      sortField: identifier?.key,
      sortOrder: 'asc',
    });
    return json(200, { options: result.records.map((r) => ({ id: r.id, label: labelOf(r, identifier) })) });
  }

  // ── Files ───────────────────────────────────────────────────────────────

  private async upload(ctx: Ctx, entity: EntityModel, fieldSlug: string, request: Request): Promise<Response> {
    const field = entity.bySlug.get(fieldSlug);
    if (!field || (field.kind !== 'file' && field.kind !== 'image')) throw new AccessDenied(404);
    const can =
      this.policy.resolve(ctx.caller, entity.objectKey, 'create').fields.has(field.key) ||
      this.policy.resolve(ctx.caller, entity.objectKey, 'update').fields.has(field.key);
    if (!can) throw new AccessDenied(404);

    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > MAX_UPLOAD_BYTES + 64 * 1024) throw new HttpError(413, 'Files must be 20 MB or smaller.');
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!file || typeof file === 'string') throw new HttpError(400, 'No file received.');
    if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Files must be 20 MB or smaller.');
    if (file.size === 0) throw new HttpError(400, 'That file is empty.');

    const asset = await this.knack.uploadAsset(field.kind, file, safeFilename(file.name));
    await this.log(ctx, { kind: 'upload', entity: entity.slug, fields: [field.slug] });
    return json(201, { id: asset.id, filename: asset.filename, size: file.size, type: file.type || null });
  }

  /**
   * Download proxy. Knack's asset links open without credentials, so they
   * never reach the browser: the server checks read access to the record and
   * to the field, logs the access, then streams the bytes.
   */
  private async download(ctx: Ctx, entity: EntityModel, id: string, fieldSlug: string): Promise<Response> {
    const field = entity.bySlug.get(fieldSlug);
    if (!field || (field.kind !== 'file' && field.kind !== 'image')) throw new AccessDenied(404);
    if (!this.policy.readFields(ctx.caller, entity.objectKey).has(field.key)) throw new AccessDenied(404);
    const record = await this.loadFor(ctx, entity, id, 'read');
    const url = fileUrl(record, field);
    const meta = readField(record, field) as { filename?: string; type?: string } | null;
    if (!url || !meta) throw new AccessDenied(404);

    const upstream = await this.knack.download(url);
    await this.log(ctx, { kind: 'download', entity: entity.slug, recordId: id, fields: [field.slug], source: ctx.url.searchParams.get('source') ?? undefined });

    const inline = ctx.url.searchParams.get('inline') === '1';
    const filename = safeFilename(meta.filename ?? 'file');
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? meta.type ?? 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        // A downloaded HTML/SVG file must not run as this origin.
        'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      },
    });
  }

  // ── Admin ───────────────────────────────────────────────────────────────

  /** The derived policy in readable form: what each role can do, and why. */
  accessReport() {
    const roles = [...this.derived.roles.values()].map((role) => ({
      profileKey: role.profileKey,
      name: role.roleName,
      admin: role.admin,
      entities: [...role.entities.entries()].map(([objectKey, access]) => {
        const entity = this.model.byObject.get(objectKey)!;
        const fieldNames = (keys: Set<string>) => entity.fields.filter((f) => keys.has(f.key)).map((f) => f.name);
        return {
          entity: entity.slug,
          name: entity.name,
          actions: Object.fromEntries(
            ACTIONS.map((a) => [a, access.grants[a].map((g) => this.describeGrant(entity, g))]),
          ),
          readFields: fieldNames(access.readFields),
          createFields: fieldNames(access.createFields),
          updateFields: fieldNames(access.updateFields),
          sources: [...access.sources],
        };
      }),
    }));
    return { roles, warnings: this.derived.warnings };
  }

  private describeGrant(entity: EntityModel, grant: import('../access/derive.js').Grant): string {
    if (!grant.length) return 'All records';
    return grant
      .map((c) => {
        switch (c.type) {
          case 'user':
            return `${entity.byKey.get(c.field)?.name ?? c.field} is the signed-in ${this.model.byObject.get(c.userObject)?.name ?? ''} record`;
          case 'self':
            return 'Their own record';
          case 'parent':
            return `${entity.byKey.get(c.field)?.name ?? c.field} is a ${this.model.byObject.get(c.parentObject)?.name ?? ''} record they can see`;
          case 'readable':
            return 'Records they can see';
          case 'match':
            return `${entity.byKey.get(c.field)?.name ?? c.field} ${c.operator} ${JSON.stringify(c.value)}`;
        }
      })
      .join(' and ');
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private invalidate(entity: EntityModel): void {
    for (const key of this.listCache.keys()) if (key.includes(`"${entity.objectKey}"`)) this.listCache.delete(key);
  }

  private slugs(entity: EntityModel, keys: string[]): string[] {
    return keys.map((k) => entity.byKey.get(k)?.slug ?? k);
  }

  private async log(ctx: Ctx, event: Omit<AuditEvent, 'at' | 'actor' | 'profiles'>): Promise<void> {
    try {
      await this.deps.audit.write({
        at: new Date().toISOString(),
        actor: { accountId: ctx.caller.accountId, name: ctx.caller.name, email: ctx.caller.email },
        profiles: ctx.caller.profiles,
        ip: ctx.ip || undefined,
        ...stripUndefined(event),
      });
    } catch (error) {
      // An audit write failing must be loud, but must not leak data in the log.
      console.error('audit write failed:', error instanceof Error ? error.message : 'unknown');
    }
  }
}

interface Ctx {
  caller: Caller;
  ip: string;
  url: URL;
}

const withHeader = (response: Response, name: string, value: string): Response => {
  const headers = new Headers(response.headers);
  headers.append(name, value);
  return new Response(response.body, { status: response.status, headers });
};

const readJson = async (request: Request, optional = false): Promise<Record<string, unknown>> => {
  const text = await request.text();
  if (!text) {
    if (optional) return {};
    throw new HttpError(400, 'Request body required.');
  }
  if (text.length > 1_000_000) throw new HttpError(413, 'Request too large.');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
};

const clampInt = (raw: string | null, min: number, max: number, fallback: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : undefined);

const stripUndefined = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const safeFilename = (name: string): string => name.replace(/[\\/\r\n\t\0]/g, '_').slice(0, 200) || 'file';

const labelOf = (record: KnackRecord, identifier: FieldModel | undefined): string => {
  if (!identifier) return record.id;
  const v = readField(record, identifier);
  if (v && typeof v === 'object') {
    if (Array.isArray(v)) return v.map((c) => (c as { identifier?: string }).identifier ?? '').join(', ');
    return String((v as { full?: string }).full ?? '');
  }
  return v === null || v === undefined ? '' : String(v);
};

