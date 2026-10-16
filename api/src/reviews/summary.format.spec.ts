import { ReviewsService } from './reviews.service.js';
import type { Review } from './review.types.js';
import { formatSummaryMarkdown } from './summary.format.js';

const reviews: Review[] = [5, 5, 1].map((rating, i) => ({ id: `${i}`, rating, title: '', text: 'x', publishedAt: '2026-09-01T00:00:00Z', author: 'a' }));
const base = { ...ReviewsService.blankSummary('https://store.steampowered.com/app/620/'), status: 'ready' as const, platform: 'Steam', entityName: 'Portal 2', ingested: 3 };

describe('formatSummaryMarkdown', () => {
  it('renders thumbs without a star average', () => {
    const md = formatSummaryMarkdown({
      ...base, ratingScale: 'thumbs', platformRatingLabel: 'Very Positive (90%)', reportedTotal: 212069,
      ...ReviewsService.computeStats(reviews, 'thumbs'),
    });
    expect(md).toContain('👍 Recommended');
    expect(md).toContain('67% recommended');
    expect(md).toContain('Very Positive (90%)');
    expect(md).toContain('(<1%)');
    expect(md).not.toContain('Average rating');
    expect(md).not.toContain('★');
  });
  it('still renders stars', () => {
    const md = formatSummaryMarkdown({ ...base, platform: 'Trustpilot', ...ReviewsService.computeStats(reviews) });
    expect(md).toContain('Average rating');
    expect(md).toContain('5★');
  });
});
