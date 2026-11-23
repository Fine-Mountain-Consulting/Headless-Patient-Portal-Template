/**
 * One origin for the web app and the API, shared by every host.
 *
 * DOC-448: Firebase Hosting is not a covered service under Google's HIPAA BAA, so
 * the Firebase host no longer sits behind it. The function serves the built web app
 * itself, as the Node host always has. Both hosts send the same security headers and
 * the same files from this module, so they cannot drift apart. Before, the headers
 * were written twice, once in firebase.json and once in server-node.
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

/**
 * Security headers for every response, API and static alike.
 * connect-src 'self': the browser talks to this origin only, never to Knack.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
    "font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; " +
    "form-action 'self'; object-src 'none'",
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
});

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/**
 * A file from the built web app, or index.html for any path that is not one, so the
 * client-side router owns every URL that is not an asset.
 *
 * A path that normalises outside `webDist` gets index.html, never the file it names.
 * Hashed files under assets/ are cached forever. Everything else is revalidated, so a
 * deploy is visible on the next load.
 */
export const staticResponse = async (webDist: string, pathname: string): Promise<Response> => {
  const root = normalize(webDist.endsWith(sep) ? webDist : webDist + sep);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = '/';
  }
  const candidate = normalize(join(root, decoded));
  let file = join(root, 'index.html');
  if (candidate.startsWith(root)) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) file = candidate;
  }
  const body = await readFile(file).catch(() => null);
  if (!body) {
    return new Response('Not built. Run "npm run build".', {
      status: 404,
      headers: { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const immutable = file.startsWith(join(root, 'assets') + sep);
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  });
};
