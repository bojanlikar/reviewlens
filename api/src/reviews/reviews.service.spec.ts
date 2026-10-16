import { ReviewRepository, type Snapshot } from './review.repository.js';
import type { Review } from './review.types.js';
import { ReviewsService } from './reviews.service.js';

const r = (id: string, rating: number): Review => ({ id, rating, title: '', text: 'x', publishedAt: '2026-09-01T00:00:00Z', author: 'a' });

describe('ReviewsService.computeStats', () => {
  it('averages stars', () => {
    expect(ReviewsService.computeStats([r('1', 5), r('2', 4)]).averageRating).toBe(4.5);
  });
  it('has no average for the thumbs scale but keeps the 5/1 counts', () => {
    const s = ReviewsService.computeStats([r('1', 5), r('2', 1), r('3', 5)], 'thumbs');
    expect(s.averageRating).toBeNull();
    expect(s.ratingDistribution[5]).toBe(2);
    expect(s.ratingDistribution[1]).toBe(1);
  });
});

describe('ReviewsService.restore', () => {
  it('fills fields missing from snapshots written by older versions', async () => {
    const { ratingScale: _a, platformRatingLabel: _b, ...old } = ReviewsService.blankSummary('src');
    const snap = { version: 1, savedAt: '2026-10-01T00:00:00Z', summary: old, reviews: [r('1', 5)] } as unknown as Snapshot;
    const repo = new (class extends ReviewRepository {
      async load() { return snap; }
      async save() {}
    })();
    const svc = new ReviewsService(repo);
    expect(await svc.restore('src')).toBe(true);
    expect(svc.getSummary().ratingScale).toBe('stars');
    expect(svc.getSummary().platformRatingLabel).toBeNull();
  });
});
