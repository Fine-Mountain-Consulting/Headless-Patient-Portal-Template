/**
 * Node host: one origin serving the built web app and the API.
 *
 *   npm run build && npm start
 *
 * Put it behind TLS (a load balancer or reverse proxy that sets
 * X-Forwarded-Proto). Session cookies are marked Secure when the request
 * arrived over HTTPS.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { HeadlessApp, loadConfig, staticResponse, type AppSnapshot } from '@headless/core';
import { FileAuditStore } from './fileAudit.js';
import { FileFeatureStore } from './fileFeatures.js';
import { SECURITY_HEADERS } from './headers.js';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const webDist = join(root, 'apps/web/dist');
const snapshotPath = process.env.KNACK_SNAPSHOT ?? join(root, '.knack/snapshot.json');

const config = loadConfig(process.env);
const snapshot = JSON.parse(
  await readFile(snapshotPath, 'utf8').catch(() => {
    throw new Error(`No Knack snapshot at ${snapshotPath}. Run "npm run sync" first.`);
  }),
) as AppSnapshot;

const app = new HeadlessApp({
  config,
  snapshot,
  audit: new FileAuditStore(resolve(root, process.env.DATA_DIR ?? 'data')),
  features: new FileFeatureStore(resolve(root, process.env.DATA_DIR ?? 'data')),
  // Keep the newest structure (and its locked names) across restarts.
  onSnapshot: async (next) => {
    const tmp = `${snapshotPath}.tmp`;
    await writeFile(tmp, JSON.stringify(next));
    await rename(tmp, snapshotPath);
  },
});

const toRequest = (req: IncomingMessage): Request => {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? 'http';
  const host = req.headers.host ?? 'localhost';
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(`${proto}://${host}${req.url ?? '/'}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // Node's fetch needs this for streamed bodies.
    duplex: hasBody ? 'half' : undefined,
  } as RequestInit);
};

const send = async (res: ServerResponse, response: Response): Promise<void> => {
  const headers: Record<string, string | string[]> = { ...SECURITY_HEADERS };
  response.headers.forEach((value, key) => {
    if (key === 'set-cookie') return;
    headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  }
  res.end();
};

const serveStatic = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  await send(res, await staticResponse(webDist, new URL(req.url ?? '/', 'http://x').pathname));
};

const server = createServer(async (req, res) => {
  try {
    if (req.url?.startsWith('/api/')) {
      const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? '';
      await send(res, await app.handle(toRequest(req), ip));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    console.error('request failed', error instanceof Error ? error.message : 'unknown');
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Server error');
  }
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => {
  console.log(`headless portal on http://localhost:${port}  (Knack app ${config.knackAppId}, tier ${config.tier})`);
});
