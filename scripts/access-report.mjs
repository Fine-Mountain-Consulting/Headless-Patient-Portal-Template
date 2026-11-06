// Full access report: per role, per object, which records, actions and fields,
// and which Knack views granted them. Reads .knack/snapshot.json.
import { readFile } from 'node:fs/promises';
const core = await import('../packages/core/dist/index.js');
const snapshot = JSON.parse(await readFile('.knack/snapshot.json', 'utf8'));
const model = core.buildModel(snapshot);
const derived = core.derivePolicy(snapshot, model);

const describe = (entity, grant) =>
  grant.length === 0
    ? 'all records'
    : grant
        .map((c) => {
          const f = c.field ? entity.byKey.get(c.field)?.name : '';
          if (c.type === 'user') return `${f} = me`;
          if (c.type === 'self') return 'my own record';
          if (c.type === 'parent') return `${f} is a ${model.byObject.get(c.parentObject)?.name} I can see`;
          if (c.type === 'readable') return 'a record I can see';
          return `${f} ${c.operator} ${JSON.stringify(c.value)}`;
        })
        .join(' AND ');

const only = process.argv[2];
for (const role of derived.roles.values()) {
  if (only && !role.roleName.toLowerCase().includes(only.toLowerCase())) continue;
  console.log(`\n══ ${role.roleName} (${role.profileKey})${role.admin ? ' — full access' : ''}`);
  if (role.admin) continue;
  for (const [key, a] of role.entities) {
    const entity = model.byObject.get(key);
    console.log(`\n  ${entity.name}`);
    for (const action of ['read', 'create', 'update', 'delete']) {
      const g = a.grants[action];
      if (g.length) console.log(`    ${action.padEnd(6)} ${g.map((x) => describe(entity, x)).join('  |  ')}`);
    }
    const names = (s) => entity.fields.filter((f) => s.has(f.key)).map((f) => f.name).join(', ') || '—';
    console.log(`    fields read:   ${names(a.readFields)}`);
    if (a.createFields.size) console.log(`    fields create: ${names(a.createFields)}`);
    if (a.updateFields.size) console.log(`    fields update: ${names(a.updateFields)}`);
  }
}
for (const w of derived.warnings) console.warn(`\n! ${w}`);
