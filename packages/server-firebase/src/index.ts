/**
 * Firebase entry point: a single HTTPS function, `api`, reached only through
 * the Hosting rewrite `/api/**` (same origin, so the session cookie flows and
 * the function needs no CORS).
 *
 * Secrets come from Secret Manager:
 *   firebase functions:secrets:set KNACK_API_KEY
 *   firebase functions:secrets:set SESSION_SECRET
 * Non-secret settings (KNACK_APP_ID, KNACK_API_HOST, COMPLIANCE_TIER, …) go in
 * packages/server-firebase/.env, which `firebase deploy` reads. Don't commit it.
 */
import { readFileSync } from 'node:fs';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { HeadlessApp, loadConfig, type AppSnapshot } from '@headless/core';
import { FirestoreAuditStore } from './firestoreAudit.js';

const KNACK_API_KEY = defineSecret('KNACK_API_KEY');
const SESSION_SECRET = defineSecret('SESSION_SECRET');

initializeApp();

let app: HeadlessApp | null = null;
const getApp = (): HeadlessApp => {
  if (!app) {
    const snapshot = JSON.parse(readFileSync(new URL('./snapshot.json', import.meta.url), 'utf8')) as AppSnapshot;
    app = new HeadlessApp({
      config: loadConfig({ ...process.env, KNACK_API_KEY: KNACK_API_KEY.value(), SESSION_SECRET: SESSION_SECRET.value() }),
      snapshot,
      audit: new FirestoreAuditStore(),
    });
  }
  return app;
};

export const api = onRequest(
  {
    region: process.env.FUNCTION_REGION ?? 'us-central1',
    secrets: [KNACK_API_KEY, SESSION_SECRET],
    maxInstances: 10,
    concurrency: 40,
    memory: '512MiB',
    timeoutSeconds: 120,
    // Cold starts are paid by whoever signs in first. Set minInstances: 1
    // if that matters for this deployment (a small standing cost).
    // Hosting rewrites call the function as an anonymous client, so the
    // service must accept unauthenticated invocations. That is not data
    // access: every route but /api/config and /api/session/login requires a
    // valid session cookie. On the HIPAA tier, see docs/hipaa.md about putting
    // a covered front door (HTTPS load balancer) in front instead of Hosting.
    invoker: 'public',
  },
  async (req, res) => {
    const proto = String(req.headers['x-forwarded-proto'] ?? 'https').split(',')[0];
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v !== undefined) headers.set(k, String(v));
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(`${proto}://${host}${req.originalUrl}`, {
      method: req.method,
      headers,
      body: hasBody ? new Uint8Array(req.rawBody ?? Buffer.alloc(0)) : undefined,
    });
    const ip = String(req.headers['x-forwarded-for'] ?? req.ip ?? '').split(',')[0]!.trim();

    const response = await getApp().handle(request, ip);
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie') res.setHeader(key, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('set-cookie', cookies);
    if (response.body) {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
    }
    res.end();
  },
);
