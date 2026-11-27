import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeadlessApp, loadConfig, MemoryAuditStore, MemoryFeatureStore, type AppSnapshot } from '../dist/index.js';
import { SessionManager } from '../dist/auth/session.js';
import { snapshot } from './fixture.ts';

const SECRET = 'synthetic-test-secret-'.padEnd(48, 'x');
const id = (n: number) => n.toString(16).padStart(24, '0');

const snap = {
  ...(snapshot as unknown as AppSnapshot),
  template: {
    template: 'fixture',
    roles: { patient: 'Patients', admin: 'Headless Admin' },
    entities: {},
    features: {
      'add-results': {
        title: 'Patients add results',
        description: 'test',
        grants: [{ role: 'patient', entity: 'Results', actions: ['create'], own: 'Patient', fields: ['Title'] }],
      },
    },
  },
} as AppSnapshot;

const config = loadConfig({
  KNACK_APP_ID: snap.id,
  KNACK_API_KEY: 'synthetic',
  SESSION_SECRET: SECRET,
  COMPLIANCE_TIER: 'standard',
  SYNC_MINUTES: '0',
});

const sessions = new SessionManager(SECRET, 15 * 60_000, 12 * 3_600_000);
const cookieFor = async (profiles: string[], records: Record<string, string>) => {
  const now = Date.now();
  const token = await sessions.sign({ accountId: records.object_1!, email: 'x@example.com', name: 'Synthetic', profiles, records, v: 1, iat: now, last: now, checked: now });
  return `__session=${token}`;
};

const call = async (app: HeadlessApp, cookie: string, path: string, init: { method?: string; body?: unknown } = {}) => {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method: init.method ?? 'GET',
      headers: { cookie, 'x-requested-with': 'headless', 'content-type': 'application/json' },
      body: init.body ? JSON.stringify(init.body) : undefined,
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

test('an admin switches a feature on; it changes access, is stored and logged', async () => {
  const audit = new MemoryAuditStore();
  const store = new MemoryFeatureStore();
  const app = new HeadlessApp({ config, snapshot: snap, audit, features: store });
  const admin = await cookieFor(['all_users', 'profile_6'], { object_1: id(3), object_6: id(31) });
  const patient = await cookieFor(['all_users', 'profile_2'], { object_1: id(1), object_2: id(11) });

  const canCreate = async () => (await call(app, patient, '/api/schema')).body.entities.find((e: any) => e.slug === 'results')?.can.create ?? false;

  assert.equal(await canCreate(), false);
  const list = await call(app, admin, '/api/admin/features');
  assert.equal(list.body.features[0].on, false);

  // Only admins may switch.
  assert.equal((await call(app, patient, '/api/admin/features/add-results', { method: 'PUT', body: { on: true } })).status, 404);
  assert.equal((await call(app, admin, '/api/admin/features/nope', { method: 'PUT', body: { on: true } })).status, 404);
  assert.equal((await call(app, admin, '/api/admin/features/add-results', { method: 'PUT', body: { on: 'yes' } })).status, 400);

  const on = await call(app, admin, '/api/admin/features/add-results', { method: 'PUT', body: { on: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.features[0].on, true);
  assert.equal(await canCreate(), true);
  assert.equal((await store.load())['add-results']?.on, true);
  const events = await audit.query({ kinds: ['setting'] });
  assert.match(events[0]!.reason!, /Switched on: Patients add results/);

  // The Access map says where the grant came from.
  const access = await call(app, admin, '/api/admin/access');
  const results = access.body.roles.find((r: any) => r.profileKey === 'profile_2').entities.find((e: any) => e.entity === 'results');
  assert.ok(results.sources.includes('feature:add-results'));

  await call(app, admin, '/api/admin/features/add-results', { method: 'PUT', body: { on: false } });
  assert.equal(await canCreate(), false);
});

test('switches stored elsewhere (another instance) are picked up', async () => {
  const store = new MemoryFeatureStore();
  await store.save({ 'add-results': { on: true } });
  const app = new HeadlessApp({ config, snapshot: snap, audit: new MemoryAuditStore(), features: store });
  const patient = await cookieFor(['all_users', 'profile_2'], { object_1: id(1), object_2: id(11) });
  const schema = await call(app, patient, '/api/schema');
  assert.equal(schema.body.entities.find((e: any) => e.slug === 'results').can.create, true);
});
