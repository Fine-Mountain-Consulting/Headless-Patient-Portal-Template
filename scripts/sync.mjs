// Pull the Knack app's metadata (schema + pages) into .knack/snapshot.json,
// check it against the template manifest, and print the access it implies.
//
//   KNACK_APP_ID=... npm run sync
//
// The loader endpoint is public, so this needs no API key.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const core = await import('../packages/core/dist/index.js').catch(() => {
  console.error('Build core first: npm run build -w @headless/core');
  process.exit(1);
});

if (existsSync('.env')) process.loadEnvFile('.env');
const appId = process.env.KNACK_APP_ID;
if (!appId) {
  console.error('Set KNACK_APP_ID (in .env or the environment).');
  process.exit(1);
}

const fresh = await core.fetchSnapshot(appId, process.env.KNACK_LOADER_URL || undefined);

// ── Template manifest ──────────────────────────────────────────────────────
const template = process.env.TEMPLATE ?? 'patient-portal';
const manifest = JSON.parse(await readFile(`templates/${template}/manifest.json`, 'utf8'));
fresh.template = manifest;

// Carry the friendly-name lock forward from the last sync of this app, so a
// field renamed in Knack keeps the name the screens use.
const previous = existsSync('.knack/snapshot.json') ? JSON.parse(await readFile('.knack/snapshot.json', 'utf8')) : null;
const snapshot = core.carryForward(previous?.id === fresh.id ? previous : null, fresh);
const model = core.buildModel(snapshot);
const derived = core.derivePolicy(snapshot, model);
const check = core.checkTemplate(model, manifest);

console.log(`\n${snapshot.name} (${snapshot.id}) · time zone ${model.timezone}`);
if (model.timezone === 'UTC' && snapshot.settings.timezone && snapshot.settings.timezone !== 'UTC') {
  console.warn(`  ! Unknown Knack time zone "${snapshot.settings.timezone}"; times will show in UTC. Add it to RAILS_TO_IANA.`);
}
if (previous?.id === fresh.id) {
  const changes = core.diffSnapshots(previous, snapshot);
  console.log(changes.length ? `\nChanged in Knack since the last sync:\n${changes.map((c) => `  · ${c}`).join('\n')}` : '\nNo changes in Knack since the last sync.');
}
for (const r of check.renamed) console.log(`  ↻ ${r} (still mapped)`);
for (const m of check.missingOptional) console.warn(`  ! ${m} A feature that uses it is switched off.`);

if (check.problems.length) {
  console.error(`\nThe Knack app doesn't match the "${template}" template:`);
  for (const p of check.problems) console.error(`  ✗ ${p}`);
  console.error('\nAdd them back in the Knack Builder, then sync again.');
  process.exit(1);
}

await mkdir('.knack', { recursive: true });
await writeFile('.knack/snapshot.json', JSON.stringify(snapshot));

console.log(`\nAccess derived from your Knack pages:`);
for (const role of derived.roles.values()) {
  if (role.profileKey === 'all_users') continue;
  const entities = [...role.entities.entries()]
    .map(([key, a]) => {
      const name = model.byObject.get(key).name;
      const acts = ['read', 'create', 'update', 'delete'].filter((x) => a.grants[x].length).map((x) => x[0].toUpperCase());
      return acts.length ? `${name} ${acts.join('')}` : null;
    })
    .filter(Boolean);
  console.log(`  ${role.admin ? '★' : '•'} ${role.roleName}: ${entities.length ? entities.join(', ') : 'no access'}`);
}
if (derived.warnings.length) {
  console.warn('\nWarnings:');
  for (const w of derived.warnings) console.warn(`  ! ${w}`);
}
const features = core.applyFeatures(core.derivePolicy(snapshot, model), model, manifest, {});
if (features.length) {
  console.log('\nPortal features (switched on by a Headless Admin in the portal):');
  for (const f of features) {
    console.log(`  ${f.available ? '•' : '✗'} ${f.title}${f.available ? '' : ` (can't be switched on: ${f.problems.join(' ')})`}`);
  }
}
console.log('\nSnapshot written to .knack/snapshot.json (git-ignored). Run "npm run access" for the full report.\n');
