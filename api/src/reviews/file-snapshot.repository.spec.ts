import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { FileSnapshotRepository } from './file-snapshot.repository.js';
import { ReviewsService } from './reviews.service.js';

const snapshot = () => ({
  version: 1 as const,
  savedAt: '2026-10-01T00:00:00.000Z',
  summary: ReviewsService.blankSummary('src'),
  reviews: [{ id: '1', rating: 5, title: 't', text: 'x', publishedAt: '2026-09-01T00:00:00Z', author: 'a' }],
});

async function repoAt(file: string) {
  const dir = await mkdtemp(join(tmpdir(), 'rl-snap-'));
  const path = join(dir, file);
  return { path, repo: new FileSnapshotRepository(new ConfigService({ SNAPSHOT_PATH: path })) };
}

describe('FileSnapshotRepository', () => {
  it('round-trips and creates missing directories', async () => {
    const { repo } = await repoAt('nested/deeper/snapshot.json');
    await repo.save(snapshot());
    expect(await repo.load()).toEqual(snapshot());
  });

  it('returns null when there is no snapshot', async () => {
    const { repo } = await repoAt('missing.json');
    expect(await repo.load()).toBeNull();
  });

  it('ignores a corrupt snapshot instead of crashing', async () => {
    const { repo, path } = await repoAt('bad.json');
    await writeFile(path, '{not json');
    expect(await repo.load()).toBeNull();
  });

  it('ignores a snapshot with an unexpected shape', async () => {
    const { repo, path } = await repoAt('shape.json');
    await writeFile(path, JSON.stringify({ version: 2 }));
    expect(await repo.load()).toBeNull();
  });

  it('leaves no temp file behind after saving', async () => {
    const { repo, path } = await repoAt('s.json');
    await repo.save(snapshot());
    await expect(readFile(`${path}.tmp`)).rejects.toThrow();
  });
});
