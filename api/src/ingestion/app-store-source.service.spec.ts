import { Injectable, Logger } from '@nestjs/common';
import type { Review } from '../reviews/review.types.js';
import { fetchText, sleep } from './http.js';
import type { ReviewSource, ScrapeResult } from './source.types.js';

const MAX_APPLE_PAGES = 10; // Apple's feed serves at most 10 pages x 50 reviews
const EXAMPLE_URL = 'https://apps.apple.com/us/app/instagram/id389801252';
const JSON_HEADERS = { Accept: 'application/json' };
const FIRST_PAGE_ATTEMPTS = 3;

/** Short, single-line excerpt of a response body for logs and error messages. */
function snippet(body: string, max = 160): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat
    ? `${body.length} bytes: ${flat.slice(0, max)}${flat.length > max ? '…' : ''}`
    : 'empty body';
}

export interface ParsedFeed {
  reviews: Review[];
  skippedEmpty: number;
  metaName: string | null;
}

/**
 * Parses one page of Apple's customer-reviews JSON feed. Entries without a
 * rating are feed/app metadata, not reviews, and are ignored.
 */
export function parseAppStoreFeed(json: string): ParsedFeed {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Apple returned a response that is not valid JSON');
  }
  let entries = data?.feed?.entry ?? [];
  if (!Array.isArray(entries)) entries = [entries]; // a single entry is not wrapped in an array

  const reviews: Review[] = [];
  let skippedEmpty = 0;
  let metaName: string | null = null;
  for (const e of entries) {
    if (!e?.['im:rating']) {
      metaName ??= e?.['im:name']?.label ?? null;
      continue;
    }
    const rating = Number(e['im:rating'].label);
    const title = String(e.title?.label ?? '').trim();
    const text = String(e.content?.label ?? '').trim();
    const id = String(e.id?.label ?? '');
    if (!id || !(rating >= 1 && rating <= 5) || (!title && !text)) {
      skippedEmpty++;
      continue;
    }
    reviews.push({
      id,
      rating,
      title,
      text,
      publishedAt: String(e.updated?.label ?? ''),
      author: String(e.author?.name?.label ?? 'Anonymous'),
      version: e['im:version']?.label
        ? String(e['im:version'].label)
        : undefined,
    });
  }
  return { reviews, skippedEmpty, metaName };
}

@Injectable()
export class AppStoreSourceService implements ReviewSource {
  readonly platform = 'Apple App Store';
  private readonly logger = new Logger(AppStoreSourceService.name);
  /** Base wait between first-page retries (overridable in tests). */
  retryDelayMs = 1500;

