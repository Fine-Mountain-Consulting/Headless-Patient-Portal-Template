/**
 * Portal feature switches on local disk: DATA_DIR/features.json.
 * Written atomically (temp file + rename) so a crash can't leave half a file.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FeatureStates, FeatureStore } from '@headless/core';

export class FileFeatureStore implements FeatureStore {
  private readonly file: string;
  private ready: Promise<unknown>;

  constructor(dir: string) {
    this.file = join(dir, 'features.json');
    this.ready = mkdir(dir, { recursive: true, mode: 0o700 });
  }

  async load(): Promise<FeatureStates> {
    await this.ready;
    const text = await readFile(this.file, 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return '{}';
      throw e;
    });
    return JSON.parse(text) as FeatureStates;
  }

  async save(states: FeatureStates): Promise<void> {
    await this.ready;
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(states, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
