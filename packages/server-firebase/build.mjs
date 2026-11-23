// Bundle the function and core into lib/index.js, and ship the Knack snapshot
// and the built web app beside it. Firebase uploads this folder and installs only package.json deps.
import { build } from 'esbuild';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const snapshot = new URL('../../.knack/snapshot.json', import.meta.url);
if (!existsSync(snapshot)) {
  console.error('No .knack/snapshot.json. Run "npm run sync" first.');
  process.exit(1);
}
await mkdir(new URL('./lib/', import.meta.url), { recursive: true });
// DOC-448 — the function serves the web app itself (no Firebase Hosting), so the
// built app ships inside the function's upload, at lib/web.
const web = new URL('../../apps/web/dist/', import.meta.url);
if (!existsSync(new URL('index.html', web))) {
  console.error('No apps/web/dist. Run "npm run build:firebase", which builds the web app first.');
  process.exit(1);
}
await rm(new URL('./lib/web/', import.meta.url), { recursive: true, force: true });
await cp(web, new URL('./lib/web/', import.meta.url), { recursive: true });
await copyFile(snapshot, new URL('./lib/snapshot.json', import.meta.url));
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['firebase-admin', 'firebase-admin/*', 'firebase-functions', 'firebase-functions/*'],
  logLevel: 'info',
});
