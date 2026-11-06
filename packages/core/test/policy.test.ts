import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, derivePolicy, Policy, type AppSnapshot, type Caller } from '../dist/index.js';
import { snapshot } from './fixture.ts';

const snap = snapshot as unknown as AppSnapshot;
const model = buildModel(snap);
const derived = derivePolicy(snap, model);
const policy = new Policy(model, derived);

const id = (n: number) => n.toString(16).padStart(24, '0');
const patient: Caller = { accountId: id(1), email: 'p@x', name: 'P', profiles: ['all_users', 'profile_2'], records: { object_1: id(1), object_2: id(11) } };
const doctor: Caller = { accountId: id(2), email: 'd@x', name: 'D', profiles: ['all_users', 'profile_3'], records: { object_1: id(2), object_3: id(21) } };
const admin: Caller = { accountId: id(3), email: 'a@x', name: 'A', profiles: ['all_users', 'profile_6'], records: { object_1: id(3), object_6: id(31) } };
const nobody: Caller = { accountId: id(4), email: 'n@x', name: 'N', profiles: ['all_users'], records: { object_1: id(4) } };

/** A fake Knack client holding a few records. */
const records: Record<string, Record<string, Record<string, unknown>>> = {
  object_2: {
    [id(11)]: { id: id(11), field_5_raw: [{ id: id(21) }] }, // patient of doctor 21
    [id(12)]: { id: id(12), field_5_raw: [{ id: id(99) }] }, // someone else's patient
  },
};
const knack = { get: async (o: string, i: string) => (records[o]?.[i] as never) ?? null } as never;

const appts = model.byObject.get('object_4')!;
const results = model.byObject.get('object_5')!;
const patients = model.byObject.get('object_2')!;

test('public pages grant nothing', () => {
  // The Home page lists every appointment; nobody may use it.
  assert.equal(policy.can(nobody, 'object_4', 'read'), false);
});

test('orphaned pages grant nothing', () => {
  assert.equal(policy.can(patient, 'object_5', 'create'), false);
  assert.ok(derived.warnings.some((w) => w.includes('(stray) is orphaned')));
});

test('patient list scope is a flat AND on their own record', async () => {
  const scope = await policy.listScope(patient, appts, null, knack);
  assert.deepEqual(scope, { kind: 'filter', match: 'and', rules: [{ field: 'field_10', operator: 'is', value: id(11) }] });
});

test('patient readable fields are the columns their page shows', () => {
  const fields = policy.readFields(patient, 'object_4');
  assert.ok(fields.has('field_9') && fields.has('field_11') && fields.has('field_12'));
  assert.equal(fields.has('field_13'), false, 'Internal is not on any patient page');
});

test('patient record check: own yes, other no', async () => {
  const mine = { id: id(50), field_10_raw: [{ id: id(11) }] };
  const theirs = { id: id(51), field_10_raw: [{ id: id(12) }] };
  assert.equal(await policy.allows(patient, appts, mine as never, 'read', knack), true);
  assert.equal(await policy.allows(patient, appts, theirs as never, 'read', knack), false);
  assert.equal(await policy.allows(patient, appts, mine as never, 'delete', knack), false, 'no delete link on patient pages');
});

test('patient create forces the connection and carries the form rule', async () => {
  const { forced, rules } = await policy.createScope(patient, appts, { field_10: [id(12)] }, knack);
  assert.deepEqual(forced, { field_10: [id(11)] }, 'client-supplied patient is overwritten');
  assert.deepEqual(rules, [{ type: 'value', field: 'field_12', value: 'Scheduled' }]);
});

test('doctor child list needs a parent they can read', async () => {
  await assert.rejects(policy.listScope(doctor, results, null, knack), /parent/);
  const ok = await policy.listScope(doctor, results, { field: 'field_15', id: id(11) }, knack);
  assert.deepEqual(ok, { kind: 'filter', match: 'and', rules: [{ field: 'field_15', operator: 'is', value: id(11) }] });
  await assert.rejects(policy.listScope(doctor, results, { field: 'field_15', id: id(12) }, knack), /Not found/);
});

test('doctor details page: readable only for their own patients', async () => {
  assert.equal(await policy.canRead(doctor, patients, id(11), knack), true);
  assert.equal(await policy.canRead(doctor, patients, id(12), knack), false);
});

test('doctor create under a parent applies "Doctor = me"', async () => {
  const { forced, rules } = await policy.createScope(doctor, results, { field_15: [id(11)] }, knack);
  assert.deepEqual(forced, { field_15: [id(11)] });
  assert.deepEqual(rules, [{ type: 'user', field: 'field_16', userObject: 'object_3' }]);
  await assert.rejects(policy.createScope(doctor, results, { field_15: [id(12)] }, knack));
});

test('scope rules are never nested (Knack ignores nested groups)', async () => {
  for (const caller of [patient, doctor, admin]) {
    for (const entity of model.entities) {
      const scope = await policy.listScope(caller, entity, null, knack).catch(() => null);
      if (scope?.kind === 'filter') for (const r of scope.rules) assert.equal('rules' in r, false);
    }
  }
});

test('Headless Admin has everything; no-role users have nothing', async () => {
  for (const e of model.entities) {
    assert.equal(policy.can(admin, e.objectKey, 'delete'), true);
    assert.equal(policy.can(nobody, e.objectKey, 'read'), false);
  }
  assert.equal(policy.readFields(admin, 'object_4').has('field_13'), true);
});

test('dates, names and slugs', () => {
  assert.equal(model.timezone, 'America/New_York');
  assert.equal(appts.slug, 'appointments');
  assert.equal(appts.byKey.get('field_9')!.slug, 'when');
  assert.equal(patients.byKey.get('field_6')!.slug, 'secretNote');
});
