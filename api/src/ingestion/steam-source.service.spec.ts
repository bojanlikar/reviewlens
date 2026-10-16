import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { parseSteamPage, SteamSourceService } from './steam-source.service.js';

const page1 = readFileSync('test/fixtures/steam-page1.json', 'utf8');
const URL1 = 'https://store.steampowered.com/app/620/Portal_2/';
const svc = (cfg: Record<string, unknown> = {}) => new SteamSourceService(new ConfigService(cfg));

describe('parseSteamPage', () => {
  it('maps thumbs to 5/1, drops identities, skips blank reviews', () => {
    const p = parseSteamPage(page1);
    expect(p.reviews.map((r) => r.id)).toEqual(['101', '102', '104']);
    expect(p.reviews[0]).toMatchObject({ rating: 5, author: 'Steam user', playtimeHours: 11, likes: 12 });
    expect(p.reviews[0].text).toBe('Brilliant puzzles.\nLoved the co-op.');
    expect(p.reviews[1]).toMatchObject({ rating: 1, playtimeHours: 0.5 });
    expect(p.skippedEmpty).toBe(1);
    expect(p.rawCount).toBe(4);
    expect(p.nextCursor).toBe('AoJ4abc+/=');
    expect(p.summary).toMatchObject({ totalReviews: 1000, totalPositive: 900, scoreDesc: 'Overwhelmingly Positive' });
    expect(JSON.stringify(p.reviews)).not.toContain('x1');
  });

  it('rejects bad responses clearly', () => {
    expect(() => parseSteamPage('<html>')).toThrow(/not valid JSON/);
    expect(() => parseSteamPage('{"success":2}')).toThrow(/success=2/);
  });
});

describe('SteamSourceService.parseUrl / supports', () => {
  it('extracts the app id', () => {
    expect(SteamSourceService.parseUrl(URL1).appId).toBe('620');
    expect(SteamSourceService.parseUrl('https://store.steampowered.com/appreviews/620').appId).toBe('620');
  });
  it.each(['http://store.steampowered.com/app/620/', 'https://evil.com/app/620/', 'https://store.steampowered.com/', 'nope'])(
    'rejects %s',
    (u) => expect(() => SteamSourceService.parseUrl(u)).toThrow(),
  );
  it('supports only Steam hosts', () => {
    expect(svc().supports(URL1)).toBe(true);
    expect(svc().supports('https://apps.apple.com/us/app/x/id1')).toBe(false);
  });
});

describe('SteamSourceService.scrape', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('follows the cursor, stops on an empty page and reports thumbs', async () => {
    const empty = JSON.stringify({ success: 1, query_summary: { num_reviews: 0 }, reviews: [], cursor: 'AoJ4abc+/=' });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/appdetails')) return new Response(JSON.stringify({ '620': { success: true, data: { name: 'Portal 2' } } }));
      return new Response(url.endsWith('cursor=*') ? page1 : empty);
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await svc().scrape(URL1, 5);
    expect(res.platform).toBe('Steam');
    expect(res.entityName).toBe('Portal 2');
    expect(res.ratingScale).toBe('thumbs');
    expect(res.reviews).toHaveLength(3);
    expect(res.reportedTotal).toBe(1000);
    expect(res.platformRatingLabel).toMatch(/Overwhelmingly Positive.*90%/);
    expect(res.warnings.join(' ')).toMatch(/no star ratings/i);
    const pageCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/appreviews/'));
    expect(pageCalls).toHaveLength(2);
    expect(String(pageCalls[1][0])).toContain('cursor=AoJ4abc%2B%2F%3D');
  }, 15_000);

  it('explains an empty first page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: 1, reviews: [], cursor: '*' }))));
    await expect(svc().scrape(URL1, 2)).rejects.toThrow(/no english reviews.*STEAM_LANGUAGE/s);
  });
});
