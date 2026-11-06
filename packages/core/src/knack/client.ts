/**
 * Knack object-based REST client. Server-side only, forever.
 *
 * It authenticates with the application's master API key, which ignores
 * Knack's roles, record rules and Data Access Control. The key must never be
 * returned to a caller, logged, or included in an error message.
 */
import { toKnackDate, type KnackRecord } from './values.js';

export interface FilterRule {
  field: string;
  operator: string;
  value?: unknown;
}

export interface KnackFilters {
  match: 'and' | 'or';
  rules: Array<FilterRule | KnackFilters>;
}

export interface ListOptions {
  page?: number;
  rowsPerPage?: number;
  filters?: KnackFilters;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface ListResult {
  records: KnackRecord[];
  totalRecords: number;
  totalPages: number;
  currentPage: number;
}

export class KnackError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Knack's own error text, for field-level messages. Never contains the key. */
    readonly knackErrors: Array<{ field?: string; message: string }> = [],
  ) {
    super(message);
  }
}

/** Called once per HTTP attempt (retries included), for the usage counter. */
export type UsageHook = (call: { method: string; objectKey: string; status: number }) => void;

/**
 * 502/503/504 are Knack's infrastructure faltering; 429 is its rate limit.
 * Everything else is a real answer, and a failed write may still have landed,
 * so only GETs are retried.
 */
const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Knack error bodies look like `{errors: [{message, field?}]}` and can echo
 * submitted values. We keep the messages for the caller only when they are
 * about validation (400), and log nothing but the status and a short type.
 */
const parseErrors = (text: string): Array<{ field?: string; message: string }> => {
  try {
    const body = JSON.parse(text) as { errors?: Array<{ message?: string; field?: string }> | string };
    if (Array.isArray(body.errors)) {
      return body.errors.map((e) => ({ field: e.field, message: String(e.message ?? 'Invalid value') }));
    }
    if (typeof body.errors === 'string') return [{ message: body.errors }];
  } catch {
    /* not JSON */
  }
  return [];
};

export class KnackClient {
  constructor(
    private readonly appId: string,
    private readonly apiKey: string,
    private readonly host: string,
    private readonly onCall: UsageHook = () => {},
  ) {}

