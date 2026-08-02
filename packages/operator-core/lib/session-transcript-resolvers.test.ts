/**
 * session-transcript-resolvers tests — fixture-dir walks for the codex rollout
 * and omp session file resolvers (no real $HOME dependency: both take a root
 * override).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findCodexRolloutPath,
  findCodexRolloutPathByUuid,
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

/**
 * WI-6794 — the positive-resolution cache must key on the ROOT it searched.
 *
 * Every resolver here takes a home/root override, so a cache keyed by session
 * id alone hands one home's answer to a caller that asked about a different
 * one. The existing staleness guard cannot catch that: it only re-stats the
 * cached path, and that path still exists — under the wrong root. Found by
 * WI-6581's live probe, where a homeOverride hit made a later default lookup
 * report a rollout that is not in the default home at all.
 */
describe('WI-6794: a cached resolution never leaks across roots', () => {
  const UUID = '019f713e-8fa2-7d52-9cbc-29644c273d4f';

  /** `<home>/sessions/<y>/<m>/<d>/rollout-<ts>-<uuid>.jsonl` — the real shape. */
  async function seedCodex(home: string, uuid: string): Promise<string> {
    const day = join(home, 'sessions', '2026', '08', '01');
    await fs.mkdir(day, { recursive: true });
    const p = join(day, `rollout-2026-08-01T00-00-00-${uuid}.jsonl`);
    await fs.writeFile(p, '{}\n');
    return p;
  }

  async function twoHomes(): Promise<[string, string]> {
    return [
      await fs.mkdtemp(join(tmpdir(), 'resolv-a-')),
      await fs.mkdtemp(join(tmpdir(), 'resolv-b-')),
    ];
  }

  it('findCodexRolloutPathByUuid does not serve home A\'s hit to a home B lookup', async () => {
    const [a, b] = await twoHomes();
    try {
      const inA = await seedCodex(a, UUID);
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: a })).toBe(inA);
      // B genuinely has no rollout for this uuid. Pre-fix this returned A's
      // path straight from the cache, having never walked B at all.
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: b })).toBeNull();
      // …and A still resolves, i.e. the fix did not just disable the cache.
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: a })).toBe(inA);
    } finally {
      await Promise.all([a, b].map((d) => fs.rm(d, { recursive: true, force: true })));
    }
  });

  it('returns each root\'s OWN file when BOTH hold the same uuid, in either order', async () => {
    const [a, b] = await twoHomes();
    try {
      const inA = await seedCodex(a, UUID);
      const inB = await seedCodex(b, UUID);
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: a })).toBe(inA);
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: b })).toBe(inB);
      __resetTranscriptResolverCaches();
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: b })).toBe(inB);
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: a })).toBe(inA);
    } finally {
      await Promise.all([a, b].map((d) => fs.rm(d, { recursive: true, force: true })));
    }
  });

  it('findCodexRolloutPath (adv-row session key) is root-scoped too', async () => {
    const [a, b] = await twoHomes();
    try {
      const inA = await seedCodex(a, UUID);
      expect(await findCodexRolloutPath('13354', { homeOverride: a })).toBe(inA);
      expect(await findCodexRolloutPath('13354', { homeOverride: b })).toBeNull();
    } finally {
      await Promise.all([a, b].map((d) => fs.rm(d, { recursive: true, force: true })));
    }
  });

  it('findOmpSessionPath is root-scoped too', async () => {
    const [a, b] = await twoHomes();
    const tid = '019f1de3-19b8-7000-90a3-a36f8c343ac6';
    try {
      const dir = join(a, '-home-x-proj');
      await fs.mkdir(dir, { recursive: true });
      const inA = join(dir, `2026-08-01T00-00-00-000Z_${tid}.jsonl`);
      await fs.writeFile(inA, '{}\n');
      expect(await findOmpSessionPath(tid, { rootOverride: a })).toBe(inA);
      expect(await findOmpSessionPath(tid, { rootOverride: b })).toBeNull();
      expect(await findOmpSessionPath(tid, { rootOverride: a })).toBe(inA);
    } finally {
      await Promise.all([a, b].map((d) => fs.rm(d, { recursive: true, force: true })));
    }
  });

  it('a cached path whose file is GONE is dropped, not served', async () => {
    const [a, b] = await twoHomes();
    try {
      const inA = await seedCodex(a, UUID);
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: a })).toBe(inA);
      await fs.rm(inA);
      expect(await findCodexRolloutPathByUuid(UUID, { homeOverride: a })).toBeNull();
    } finally {
      await Promise.all([a, b].map((d) => fs.rm(d, { recursive: true, force: true })));
    }
  });
});

describe('the resolver source file is clean text', () => {
  // A NUL byte from a mistyped template-literal separator landed in this exact
  // module while fixing WI-6794. It is invisible in an editor AND it silently
  // turns every grep/rg over the file into "binary file matches" — the file
  // stops being searchable by every agent on this box, with no error anywhere
  // and no test that would notice.
  it('session-transcript-resolvers.ts contains no NUL bytes', () => {
    const raw = readFileSync(join(__dirname, 'session-transcript-resolvers.ts'));
    expect(raw.indexOf(0)).toBe(-1);
  });
});
