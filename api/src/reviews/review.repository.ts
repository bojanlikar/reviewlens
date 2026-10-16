import type { IngestionSummary, Review } from './review.types.js';

export interface Snapshot {
  version: 1;
  savedAt: string;
  summary: IngestionSummary;
  reviews: Review[];
}

/**
 * Persistence boundary for ingested data. The default implementation writes a
 * JSON snapshot to a volume; swap in Postgres by providing another class.
 */
export abstract class ReviewRepository {
  abstract load(): Promise<Snapshot | null>;
  abstract save(snapshot: Snapshot): Promise<void>;
}
