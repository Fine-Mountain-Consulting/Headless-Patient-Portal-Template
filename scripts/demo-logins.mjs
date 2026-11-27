// Create (or reset) one demo login per role, for a DEMO deployment that holds
// synthetic data only.
//
//   KNACK_API_KEY=... node scripts/demo-logins.mjs --password '<demo password>'
//
// Each login is a record in that role's Knack object (Patients, Doctors,
// Medical Staff, Headless Admin), with an @example.com address. Running it
// again resets the password and leaves everything else alone. The demo patient
// is connected to the demo doctor so both see the same records.
//
// It prints a DEMO_LOGINS line for .env (git-ignored); the sign-in page shows
// those logins when DEMO_MODE=true. Nothing here is written to the repo.
//
// NEVER run this against a HIPAA tenant: it refuses the GovCloud host.
import { existsSync, readFileSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const password = arg('--password');
const APP = process.env.KNACK_APP_ID;
const KEY = process.env.KNACK_API_KEY;
const HOST = (process.env.KNACK_API_HOST || 'https://api.knack.com/v1').replace(/\/+$/, '');

if (!password) throw new Error("Usage: demo-logins.mjs --password '<demo password>'");
if (!APP || !KEY) throw new Error('Set KNACK_APP_ID and KNACK_API_KEY (pass the key on the command line, never in a file).');
if (/usgc/i.test(HOST)) throw new Error('Refusing to create demo logins on a HIPAA/GovCloud tenant.');

const snapshot = JSON.parse(readFileSync('.knack/snapshot.json', 'utf8'));
const manifest = snapshot.template; // sync embeds the template manifest

const LOGINS = [
  { role: 'patient', label: 'Patient', first: 'Demo', last: 'Patient' },
  { role: 'doctor', label: 'Doctor', first: 'Demo', last: 'Doctor' },
  { role: 'staff', label: 'Medical staff', first: 'Demo', last: 'Staff' },
  { role: 'admin', label: 'Admin', first: 'Demo', last: 'Admin' },
];

const H = { 'X-Knack-Application-Id': APP, 'X-Knack-REST-API-Key': KEY, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, body) => {
  await sleep(150);
  const r = await fetch(`${HOST}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

const objectFor = (roleKey) => {
  const name = manifest.roles[roleKey];
  const o = snapshot.objects.find((x) => x.name === name);
  if (!o) throw new Error(`No Knack object "${name}" for role ${roleKey}`);
  const f = (field) => o.fields.find((y) => y.name === field)?.key;
  return { key: o.key, name, f };
};

const ids = {};
const lines = [];
for (const login of LOGINS) {
  const o = objectFor(login.role);
  const email = `demo.${login.role}@example.com`;
  const values = {
    [o.f('Name')]: { first: login.first, last: login.last },
    [o.f('Email')]: email,
    [o.f('Password')]: password,
    [o.f('User Status')]: 'active',
  };
  const filters = encodeURIComponent(JSON.stringify({ match: 'and', rules: [{ field: o.f('Email'), operator: 'is', value: email }] }));
  const [existing] = (await call('GET', `/objects/${o.key}/records?rows_per_page=2&filters=${filters}`)).records;
  const record = existing
    ? await call('PUT', `/objects/${o.key}/records/${existing.id}`, values)
    : await call('POST', `/objects/${o.key}/records`, values);
  ids[login.role] = record.id;
  console.log(`  ${existing ? 'reset  ' : 'created'} ${login.label.padEnd(14)} ${email}`);
  lines.push(`${login.label}|${email}|${password}`);
}

// The demo patient's primary doctor is the demo doctor.
const patients = objectFor('patient');
if (patients.f('Doctor') && ids.doctor) {
  await call('PUT', `/objects/${patients.key}/records/${ids.patient}`, { [patients.f('Doctor')]: [ids.doctor] });
}

console.log(`\nAdd to .env (never commit it):\n\nDEMO_MODE=true\nDEMO_LOGINS=${lines.join(';')}\n`);
console.log('Then fill the demo patient with synthetic records:\n');
console.log('  KNACK_API_KEY=... node scripts/seed-demo.mjs --email demo.patient@example.com --doctor demo.doctor@example.com --staff demo.staff@example.com\n');
