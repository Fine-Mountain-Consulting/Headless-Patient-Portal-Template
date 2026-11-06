/**
 * Password sign-in.
 *
 * Knack stays the identity system: accounts, passwords, approval and role
 * assignments all live there. This moves the login call to the server, throws
 * away the Knack user token, and issues our own session.
 *
 * Knack keeps a separate record for the user in each role object (a patient
 * has a Patients record whose id differs from their Accounts id; verified on
 * the Patient Portal template). "Records connected to the logged-in user" in
 * Knack means connected to *that* role record, so we resolve it here, once,
 * by email, and carry it in the session.
 */
import type { Caller } from '../access/policy.js';
import type { KnackClient } from '../knack/client.js';
import { emailField, type AppModel, type EntityModel } from '../model/model.js';

export class LoginError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 429 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

interface KnackSessionUser {
  id?: string;
  approval_status?: string;
  profile_keys?: string[];
  values?: Record<string, unknown>;
}

// ── A small in-memory throttle in front of Knack's own lockout ───────────────
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 8;
const failures = new Map<string, number[]>();

const recentFailures = (key: string, now: number): number[] =>
  (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

const noteFailure = (key: string, now: number): void => {
  const list = recentFailures(key, now);
  list.push(now);
  failures.set(key, list);
  if (failures.size > 10_000) failures.clear();
};

const readEmail = (user: KnackSessionUser, model: AppModel, fallback: string): string => {
  const key = emailField(model.accounts)?.key;
  const value = key ? user.values?.[key] : undefined;
  if (typeof value === 'string' && value.includes('@')) return value;
  if (value && typeof value === 'object' && typeof (value as { email?: unknown }).email === 'string') {
    return (value as { email: string }).email;
  }
  return fallback;
};

const readName = (user: KnackSessionUser, model: AppModel): string => {
  const key = model.accounts.fields.find((f) => f.kind === 'name')?.key;
  const value = key ? user.values?.[key] : undefined;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const v = value as { full?: string; first?: string; last?: string };
    return v.full ?? [v.first, v.last].filter(Boolean).join(' ');
  }
  return '';
};

/** Find the caller's record in a role object by email. Refuses ambiguity. */
const findRoleRecord = async (
  knack: KnackClient,
  entity: EntityModel,
  email: string,
): Promise<string | null | 'ambiguous'> => {
  const field = emailField(entity);
  if (!field) return null;
  for (const candidate of [...new Set([email.toLowerCase(), email])]) {
    const result = await knack.list(entity.objectKey, {
      rowsPerPage: 2,
      filters: { match: 'and', rules: [{ field: field.key, operator: 'is', value: candidate }] },
    });
    if (result.records.length > 1) return 'ambiguous';
    if (result.records.length === 1) return result.records[0]!.id;
  }
  return null;
};

export const login = async (
  knack: KnackClient,
  model: AppModel,
  emailInput: unknown,
  passwordInput: unknown,
  clientKey: string,
): Promise<Caller> => {
  const email = typeof emailInput === 'string' ? emailInput.trim() : '';
  const password = typeof passwordInput === 'string' ? passwordInput : '';
  if (!email || !password) throw new LoginError(400, 'Enter your email and password.');

  const now = Date.now();
  const throttleKey = `${clientKey}|${email.toLowerCase()}`;
  if (recentFailures(throttleKey, now).length >= MAX_FAILURES) {
    throw new LoginError(429, 'Too many sign-in attempts. Wait a few minutes and try again.');
  }

  const { status, body } = await knack.login(email, password);

  if (status === 0) throw new LoginError(503, 'We could not reach the sign-in service. Try again.');
  if (status === 429) {
    // A throttle is not a bad password. Saying so stops people resetting a
    // password that was fine.
    throw new LoginError(429, 'Too many sign-in attempts right now. Wait a moment and try again.');
  }
  if (status < 200 || status >= 300) {
    noteFailure(throttleKey, now);
    console.warn(`login refused by Knack: ${status}`);
    if (status >= 500) throw new LoginError(502, 'Sign-in is temporarily unavailable. Try again shortly.');
    throw new LoginError(401, 'That email and password don’t match our records.');
  }

  const user = (body as { session?: { user?: KnackSessionUser } } | null)?.session?.user;
  if (!user?.id) {
    console.error('Knack authenticated but returned no user id.');
    throw new LoginError(502, 'Sign-in failed. Try again.');
  }

  // Pending or denied accounts still get a Knack token. They don't get in.
  if (user.approval_status && user.approval_status !== 'approved') {
    throw new LoginError(403, 'Your account is waiting for approval. You’ll get an email when it’s ready.');
  }

  const resolvedEmail = readEmail(user, model, email);
  const records: Record<string, string> = { [model.accounts.objectKey]: user.id };
  const profiles = new Set<string>(['all_users']);

  for (const profileKey of user.profile_keys ?? []) {
    const entity = model.byProfile.get(profileKey);
    if (!entity || profileKey === 'all_users') continue;
    const id = await findRoleRecord(knack, entity, resolvedEmail);
    if (id === 'ambiguous') {
      console.error(`login: more than one ${entity.name} record matches the signing-in email; role refused.`);
      continue;
    }
    if (!id) {
      console.warn(`login: profile ${profileKey} has no ${entity.name} record for this email; role dropped.`);
      continue;
    }
    records[entity.objectKey] = id;
    profiles.add(profileKey);
  }

  failures.delete(throttleKey);
  return {
    accountId: user.id,
    email: resolvedEmail,
    name: readName(user, model) || resolvedEmail,
    profiles: [...profiles],
    records,
  };
};
