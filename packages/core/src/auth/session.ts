/**
 * Sessions: an HMAC-signed token in an HttpOnly cookie.
 *
 * Why not Firebase Auth custom tokens, as the Hospital CRM uses:
 *
 *  - It runs unchanged on every platform (Firebase, Node, containers), which
 *    is a requirement of this template.
 *  - In a patient portal the users are patients. Their email and the fact
 *    that they are a patient of this practice is PHI. A self-issued session
 *    keeps that out of a separate identity service (Firebase Authentication is
 *    not on Google's BAA-covered list; Identity Platform is).
 *  - The browser holds no Knack credential and no bearer token readable by
 *    script: the cookie is HttpOnly, Secure, SameSite=Strict, and has no
 *    expiry, so closing the browser ends the session (HIPAA automatic logoff).
 *
 * The cookie is named `__session` because Firebase Hosting strips every other
 * cookie before rewriting to a function.
 *
 * Roles ride in the token, so a role changed in Knack takes effect at the next
 * sign-in, as with the CRM.
 */
import type { webcrypto } from 'node:crypto';
import type { Caller } from '../access/policy.js';

export const SESSION_COOKIE = '__session';

export interface SessionPayload extends Caller {
  v: 1;
  /** Issued at (ms). */
  iat: number;
  /** Last activity (ms). Slides forward as the user works. */
  last: number;
  /** When roles and account status were last re-checked against Knack (ms). */
  checked?: number;
}

const enc = new TextEncoder();

const b64url = (bytes: ArrayBuffer | Uint8Array): string =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromB64url = (s: string): Uint8Array =>
  new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

export class SessionManager {
  private keyPromise: Promise<webcrypto.CryptoKey>;

  constructor(
    secret: string,
    private readonly idleMs: number,
    private readonly maxMs: number,
  ) {
    this.keyPromise = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
  }

  async sign(payload: SessionPayload): Promise<string> {
    const body = b64url(enc.encode(JSON.stringify(payload)));
    const sig = await crypto.subtle.sign('HMAC', await this.keyPromise, enc.encode(body));
    return `${body}.${b64url(sig)}`;
  }

  /** The payload if the token is authentic and neither idle nor too old. */
  async verify(token: string | undefined, now = Date.now()): Promise<SessionPayload | null> {
    if (!token) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    let ok = false;
    try {
      ok = await crypto.subtle.verify('HMAC', await this.keyPromise, fromB64url(sig), enc.encode(body));
    } catch {
      return null;
    }
    if (!ok) return null;
    let payload: SessionPayload;
    try {
      payload = JSON.parse(Buffer.from(fromB64url(body)).toString('utf8')) as SessionPayload;
    } catch {
      return null;
    }
    if (payload.v !== 1) return null;
    if (now - payload.iat > this.maxMs) return null;
    if (now - payload.last > this.idleMs) return null;
    return payload;
  }

  /** Should this request re-issue the cookie to slide the idle window? */
  needsRefresh(payload: SessionPayload, now = Date.now()): boolean {
    return now - payload.last > 60_000;
  }

  /** Idle and absolute expiry for the client's countdown. */
  expiry(payload: SessionPayload): { idleAt: number; maxAt: number } {
    return { idleAt: payload.last + this.idleMs, maxAt: payload.iat + this.maxMs };
  }

  cookie(token: string, secure: boolean): string {
    // No Max-Age/Expires: a browser-session cookie, gone when the browser closes.
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }

  clearCookie(secure: boolean): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}

export const readCookie = (header: string | null, name: string): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
};
