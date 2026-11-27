# Headless Patient Portal for Knack

A modern patient portal that sits on top of the Knack **Patient Portal** template. Knack stays the database and the place you manage users and access. This replaces Knack's built-in pages with a fast, mobile-first app for patients, doctors, staff and administrators.

- **Patients:** home dashboard, appointments (list and calendar), online booking, test results, medications, secure messages, documents, emergency contacts.
- **Doctors:** today's schedule, calendar, patient charts with results, prescriptions, documents and visit notes, messages, and their own availability and time off.
- **Medical staff:** front-desk view of today across all doctors with one-tap status changes, and every table their Knack pages give them.
- **Headless Admin:** all data, **portal feature switches**, an **Access map** showing what each role can do and why, an activity log, Knack API usage, and Knack sync status.

> **Compliance tier: HIPAA.** A patient portal holds protected health information. Read [Before real patients use it](#before-real-patients-use-it) before you put real data in it.

## How access works

**Access is whatever your Knack app says it is.** The server reads your Knack pages and enforces the same rules:

| In Knack | In the headless portal |
| --- | --- |
| A login page limited to a role | That role can use the pages under it |
| A table showing "records connected to the logged-in user" | The role sees only those records |
| A table on a details page (records connected to *this* record) | The role sees them only under a parent record it can see |
| An add or edit form | The role can create or update, and only the form's fields |
| A delete link | The role can delete those rows |
| The columns and fields a page shows | The only fields the role receives |
| Form record rules ("set Doctor to the logged-in doctor") | Applied by the server the same way |

Pages with no login are **ignored**: there is no anonymous data access. The **Access map** (admin) lists every rule and the Knack page it came from.

Two things are added on top of your Knack pages:

- **Headless Admin**, a Knack user role with full access, used to administer the portal. Create it in Knack (a user role object named exactly `Headless Admin`) and assign it to whoever administers the portal.
- **Portal features**: abilities this portal adds that the Knack template has no page for (see below). Each is **off until a Headless Admin switches it on** under *Administration → Portal features*. A feature only ever covers people's **own** records, can't be switched on if your Knack app lacks a table or field it needs, and shows in the Access map as "Portal feature". Who switched it, and when, is shown there and written to the activity log.

### Portal features

| Feature | When switched on |
| --- | --- |
| **Online booking** | Patients book their own appointments: date and time first, then a doctor who is free. Created for the signed-in patient only, with *Status = Scheduled*. |
| **Doctor availability** | Doctors edit their own working days, hours, appointment length and online-booking setting, and add or delete their own time off. |

Features are defined in [templates/patient-portal/manifest.json](templates/patient-portal/manifest.json) by Knack table and field name. If you'd rather grant the same thing with Knack pages, that works too: access from pages and features is combined.

### Security model

- The browser never talks to Knack and never holds a Knack credential. All Knack calls go through the server with your REST API key, which never leaves the server.
- That key bypasses Knack's own permissions, so **the server is the only thing enforcing access**. Scope is applied server-side as a filter; get, update and delete re-check the stored record; "not found" and "not yours" are the same answer.
- Sessions are an HMAC-signed, `HttpOnly`, `SameSite=Strict` cookie that ends when the browser closes. Users are signed out after 15 minutes idle (or Knack's own inactivity setting, if stricter), with a one-minute warning.
- Roles are re-checked against Knack every 2 minutes, so a removed role or deactivated account stops working without waiting for sign-out.
- Every sign-in, record view, list, download, upload, create, update and delete is written to an append-only activity log.
- File downloads go through the server, which checks access and logs the download first. Knack's asset links open without any credential, so they never reach the browser.

## Quick start (local)

Requirements: Node 22, a Knack app built from the Patient Portal template, its **app ID** and **REST API key** (Knack Builder → Settings → API & Code).

```bash
npm install
cp .env.example .env          # fill in KNACK_APP_ID and SESSION_SECRET
                              # (openssl rand -base64 48)
KNACK_API_KEY=your-key npm run dev
```

Open http://localhost:5173 and sign in with a Knack user.

**Keep the REST API key out of files.** Pass it on the command line locally, and use Secret Manager (Firebase) or your host's secret store in production. `npm run check:keys` (also run in CI) fails if a key, secret or Knack id appears in the repo or the built app.

## Demo deployment

For showing the portal to people, on a **non-HIPAA test app with synthetic data only**. Both scripts refuse the GovCloud host.

1. Create one login per role (Patient, Doctor, Medical staff, Admin), all at `@example.com` addresses. The demo patient's primary doctor is the demo doctor. Running it again resets the passwords.

   ```bash
   KNACK_API_KEY=your-key node scripts/demo-logins.mjs --password 'choose-a-demo-password'
   ```

2. Fill the demo patient with synthetic appointments, results, medications, messages, documents, contacts and visit notes. Every record created is listed in `.knack/` so `--remove` deletes exactly those.

   ```bash
   KNACK_API_KEY=your-key node scripts/seed-demo.mjs --email demo.patient@example.com \
     --doctor demo.doctor@example.com --staff demo.staff@example.com
   KNACK_API_KEY=your-key node scripts/seed-demo.mjs --email demo.patient@example.com --remove
   ```

3. Add the two lines the first script prints to `.env` (or your host's config):

   ```bash
   DEMO_MODE=true
   DEMO_LOGINS=Patient|demo.patient@example.com|…;Doctor|demo.doctor@example.com|…
   ```

With `DEMO_MODE=true`, the sign-in page says this is a test site: no PHI, no HIPAA compliance implied or performed, demo data only. It lists the demo logins for one-click sign-in. The server refuses `DEMO_MODE` on the GovCloud host.

**The demo logins are public.** Anyone who opens the page can use them. The Admin login can change or delete every record and switch portal features, so leave it out of `DEMO_LOGINS` for a public demo, or reset the data regularly.

## Keeping up with Knack

`npm run sync` reads your Knack app's structure (tables, fields, pages) from Knack's public metadata endpoint into `.knack/snapshot.json` (git-ignored; it describes *your* app). It checks the app against the template ([templates/patient-portal/manifest.json](templates/patient-portal/manifest.json)) and prints the access it implies. `npm run access` prints the full access report.

After deploy, the server **re-syncs by itself** every `SYNC_MINUTES` (default 5), and admins can press **Sync now**:

- **Fields added:** appear wherever a Knack page shows them to a role. Generic screens pick them up automatically.
- **Fields or tables renamed:** keep working. Each field's name in the app is locked to its Knack key the first time it's seen.
- **Fields deleted:** the admin overview says which screens are affected. Required template fields make `npm run sync` fail at deploy time.
- **Choices or types changed:** forms and validation follow Knack.
- **Pages or access changed:** the new rules apply at the next sync. Access always follows Knack, even when the template no longer matches.

If Knack can't be reached, the last good structure stays in use.

## Online booking

Switch on **Online booking** (and, so doctors can keep their own hours, **Doctor availability**) under *Administration → Portal features*. Booking reads these from Knack. They aren't in Knack's stock template, so add them once in the Knack Builder (tables and fields only; no pages needed):

- **Doctor schedules** (optional fields on Doctors): *Available Days*, *Day Starts*, *Day Ends*, *Appointment Length*, *Online Booking*. Blank means Monday–Friday, 9–5, 30 minutes. A doctor with *Online Booking* off isn't offered.
- **Doctor Time Off** (optional table: *Starts*, *Ends*, *Reason*, *Doctor*): blocks booking.

If those fields or that table are missing, the feature says what's missing and stays off.

Patients receive only *when* doctors are busy, never whose appointment it is. Every booking is re-checked on the server against fresh data: working hours, at least 2 hours' notice, no more than 90 days ahead, no double-booking.

## Deploy

### Firebase (recommended)

One Cloud Function (`api`) serves the whole site: the built web app and the API, from one origin. The activity log and the feature switches are stored in Firestore.

**No Firebase Hosting.** Hosting is not a covered service under Google's HIPAA BAA, and a Hosting rewrite would carry every patient request through it. Cloud Functions, Cloud Run and Firestore are covered. One origin also keeps the session cookie first-party.

```bash
npm run sync
firebase functions:secrets:set KNACK_API_KEY
firebase functions:secrets:set SESSION_SECRET
# packages/server-firebase/.env (not committed): KNACK_APP_ID, KNACK_API_HOST,
#   COMPLIANCE_TIER, APP_NAME, SYNC_MINUTES, …
npm run build:firebase
firebase deploy --only functions,firestore
gcloud run services describe api --region us-central1 --format='value(status.url)'
```

Open the **Cloud Run URL** that last command prints (`https://api-….run.app`). Don't use `cloudfunctions.net/api`: that address puts `/api` in front of every path, and the app's own `/api/...` calls would miss. For your own domain, map it to the Cloud Run service (Cloud Run domain mapping, or an HTTPS load balancer). Both are covered. Don't put Firebase Hosting in front.

`firestore.rules` deny all client access; only the function reads or writes Firestore.

### Any Node host (Docker, Render, Fly, a VM)

```bash
npm run sync && npm run build
KNACK_API_KEY=… SESSION_SECRET=… KNACK_APP_ID=… npm start   # port 8787
```

Put it behind TLS. The activity log goes to `DATA_DIR/audit.jsonl`, which may contain PHI: keep it on an encrypted volume readable only by the service. Feature switches are kept in `DATA_DIR/features.json`.

## Before real patients use it

The headless app can only be as compliant as everything it runs on. Before the first real patient record:

1. **Business Associate Agreements** with Knack (HIPAA plan, GovCloud), your cloud (Google Cloud BAA, which covers Cloud Functions, Cloud Run and Firestore but **not** Firebase Hosting or plain Firebase Auth), and anything else that touches PHI.
2. **Knack HIPAA tenant.** Set `KNACK_API_HOST=https://usgc-api.knack.com/v1`. The commercial host *accepts* writes for a GovCloud app, answers 200, and drops them. With `COMPLIANCE_TIER=hipaa` the server refuses the commercial host unless `ALLOW_COMMERCIAL_HOST_FOR_DEMO=true`, which is only for synthetic demo data.
3. **Front door.** The function is the front door, with no Firebase Hosting in front of it (see Deploy). If you add a custom domain, use Cloud Run domain mapping or an HTTPS load balancer. This template signs people in with its own Knack-backed session, not Firebase Auth. If you add Firebase sign-in, upgrade it to **Identity Platform**, which the BAA covers; plain Firebase Auth is not.
4. **Retention** for the activity log, agreed with the practice. Leave `AUDIT_VALUES=false` unless the practice needs before/after values (which makes the log itself PHI).
5. **Lock down Knack's own live app.** It is still reachable at your Knack URL. Remove public pages, or turn the live app off once the headless portal replaces it.
6. **Demo mode off.** `DEMO_MODE` unset, and never run `seed-demo.mjs` or `demo-logins.mjs` against a real tenant. All three are refused on GovCloud hosts.

## Repository layout

| Path | What it is |
| --- | --- |
| [packages/core](packages/core) | Platform-neutral server: Knack client, app model, access policy derived from Knack pages, sessions, booking, the HTTP API. No platform imports. |
| [packages/server-node](packages/server-node) | Runs core on any Node host. |
| [packages/server-firebase](packages/server-firebase) | Runs core as a Firebase Cloud Function. |
| [apps/web](apps/web) | The React app (Vite, Tailwind, TanStack Query, [@fmc/knack-ui](https://github.com/Fine-Mountain-Consulting/knack-ui)). |
| [templates/patient-portal](templates/patient-portal) | What this template needs from the Knack app, by name. |
| [scripts](scripts) | `sync`, `access-report`, `check-no-keys`, `dev`, and for demo apps `demo-logins` and `seed-demo`. |

`npm run verify` runs what CI runs: key check, typecheck, tests, build.
