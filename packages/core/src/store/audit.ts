/**
 * The audit trail: who changed what (change log) and who looked at what
 * (access log). HIPAA's audit-controls safeguard needs both.
 *
 * Platform adapters provide the store (Firestore on Firebase, an append-only
 * file on Node). Whatever the store, it is append-only and readable by
 * Headless Admins only.
 *
 * Values are recorded only when AUDIT_VALUES=true. Off, an entry says who
 * changed which fields when; on, it also holds before/after values, which
 * makes the log itself PHI.
 */

export type AuditKind = 'create' | 'update' | 'delete' | 'view' | 'list' | 'download' | 'upload' | 'sign-in' | 'sign-out' | 'setting';

export interface AuditEvent {
  at: string;
  kind: AuditKind;
  actor: { accountId: string; name: string; email: string };
  profiles: string[];
  /** Entity slug. */
  entity?: string;
  recordId?: string;
  /** Field slugs touched. */
  fields?: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** For list reads: how many records were returned. */
  count?: number;
  /** Where in the app the action came from (screen name). */
  source?: string;
  reason?: string;
  ip?: string;
}

export interface AuditQuery {
  entity?: string;
  recordId?: string;
  accountId?: string;
  kinds?: AuditKind[];
  limit?: number;
}

export interface AuditStore {
  write(event: AuditEvent): Promise<void>;
  /** Newest first. */
  query(q: AuditQuery): Promise<AuditEvent[]>;
}

/** Keeps the last N events in memory. Development and tests only. */
export class MemoryAuditStore implements AuditStore {
  private events: AuditEvent[] = [];
  constructor(private readonly max = 5000) {}

  async write(event: AuditEvent): Promise<void> {
    this.events.push(event);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
  }

  async query(q: AuditQuery): Promise<AuditEvent[]> {
    return filterEvents([...this.events].reverse(), q);
  }
}

export const filterEvents = (events: AuditEvent[], q: AuditQuery): AuditEvent[] =>
  events
    .filter(
      (e) =>
        (!q.entity || e.entity === q.entity) &&
        (!q.recordId || e.recordId === q.recordId) &&
        (!q.accountId || e.actor.accountId === q.accountId) &&
        (!q.kinds?.length || q.kinds.includes(e.kind)),
    )
    .slice(0, Math.min(q.limit ?? 100, 500));

// ── API usage ─────────────────────────────────────────────────────────────

/**
 * Knack allows about 10 requests/second for the whole app, shared by every
 * user. Counting every attempt (retries included) shows admins where the
 * budget goes. Counts carry no identity: date, method, object, status only.
 */
export class UsageCounter {
  private counts = new Map<string, number>();
  private recent: number[] = [];

  record(call: { method: string; objectKey: string; status: number }): void {
    const day = new Date().toISOString().slice(0, 10);
    const key = `${day}|${call.method}|${call.objectKey}|${call.status === 0 ? 'error' : call.status < 400 ? 'ok' : call.status}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    const now = Date.now();
    this.recent.push(now);
    if (this.recent.length > 2000) this.recent = this.recent.filter((t) => now - t < 60_000);
  }

  snapshot(): { rows: Array<{ day: string; method: string; objectKey: string; outcome: string; count: number }>; lastMinute: number } {
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    const rows = [...this.counts.entries()].map(([key, count]) => {
      const [day, method, objectKey, outcome] = key.split('|') as [string, string, string, string];
      return { day, method, objectKey, outcome, count };
    });
    rows.sort((a, b) => b.day.localeCompare(a.day) || b.count - a.count);
    return { rows: rows.slice(0, 500), lastMinute: this.recent.length };
  }
}
