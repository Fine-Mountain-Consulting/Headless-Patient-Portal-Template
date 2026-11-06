/**
 * Audit log in Firestore: `audit/{autoId}`, append-only.
 *
 * firestore.rules denies every client read and write; only this function
 * (Admin SDK) touches it. Firestore is on Google's BAA-covered list. Set a
 * retention policy (TTL on `at`) agreed with the practice.
 */
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import type { AuditEvent, AuditQuery, AuditStore } from '@headless/core';

export class FirestoreAuditStore implements AuditStore {
  private get col() {
    return getFirestore().collection('audit');
  }

  async write(event: AuditEvent): Promise<void> {
    await this.col.add({ ...event, atTs: Timestamp.fromDate(new Date(event.at)) });
  }

  async query(q: AuditQuery): Promise<AuditEvent[]> {
    let query: FirebaseFirestore.Query = this.col;
    if (q.entity) query = query.where('entity', '==', q.entity);
    if (q.recordId) query = query.where('recordId', '==', q.recordId);
    if (q.accountId) query = query.where('actor.accountId', '==', q.accountId);
    if (q.kinds?.length) query = query.where('kind', 'in', q.kinds.slice(0, 10));
    const snap = await query.orderBy('atTs', 'desc').limit(Math.min(q.limit ?? 100, 500)).get();
    return snap.docs.map((d) => {
      const { atTs: _ignored, ...rest } = d.data();
      return rest as AuditEvent;
    });
  }
}
