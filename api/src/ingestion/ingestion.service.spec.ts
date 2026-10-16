import { ConfigService } from '@nestjs/config';
import { ReviewRepository, type Snapshot } from '../reviews/review.repository.js';
import type { Review } from '../reviews/review.types.js';
import { ReviewsService } from '../reviews/reviews.service.js';
import type { AppStoreSourceService } from './app-store-source.service.js';
import type { FileSourceService } from './file-source.service.js';
import { IngestionService } from './ingestion.service.js';
import type { SteamSourceService } from './steam-source.service.js';
import type { ScrapeResult } from './source.types.js';
import type { TrustpilotScraperService } from './trustpilot-scraper.service.js';

class MemoryRepo extends ReviewRepository {
  constructor(public snap: Snapshot | null = null) {
    super();
  }
  async load() {
    return this.snap;
  }
  async save(s: Snapshot) {
    this.snap = s;
  }
}

const SOURCE = 'https://www.trustpilot.com/review/acme.com';
const APP_URL = 'https://apps.apple.com/us/app/acme/id111';
const review = (id: string): Review => ({ id, rating: 4, title: 't', text: 'x', publishedAt: '2026-09-01T00:00:00Z', author: 'a' });
const result = (reviews: Review[], platform = 'Trustpilot'): ScrapeResult => ({
  platform, entityName: 'Acme', reportedTotal: null, trustScore: null, reviews,
  pagesFetched: 1, pagesPlanned: 1, duplicatesSkipped: 0, emptySkipped: 0, warnings: [],
});

function setup(
  scrape: () => Promise<ScrapeResult>,
  repo = new MemoryRepo(),
  url = SOURCE,
  appScrape: () => Promise<ScrapeResult> = async () => result([review('app')], 'Apple App Store'),
  extraConfig: Record<string, unknown> = {},
) {
  const reviews = new ReviewsService(repo);
  const trustpilot = { platform: 'Trustpilot', supports: (u: string) => u.includes('trustpilot.com'), scrape };
  const appStore = { platform: 'Apple App Store', supports: (u: string) => u.includes('apple.com'), scrape: appScrape };
  const steam = {
    platform: 'Steam',
    supports: (u: string) => u.includes('steampowered.com'),
    scrape: async () => ({ ...result([review('s1'), review('s2')], 'Steam'), ratingScale: 'thumbs' as const, platformRatingLabel: 'Very Positive' }),
  };
  const svc = new IngestionService(
    new ConfigService({ REVIEW_SOURCE_URL: url, ...extraConfig }),
    trustpilot as unknown as TrustpilotScraperService,
    appStore as unknown as AppStoreSourceService,
    steam as unknown as SteamSourceService,
    {} as FileSourceService,
    reviews,
  );
  return { svc, reviews, repo };
}

describe('IngestionService persistence', () => {
  it('saves a snapshot after a successful ingestion', async () => {
    const { svc, repo } = setup(async () => result([review('1')]));
    await svc.ingest();
    expect(repo.snap?.reviews).toHaveLength(1);
    expect(repo.snap?.summary.sourceUrl).toBe(SOURCE);
    expect(repo.snap?.summary.snapshot).toBeNull();
  });

  it('serves the snapshot and flags it stale when the refresh fails', async () => {
    const first = setup(async () => result([review('1')]));
    await first.svc.ingest();

    const { svc, reviews } = setup(async () => { throw new Error('HTTP 403 for x'); }, first.repo);
    expect(await reviews.restore(SOURCE)).toBe(true);
    await svc.ingest();

    const s = reviews.getSummary();
    expect(s.status).toBe('ready');
    expect(s.ingested).toBe(1);
    expect(reviews.getReviews()).toHaveLength(1);
    expect(s.snapshot?.refreshError).toMatch(/403/);
  });

  it('does not overwrite good data with an empty result', async () => {
    const first = setup(async () => result([review('1')]));
    await first.svc.ingest();
    const { svc, reviews } = setup(async () => result([]), first.repo);
    await reviews.restore(SOURCE);
    await svc.ingest();
    expect(reviews.getReviews()).toHaveLength(1);
    expect(first.repo.snap?.reviews).toHaveLength(1);
  });

  it('ignores a snapshot taken from a different source', async () => {
    const first = setup(async () => result([review('1')]));
    await first.svc.ingest();
    const { reviews } = setup(async () => result([]), first.repo);
    expect(await reviews.restore('https://www.trustpilot.com/review/other.com')).toBe(false);
    expect(reviews.hasData()).toBe(false);
  });

  it('reports failure when there is no data to fall back on', async () => {
    const { svc, reviews } = setup(async () => { throw new Error('boom'); });
    await svc.ingest();
    expect(reviews.getSummary().status).toBe('failed');
    expect(reviews.getSummary().error).toBe('boom');
  });
});

