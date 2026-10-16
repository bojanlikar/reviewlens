import { readFileSync } from 'node:fs';
import { parseTrustpilotPage, TrustpilotScraperService } from './trustpilot-scraper.service.js';

describe('parseTrustpilotPage', () => {
  const html = readFileSync('test/fixtures/trustpilot-page.html', 'utf8');

  it('extracts entity metadata and reviews, skipping empty ones', () => {
    const p = parseTrustpilotPage(html);
    expect(p.entityName).toBe('Acme Co');
    expect(p.reportedTotal).toBe(1234);
    expect(p.totalPages).toBe(62);
    expect(p.reviews.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(p.skippedEmpty).toBe(1);
  });

  it('throws a clear error when the page has no embedded data', () => {
    expect(() => parseTrustpilotPage('<html></html>')).toThrow(/__NEXT_DATA__/);
  });
});

describe('TrustpilotScraperService.validateUrl', () => {
  it('accepts Trustpilot review URLs', () => {
    expect(() => TrustpilotScraperService.validateUrl('https://www.trustpilot.com/review/acme.com')).not.toThrow();
  });
  it.each(['http://www.trustpilot.com/review/x', 'https://evil.com/review/x', 'https://www.trustpilot.com/about', 'nope'])(
    'rejects %s',
    (u) => expect(() => TrustpilotScraperService.validateUrl(u)).toThrow(),
  );
});
