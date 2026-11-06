# Working in this repo

A headless React front end on a Knack database. Read [README.md](README.md) first.

## Rules that are not negotiable

- **Access mirrors the customer's Knack pages.** It is derived in `packages/core/src/access/derive.ts` and enforced in `packages/core/src/access/policy.ts`. Never hand-write a permission matrix or grant access that no Knack page grants. The only exception is the `Headless Admin` role (full access). If a feature needs access Knack doesn't grant, the answer is a Knack page, and the README says which.
- **The browser never talks to Knack.** All Knack calls go through `packages/core/src/knack/client.ts` on the server, using the master REST key.
- **No `field_N` or `object_N` in the browser.** DTOs use slugs (`packages/core/src/knack/values.ts`). Slugs are locked to keys (`model.ts`, `SlugLock`), so a rename in Knack doesn't break screens.
- **Knack ignores nested filter groups.** Scope filters must stay flat; scope is always a top-level AND.
- **This repo is public.** No keys, secrets, customer app ids, record ids or PHI in any file. `npm run check:keys` enforces it. Pass `KNACK_API_KEY` on the command line; never write it to `.env`.
- **HIPAA tier.** Don't add analytics, third-party scripts, logging of response bodies, or `localStorage` of anything a user typed. Cache-Control on API responses stays `no-store`.
- **Only synthetic data** in prompts, tests, fixtures and seed scripts.

## Knack quirks we rely on (verified)

- Role records (Patients, Doctors…) have their own ids, separate from Accounts, linked by email. Login resolves them (`auth/login.ts`).
- `iso_timestamp` in date fields is real UTC. Writes use `{date, hours, minutes, am_pm}` in the app's time zone.
- Asset (file) URLs download without credentials, even for "secure" fields. Downloads are proxied.
- Removing a role in Knack deletes that role record and drops the profile key from the account.

## Commands

`npm run sync` · `npm run access` · `KNACK_API_KEY=… npm run dev` · `npm test` · `npm run verify`
