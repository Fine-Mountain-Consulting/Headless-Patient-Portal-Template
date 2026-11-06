/**
 * Append-only audit log on local disk, one JSON object per line.
 *
 * The file can hold PHI (who opened which record; values too when
 * AUDIT_VALUES=true). Keep DATA_DIR on an encrypted volume, out of backups
 * that aren't covered, and readable by the service account only.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { filterEvents, type AuditEvent, type AuditQuery, type AuditStore } from '@headless/core';

export class FileAuditStore implements AuditStore {
  private readonly file: string;
  private ready: Promise<unknown>;

  constructor(dir: string) {
    this.file = join(dir, 'audit.jsonl');
    this.ready = mkdir(dir, { recursive: true, mode: 0o700 });
  }

  async write(event: AuditEvent): Promise<void> {
    await this.ready;
    await appendFile(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  async query(q: AuditQuery): Promise<AuditEvent[]> {
    await this.ready;
    const text = await readFile(this.file, 'utf8').catch(() => '');
    const events: AuditEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as AuditEvent);
      } catch {
        /* skip a torn line */
      }
    }
    return filterEvents(events.reverse(), q);
  }
}
