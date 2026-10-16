import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ReviewRepository, type Snapshot } from './review.repository.js';

@Injectable()
export class FileSnapshotRepository extends ReviewRepository {
  private readonly logger = new Logger(FileSnapshotRepository.name);
  private readonly path: string;

  constructor(config: ConfigService) {
    super();
    this.path = config.get<string>('SNAPSHOT_PATH') ?? './state/snapshot.json';
  }

  async load(): Promise<Snapshot | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`Could not read snapshot ${this.path}: ${(err as Error).message}`);
      }
      return null;
    }
    try {
      const data = JSON.parse(raw);
      if (data?.version !== 1 || !Array.isArray(data.reviews) || typeof data.summary !== 'object' || !data.summary) {
        throw new Error('unexpected snapshot shape');
      }
      return data as Snapshot;
    } catch (err) {
      // A corrupt snapshot must never stop the app from booting.
      this.logger.warn(`Ignoring unusable snapshot ${this.path}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Atomic write: a crash mid-write can never leave a half-written snapshot. */
  async save(snapshot: Snapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot), 'utf8');
    await rename(tmp, this.path);
  }
}
