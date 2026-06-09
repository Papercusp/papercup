import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Sql } from 'postgres';
import { readInsightsSnapshot, readMemoryHealth } from './knowledge-read';

/**
 * knowledge-read — the Learning tab Knowledge reader (operator-learning-tab
 * P-008). The insights half wraps the separately-tested readInsightsDir, so
 * here we pin only what THIS module adds: mtime-recency ordering + the
 * count/recent split. The memory half is pure SQL over an injected Sql.
 */

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-read-'));
  const mk = async (name: string, fm: string, mtime: Date) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, `---\n${fm}\n---\n\nBody.\n`, 'utf8');
    await fs.utimes(file, mtime, mtime);
  };
  await mk('older-insight.mdx', 'title: Older insight\ndescription: The older one.', new Date('2026-06-01T00:00:00Z'));
  await mk('newer-insight.mdx', 'title: Newer insight\ndescription: The newer one.\ntags: [pg, sync]', new Date('2026-06-08T00:00:00Z'));
  await mk('retired-insight.mdx', 'title: Retired insight\nstatus: retired', new Date('2026-06-09T00:00:00Z'));
  await mk('index.mdx', 'title: Section index', new Date('2026-06-09T00:00:00Z'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('readInsightsSnapshot', () => {
  it('counts visible insights and orders recent by file mtime, newest first', async () => {
    const snap = await readInsightsSnapshot(dir);
    expect(snap.count).toBe(2); // retired + index excluded
    expect(snap.recent.map((r) => r.slug)).toEqual(['newer-insight', 'older-insight']);
    expect(snap.recent[0].title).toBe('Newer insight');
    expect(snap.recent[0].tags).toEqual(['pg', 'sync']);
    expect(snap.recent[0].modifiedAt).toBe('2026-06-08T00:00:00.000Z');
  });

  it('caps recent at the requested limit while count stays the full library size', async () => {
    const snap = await readInsightsSnapshot(dir, 1);
    expect(snap.count).toBe(2);
    expect(snap.recent).toHaveLength(1);
    expect(snap.recent[0].slug).toBe('newer-insight');
  });

  it('degrades to an empty snapshot for a missing directory', async () => {
    const snap = await readInsightsSnapshot(path.join(dir, 'does-not-exist'));
    expect(snap).toEqual({ count: 0, recent: [] });
  });
});

describe('readMemoryHealth', () => {
  const sqlReturning = (rows: Array<Record<string, unknown>>): Sql =>
    ((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve(rows)) as unknown as Sql;

  it('maps the one-roundtrip counts row', async () => {
    const health = await readMemoryHealth(sqlReturning([{ total_memories: 168, feedback_30d: 2 }]));
    expect(health).toEqual({ totalMemories: 168, feedback30d: 2 });
  });

  it('zero-fills an empty result rather than crashing', async () => {
    const health = await readMemoryHealth(sqlReturning([]));
    expect(health).toEqual({ totalMemories: 0, feedback30d: 0 });
  });
});
