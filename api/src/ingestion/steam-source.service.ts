import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Review } from '../reviews/review.types.js';
import { fetchText, sleep } from './http.js';
import type { ReviewSource, ScrapeResult } from './source.types.js';

const PAGE_SIZE = 50;
const MAX_STEAM_PAGES = 40;
const EXAMPLE_URL = 'https://store.steampowered.com/app/620/Portal_2/';
const JSON_HEADERS = { Accept: 'application/json' };

export interface SteamSummary {
  totalPositive: number;
  totalNegative: number;
  totalReviews: number;
  scoreDesc: string | null;
}

export interface SteamPage {
  reviews: Review[];
  skippedEmpty: number;
  /** Reviews on the page including skipped ones; 0 means the cursor ran out. */
  rawCount: number;
  nextCursor: string | null;
  /** Only present on the first page of a query. */
  summary: SteamSummary | null;
}

/**
 * Parses one page of Steam's appreviews JSON. Reviews are thumbs up/down
 * (`voted_up`), so they are mapped to 5 (recommended) or 1 (not recommended)
 * and the summary is flagged with ratingScale "thumbs". Reviewer identities
 * (Steam ids, profile names) are deliberately not kept.
 */
export function parseSteamPage(json: string): SteamPage {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Steam returned a response that is not valid JSON');
  }
  if (data?.success !== 1) {
    throw new Error(`Steam did not return reviews (success=${data?.success ?? 'missing'})`);
  }

  const list: any[] = Array.isArray(data.reviews) ? data.reviews : [];
  const reviews: Review[] = [];
  let skippedEmpty = 0;
  for (const r of list) {
    const id = r?.recommendationid ? String(r.recommendationid) : '';
    const text = String(r?.review ?? '').trim();
    if (!id || !text) {
      skippedEmpty++;
      continue;
    }
    const minutes = [r?.author?.playtime_at_review, r?.author?.playtime_forever].find(
      (m) => typeof m === 'number' && m >= 0,
    );
    reviews.push({
      id,
      rating: r.voted_up ? 5 : 1,
      title: '',
      text,
      publishedAt: Number.isFinite(r.timestamp_created) ? new Date(r.timestamp_created * 1000).toISOString() : '',
      author: 'Steam user',
      language: typeof r.language === 'string' ? r.language : undefined,
      likes: typeof r.votes_up === 'number' ? r.votes_up : undefined,
      playtimeHours: typeof minutes === 'number' ? Math.round(minutes / 6) / 10 : undefined,
    });
  }

  const q = data.query_summary;
  return {
    reviews,
    skippedEmpty,
    rawCount: list.length,
    nextCursor: typeof data.cursor === 'string' && data.cursor ? data.cursor : null,
    summary:
      q && typeof q.total_reviews === 'number'
        ? {
            totalPositive: Number(q.total_positive) || 0,
            totalNegative: Number(q.total_negative) || 0,
            totalReviews: q.total_reviews,
            scoreDesc: typeof q.review_score_desc === 'string' ? q.review_score_desc : null,
          }
        : null,
  };
}

function ratingLabel(s: SteamSummary | null): string | null {
  if (!s || s.totalReviews <= 0) return null;
  const pct = Math.round((s.totalPositive / s.totalReviews) * 100);
  return `${s.scoreDesc ?? 'Steam user reviews'} (${pct}% positive of ${s.totalReviews} reviews)`;
}

@Injectable()
export class SteamSourceService implements ReviewSource {
  readonly platform = 'Steam';
  private readonly logger = new Logger(SteamSourceService.name);

  constructor(private readonly config: ConfigService) {}

  supports(url: string): boolean {
    try {
      return new URL(url).hostname.toLowerCase() === 'store.steampowered.com';
    } catch {
      return false;
    }
  }

