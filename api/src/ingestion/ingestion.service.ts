import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReviewsService } from '../reviews/reviews.service.js';
import { AppStoreSourceService } from './app-store-source.service.js';
import { FileSourceService } from './file-source.service.js';
import { SteamSourceService } from './steam-source.service.js';
import type { ReviewSource } from './source.types.js';
import { TrustpilotScraperService } from './trustpilot-scraper.service.js';

@Injectable()
export class IngestionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IngestionService.name);
  private running: Promise<void> | null = null;
  private readonly sources: ReviewSource[];

  constructor(
    private readonly config: ConfigService,
    trustpilot: TrustpilotScraperService,
    appStore: AppStoreSourceService,
    steam: SteamSourceService,
    private readonly files: FileSourceService,
    private readonly reviews: ReviewsService,
  ) {
    // Register new platforms here.
    this.sources = [steam, appStore, trustpilot];
  }

  private get source(): { file?: string; key: string } {
    const file = this.config.get<string>('REVIEW_SOURCE_FILE') || undefined;
    return { file, key: file ?? (this.config.get<string>('REVIEW_SOURCE_URL') as string) };
  }

  /** Pick the adapter that understands the configured URL. */
  private resolve(url: string): ReviewSource {
    const found = this.sources.find((s) => s.supports(url));
    if (!found) {
      throw new Error(
        `Unsupported review source: ${url}\nSupported: Steam (https://store.steampowered.com/app/<id>/<name>/), Apple App Store (https://apps.apple.com/<cc>/app/<name>/id<id>), Trustpilot (https://www.trustpilot.com/review/<domain>), or REVIEW_SOURCE_FILE for saved data.`,
      );
    }
    return found;
  }

  /**
   * Serve the last good snapshot immediately (if it matches the configured
   * source). Unless that snapshot is younger than REFRESH_MIN_AGE_HOURS, refresh
   * in the background without blocking startup. Skipping the refresh while the
   * data is fresh keeps restarts from hammering (and getting throttled by) the
   * source; /reingest always forces one.
   */
  async onApplicationBootstrap(): Promise<void> {
    const restored = await this.reviews.restore(this.source.key);
    const minAgeHours = Number(this.config.get('REFRESH_MIN_AGE_HOURS') ?? 6);
    const age = this.reviews.snapshotAgeMs();
    if (restored && minAgeHours > 0 && age !== null && age < minAgeHours * 3_600_000) {
      this.logger.log(
        `Snapshot is ${Math.round(age / 60_000)} min old (< ${minAgeHours} h): skipping the startup refresh. Use /reingest to force one.`,
      );
      return;
    }
    void this.ingest();
  }

  ingest(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.doIngest().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doIngest(): Promise<void> {
    const { file: sourceFile, key: sourceUrl } = this.source;
    const maxPages = Number(this.config.get('MAX_PAGES') ?? 10);
    const base = ReviewsService.blankSummary(sourceUrl);
    // With existing data we keep serving it while refreshing.
    const hadData = this.reviews.hasData();
    if (!hadData) this.reviews.setSummary({ ...base, status: 'running' });
    let platform = base.platform;

    try {
      const adapter = sourceFile ? undefined : this.resolve(sourceUrl);
      if (adapter) platform = adapter.platform;
      const res = sourceFile ? await this.files.load(sourceFile) : await adapter!.scrape(sourceUrl, maxPages);
      platform = res.platform;
      // Never replace good data with an empty result.
      if (res.reviews.length === 0) throw new Error('No reviews were extracted.');

      const warnings = [...res.warnings];
      if (res.reportedTotal !== null && res.reviews.length < res.reportedTotal) {
        warnings.push(
          `Ingested ${res.reviews.length} of ${res.reportedTotal} reviews the platform reports for this entity.`,
        );
      }
      this.reviews.replaceAll(res.reviews);
      this.reviews.setSummary({
        ...base,
        platform,
        status: 'ready',
        entityName: res.entityName,
        reportedTotal: res.reportedTotal,
        reportedTrustScore: res.trustScore,
        ratingScale: res.ratingScale ?? 'stars',
        platformRatingLabel: res.platformRatingLabel ?? null,
        ingested: res.reviews.length,
        pagesFetched: res.pagesFetched,
        pagesPlanned: res.pagesPlanned,
        duplicatesSkipped: res.duplicatesSkipped,
        emptySkipped: res.emptySkipped,
        ...ReviewsService.computeStats(res.reviews, res.ratingScale ?? 'stars'),
        ingestedAt: new Date().toISOString(),
        warnings,
      });
      await this.reviews.persist();
    } catch (err) {
      let message = (err as Error).message;
      if (platform === 'Trustpilot' && !sourceFile && /HTTP 40[13]/.test(message)) {
        message +=
          '\n\nTrustpilot blocks automated requests from this client. Workaround: save the review page(s) from your browser into a folder (Save Page As → HTML), mount it, and set REVIEW_SOURCE_FILE to that folder (or a .json file), or use an Apple App Store URL. See README.';
      }
      this.logger.error(`Ingestion failed: ${message}`);
      if (hadData) this.reviews.markRefreshFailed(message);
      else this.reviews.setSummary({ ...base, platform, status: 'failed', error: message });
    }
  }
}
