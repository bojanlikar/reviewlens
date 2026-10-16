import type { RatingScale, Review } from '../reviews/review.types.js';

export interface ScrapeResult {
  platform: string;
  entityName: string | null;
  reportedTotal: number | null;
  /** Platform-reported aggregate rating (e.g. Trustpilot TrustScore, App Store average). */
  trustScore: number | null;
  reviews: Review[];
  pagesFetched: number;
  pagesPlanned: number;
  duplicatesSkipped: number;
  emptySkipped: number;
  warnings: string[];
  /** Defaults to 'stars'. */
  ratingScale?: RatingScale;
  platformRatingLabel?: string | null;
}

/** A review platform adapter. Add a new platform by implementing this and registering it. */
export interface ReviewSource {
  readonly platform: string;
  supports(url: string): boolean;
  scrape(url: string, maxPages: number): Promise<ScrapeResult>;
}
