// First-time setup and health check. Safe to run any number of times.
//
//   npm run setup -- --app-id <24-char Knack app id> --test     # synthetic data, commercial host
//   npm run setup -- --app-id <24-char Knack app id> --hipaa    # real patients, HIPAA/GovCloud host
//   KNACK_API_KEY=... npm run setup                            # re-check, including live Knack checks
//
// Creates .env from .env.example if it doesn't exist (with a fresh session
// secret), builds core, syncs the Knack app, and checks everything the portal
// needs. Each line is ✔ done, ! worth knowing, or ✗ blocking, with the fix.
//
// It never writes KNACK_API_KEY anywhere: pass it on the command line.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const HELP = 'Need help? Fine Mountain Consulting can configure and install it for you: https://finemountainconsulting.com';
const COMMERCIAL = 'https://api.knack.com/v1';
const GOVCLOUD = 'https://usgc-api.knack.com/v1';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const appIdArg = arg('--app-id');
const mode = args.includes('--hipaa') ? 'hipaa' : args.includes('--test') ? 'test' : undefined;

let blocking = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const note = (m) => console.log(`  ! ${m}`);
const fail = (m, fix) => {
  blocking++;
  console.log(`  ✗ ${m}${fix ? `\n      → ${fix}` : ''}`);
};
const section = (m) => console.log(`\n${m}`);

// ── Machine ───────────────────────────────────────────────────────────────
section('Machine');
const major = Number(process.versions.node.split('.')[0]);
major >= 22 ? ok(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node} is too old.`, 'Install Node 22 or newer.');
existsSync('node_modules') ? ok('Dependencies installed') : fail('Dependencies not installed.', 'Run: npm install');
if (blocking) finish();

// ── .env ──────────────────────────────────────────────────────────────────
section('Configuration (.env)');
const setVar = (text, key, value) =>
  new RegExp(`^${key}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;

