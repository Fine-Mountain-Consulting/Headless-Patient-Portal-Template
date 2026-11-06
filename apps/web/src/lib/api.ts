/**
 * The only way the browser talks to the server. Same origin, cookie session,
 * no tokens in JavaScript. The browser never talks to Knack.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

type Listener = () => void;
const sessionEndedListeners = new Set<Listener>();

/** Called when any request finds the session gone (idle timeout, server restart, sign-out elsewhere). */
export const onSessionEnded = (fn: Listener): (() => void) => {
  sessionEndedListeners.add(fn);
  return () => sessionEndedListeners.delete(fn);
};

export const api = async <T>(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined | null>; signal?: AbortSignal } = {},
): Promise<T> => {
  const qs = init.query
    ? Object.entries(init.query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  const isForm = init.body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(`/api${path}${qs ? `?${qs}` : ''}`, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'headless',
        ...(init.body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body === undefined ? undefined : isForm ? (init.body as FormData) : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError(0, 'You appear to be offline. Check your connection and try again.');
  }

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const err = (body as { error?: { message?: string; fields?: Record<string, string> } } | null)?.error;
    if (response.status === 401 && path !== '/session/login') sessionEndedListeners.forEach((fn) => fn());
    throw new ApiError(response.status, err?.message ?? `Request failed (${response.status}).`, err?.fields ?? {});
  }
  return body as T;
};

/** Upload with progress (fetch has no upload progress). */
export const uploadWithProgress = (
  path: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<{ id: string; filename: string; size: number; type: string | null }> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Requested-With', 'headless');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: { error?: { message?: string } } & Record<string, unknown> = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as never);
      else {
        if (xhr.status === 401) sessionEndedListeners.forEach((fn) => fn());
        reject(new ApiError(xhr.status, body.error?.message ?? 'Upload failed.'));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed. Check your connection.'));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
