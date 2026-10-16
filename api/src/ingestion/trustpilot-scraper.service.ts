import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import type { Review } from '../reviews/review.types.js';
import { fetchText, sleep } from './http.js';
import type { ReviewSource, ScrapeResult } from './source.types.js';

export type { ScrapeResult } from './source.types.js';

export interface ParsedPage {
  entityName: string | null;
  reportedTotal: number | null;
  trustScore: number | null;
  totalPages: number | null;
  reviews: Review[];
  skippedEmpty: number;
}

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

/**
 * Parses a Trustpilot review page. Trustpilot is a Next.js app and ships the
 * review list as JSON in <script id="__NEXT_DATA__">, which is far more stable
 * than scraping CSS classes.
 */
export function parseTrustpilotPage(html: string): ParsedPage {
  const $ = cheerio.load(html);
  const raw = $('script#__NEXT_DATA__').first().html();
  if (!raw) {
    throw new Error('No __NEXT_DATA__ found: page layout changed or request was blocked');
  }
  const pageProps = JSON.parse(raw)?.props?.pageProps ?? {};
  const list: any[] = Array.isArray(pageProps.reviews) ? pageProps.reviews : [];

  const reviews: Review[] = [];
  let skippedEmpty = 0;
  for (const r of list) {
    const text = String(r?.text ?? '').trim();
    const title = String(r?.title ?? '').trim();
    if (!r?.id || (!text && !title)) {
      skippedEmpty++;
      continue;
    }
    reviews.push({
      id: String(r.id),
      rating: Number(r.rating),
      title,
      text,
      publishedAt: String(r?.dates?.publishedDate ?? ''),
      author: String(r?.consumer?.displayName ?? 'Anonymous'),
      language: r?.language,
      likes: typeof r?.likes === 'number' ? r.likes : undefined,
    });
  }

  const bu = pageProps.businessUnit ?? {};
  return {
    entityName: bu.displayName ?? null,
    reportedTotal: typeof bu.numberOfReviews === 'number' ? bu.numberOfReviews : null,
    trustScore: typeof bu.trustScore === 'number' ? bu.trustScore : null,
    totalPages: pageProps.filters?.pagination?.totalPages ?? null,
    reviews,
    skippedEmpty,
  };
}

@Injectable()
export class TrustpilotScraperService implements ReviewSource {
  readonly platform = 'Trustpilot';
  private readonly logger = new Logger(TrustpilotScraperService.name);

  supports(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'trustpilot.com' || host.endsWith('.trustpilot.com');
    } catch {
      return false;
    }
  }

  /** Only Trustpilot review URLs are accepted. */
  static validateUrl(input: string): URL {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new Error(`Invalid URL: ${input}`);
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host === 'trustpilot.com' || host.endsWith('.trustpilot.com'))) {
      throw new Error('Only https://*.trustpilot.com review URLs are supported');
    }
    if (!url.pathname.startsWith('/review/')) {
      throw new Error('URL must look like https://www.trustpilot.com/review/<domain>');
    }
    return url;
  }

  async scrape(sourceUrl: string, maxPages: number): Promise<ScrapeResult> {
    const base = TrustpilotScraperService.validateUrl(sourceUrl);
    base.search = '';
    base.searchParams.set('sort', 'recency');

    const warnings: string[] = [];
    const seen = new Map<string, Review>();
    let duplicatesSkipped = 0;
    let emptySkipped = 0;
    let pagesFetched = 0;
    let pagesPlanned = maxPages;
    let meta: Pick<ParsedPage, 'entityName' | 'reportedTotal' | 'trustScore'> = {
      entityName: null,
      reportedTotal: null,
      trustScore: null,
    };

    for (let page = 1; page <= pagesPlanned; page++) {
      const url = new URL(base);
      if (page > 1) url.searchParams.set('page', String(page));
      let parsed: ParsedPage;
      try {
        parsed = parseTrustpilotPage(await fetchText(url.toString(), BROWSER_HEADERS));
      } catch (err) {
        const msg = (err as Error).message;
        if (page === 1) throw err; // nothing ingested: surface as failure
        warnings.push(`Stopped at page ${page}: ${msg}`);
        break;
      }
      pagesFetched++;
      if (page === 1) {
        meta = parsed;
        if (parsed.totalPages) pagesPlanned = Math.min(maxPages, parsed.totalPages);
        if (parsed.totalPages && parsed.totalPages > maxPages) {
          warnings.push(
            `Entity has ${parsed.totalPages} pages of reviews; only the ${maxPages} most recent pages were ingested (MAX_PAGES).`,
          );
        }
      }
      emptySkipped += parsed.skippedEmpty;
      for (const r of parsed.reviews) {
        if (seen.has(r.id)) duplicatesSkipped++;
        else seen.set(r.id, r);
      }
      if (parsed.reviews.length === 0 && parsed.skippedEmpty === 0) break;
      if (page < pagesPlanned) await sleep(600);
    }

    this.logger.log(`Scraped ${seen.size} reviews over ${pagesFetched} pages`);
    return {
      platform: this.platform,
      ...meta,
      reviews: [...seen.values()],
      pagesFetched,
      pagesPlanned,
      duplicatesSkipped,
      emptySkipped,
      warnings,
    };
  }
}
