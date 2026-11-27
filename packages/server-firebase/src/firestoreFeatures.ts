/**
 * Portal feature switches in Firestore: one document, `settings/features`.
 * firestore.rules deny all client access; only this function reads or writes it.
 */
import { getFirestore } from 'firebase-admin/firestore';
import type { FeatureStates, FeatureStore } from '@headless/core';

export class FirestoreFeatureStore implements FeatureStore {
  private get doc() {
    return getFirestore().collection('settings').doc('features');
  }

  async load(): Promise<FeatureStates> {
    const snap = await this.doc.get();
    return (snap.exists ? (snap.data() as FeatureStates) : {}) ?? {};
  }

  async save(states: FeatureStates): Promise<void> {
    await this.doc.set(states);
  }
}
