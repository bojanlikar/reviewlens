import type { IngestionSummary } from './review.types.js';

/** Markdown rendering of the ingestion summary, shown in the chat UI. */
export function formatSummaryMarkdown(s: IngestionSummary): string {
  if (s.status === 'running' || s.status === 'idle') {
    return `⏳ **Ingestion in progress** for ${s.sourceUrl}. Try \`/summary\` again in a few seconds.`;
  }
  if (s.status === 'failed') {
    return `❌ **Ingestion failed** for ${s.sourceUrl}\n\n${s.error ?? 'No reviews could be extracted.'}`;
  }

  const thumbs = s.ratingScale === 'thumbs';
  const rows: Array<[string, number]> = thumbs
    ? [
        ['👍 Recommended', s.ratingDistribution[5]],
        ['👎 Not recommended', s.ratingDistribution[1]],
      ]
    : ([5, 4, 3, 2, 1] as const).map((k): [string, number] => [`${k}★`, s.ratingDistribution[k]]);
  const max = Math.max(1, ...rows.map(([, n]) => n));
  const bars = rows
    .map(([label, n]) => {
      const pct = s.ingested ? Math.round((n / s.ingested) * 100) : 0;
      return `| ${label} | ${'█'.repeat(Math.round((n / max) * 20)) || '·'} | ${n} (${pct}%) |`;
    })
    .join('\n');

  let coverage = `${s.ingested}`;
  if (s.reportedTotal !== null) {
    const p = (s.ingested / Math.max(1, s.reportedTotal)) * 100;
    coverage = `${s.ingested} of ${s.reportedTotal} (${p > 0 && p < 1 ? '<1' : Math.round(p)}%)`;
  }
  const ratingLine = thumbs
    ? `- **Verdict:** ${s.ingested ? Math.round((s.ratingDistribution[5] / s.ingested) * 100) : 0}% recommended (ingested sample)` +
      (s.platformRatingLabel ? `  ·  platform: ${s.platformRatingLabel}` : '')
    : `- **Average rating (ingested):** ${s.averageRating ?? 'n/a'} / 5` +
      (s.reportedTrustScore !== null ? `  ·  platform rating: ${s.reportedTrustScore}` : '');

  const lines = [
    ...(s.snapshot
      ? [
          `> ⚠️ **Showing a saved snapshot from ${s.snapshot.savedAt.slice(0, 16).replace('T', ' ')} UTC.** ` +
            (s.snapshot.refreshError
              ? `The latest refresh failed: ${s.snapshot.refreshError.split('\n')[0]}`
              : 'Type `/reingest` to refresh it now.'),
          '',
        ]
      : []),
    `## ✅ Ingested: ${s.entityName ?? 'Unknown entity'} (${s.platform})`,
    '',
    `- **Source:** ${s.sourceUrl}`,
    `- **Reviews ingested:** ${coverage}`,
    ratingLine,
    s.dateRange ? `- **Date range:** ${s.dateRange.from} → ${s.dateRange.to}` : '',
    `- **Pages fetched:** ${s.pagesFetched}/${s.pagesPlanned}  ·  duplicates skipped: ${s.duplicatesSkipped}  ·  empty skipped: ${s.emptySkipped}`,
    '',
    `| ${thumbs ? 'Verdict' : 'Rating'} | Distribution | Reviews |`,
    '|---|---|---|',
    bars,
  ];
  if (s.warnings.length) {
    lines.push('', '**⚠️ Data-quality notes**', ...s.warnings.map((w) => `- ${w}`));
  }
  lines.push('', '_Ask me anything about these reviews. Commands: `/summary`, `/reingest`._');
  return lines.filter((l) => l !== undefined).join('\n');
}
