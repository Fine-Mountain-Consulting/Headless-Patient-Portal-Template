// Bundle the function and core into lib/index.js, and ship the Knack snapshot
// beside it. Firebase uploads this folder and installs only package.json deps.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const snapshot = new URL('../../.knack/snapshot.json', import.meta.url);
if (!existsSync(snapshot)) {
  console.error('No .knack/snapshot.json. Run "npm run sync" first.');
  process.exit(1);
}
await mkdir(new URL('./lib/', import.meta.url), { recursive: true });
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
