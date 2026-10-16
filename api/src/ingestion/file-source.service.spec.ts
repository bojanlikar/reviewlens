import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSourceService } from './file-source.service.js';

describe('FileSourceService', () => {
  const svc = new FileSourceService();

  it('loads a saved Trustpilot page', async () => {
    const res = await svc.load('test/fixtures/trustpilot-page.html');
    expect(res.entityName).toBe('Acme Co');
    expect(res.reviews).toHaveLength(2);
    expect(res.warnings[0]).toMatch(/saved files/);
  });

  it('merges a folder of pages and dedupes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rl-'));
    const html = await (await import('node:fs/promises')).readFile('test/fixtures/trustpilot-page.html', 'utf8');
    await writeFile(join(dir, 'p1.html'), html);
    await writeFile(join(dir, 'p2.html'), html);
    const res = await svc.load(dir);
    expect(res.reviews).toHaveLength(2);
    expect(res.duplicatesSkipped).toBe(2);
    expect(res.pagesFetched).toBe(2);
  });

  it('loads JSON and skips invalid rows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rl-'));
    const f = join(dir, 'r.json');
    await writeFile(
      f,
      JSON.stringify({
        entityName: 'X',
        reviews: [
          { rating: 4, title: 'ok', text: 'fine', date: '2026-01-02' },
          { rating: 9, text: 'bad rating' },
          { rating: 2, text: '' },
        ],
      }),
    );
    const res = await svc.load(f);
    expect(res.entityName).toBe('X');
    expect(res.reviews).toHaveLength(1);
    expect(res.emptySkipped).toBe(2);
  });

  it('errors clearly for missing paths and unsupported types', async () => {
    await expect(svc.load('/nope/missing')).rejects.toThrow(/not found/);
  });
});
