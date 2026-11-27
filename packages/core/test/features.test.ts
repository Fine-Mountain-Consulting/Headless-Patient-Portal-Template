import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFeatures, buildModel, derivePolicy, Policy, type AppSnapshot, type Caller } from '../dist/index.js';
import { snapshot } from './fixture.ts';

const snap = snapshot as unknown as AppSnapshot;
const model = buildModel(snap);

const id = (n: number) => n.toString(16).padStart(24, '0');
const patient: Caller = { accountId: id(1), email: 'p@x', name: 'P', profiles: ['all_users', 'profile_2'], records: { object_1: id(1), object_2: id(11) } };
const doctor: Caller = { accountId: id(2), email: 'd@x', name: 'D', profiles: ['all_users', 'profile_3'], records: { object_1: id(2), object_3: id(21) } };
const knack = { get: async () => null } as never;

const manifest = {
  template: 'fixture',
  roles: { patient: 'Patients', doctor: 'Doctors' },
  entities: {},
  features: {
    $comment: 'ignored',
    'add-results': {
      title: 'Patients add results',
      description: 'test',
      grants: [{ role: 'patient', entity: 'Results', actions: ['create'], own: 'Patient', fields: ['Title'], set: { Title: 'From patient' } }],
    },
    'own-profile': {
      title: 'Doctors edit their profile',
      description: 'test',
      grants: [{ role: 'doctor', entity: 'Doctors', actions: ['read', 'update'], own: 'self', fields: ['Name'] }],
    },
    broken: {
      title: 'Broken',
      description: 'test',
      grants: [{ role: 'patient', entity: 'Results', actions: ['read'], own: 'Patient', fields: ['No Such Field'] }],
    },
    'self-create': {
      title: 'Self create',
      description: 'test',
      grants: [{ role: 'doctor', entity: 'Doctors', actions: ['create'], own: 'self', fields: ['Name'] }],
    },
  },
} as never;

const build = (states: Record<string, { on: boolean }>) => {
  const derived = derivePolicy(snap, model);
  const report = applyFeatures(derived, model, manifest, states);
  return { derived, report, policy: new Policy(model, derived) };
};

test('features are off until switched on', () => {
  const { policy, report } = build({});
  assert.equal(policy.can(patient, 'object_5', 'create'), false);
  assert.deepEqual(report.map((f) => f.id), ['add-results', 'own-profile', 'broken', 'self-create']);
  assert.ok(report.every((f) => !f.on));
});

test('a switched-on feature grants only the signed-in user’s own records', async () => {
  const { policy, derived } = build({ 'add-results': { on: true } });
  const results = model.byObject.get('object_5')!;
  const { forced, rules } = await policy.createScope(patient, results, { field_15: [id(99)] }, knack);
  // The patient connection is forced to the caller, whatever was sent.
  assert.deepEqual(forced, { field_15: [id(11)] });
  assert.deepEqual(rules, [{ type: 'value', field: 'field_14', value: 'From patient' }]);
  assert.ok(policy.resolve(patient, 'object_5', 'create').fields.has('field_14'));
  // They can see what they add, scoped to themselves.
  const scope = await policy.listScope(patient, results, null, knack);
  assert.deepEqual(scope, { kind: 'filter', match: 'and', rules: [{ field: 'field_15', operator: 'is', value: id(11) }] });
  assert.ok(derived.roles.get('profile_2')!.entities.get('object_5')!.sources.has('feature:add-results'));
  // Other roles gain nothing.
  assert.equal(derived.roles.get('profile_3')!.entities.get('object_5')!.sources.has('feature:add-results'), false);
});

test('"self" grants cover only the caller’s own role record', async () => {
  const { policy } = build({ 'own-profile': { on: true } });
  const doctors = model.byObject.get('object_3')!;
  assert.equal(await policy.allows(doctor, doctors, { id: id(21) }, 'update', knack), true);
  assert.equal(await policy.allows(doctor, doctors, { id: id(22) }, 'update', knack), false);
  assert.equal(policy.can(patient, 'object_3', 'update'), false);
});

test('a feature the Knack app can’t support is unavailable and never applies', () => {
  const { policy, report } = build({ broken: { on: true }, 'self-create': { on: true } });
  const broken = report.find((f) => f.id === 'broken')!;
  assert.equal(broken.available, false);
  assert.match(broken.problems[0]!, /No Such Field/);
  assert.equal(policy.can(patient, 'object_5', 'read'), false);
  assert.equal(report.find((f) => f.id === 'self-create')!.available, false);
  assert.equal(policy.can(doctor, 'object_3', 'create'), false);
});