  private async request(
    path: string,
    init: { method: string; body?: unknown; objectKey: string },
  ): Promise<unknown> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${this.host}${path}`, {
          method: init.method,
          headers: {
            'X-Knack-Application-Id': this.appId,
            'X-Knack-REST-API-Key': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        this.onCall({ method: init.method, objectKey: init.objectKey, status: 0 });
        console.warn(`knack ${init.method} ${init.objectKey} attempt ${attempt}: network error or timeout`);
        if (attempt < MAX_ATTEMPTS && init.method === 'GET') {
          await sleep(300 * 2 ** (attempt - 1));
          continue;
        }
        throw new KnackError('Knack is not responding.', 503);
      }

      this.onCall({ method: init.method, objectKey: init.objectKey, status: response.status });
      if (response.ok) return response.status === 204 ? null : response.json();

      const text = await response.text().catch(() => '');
      const retryable = RETRYABLE.has(response.status) && init.method === 'GET';
      // Minimum necessary: status and object, never the body (it can hold PHI).
      console[retryable ? 'warn' : 'error'](
        `knack ${init.method} ${init.objectKey} attempt ${attempt} -> ${response.status}`,
      );
      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw new KnackError(
          `Knack request failed (${response.status}).`,
          response.status,
          response.status === 400 ? parseErrors(text) : [],
        );
      }
      await sleep(300 * 2 ** (attempt - 1));
    }
    throw new KnackError('Knack request failed.', 503);
  }

  async list(objectKey: string, options: ListOptions = {}): Promise<ListResult> {
    const params = new URLSearchParams({
      page: String(options.page ?? 1),
      rows_per_page: String(Math.min(Math.max(options.rowsPerPage ?? 25, 1), 1000)),
    });
    if (options.sortField) {
      params.set('sort_field', options.sortField);
      params.set('sort_order', options.sortOrder ?? 'asc');
    }
    if (options.filters && options.filters.rules.length) {
      params.set('filters', JSON.stringify(normaliseFilters(options.filters)));
    }
    const body = (await this.request(`/objects/${objectKey}/records?${params}`, {
      method: 'GET',
      objectKey,
    })) as { records?: KnackRecord[]; total_records?: number; total_pages?: number; current_page?: number | string };
    return {
      records: body.records ?? [],
      totalRecords: body.total_records ?? 0,
      totalPages: body.total_pages ?? 0,
      currentPage: Number(body.current_page ?? 1),
    };
  }

  /** Every matching record, paged on the server, capped. */
  async listAll(objectKey: string, options: Omit<ListOptions, 'page' | 'rowsPerPage'>, cap = 5000): Promise<{ records: KnackRecord[]; truncated: boolean }> {
    const records: KnackRecord[] = [];
    for (let page = 1; ; page += 1) {
      const result = await this.list(objectKey, { ...options, page, rowsPerPage: 1000 });
      records.push(...result.records);
      if (records.length >= cap) return { records: records.slice(0, cap), truncated: true };
      if (page >= result.totalPages || result.records.length === 0) return { records, truncated: false };
    }
  }

  /** null for a missing record. Callers answer "not found" for forbidden ones too. */
  async get(objectKey: string, id: string): Promise<KnackRecord | null> {
    if (!/^[a-f0-9]{24}$/i.test(id)) return null;
    try {
      return (await this.request(`/objects/${objectKey}/records/${id}`, { method: 'GET', objectKey })) as KnackRecord;
    } catch (error) {
      if (error instanceof KnackError && (error.status === 404 || error.status === 400)) return null;
      throw error;
    }
  }

  async create(objectKey: string, values: Record<string, unknown>): Promise<KnackRecord> {
    return (await this.request(`/objects/${objectKey}/records`, { method: 'POST', body: values, objectKey })) as KnackRecord;
  }

  async update(objectKey: string, id: string, values: Record<string, unknown>): Promise<KnackRecord> {
    return (await this.request(`/objects/${objectKey}/records/${id}`, {
      method: 'PUT',
      body: values,
      objectKey,
    })) as KnackRecord;
  }

  async delete(objectKey: string, id: string): Promise<void> {
    await this.request(`/objects/${objectKey}/records/${id}`, { method: 'DELETE', objectKey });
  }

  /**
   * Step one of a file field write: upload the bytes as an asset. Step two is
   * writing the returned asset id into the record.
   */
  async uploadAsset(kind: 'file' | 'image', file: Blob, filename: string): Promise<{ id: string; filename: string }> {
    const form = new FormData();
    form.append('files', file, filename);
    let response: Response;
    try {
      response = await fetch(`${this.host}/applications/${this.appId}/assets/${kind}/upload`, {
        method: 'POST',
        headers: { 'X-Knack-Application-Id': this.appId, 'X-Knack-REST-API-Key': this.apiKey },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      this.onCall({ method: 'POST', objectKey: 'assets', status: 0 });
      throw new KnackError('Upload failed: Knack is not responding.', 503);
    }
    this.onCall({ method: 'POST', objectKey: 'assets', status: response.status });
    if (!response.ok) {
      console.error(`knack asset upload -> ${response.status}`);
      throw new KnackError(`Upload failed (${response.status}).`, response.status);
    }
    const body = (await response.json()) as { id?: string; filename?: string };
    if (!body.id) throw new KnackError('Upload failed: no asset id returned.', 502);
    return { id: body.id, filename: body.filename ?? filename };
  }

  /**
   * Fetch an asset's bytes for the download proxy. The URL comes from a record
   * this server just read with the master key, never from the caller, and must
   * point at Knack.
   */
  async download(url: string): Promise<Response> {
    const parsed = new URL(url);
    if (!/(^|\.)knack\.com$/.test(parsed.hostname) && !/(^|\.)amazonaws\.com$/.test(parsed.hostname)) {
      throw new KnackError('Refusing to fetch a non-Knack asset URL.', 400);
    }
    const response = await fetch(url, {
      headers: { 'X-Knack-Application-Id': this.appId, 'X-Knack-REST-API-Key': this.apiKey },
      signal: AbortSignal.timeout(60_000),
    });
    this.onCall({ method: 'GET', objectKey: 'assets', status: response.status });
    if (!response.ok) throw new KnackError(`Download failed (${response.status}).`, response.status);
    return response;
  }

  /**
   * Knack's login endpoint. Needs no API key. Answers with the session (user
   * id, profile keys, approval status). The Knack user token in the answer is
   * thrown away by the caller.
   */
  async login(email: string, password: string): Promise<{ status: number; body: unknown }> {
    // One retry on a network-level failure only (no response at all). Creating
    // a session has no side effect worth guarding against, and a single
    // dropped connection shouldn't tell someone sign-in is down.
    const first = await this.loginOnce(email, password);
    if (first.status !== 0) return first;
    await sleep(400);
    return this.loginOnce(email, password);
  }

  private async loginOnce(email: string, password: string): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetch(`${this.host}/applications/${this.appId}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const e = error as Error & { cause?: { code?: string } };
      console.error(`knack login: request failed (${e.name}${e.cause?.code ? ` ${e.cause.code}` : ''}: ${e.message})`);
      return { status: 0, body: null };
    }
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      console.error(`knack login: ${response.status} with a non-JSON body (${text.length} bytes)`);
    }
    console.log(`knack login -> ${response.status}`);
    return { status: response.status, body };
  }
}

/** Dates in filters must be MM/DD/YYYY; ISO silently matches nothing. */
const normaliseFilters = (filters: KnackFilters): KnackFilters => ({
  match: filters.match,
  rules: filters.rules.map((r) =>
    'rules' in r ? normaliseFilters(r) : { ...r, value: r.value === undefined ? undefined : toKnackDate(r.value) },
  ),
});