  /** https://store.steampowered.com/app/<id>/<Name>/ (or the /appreviews/<id> API form) → app id */
  static parseUrl(input: string): { appId: string } {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new Error(`Invalid URL: ${input}`);
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'store.steampowered.com') {
      throw new Error(`Only https://store.steampowered.com game URLs are supported, e.g. ${EXAMPLE_URL}`);
    }
    const appId = /^\/(?:app|appreviews)\/(\d+)/.exec(url.pathname)?.[1];
    if (!appId) throw new Error(`Steam URL must contain a game id, e.g. ${EXAMPLE_URL}`);
    return { appId };
  }

  private language(warnings: string[]): string {
    const raw = this.config.get<string>('STEAM_LANGUAGE')?.trim() || 'english';
    if (/^[A-Za-z_-]{2,20}$/.test(raw)) return raw.toLowerCase();
    warnings.push(`Ignoring invalid STEAM_LANGUAGE "${raw}"; using english.`);
    return 'english';
  }

  private static pageUrl(appId: string, language: string, cursor: string): string {
    return (
      `https://store.steampowered.com/appreviews/${appId}?json=1&filter=recent` +
      `&language=${encodeURIComponent(language)}&purchase_type=all&review_type=all` +
      `&num_per_page=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
    );
  }

  async scrape(sourceUrl: string, maxPages: number): Promise<ScrapeResult> {
    const { appId } = SteamSourceService.parseUrl(sourceUrl);
    const warnings: string[] = [
      'Steam has no star ratings: every review is either "recommended" or "not recommended".',
    ];
    const language = this.language(warnings);
    warnings.push(
      language === 'all'
        ? 'Reviews in all languages are included.'
        : `Only ${language}-language reviews are included (set STEAM_LANGUAGE=all for every language).`,
    );
    const pagesPlanned = Math.max(1, Math.min(maxPages, MAX_STEAM_PAGES));

    const name = await this.lookupName(appId, warnings);

    const seen = new Map<string, Review>();
    let duplicatesSkipped = 0;
    let emptySkipped = 0;
    let pagesFetched = 0;
    let exhausted = false;
    let summary: SteamSummary | null = null;
    let cursor = '*';

    for (let page = 1; page <= pagesPlanned; page++) {
      let parsed: SteamPage;
      try {
        parsed = parseSteamPage(await fetchText(SteamSourceService.pageUrl(appId, language, cursor), JSON_HEADERS));
      } catch (err) {
        if (page === 1) throw err;
        warnings.push(`Stopped at page ${page}: ${(err as Error).message}`);
        break;
      }
      pagesFetched++;
      if (page === 1) {
        summary = parsed.summary;
        if (parsed.rawCount === 0) {
          throw new Error(
            `Steam returned no ${language === 'all' ? '' : `${language} `}reviews for app ${appId}. ` +
              `Check the game id in REVIEW_SOURCE_URL${language === 'all' ? '' : ', or set STEAM_LANGUAGE=all'}.`,
          );
        }
      }
      emptySkipped += parsed.skippedEmpty;
      for (const r of parsed.reviews) {
        if (seen.has(r.id)) duplicatesSkipped++;
        else seen.set(r.id, r);
      }
      if (parsed.rawCount === 0 || !parsed.nextCursor || parsed.nextCursor === cursor) {
        exhausted = true; // no more reviews, or the cursor stopped advancing
        break;
      }
      cursor = parsed.nextCursor;
      if (page < pagesPlanned) await sleep(300);
    }

    this.logger.log(`Fetched ${seen.size} Steam reviews over ${pagesFetched} pages`);
    return {
      platform: this.platform,
      entityName: name ?? `Steam app ${appId}`,
      reportedTotal: summary?.totalReviews ?? null,
      trustScore: null,
      platformRatingLabel: ratingLabel(summary),
      ratingScale: 'thumbs',
      reviews: [...seen.values()],
      pagesFetched,
      pagesPlanned: exhausted ? pagesFetched : pagesPlanned,
      duplicatesSkipped,
      emptySkipped,
      warnings,
    };
  }

  /** Best-effort: the game's name from the Steam store API. */
  private async lookupName(appId: string, warnings: string[]): Promise<string | null> {
    try {
      const body = await fetchText(
        `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`,
        JSON_HEADERS,
      );
      const entry = JSON.parse(body)?.[appId];
      return entry?.success && typeof entry.data?.name === 'string' ? (entry.data.name as string) : null;
    } catch (err) {
      warnings.push(`Could not look up the game name: ${(err as Error).message}`);
      return null;
    }
  }
}
