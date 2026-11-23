import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SECURITY_HEADERS, staticResponse } from '../dist/http/static.js';

// DOC-448 — the function serves the web app itself, so this is the only thing standing
// between a URL and the file system.
const built = async (): Promise<string> => {
  const parent = await mkdtemp(join(tmpdir(), 'static-'));
  const dist = join(parent, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<!doctype html>APP');
  await writeFile(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  await writeFile(join(dist, 'favicon.svg'), '<svg/>');
  await writeFile(join(parent, 'secret.txt'), 'SECRET'); // beside dist, must never be served
  return dist;
};

test('an asset is served with its type and cached forever', async () => {
  const r = await staticResponse(await built(), '/assets/index-abc123.js');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'console.log(1)');
  assert.match(r.headers.get('content-type') ?? '', /^text\/javascript/);
  assert.match(r.headers.get('cache-control') ?? '', /immutable/);
});

test('a non-asset file is revalidated, not cached forever', async () => {
  const r = await staticResponse(await built(), '/favicon.svg');
  assert.equal(await r.text(), '<svg/>');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
});

test('an unknown path gets index.html, so the client router owns it', async () => {
  const r = await staticResponse(await built(), '/patient/appointments');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '<!doctype html>APP');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
});

test('a path that escapes the build folder gets index.html, never the file', async () => {
  const dist = await built();
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/../../secret.txt', '/..%2Fsecret.txt']) {
    const body = await (await staticResponse(dist, p)).text();
    assert.equal(body, '<!doctype html>APP', p);
  }
});

test('a sibling folder whose name starts with the build folder name is not inside it', async () => {
  const dist = await built();
  await mkdir(`${dist}-other`, { recursive: true });
  await writeFile(join(`${dist}-other`, 'x.txt'), 'OTHER');
  const body = await (await staticResponse(dist, '/../dist-other/x.txt')).text();
  assert.equal(body, '<!doctype html>APP');
});

test('a malformed escape does not throw', async () => {
  const r = await staticResponse(await built(), '/%E0%A4%A');
  assert.equal(r.status, 200);
});

test('every response carries the security headers', async () => {
  const dist = await built();
  for (const p of ['/', '/assets/index-abc123.js']) {
    const r = await staticResponse(dist, p);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers.get(k), v, `${p} ${k}`);
  }
  const missing = await staticResponse(join(dist, 'nope'), '/');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('content-security-policy'), SECURITY_HEADERS['content-security-policy']);
});
