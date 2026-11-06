// Seed a demo patient with SYNTHETIC records that exercise every workflow:
// appointments (past, today, upcoming, cancelled), test results, medications,
// messages, documents, emergency contacts and visit notes.
//
//   KNACK_API_KEY=... node scripts/seed-demo.mjs --email patient@example.com
//   KNACK_API_KEY=... node scripts/seed-demo.mjs --email patient@example.com --remove
//
// The patient must already exist (a Patients record with that email). Doctors
// and staff are taken from the app's existing records. Every id created is
// written to .knack/seed-<email>.json so --remove can delete exactly those.
//
// NEVER run this against a HIPAA tenant: it refuses the GovCloud host.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const args = process.argv.slice(2);
const email = args[args.indexOf('--email') + 1];
const remove = args.includes('--remove');
const APP = process.env.KNACK_APP_ID;
const KEY = process.env.KNACK_API_KEY;
const HOST = (process.env.KNACK_API_HOST || 'https://api.knack.com/v1').replace(/\/+$/, '');

if (!email || args.indexOf('--email') === -1) throw new Error('Usage: seed-demo.mjs --email <patient email> [--remove]');
if (!APP || !KEY) throw new Error('Set KNACK_APP_ID and KNACK_API_KEY (pass the key on the command line, never in a file).');
if (/usgc/i.test(HOST)) throw new Error('Refusing to seed demo data on a HIPAA/GovCloud tenant.');

const snapshot = JSON.parse(readFileSync('.knack/snapshot.json', 'utf8'));
const obj = (name) => {
  const o = snapshot.objects.find((x) => x.name === name);
  if (!o) throw new Error(`No object "${name}"`);
  return { key: o.key, f: (field) => {
    const x = o.fields.find((y) => y.name === field);
    if (!x) throw new Error(`No field "${name}.${field}"`);
    return x.key;
  } };
};
const O = {
  patients: obj('Patients'),
  doctors: obj('Doctors'),
  staff: obj('Medical Staff'),
  appts: obj('Appointments'),
  results: obj('Test Results'),
  rx: obj('Prescriptions'),
  messages: obj('Messages'),
  docs: obj('Documents'),
  contacts: obj('Emergency Contacts'),
  notes: obj('Notes'),
};