if (!existsSync('.env')) {
  if (!appIdArg || !mode) {
    fail(
      'No .env yet.',
      'Run: npm run setup -- --app-id <your Knack app id> --test   (synthetic data)\n' +
        '        or: npm run setup -- --app-id <your Knack app id> --hipaa  (real patients, HIPAA tenant)\n' +
        '        The app id is in the Knack Builder URL, or under Settings → API & Code.',
    );
    finish();
  }
  let env = readFileSync('.env.example', 'utf8');
  env = setVar(env, 'KNACK_APP_ID', appIdArg);
  env = setVar(env, 'SESSION_SECRET', randomBytes(48).toString('base64'));
  env = setVar(env, 'COMPLIANCE_TIER', 'hipaa');
  env = setVar(env, 'KNACK_API_HOST', mode === 'hipaa' ? GOVCLOUD : COMMERCIAL);
  env = setVar(env, 'ALLOW_COMMERCIAL_HOST_FOR_DEMO', mode === 'test' ? 'true' : 'false');
  // The key is never stored: drop its line (and its comment) from the copy.
  env = env.replace(/^# The REST API key IS secret.*\n(#.*\n)*KNACK_API_KEY=.*\n/m, '').replace(/^KNACK_API_KEY=.*\n/m, '');
  writeFileSync('.env', env, { mode: 0o600 });
  ok(`Created .env for a ${mode === 'hipaa' ? 'HIPAA (GovCloud)' : 'test (synthetic data)'} app, with a new session secret`);
} else {
  ok('.env exists (left as is)');
  if (appIdArg) note('--app-id ignored because .env already exists. Edit KNACK_APP_ID in .env to change apps.');
}

const fileEnv = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
if (fileEnv.KNACK_API_KEY) {
  fail('.env contains KNACK_API_KEY. The key must never be stored in a file.', 'Delete that line from .env and pass the key on the command line instead.');
}
const env = { ...fileEnv, ...process.env };
const key = process.env.KNACK_API_KEY?.trim();
const host = (env.KNACK_API_HOST || COMMERCIAL).replace(/\/+$/, '');
const appId = env.KNACK_APP_ID ?? '';

/^[a-f0-9]{24}$/i.test(appId) ? ok(`Knack app id ${appId}`) : fail('KNACK_APP_ID is missing or malformed in .env.', 'It is 24 hex characters, from the Knack Builder URL.');
(env.SESSION_SECRET ?? '').length >= 32 ? ok('Session secret set') : fail('SESSION_SECRET is shorter than 32 characters.', 'Set it to the output of: openssl rand -base64 48');
if (host === GOVCLOUD) ok('Knack host: HIPAA/GovCloud');
else if (env.ALLOW_COMMERCIAL_HOST_FOR_DEMO === 'true' || env.COMPLIANCE_TIER === 'standard') {
  ok('Knack host: commercial');
  note('This setup is for synthetic demo data only. For real patients use a Knack HIPAA plan and run setup with --hipaa.');
} else {
  fail('COMPLIANCE_TIER=hipaa but KNACK_API_HOST is the commercial host.', `For a HIPAA tenant set KNACK_API_HOST=${GOVCLOUD}; for a test app with synthetic data set ALLOW_COMMERCIAL_HOST_FOR_DEMO=true.`);
}
if (env.DEMO_MODE === 'true') note('DEMO_MODE is on: the sign-in page shows the demo notice and demo logins.');
if (blocking) finish();

// ── Knack app structure ───────────────────────────────────────────────────
section('Knack app');
const run = (cmd, cmdArgs) => spawnSync(cmd, cmdArgs, { stdio: 'inherit', env: { ...process.env, KNACK_API_KEY: '' } });
if (!existsSync('packages/core/dist/index.js')) {
  console.log('  Building core…');
  if (run('npm', ['run', 'build', '-w', '@headless/core', '--silent']).status !== 0) {
    fail('Core did not build.', 'Run: npm run build -w @headless/core, and fix the errors it prints.');
    finish();
  }
}
const sync = run('node', ['scripts/sync.mjs']);
if (sync.status !== 0) {
  fail(
    'Sync failed (see above).',
    'If it lists missing tables or fields, add them in the Knack Builder (or with the Knack MCP server; see AGENTS.md). ' +
      'A missing "Headless Admin" table is the usual one on a fresh Patient Portal app.',
  );
  finish();
}
ok('Knack app matches the Patient Portal template');

// ── Live checks (need the REST key) ───────────────────────────────────────
section('Live Knack checks');
if (!key) {
  note('KNACK_API_KEY not set, so the key and the Headless Admin user were not checked.');
  note('Re-run with the key: KNACK_API_KEY=<key> npm run setup   (Knack Builder → Settings → API & Code)');
} else {
  const snapshot = JSON.parse(readFileSync('.knack/snapshot.json', 'utf8'));
  const adminName = snapshot.template?.roles?.admin ?? 'Headless Admin';
  const admin = snapshot.objects.find((o) => o.name === adminName);
  const field = (name) => admin?.fields.find((f) => f.name === name)?.key;
  const headers = { 'X-Knack-Application-Id': appId, 'X-Knack-REST-API-Key': key };
  try {
    const filters = field('User Status')
      ? `&filters=${encodeURIComponent(JSON.stringify({ match: 'and', rules: [{ field: field('User Status'), operator: 'is', value: 'active' }] }))}`
      : '';
    const r = await fetch(`${host}/objects/${admin.key}/records?rows_per_page=1${filters}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (r.status === 401 || r.status === 403) {
      fail(`Knack refused the REST key (${r.status}).`, `Copy it again from Knack Builder → Settings → API & Code, and check KNACK_API_HOST (${host}) matches the app's tenant.`);
    } else if (!r.ok) {
      fail(`Knack answered ${r.status}.`, `Check KNACK_API_HOST (${host}) and KNACK_APP_ID.`);
    } else {
      ok('REST key accepted');
      const total = (await r.json()).total_records ?? 0;
      total > 0
        ? ok(`${total} active ${adminName} user${total === 1 ? '' : 's'} (can sign in and switch on portal features)`)
        : fail(`No active ${adminName} user, so nobody can administer the portal.`, `Add yourself as a record in the "${adminName}" table in Knack (name, email, password, status Active).`);
    }
  } catch (e) {
    fail(`Could not reach Knack at ${host}: ${e.message}`);
  }
}

finish();

function finish() {
  if (blocking) {
    console.log(`\n${blocking} thing${blocking === 1 ? '' : 's'} to fix (✗ above). Fix, then run npm run setup again.\n${HELP}\n`);
    process.exit(1);
  }
  console.log(`\nReady. Start it with:\n\n  KNACK_API_KEY=<key> npm run dev\n\nthen open http://localhost:5173 and sign in as a Headless Admin user.\n${HELP}\n`);
  process.exit(0);
}
