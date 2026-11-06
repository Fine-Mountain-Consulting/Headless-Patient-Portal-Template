import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, carryForward, checkTemplate, diffSnapshots, type AppSnapshot } from '../dist/index.js';
import { snapshot } from './fixture.ts';

const base = carryForward(null, structuredClone(snapshot) as unknown as AppSnapshot);
const manifest = {
  template: 'test',
  roles: { patient: 'Patients' },
  entities: { Appointments: ['When', 'Status'] },
  optional: { Results: ['Title'] },
};

const edit = (fn: (s: AppSnapshot) => void): AppSnapshot => {
  const next = structuredClone(base) as AppSnapshot;
  delete next.slugs;
  fn(next);
  return carryForward(base, next);
};
const field = (s: AppSnapshot, key: string) => s.objects.flatMap((o) => o.fields).find((f) => f.key === key)!;

test('a renamed field keeps its slug, so screens keep working', () => {
  const renamed = edit((s) => {
    field(s, 'field_9').name = 'Visit Date';
  });
  const model = buildModel(renamed);
  const appts = model.byObject.get('object_4')!;
  assert.equal(appts.byKey.get('field_9')!.slug, 'when');
  assert.equal(appts.byKey.get('field_9')!.name, 'Visit Date');
  const check = checkTemplate(model, manifest);
  assert.deepEqual(check.problems, []);
  assert.deepEqual(check.renamed, ['"Appointments.When" is now called "Visit Date".']);
  assert.deepEqual(diffSnapshots(base, renamed), ['Field renamed: "Appointments.When" → "Visit Date".']);
});

test('a renamed table keeps its slug', () => {
  const renamed = edit((s) => {
    s.objects.find((o) => o.key === 'object_4')!.name = 'Visits';
  });
  assert.equal(buildModel(renamed).byObject.get('object_4')!.slug, 'appointments');
});

test('a new field gets a fresh slug that does not steal a locked one', () => {
  const added = edit((s) => {
    field(s, 'field_9').name = 'Visit Date';
    s.objects.find((o) => o.key === 'object_4')!.fields.push({ key: 'field_99', name: 'When', type: 'short_text' });
  });
  const appts = buildModel(added).byObject.get('object_4')!;
  assert.equal(appts.byKey.get('field_9')!.slug, 'when');
  assert.notEqual(appts.byKey.get('field_99')!.slug, 'when');
  assert.ok(diffSnapshots(base, added).includes('Field added: "Appointments.When".'));
});

test('deleting a required field is a problem; an optional one only switches a feature off', () => {
  const deleted = edit((s) => {
    const a = s.objects.find((o) => o.key === 'object_4')!;
    a.fields = a.fields.filter((f) => f.key !== 'field_12');
    const r = s.objects.find((o) => o.key === 'object_5')!;
    r.fields = r.fields.filter((f) => f.key !== 'field_14');
  });
  const check = checkTemplate(buildModel(deleted), manifest);
  assert.deepEqual(check.problems, ['"Appointments" is missing the "Status" field.']);
  assert.deepEqual(check.missingOptional, ['"Results" is missing the "Title" field.']);
  assert.ok(diffSnapshots(base, deleted).includes('Field deleted: "Appointments.Status".'));
});

test('changed choices and changed pages are reported', () => {
  const changed = edit((s) => {
    field(s, 'field_12').format = { options: ['Scheduled', 'Cancelled', 'No-show'] };
    s.scenes.find((sc) => sc.slug === 'patient-portal')!.views.pop();
  });
  const diff = diffSnapshots(base, changed);
  assert.ok(diff.includes('Choices changed: "Appointments.Status".'));
  assert.ok(diff.includes('Page changed: "Patient Portal".'));
});

test('no changes, no diff', () => {
  assert.deepEqual(diffSnapshots(base, edit(() => undefined)), []);
});
