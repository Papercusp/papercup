/**
 * export tests (learning-packs-2026-06-11 P-016) — the distill-to-pack writer.
 *
 * Fake memory backend (canned hive pool) + a real tmp dir, so the written pack
 * is round-tripped back through loadLearningPackFromDir to prove the on-disk
 * shape is the loader's shape. Pins: organic-only default vs includePackRows,
 * semver/kebab validation, nothing_to_export, and (LP-3) the `id:` frontmatter
 * that keeps pack_item_id stable across an export → re-import round-trip.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../memory/backend', () => ({ getMemoryBackend: vi.fn() }));

import { getMemoryBackend } from '../memory/backend';
import { exportHiveLearningsToPack } from './export';
import { loadLearningPackFromDir } from './load-packs';
import { memoryTextOf } from './pack-format';

type Entry = { id: string; text: string; scope: string; kind?: string; metadata?: Record<string, unknown> };

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const setPool = (pool: Entry[], available = true) => {
  const backend = {
    name: 'fake',
    available: vi.fn(async () => (available ? { ok: true as const } : { ok: false as const, reason: 'down' })),
    list: vi.fn(async () => pool),
  };
  vi.mocked(getMemoryBackend).mockReturnValue(backend as unknown as ReturnType<typeof getMemoryBackend>);
  return backend;
};

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'pc-lp-export-'));
});

const ORGANIC: Entry[] = [
  { id: 'o1', text: 'Run tests — find how this project runs its test suite first', scope: 'hive:h', kind: 'feedback' },
  { id: 'o2', text: 'Prefer existing libs — reach for a maintained dep over rolling your own', scope: 'hive:h', kind: 'reference' },
];
const PACK_ROW: Entry = {
  id: 'p1',
  text: 'Seeded — came from an installed pack',
  scope: 'hive:h',
  kind: 'feedback',
  metadata: { source: 'pack', pack_id: 'other', pack_item_id: 'z' },
};

describe('exportHiveLearningsToPack', () => {
  it('exports organic rows only by default; skips pack-sourced rows', async () => {
    setPool([...ORGANIC, PACK_ROW]);
    const res = await exportHiveLearningsToPack({
      hiveSlug: 'h',
      packId: 'my-pack',
      title: 'My Pack',
      description: 'A pack',
      targetDir: root,
    });
    expect(res).toMatchObject({ ok: true, exported: 2, skippedPackRows: 1 });
    expect(res.packDir).toBe(join(root, 'learning-packs', 'my-pack'));
  });

  it('includePackRows: true also exports the seeded rows', async () => {
    setPool([...ORGANIC, PACK_ROW]);
    const res = await exportHiveLearningsToPack({
      hiveSlug: 'h',
      packId: 'my-pack',
      title: 'My Pack',
      description: 'A pack',
      targetDir: root,
      includePackRows: true,
    });
    expect(res).toMatchObject({ ok: true, exported: 3, skippedPackRows: 0 });
  });

  it('rejects a non-semver version and a non-kebab packId (before any IO)', async () => {
    const backend = setPool(ORGANIC);
    expect(await exportHiveLearningsToPack({ hiveSlug: 'h', packId: 'ok', title: 'T', description: 'D', targetDir: root, version: 'v1' }))
      .toMatchObject({ ok: false, error: 'version must be three-part semver' });
    expect(await exportHiveLearningsToPack({ hiveSlug: 'h', packId: 'Bad_Id', title: 'T', description: 'D', targetDir: root }))
      .toMatchObject({ ok: false, error: 'packId must be kebab-case' });
    // Validation precedes the pool read.
    expect(backend.list).not.toHaveBeenCalled();
  });

  it('nothing_to_export when the pool has only pack rows (organic-only default)', async () => {
    setPool([PACK_ROW]);
    const res = await exportHiveLearningsToPack({
      hiveSlug: 'h',
      packId: 'my-pack',
      title: 'T',
      description: 'D',
      targetDir: root,
    });
    expect(res).toMatchObject({ ok: false, error: 'nothing_to_export', skippedPackRows: 1 });
  });

  it('memory_unavailable surfaces the backend reason', async () => {
    setPool(ORGANIC, false);
    const res = await exportHiveLearningsToPack({
      hiveSlug: 'h',
      packId: 'my-pack',
      title: 'T',
      description: 'D',
      targetDir: root,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/memory_unavailable/);
  });

  it('LP-3: writes `id:` frontmatter so pack_item_ids are STABLE across a round-trip', async () => {
    setPool(ORGANIC);
    const exp = await exportHiveLearningsToPack({
      hiveSlug: 'h',
      packId: 'round-trip',
      title: 'RT',
      description: 'D',
      version: '1.2.3',
      author: 'Tester',
      targetDir: root,
    });
    expect(exp.ok).toBe(true);

    // Every learning file carries an explicit `id:` line (not just the filename).
    const { loaded, errors } = await loadLearningPackFromDir(exp.packDir!);
    expect(errors).toEqual([]);
    expect(loaded).toBeTruthy();
    const pack = loaded!.pack;
    expect(pack.manifest).toMatchObject({ id: 'round-trip', version: '1.2.3', author: 'Tester' });
    expect(pack.items).toHaveLength(2);

    const firstId = pack.items[0].id;
    // The on-disk file has a literal `id:` frontmatter matching the item id.
    const md = readFileSync(join(exp.packDir!, `${firstId}.md`), 'utf8');
    expect(md).toMatch(new RegExp(`^id: ${firstId}$`, 'm'));

    // Re-export to a second dir → ids are identical (provenance stability).
    const root2 = mkdtempSync(join(tmpdir(), 'pc-lp-export2-'));
    try {
      const exp2 = await exportHiveLearningsToPack({
        hiveSlug: 'h',
        packId: 'round-trip',
        title: 'RT',
        description: 'D',
        version: '1.2.3',
        targetDir: root2,
      });
      const { loaded: loaded2 } = await loadLearningPackFromDir(exp2.packDir!);
      expect(loaded2!.pack.items.map((i) => i.id).sort()).toEqual(pack.items.map((i) => i.id).sort());
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });

  it('round-trips the canonical memory text (title — body) back through the loader', async () => {
    setPool([ORGANIC[0]]);
    const exp = await exportHiveLearningsToPack({
      hiveSlug: 'h',
      packId: 'rt2',
      title: 'T',
      description: 'D',
      targetDir: root,
    });
    const { loaded } = await loadLearningPackFromDir(exp.packDir!);
    const item = loaded!.pack.items[0];
    // memoryTextOf(re-imported item) reconstructs the original row text — the
    // export split (title — body) is loader-reversible for a "Title — body" row.
    expect(memoryTextOf(item)).toBe(ORGANIC[0].text);
  });
});