const H = { 'X-Knack-Application-Id': APP, 'X-Knack-REST-API-Key': KEY, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, body) => {
  await sleep(150); // stay well under Knack's ~10 req/s for the whole app
  const r = await fetch(`${HOST}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};
const find = async (o, rules) =>
  (await call('GET', `/objects/${o.key}/records?rows_per_page=100&filters=${encodeURIComponent(JSON.stringify({ match: 'and', rules }))}`)).records;

const ledgerPath = `.knack/seed-${email.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.json`;

// ── Remove ────────────────────────────────────────────────────────────────
if (remove) {
  if (!existsSync(ledgerPath)) throw new Error(`Nothing to remove: ${ledgerPath} not found.`);
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  for (const { object, id } of ledger.created.reverse()) {
    await call('DELETE', `/objects/${object}/records/${id}`).catch((e) => console.warn(`  skip ${object}/${id}: ${e.message.slice(0, 80)}`));
  }
  console.log(`Removed ${ledger.created.length} demo records. The patient's own record was left as is.`);
  writeFileSync(ledgerPath.replace('.json', '.removed.json'), JSON.stringify(ledger, null, 2));
  process.exit(0);
}

// ── Dates, in the app's time zone ─────────────────────────────────────────
// Knack interprets {date, hours, minutes, am_pm} in the app's time zone, so we
// compute calendar days in that zone too.
const zone = 'America/New_York';
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const day = (offset) => {
  const d = new Date(`${ymd(new Date())}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const us = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const at = (offset, h, m = 0) => ({ date: us(day(offset)), hours: String(h % 12 === 0 ? 12 : h % 12), minutes: String(m).padStart(2, '0'), am_pm: h < 12 ? 'AM' : 'PM' });
const dateOnly = (offset) => ({ date: us(day(offset)) });

// ── People ────────────────────────────────────────────────────────────────
const [patient] = await find(O.patients, [{ field: O.patients.f('Email'), operator: 'is', value: email.toLowerCase() }]);
if (!patient) throw new Error(`No Patients record with email ${email}. Add the patient in Knack first.`);
const doctors = (await call('GET', `/objects/${O.doctors.key}/records?rows_per_page=100`)).records;
const staff = (await call('GET', `/objects/${O.staff.key}/records?rows_per_page=100`)).records;
const byName = (list, field, re) => list.find((r) => re.test(r[`${field}_raw`]?.full ?? '')) ?? list[0];
const primary = byName(doctors, O.doctors.f('Name'), /doolittle/i);
const cardio = doctors.find((d) => d[`${O.doctors.f('Specialty')}_raw`] === 'Cardiology') ?? doctors[1];
const derm = doctors.find((d) => d[`${O.doctors.f('Specialty')}_raw`] === 'Dermatology') ?? doctors[2];
const nurse = byName(staff, O.staff.f('Name'), /nurse/i);
const P = patient.id;

const created = [];
const create = async (o, values, label) => {
  const r = await call('POST', `/objects/${o.key}/records`, values);
  created.push({ object: o.key, id: r.id, label });
  return r.id;
};

console.log(`Seeding demo data for patient ${P} (primary doctor ${primary.id})…`);

// The patient's own profile: fill in what's empty, never overwrite.
const pf = (n) => O.patients.f(n);
const profile = {};
if (!patient[`${pf('Doctor')}_raw`]?.length) profile[pf('Doctor')] = [primary.id];
if (!patient[pf('Date of Birth')]) profile[pf('Date of Birth')] = { date: '06/14/1984' };
if (!patient[pf('Phone')]) profile[pf('Phone')] = '(555) 014-2266';
if (!patient[pf('Address')]) profile[pf('Address')] = { street: '100 Demo Way', city: 'Springfield', state: 'VT', zip: '05156' };
if (!patient[pf('Emergency Contact')]) profile[pf('Emergency Contact')] = 'Jordan Marshall (spouse)';
if (!patient[pf('Emergency Phone')]) profile[pf('Emergency Phone')] = '(555) 019-9001';
if (Object.keys(profile).length) {
  await call('PUT', `/objects/${O.patients.key}/records/${P}`, profile);
  console.log(`  profile: filled ${Object.keys(profile).length} empty fields`);
}

// ── Appointments ──────────────────────────────────────────────────────────
const af = (n) => O.appts.f(n);
const appt = (offset, h, m, doc, reason, status, minutes, notes = '') =>
  create(O.appts, {
    [af('Date of Appointment')]: at(offset, h, m),
    [af('Patient')]: [P],
    [af('Doctor')]: [doc.id],
    [af('Reason for Appointment')]: reason,
    [af('Status')]: status,
    [af('Duration')]: minutes,
    [af('Notes')]: notes,
    [af('Created By - Medical Staff')]: [nurse.id],
  }, `appointment ${reason}`);

const aPhysical = await appt(-60, 10, 0, primary, 'Annual physical', 'Completed', 45, 'Fasting labs drawn at visit.');
const aCardio = await appt(-21, 14, 30, cardio, 'Cardiology consult: occasional palpitations', 'Completed', 60);
const aFollow = await appt(-10, 9, 15, primary, 'Follow-up on lab results', 'Completed', 30);
await appt(-5, 11, 0, primary, 'Flu shot', 'Cancelled', 15, 'Patient rescheduled by phone.');
await appt(0, 17, 0, primary, 'Blood pressure check', 'Scheduled', 20, 'Bring your home BP log.');
await appt(3, 9, 30, cardio, 'Review Holter monitor results', 'Scheduled', 30);
await appt(16, 10, 0, primary, '6-week follow-up: blood pressure and medication', 'Scheduled', 30);
await appt(45, 13, 0, derm, 'Annual skin check', 'Scheduled', 20);
console.log('  appointments: 8');

// ── Test results ──────────────────────────────────────────────────────────
const rf = (n) => O.results.f(n);
const table = (rows) =>
  `<table><thead><tr><th>Test</th><th>Result</th><th>Reference range</th></tr></thead><tbody>${rows
    .map(([t, v, r]) => `<tr><td>${t}</td><td>${v}</td><td>${r}</td></tr>`)
    .join('')}</tbody></table>`;
const result = (type, offset, doc, status, html, ref) =>
  create(O.results, {
    [rf('Patient')]: [P],
    [rf('Doctor')]: [doc.id],
    [rf('Test Type')]: type,
    [rf('Test Date')]: at(offset, 8, 30),
    [rf('Results')]: html,
    [rf('Status')]: status,
    [rf('Lab Reference Number')]: ref,
    [rf('Added By - Medical Staff')]: [nurse.id],
  }, `result ${type}`);

await result('Complete Blood Count (CBC)', -59, primary, 'Reviewed',
  `<p><strong>All values within normal limits.</strong></p>${table([['WBC', '6.4 K/µL', '4.0–11.0'], ['Hemoglobin', '14.1 g/dL', '13.5–17.5'], ['Platelets', '251 K/µL', '150–400']])}`, 'DEMO-LAB-10231');
await result('Lipid Panel', -59, primary, 'Reviewed',
  `<p>LDL is slightly above target. We’ll start a statin and recheck in 3 months.</p>${table([['Total cholesterol', '212 mg/dL', '&lt; 200'], ['LDL', '138 mg/dL', '&lt; 100'], ['HDL', '52 mg/dL', '&gt; 40'], ['Triglycerides', '110 mg/dL', '&lt; 150']])}`, 'DEMO-LAB-10232');
await result('Hemoglobin A1C', -59, primary, 'Completed',
  `<p>A1C <strong>5.6%</strong>. Normal (below 5.7%).</p>`, 'DEMO-LAB-10233');
await result('Electrocardiogram (EKG)', -21, cardio, 'Reviewed',
  `<p>Normal sinus rhythm, rate 72. No acute changes. Occasional premature atrial contractions, which are usually harmless. A 48-hour Holter monitor was ordered.</p>`, 'DEMO-CARD-5521');
await result('Thyroid Panel', -9, primary, 'Pending', '', 'DEMO-LAB-10301');
console.log('  test results: 5');

// ── Prescriptions ─────────────────────────────────────────────────────────
const xf = (n) => O.rx.f(n);
const rx = (name, dose, html, offset, refills, status, doc) =>
  create(O.rx, {
    [xf('Patient')]: [P],
    [xf('Doctor')]: [doc.id],
    [xf('Medication Name')]: name,
    [xf('Dosage')]: dose,
    [xf('Instructions')]: html,
    [xf('Date Prescribed')]: dateOnly(offset),
    [xf('Refills Remaining')]: refills,
    [xf('Status')]: status,
    [xf('Logged By - Medical Staff')]: [nurse.id],
  }, `rx ${name}`);

await rx('Lisinopril', '10 mg tablet, once daily', '<p>Take one tablet by mouth every morning. Check your blood pressure at home twice a week and bring the log to your next visit.</p><p>Call us if you feel dizzy or develop a dry cough.</p>', -10, 3, 'Active', primary);
await rx('Atorvastatin', '20 mg tablet, once daily at bedtime', '<p>Take one tablet at bedtime. Avoid large amounts of grapefruit juice.</p>', -58, 1, 'Active', primary);
await rx('Metoprolol succinate', '25 mg extended-release, once daily', '<p>Take one tablet daily. Do not crush or chew. Do not stop suddenly.</p>', -20, 0, 'Active', cardio);
await rx('Amoxicillin', '500 mg capsule, three times daily for 10 days', '<p>Finish the full course even if you feel better.</p>', -120, 0, 'Completed', primary);
console.log('  prescriptions: 4');

// ── Messages ──────────────────────────────────────────────────────────────
const mf = (n) => O.messages.f(n);
const msg = (doc, subject, html, offset, h, priority, read, fromStaff = false) =>
  create(O.messages, {
    [mf('Doctor')]: doc ? [doc.id] : [],
    [mf('Patient')]: [P],
    [mf('Subject')]: subject,
    [mf('Message Content')]: html,
    [mf('Date Sent')]: at(offset, h, 5),
    [mf('Priority')]: priority,
    [mf('Read Status')]: read,
    [mf('Medical Staff')]: fromStaff ? [nurse.id] : [],
  }, `message ${subject}`);

await msg(primary, 'Your lab results are in', '<p>Hi! Your blood count and A1C look great. Your LDL cholesterol is a little high, so I’ve started you on atorvastatin. Details are under Test results.</p><p>Dr. Doolittle</p>', -57, 9, 'Normal', true);
await msg(cardio, 'EKG results', '<p>Your EKG was reassuring. To be thorough we’d like you to wear a Holter monitor for 48 hours. The front desk will call to arrange it.</p>', -20, 15, 'Normal', true);
await msg(primary, 'Starting lisinopril for blood pressure', '<p>Your readings have been consistently above 140/90, so we’re starting lisinopril 10 mg once daily. Please check your blood pressure at home twice a week.</p><p>If you feel lightheaded, sit down and send me a message.</p>', -9, 11, 'High', false);
await msg(null, 'Appointment reminder', '<p>This is a reminder of your blood pressure check <strong>today at 5:00 PM</strong>. Please bring your home BP log. Reply here if you need to reschedule.</p>', -1, 10, 'Normal', false, true);
await msg(primary, 'Question about my refill', '<p>Hi Dr. Doolittle, I have one refill left on atorvastatin. Should I request more now or wait until my follow-up?</p>', -2, 19, 'Low', true);
await msg(cardio, 'Holter monitor instructions', '<p>Please keep the monitor dry and press the event button if you feel palpitations. We’ll review the results at your appointment in a few days.</p>', -3, 14, 'Normal', false);
console.log('  messages: 6');

// ── Documents (synthetic PDFs) ────────────────────────────────────────────
const pdf = (title, lines) => {
  const text = [title, '', ...lines, '', 'DEMO DOCUMENT - SYNTHETIC DATA - NOT A REAL RECORD'];
  const stream = `BT /F1 14 Tf 72 720 Td 18 TL ${text.map((l) => `(${l.replace(/[()\\]/g, '')}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([out], { type: 'application/pdf' });
};
const upload = async (blob, filename) => {
  await sleep(150);
  const form = new FormData();
  form.append('files', blob, filename);
  const r = await fetch(`${HOST}/applications/${APP}/assets/file/upload`, {
    method: 'POST',
    headers: { 'X-Knack-Application-Id': APP, 'X-Knack-REST-API-Key': KEY },
    body: form,
  });
  if (!r.ok) throw new Error(`upload -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).id;
};
const df = (n) => O.docs.f(n);
const doc = async (type, filename, title, lines, offset, description) =>
  create(O.docs, {
    [df('Patient')]: [P],
    [df('Document Type')]: type,
    [df('Upload Date')]: at(offset, 10, 0),
    [df('File')]: await upload(pdf(title, lines), filename),
    [df('Description')]: description,
    [df('Added By - Medical Staff')]: [nurse.id],
  }, `document ${filename}`);

await doc('Insurance Card', 'demo-insurance-card.pdf', 'DEMO HEALTH PLAN - MEMBER CARD', ['Member: Demo Patient', 'Member ID: DEMO-000-1234', 'Group: 99999', 'Plan: PPO Gold (synthetic)'], -61, '<p>Front and back of insurance card, scanned at check-in.</p>');
await doc('Lab Report', 'demo-lipid-panel.pdf', 'DEMO LAB REPORT - LIPID PANEL', ['Total cholesterol 212 mg/dL', 'LDL 138 mg/dL', 'HDL 52 mg/dL', 'Triglycerides 110 mg/dL'], -58, '<p>Full lab report for the lipid panel.</p>');
console.log('  documents: 2');

// ── Emergency contacts ────────────────────────────────────────────────────
const cf = (n) => O.contacts.f(n);
await create(O.contacts, { [cf('Name')]: 'Jordan Marshall', [cf('Phone')]: '(555) 019-9001', [cf('Email')]: { email: 'jordan.demo@example.com' }, [cf('Address')]: { street: '100 Demo Way', city: 'Springfield', state: 'VT', zip: '05156' }, [cf('Patient')]: [P] }, 'contact Jordan');
await create(O.contacts, { [cf('Name')]: 'Casey Rivera', [cf('Phone')]: '(555) 012-3456', [cf('Email')]: { email: 'casey.demo@example.com' }, [cf('Patient')]: [P] }, 'contact Casey');
console.log('  emergency contacts: 2');

// ── Visit notes (clinician view) ──────────────────────────────────────────
const nf = (n) => O.notes.f(n);
const note = (apptId, doc, offset, text) =>
  create(O.notes, { [nf('Date')]: at(offset, 12, 0), [nf('Note')]: text, [nf('Patient')]: [P], [nf('Doctor')]: [doc.id], [nf('Appointment')]: [apptId] }, 'note');
await note(aPhysical, primary, -60, 'Healthy adult. BP 142/91 (elevated). Ordered CBC, lipid panel, A1C. Recheck BP.');
await note(aCardio, cardio, -21, 'Palpitations ~2x/week, no syncope. EKG: NSR with occasional PACs. Start metoprolol 25 mg; 48h Holter.');
await note(aFollow, primary, -10, 'BP 146/92 on home log. Start lisinopril 10 mg daily. Statin started for LDL 138. Follow up 6 weeks.');
console.log('  notes: 3');

mkdirSync('.knack', { recursive: true });
writeFileSync(ledgerPath, JSON.stringify({ email, patient: P, at: new Date().toISOString(), created }, null, 2));
console.log(`\nDone: ${created.length} records. Ledger: ${ledgerPath} (remove with --remove).`);
