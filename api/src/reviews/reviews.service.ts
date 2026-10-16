import { Injectable, Logger } from '@nestjs/common';
import { ReviewRepository } from './review.repository.js';
import {
  emptyDistribution,
  type IngestionSummary,
  type RatingScale,
  type Review,
} from './review.types.js';

/** Holds the single tracked entity's reviews in memory, backed by a snapshot on disk. */
@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);
  private reviews: Review[] = [];
  private summary: IngestionSummary = ReviewsService.blankSummary('');

  constructor(private readonly repo: ReviewRepository) {}

  static blankSummary(sourceUrl: string): IngestionSummary {
    return {
      status: 'idle',
      platform: 'Unknown',
      sourceUrl,
      entityName: null,
      reportedTotal: null,
      reportedTrustScore: null,
      ratingScale: 'stars',
      platformRatingLabel: null,
      ingested: 0,
      pagesFetched: 0,
      pagesPlanned: 0,
      duplicatesSkipped: 0,
      emptySkipped: 0,
      averageRating: null,
      ratingDistribution: emptyDistribution(),
      dateRange: null,
      ingestedAt: null,
      warnings: [],
      snapshot: null,
    };
  }

  getReviews(): Review[] {
    return this.reviews;
  }

  getSummary(): IngestionSummary {
    return this.summary;
  }

  hasData(): boolean {
    return this.reviews.length > 0;
  }

  /** Milliseconds since the restored snapshot was saved, or null when serving fresh/no data. */
  snapshotAgeMs(now = Date.now()): number | null {
    const savedAt = this.summary.snapshot?.savedAt;
    if (!savedAt) return null;
    const t = Date.parse(savedAt);
    return Number.isNaN(t) ? null : Math.max(0, now - t);
  }

  setSummary(summary: IngestionSummary): void {
    this.summary = summary;
  }

  replaceAll(reviews: Review[]): void {
    this.reviews = [...reviews].sort((a, b) =>
      b.publishedAt.localeCompare(a.publishedAt),
    );
  }

  /**
   * Restore the last good snapshot, but only if it came from the same source:
   * changing the configured entity must never surface the old entity's reviews.
   */
  async restore(sourceKey: string): Promise<boolean> {
    const snap = await this.repo.load();
    if (!snap) return false;
    if (snap.summary.sourceUrl !== sourceKey) {
      this.logger.warn(`Ignoring snapshot for a different source (${snap.summary.sourceUrl})`);
      return false;
    }
    if (!snap.reviews.length) return false;
    this.reviews = snap.reviews;
    this.summary = {
      ...ReviewsService.blankSummary(snap.summary.sourceUrl),
      ...snap.summary,
      status: 'ready',
      snapshot: { savedAt: snap.savedAt },
    };
    this.logger.log(`Restored ${snap.reviews.length} reviews from snapshot saved ${snap.savedAt}`);
    return true;
  }

  /** Best effort: a failed write must not break ingestion. */
  async persist(): Promise<void> {
    try {
      await this.repo.save({
        version: 1,
        savedAt: new Date().toISOString(),
        summary: { ...this.summary, snapshot: null },
        reviews: this.reviews,
      });
    } catch (err) {
      this.logger.warn(`Could not save snapshot: ${(err as Error).message}`);
    }
  }

  /** A refresh failed but older data exists: keep serving it and say why it is stale. */
  markRefreshFailed(error: string): void {
    const savedAt = this.summary.snapshot?.savedAt ?? this.summary.ingestedAt ?? new Date().toISOString();
    this.summary = { ...this.summary, status: 'ready', snapshot: { savedAt, refreshError: error } };
  }

  static computeStats(reviews: Review[], ratingScale: RatingScale = 'stars'): Pick<
    IngestionSummary,
    'averageRating' | 'ratingDistribution' | 'dateRange'
  > {
    const ratingDistribution = emptyDistribution();
    let sum = 0;
    for (const r of reviews) {
      const k = Math.min(5, Math.max(1, Math.round(r.rating))) as 1 | 2 | 3 | 4 | 5;
      ratingDistribution[k]++;
      sum += r.rating;
    }
    const dates = reviews.map((r) => r.publishedAt).filter(Boolean).sort();
    return {
      averageRating: reviews.length && ratingScale === 'stars'
        ? Math.round((sum / reviews.length) * 100) / 100
        : null,
      ratingDistribution,
      dateRange: dates.length
        ? { from: dates[0].slice(0, 10), to: dates[dates.length - 1].slice(0, 10) }
        : null,
    };
  }
}
