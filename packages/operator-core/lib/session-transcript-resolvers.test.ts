/**
 * session-transcript-resolvers tests — fixture-dir walks for the codex rollout
 * and omp session file resolvers (no real $HOME dependency: both take a root
 * override).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findCodexRolloutPath,
  findOmpSessionPath,
  __resetTranscriptResolverCaches,
} from './session-transcript-resolvers';

afterEach(() => __resetTranscriptResolverCaches());

describe('findCodexRolloutPath', () => {
  it('resolves the NEWEST rollout under sessions/<y>/<m>/<d>/ (a resume adds a second file)', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-home-'));
    const day = join(home, 'sessions', '2026', '06', '26');
    await fs.mkdir(day, { recursive: true });
    const older = join(day, 'rollout-2026-06-26T06-08-50-aaa.jsonl');
    const newer = join(day, 'rollout-2026-06-26T09-00-00-bbb.jsonl');
    await fs.writeFile(older, '{}\n');
    await fs.writeFile(newer, '{}\n');
    await fs.utimes(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    try {
      expect(await findCodexRolloutPath('9999', { homeOverride: home })).toBe(newer);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('null when the home has no sessions dir yet (pre-first-turn), found once written', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-empty-'));
    try {
      expect(await findCodexRolloutPath('8888', { homeOverride: home })).toBeNull();
      // The transcript appears (codex takes its first turn) → next resolve sees it
      // (misses are deliberately NOT cached — the endpoint polls for this).
      const day = join(home, 'sessions', '2026', '07', '01');
      await fs.mkdir(day, { recursive: true });
      const p = join(day, 'rollout-2026-07-01T00-00-00-ccc.jsonl');
      await fs.writeFile(p, '{}\n');
      expect(await findCodexRolloutPath('8888', { homeOverride: home })).toBe(p);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe('findOmpSessionPath', () => {
  it('resolves by _<threadId>.jsonl suffix across cwd dirs; rejects malformed ids', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'omp-root-'));
    const dir = join(root, '-home-x-proj');
    await fs.mkdir(dir, { recursive: true });
    const tid = '019f1de3-19b8-7000-90a3-a36f8c343ac6';
    const target = join(dir, `2026-07-01T13-34-10-360Z_${tid}.jsonl`);
    await fs.writeFile(target, '{}\n');
    try {
      expect(await findOmpSessionPath(tid, { rootOverride: root })).toBe(target);
      expect(await findOmpSessionPath('zzzz-not-there-1234', { rootOverride: root })).toBeNull();
      expect(await findOmpSessionPath('../..', { rootOverride: root })).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