  supports(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'apps.apple.com' || host === 'itunes.apple.com';
    } catch {
      return false;
    }
  }

  /** https://apps.apple.com/<country>/app/<name>/id<appId> → { id, country } */
  static parseUrl(input: string): { id: string; country: string } {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new Error(`Invalid URL: ${input}`);
    }
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      !(host === 'apps.apple.com' || host === 'itunes.apple.com')
    ) {
      throw new Error(
        `Only https://apps.apple.com app URLs are supported, e.g. ${EXAMPLE_URL}`,
      );
    }
    const id = /\/id(\d+)/.exec(url.pathname)?.[1];
    if (!id)
      throw new Error(
        `App Store URL must contain an app id, e.g. ${EXAMPLE_URL}`,
      );
    const first = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return {
      id,
      country: /^[a-z]{2}$/i.test(first) ? first.toLowerCase() : 'us',
    };
  }

  async scrape(sourceUrl: string, maxPages: number): Promise<ScrapeResult> {
    const { id, country } = AppStoreSourceService.parseUrl(sourceUrl);
    const pagesPlanned = Math.max(1, Math.min(maxPages, MAX_APPLE_PAGES));
    const warnings = [
      `Apple exposes only the most recent written reviews (up to about 500) for the ${country.toUpperCase()} storefront; reviews from other countries are not included.`,
    ];

    const meta = await this.lookup(id, country, warnings);

    const seen = new Map<string, Review>();
    let duplicatesSkipped = 0;
    let emptySkipped = 0;
    let pagesFetched = 0;
    let exhausted = false;
    let metaName: string | null = null;

    for (let page = 1; page <= pagesPlanned; page++) {
      let parsed: ParsedFeed;
      try {
        parsed =
          page === 1
            ? await this.fetchFirstPage(id, country)
            : parseAppStoreFeed(
                await fetchText(
                  AppStoreSourceService.feedUrl(id, country, page),
                  JSON_HEADERS,
                ),
              );
      } catch (err) {
        if (page === 1) throw err;
        warnings.push(`Stopped at page ${page}: ${(err as Error).message}`);
        break;
      }
      pagesFetched++;
      metaName ??= parsed.metaName;
      emptySkipped += parsed.skippedEmpty;
      for (const r of parsed.reviews) {
        if (seen.has(r.id)) duplicatesSkipped++;
        else seen.set(r.id, r);
      }
      if (parsed.reviews.length === 0 && parsed.skippedEmpty === 0) {
        exhausted = true; // no more pages
        break;
      }
      if (page < pagesPlanned) await sleep(300);
    }

    if (seen.size === 0) {
      warnings.push(
        `The feed returned no written reviews for app ${id} in the ${country.toUpperCase()} storefront.`,
      );
    }
    this.logger.log(
      `Fetched ${seen.size} App Store reviews over ${pagesFetched} pages`,
    );
    return {
      platform: this.platform,
      entityName: meta.name ?? metaName ?? `App ${id}`,
      // Apple's rating count includes star-only ratings, so it is not comparable
      // with the number of written reviews and is reported as a warning instead.
      reportedTotal: null,
      trustScore: meta.rating,
      reviews: [...seen.values()],
      pagesFetched,
      pagesPlanned: exhausted ? pagesFetched : pagesPlanned,
      duplicatesSkipped,
      emptySkipped,
      warnings: [
        ...warnings,
        ...(meta.ratingCount !== null
          ? [
              `The app has ${meta.ratingCount} star ratings overall; the written reviews ingested are only a subset.`,
            ]
          : []),
      ],
    };
  }

  /** Apple serves the feed under two URL shapes; the second has no explicit page segment. */
  static feedUrl(
    id: string,
    country: string,
    page: number,
    withoutPage = false,
  ): string {
    return withoutPage
      ? `https://itunes.apple.com/${country}/rss/customerreviews/id=${id}/sortby=mostrecent/json`
      : `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${id}/sortby=mostrecent/json`;
  }

  /**
   * The first page decides whether ingestion works at all, and Apple's feed
   * sometimes answers HTTP 200 with no entries (throttling or a hiccup). Retry
   * with the other URL shape, and when it stays empty say what Apple returned
   * instead of a bare "no reviews".
   */
  private async fetchFirstPage(
    id: string,
    country: string,
  ): Promise<ParsedFeed> {
    let lastBody = '';
    for (let attempt = 1; attempt <= FIRST_PAGE_ATTEMPTS; attempt++) {
      const url = AppStoreSourceService.feedUrl(id, country, 1, attempt === 2);
      const body = await fetchText(url, JSON_HEADERS);
      const parsed = parseAppStoreFeed(body);
      if (parsed.reviews.length > 0 || parsed.skippedEmpty > 0) return parsed;
      lastBody = body;
      this.logger.warn(
        `App Store page 1 came back empty (attempt ${attempt}/${FIRST_PAGE_ATTEMPTS}) from ${url} (${snippet(body)})`,
      );
      if (attempt < FIRST_PAGE_ATTEMPTS)
        await sleep(this.retryDelayMs * attempt);
    }
    throw new Error(
      `Apple's review feed returned no written reviews for app ${id} in the ${country.toUpperCase()} storefront ` +
        `after ${FIRST_PAGE_ATTEMPTS} attempts (response: ${snippet(lastBody)}). ` +
        `Check the app id and country in REVIEW_SOURCE_URL, and that the app has written reviews in that storefront. ` +
        `In 2026 Apple's public review feed has been returning empty results for many apps, so this may not be a configuration problem; ` +
        `another app or storefront may still work, or set REVIEW_SOURCE_FILE to load saved reviews.`,
    );
  }

  /** Best-effort: app name and aggregate rating from the iTunes Lookup API. */
  private async lookup(id: string, country: string, warnings: string[]) {
    try {
      const body = await fetchText(
        `https://itunes.apple.com/lookup?id=${id}&country=${country}`,
        {
          Accept: 'application/json',
        },
      );
      const r = JSON.parse(body)?.results?.[0];
      return {
        name: typeof r?.trackName === 'string' ? (r.trackName as string) : null,
        rating:
          typeof r?.averageUserRating === 'number'
            ? Math.round(r.averageUserRating * 100) / 100
            : null,
        ratingCount:
          typeof r?.userRatingCount === 'number'
            ? (r.userRatingCount as number)
            : null,
      };
    } catch (err) {
      warnings.push(
        `Could not look up the app name and overall rating: ${(err as Error).message}`,
      );
      return { name: null, rating: null, ratingCount: null };
    }
  }
}
