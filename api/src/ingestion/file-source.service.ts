import { Injectable } from '@nestjs/common';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Review } from '../reviews/review.types.js';
import type { ScrapeResult } from './source.types.js';
import { parseTrustpilotPage } from './trustpilot-scraper.service.js';

/**
 * Offline ingestion, used when the platform blocks automated requests.
 * Accepts:
 *  - a directory of saved Trustpilot pages (*.html), one per result page
 *  - a single saved page (.html)
 *  - a JSON file: an array of reviews, or { platform?, entityName, reportedTotal, reviews: [...] }
 */
@Injectable()
export class FileSourceService {
  async load(path: string): Promise<ScrapeResult> {
    const info = await stat(path).catch(() => {
      throw new Error(`REVIEW_SOURCE_FILE not found: ${path}`);
    });
    if (info.isDirectory()) {
      const files = (await readdir(path)).filter((f) => /\.html?$/i.test(f)).sort();
      if (!files.length) throw new Error(`No .html files found in ${path}`);
      return this.fromHtml(await Promise.all(files.map((f) => readFile(join(path, f), 'utf8'))));
    }
    const ext = extname(path).toLowerCase();
    if (ext === '.html' || ext === '.htm') return this.fromHtml([await readFile(path, 'utf8')]);
    if (ext === '.json') return this.fromJson(JSON.parse(await readFile(path, 'utf8')));
    throw new Error(`Unsupported file type "${ext}" (use a directory of .html pages, an .html file or a .json file)`);
  }

  private fromHtml(pages: string[]): ScrapeResult {
    const seen = new Map<string, Review>();
    const warnings: string[] = [];
    let duplicatesSkipped = 0;
    let emptySkipped = 0;
    let meta = { entityName: null as string | null, reportedTotal: null as number | null, trustScore: null as number | null };

    pages.forEach((html, i) => {
      let parsed;
      try {
        parsed = parseTrustpilotPage(html);
      } catch (err) {
        warnings.push(`Saved page ${i + 1} skipped: ${(err as Error).message}`);
        return;
      }
      meta = {
        entityName: meta.entityName ?? parsed.entityName,
        reportedTotal: meta.reportedTotal ?? parsed.reportedTotal,
        trustScore: meta.trustScore ?? parsed.trustScore,
      };
      emptySkipped += parsed.skippedEmpty;
      for (const r of parsed.reviews) {
        if (seen.has(r.id)) duplicatesSkipped++;
        else seen.set(r.id, r);
      }
    });

    return {
      platform: 'Trustpilot',
      ...meta,
      reviews: [...seen.values()],
      pagesFetched: pages.length,
      pagesPlanned: pages.length,
      duplicatesSkipped,
      emptySkipped,
      warnings: ['Data was loaded from saved files, not fetched live.', ...warnings],
    };
  }

  private fromJson(data: any): ScrapeResult {
    const list: any[] = Array.isArray(data) ? data : Array.isArray(data?.reviews) ? data.reviews : [];
    const seen = new Map<string, Review>();
    let duplicatesSkipped = 0;
    let emptySkipped = 0;

    list.forEach((r, i) => {
      const rating = Number(r?.rating);
      const text = String(r?.text ?? '').trim();
      const title = String(r?.title ?? '').trim();
      if (!(rating >= 1 && rating <= 5) || (!text && !title)) {
        emptySkipped++;
        return;
      }
      const id = String(r?.id ?? `json-${i + 1}`);
      if (seen.has(id)) {
        duplicatesSkipped++;
        return;
      }
      seen.set(id, {
        id,
        rating,
        title,
        text,
        publishedAt: String(r?.publishedAt ?? r?.date ?? r?.publishedDate ?? ''),
        author: String(r?.author ?? 'Anonymous'),
        language: r?.language,
        likes: typeof r?.likes === 'number' ? r.likes : undefined,
      });
    });

    return {
      platform: String(data?.platform ?? 'Imported data'),
      entityName: data?.entityName ?? null,
      reportedTotal: typeof data?.reportedTotal === 'number' ? data.reportedTotal : null,
      trustScore: typeof data?.trustScore === 'number' ? data.trustScore : null,
      reviews: [...seen.values()],
      pagesFetched: 1,
      pagesPlanned: 1,
      duplicatesSkipped,
      emptySkipped,
      warnings: ['Data was loaded from a JSON file, not fetched live.'],
    };
  }
}
