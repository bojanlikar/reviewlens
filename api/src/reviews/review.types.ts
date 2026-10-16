export interface Review {
  id: string;
  rating: number;
  title: string;
  text: string;
  publishedAt: string; // ISO date
  author: string;
  language?: string;
  likes?: number;
  /** App version the review refers to (App Store). */
  version?: string;
  /** Hours the reviewer had played when reviewing (Steam). */
  playtimeHours?: number;
}

/** 'stars' = 1-5 ratings; 'thumbs' = recommended / not recommended (stored as 5 / 1). */
export type RatingScale = 'stars' | 'thumbs';

export type IngestionStatus = 'idle' | 'running' | 'ready' | 'failed';

export interface IngestionSummary {
  status: IngestionStatus;
  /** Human-readable platform name, set by the source adapter. */
  platform: string;
  sourceUrl: string;
  entityName: string | null;
  /** Total review count the platform itself reports for the entity. */
  reportedTotal: number | null;
  reportedTrustScore: number | null;
  ratingScale: RatingScale;
  /** Platform's own verdict text, e.g. "Overwhelmingly Positive (99% of 212069)". */
  platformRatingLabel: string | null;
  ingested: number;
  pagesFetched: number;
  pagesPlanned: number;
  duplicatesSkipped: number;
  emptySkipped: number;
  averageRating: number | null;
  ratingDistribution: Record<1 | 2 | 3 | 4 | 5, number>;
  dateRange: { from: string; to: string } | null;
  ingestedAt: string | null;
  warnings: string[];
  error?: string;
  /** Set when the data being served was restored from disk rather than freshly ingested. */
  snapshot: { savedAt: string; refreshError?: string } | null;
}

export const emptyDistribution = (): Record<1 | 2 | 3 | 4 | 5, number> => ({
  1: 0,
  2: 0,
  3: 0,
  4: 0,
  5: 0,
});