describe('IngestionService source routing', () => {
  it('routes an App Store URL to the App Store adapter and records the platform', async () => {
    const { svc, reviews } = setup(async () => { throw new Error('wrong adapter'); }, new MemoryRepo(), APP_URL);
    await svc.ingest();
    expect(reviews.getSummary().status).toBe('ready');
    expect(reviews.getSummary().platform).toBe('Apple App Store');
  });

  it('fails clearly for an unsupported URL and lists what is supported', async () => {
    const { svc, reviews } = setup(async () => result([]), new MemoryRepo(), 'https://www.amazon.com/dp/B000');
    await svc.ingest();
    expect(reviews.getSummary().status).toBe('failed');
    expect(reviews.getSummary().error).toMatch(/Unsupported review source[\s\S]*Apple App Store[\s\S]*Trustpilot/);
  });

  it('adds the Trustpilot workaround hint only for Trustpilot 403s', async () => {
    const tp = setup(async () => { throw new Error('HTTP 403 for x'); });
    await tp.svc.ingest();
    expect(tp.reviews.getSummary().error).toMatch(/REVIEW_SOURCE_FILE/);

    const app = setup(async () => result([]), new MemoryRepo(), APP_URL, async () => { throw new Error('HTTP 403 for y'); });
    await app.svc.ingest();
    expect(app.reviews.getSummary().error).not.toMatch(/Trustpilot blocks/);
  });
});

describe('IngestionService startup refresh window', () => {
  const HOUR = 3_600_000;

  /** A repo holding a snapshot saved `ageHours` ago for SOURCE. */
  async function repoWithSnapshot(ageHours: number) {
    const first = setup(async () => result([review('1')]));
    await first.svc.ingest();
    first.repo.snap!.savedAt = new Date(Date.now() - ageHours * HOUR).toISOString();
    return first.repo;
  }

  it('still lets a manual refresh (/reingest) run while the snapshot is fresh', async () => {
    const repo = await repoWithSnapshot(1);
    const scrape = vi.fn(async () => result([review('new')]));
    const { svc, reviews } = setup(scrape, repo);
    await svc.onApplicationBootstrap();
    expect(scrape).not.toHaveBeenCalled();
    await svc.ingest();
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(reviews.getReviews().map((r) => r.id)).toEqual(['new']);
  });

  it('does not fetch at all on startup when the snapshot is fresh', async () => {
    const repo = await repoWithSnapshot(1);
    const scrape = vi.fn(async () => result([review('new')]));
    const { svc, reviews } = setup(scrape, repo);
    await svc.onApplicationBootstrap();
    expect(scrape).not.toHaveBeenCalled();
    expect(reviews.getReviews().map((r) => r.id)).toEqual(['1']);
    expect(reviews.getSummary().snapshot?.refreshError).toBeUndefined();
  });

  it('refreshes on startup once the snapshot is older than the window', async () => {
    const repo = await repoWithSnapshot(7);
    const scrape = vi.fn(async () => result([review('new')]));
    const { svc, reviews } = setup(scrape, repo);
    await svc.onApplicationBootstrap();
    await svc.ingest(); // joins the refresh that startup kicked off
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(reviews.getReviews().map((r) => r.id)).toEqual(['new']);
  });

  it('honours a custom window and 0 meaning always refresh', async () => {
    const repo = await repoWithSnapshot(1);
    const scrape = vi.fn(async () => result([review('new')]));
    const { svc } = setup(scrape, repo, SOURCE, undefined, { REFRESH_MIN_AGE_HOURS: 0 });
    await svc.onApplicationBootstrap();
    await svc.ingest();
    expect(scrape).toHaveBeenCalledTimes(1);

    const repo2 = await repoWithSnapshot(3);
    const scrape2 = vi.fn(async () => result([review('new')]));
    const second = setup(scrape2, repo2, SOURCE, undefined, { REFRESH_MIN_AGE_HOURS: 2 });
    await second.svc.onApplicationBootstrap();
    await second.svc.ingest();
    expect(scrape2).toHaveBeenCalledTimes(1);
  });

  it('always fetches when there is no usable snapshot', async () => {
    const scrape = vi.fn(async () => result([review('new')]));
    const { svc, reviews } = setup(scrape);
    await svc.onApplicationBootstrap();
    await svc.ingest();
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(reviews.hasData()).toBe(true);
  });
});

describe('IngestionService Steam routing', () => {
  it('routes a Steam URL to the Steam adapter and records the thumbs scale', async () => {
    const { svc, reviews } = setup(async () => result([]), new MemoryRepo(), 'https://store.steampowered.com/app/620/Portal_2/');
    await svc.ingest();
    const s = reviews.getSummary();
    expect(s.platform).toBe('Steam');
    expect(s.ratingScale).toBe('thumbs');
    expect(s.platformRatingLabel).toBe('Very Positive');
    expect(s.averageRating).toBeNull();
    expect(s.ingested).toBe(2);
  });
});
