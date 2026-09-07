/**
 * session-transcript-resolvers tests — fixture-dir walks for the codex rollout
 * and omp session file resolvers (no real $HOME dependency: both take a root
 * override).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findCodexLiveThreadId,
  findCodexRolloutPath,
  findCodexRolloutPathByUuid,
  findOmpSessionPath,
  ompAgentHomeForSessionKey,
  ompSessionsRootForSessionKey,
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

describe('findCodexLiveThreadId', () => {
  it('resolves the newest real thread-writer lock before any rollout exists', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-live-thread-'));
    const locks = join(home, 'thread-writer-locks');
    await fs.mkdir(locks, { recursive: true });
    const older = '01a04fe7-9310-7f81-8bcf-0887a91a811b';
    const newer = '01a05001-07fb-72c3-a65d-4b7ad0c5f55a';
    await fs.writeFile(join(locks, `${older}.lock`), '');
    await fs.writeFile(join(locks, '.coordination.lock'), '');
    await fs.writeFile(join(locks, 'not-a-thread.lock'), '');
    await fs.writeFile(join(locks, `${newer}.lock`), '');
    const stale = new Date(Date.now() - 60_000);
    await fs.utimes(join(locks, `${older}.lock`), stale, stale);
    try {
      expect(await findCodexLiveThreadId(home)).toBe(newer);
      expect(await findCodexRolloutPath('pre-turn', { homeOverride: home })).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('returns null rather than treating coordination or malformed locks as native ids', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-no-thread-'));
    const locks = join(home, 'thread-writer-locks');
    await fs.mkdir(locks, { recursive: true });
    await fs.writeFile(join(locks, '.coordination.lock'), '');
    await fs.writeFile(join(locks, 'pending.lock'), '');
    try {
      expect(await findCodexLiveThreadId(home)).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe('findOmpSessionPath', () => {
  it('uses the isolated operator root for tracked handles and transcript lookup', () => {
    vi.stubEnv('PAPERCUSP_SU_OMP_HOMES_DIR', '/tmp/isolated-omp');
    try {
      expect(ompAgentHomeForSessionKey(42, '/home/test')).toBe('/tmp/isolated-omp/session-42/agent');
      expect(ompSessionsRootForSessionKey(42, '/home/test')).toBe('/tmp/isolated-omp/session-42/agent/sessions');
      expect(ompAgentHomeForSessionKey(undefined, '/home/test')).toBe('/home/test/.omp/agent');
    } finally { vi.unstubAllEnvs(); }
  });

  it('routes tracked sessions to their isolated OMP home and untracked sessions to the shared home', () => {
    expect(ompAgentHomeForSessionKey(42, '/home/test')).toBe(
      '/home/test/.papercusp/su-omp-homes/session-42/agent',
    );
    expect(ompAgentHomeForSessionKey(undefined, '/home/test')).toBe(
      '/home/test/.omp/agent',
    );
    expect(ompSessionsRootForSessionKey(42, '/home/test')).toBe(
      '/home/test/.papercusp/su-omp-homes/session-42/agent/sessions',
    );
    expect(ompSessionsRootForSessionKey(undefined, '/home/test')).toBe(
      '/home/test/.omp/agent/sessions',
    );
  });

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

/**
 * EI-20219088862022620 / WI-38090 — the recurrence guard for a CLASS that had been
 * filed three times (WI-5075, EI-16310, EI-20219088862022620) with no closure ever
 * leaving a test that fails when it returns: "the compaction watchdog's context
 * estimate is pinned to a DEAD PREDECESSOR transcript and never tracks the live
 * successor."
 *
 * The 2026-08-12 instance was NOT in the watchdog at all — it was here. `codexPathCache`
 * is keyed by the adv-session id, which is STABLE across carry-respawns (a respawn reuses
 * the same adv row and the same per-session CODEX_HOME) while the rollout FILE changes on
 * every respawn. The cache was invalidated only when the cached file was DELETED, and
 * rollouts are never deleted — so the first resolution was pinned for the life of the
 * process and every successor generation was invisible. Downstream, coord_presence
 * .context_tokens froze at a dead session's final reading while context_estimated_at kept
 * refreshing, 48 live sessions were reported over their ceiling (one at 2.7× its true
 * usage), and the WI-5075 respawn-streak guard read "the estimate never drops" as grounds
 * to permanently suppress BOTH enforcement rungs, leaving real sessions to run into
 * "Prompt is too long".
 *
 * The pre-existing "resolves the NEWEST rollout" test above could not catch it: it
 * resolves ONCE against a cold cache, which is the only state in which the old code was
 * correct. The defect only exists on the SECOND resolution, so the guard has to make two.
 */
describe('EI-20219088862022620: a per-home resolution follows a carry-respawn to the new rollout', () => {
  /** Successive rollout generations in ONE codex home — what a carry-respawn produces. */
  async function seedGeneration(home: string, name: string, ageMs = 0): Promise<string> {
    const day = join(home, 'sessions', '2026', '08', '12');
    await fs.mkdir(day, { recursive: true });
    const p = join(day, `rollout-${name}.jsonl`);
    await fs.writeFile(p, '{}\n');
    if (ageMs > 0) {
      const t = new Date(Date.now() - ageMs);
      await fs.utimes(p, t, t);
    }
    return p;
  }

  it('returns the SUCCESSOR rollout once the cached resolution expires (the pinning bug)', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-respawn-'));
    try {
      const predecessor = await seedGeneration(home, '2026-08-12T00-02-02-gen2', 60_000);
      const t0 = 1_000_000;
      // The watchdog's first sweep resolves — and CACHES — the predecessor.
      expect(await findCodexRolloutPath('14976', { homeOverride: home, nowMs: t0 })).toBe(
        predecessor,
      );

      // The watchdog carry-respawns the session. Codex writes a NEW rollout into the SAME
      // home; the predecessor is left on disk forever, which is exactly why an
      // existence-only guard cannot notice. The adv-session key does not change.
      const successor = await seedGeneration(home, '2026-08-12T00-22-17-gen3');

      // A later sweep MUST estimate from the successor. Before the fix this returned the
      // predecessor for the life of the process — a dead session's frozen context size
      // reported as the live successor's usage.
      expect(
        await findCodexRolloutPath('14976', { homeOverride: home, nowMs: t0 + 11_000 }),
      ).toBe(successor);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('still serves the cached path WITHIN the TTL (the repeat-open win is not thrown away)', async () => {
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-ttl-'));
    try {
      const first = await seedGeneration(home, '2026-08-12T00-02-02-gen2', 60_000);
      const t0 = 2_000_000;
      expect(await findCodexRolloutPath('14976', { homeOverride: home, nowMs: t0 })).toBe(first);
      await seedGeneration(home, '2026-08-12T00-22-17-gen3');
      // One sweep calls this several times for the same owner (estimate, window, carry-spec
      // build); those must not each re-walk the home.
      expect(await findCodexRolloutPath('14976', { homeOverride: home, nowMs: t0 + 500 })).toBe(
        first,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  /**
   * FALSIFIABILITY CONTROL (repo discipline: "a guard test that has never failed is a
   * guard you have not tested"). The subject is a module we import, so the tier-1 form
   * applies — a deliberately-wrong implementation kept PERMANENTLY here, never a
   * mutation of the shared tree (a probe that edits in-tree can be committed by the
   * git-sync sweep even when nothing goes wrong).
   *
   * This is the EXACT pre-fix guard: cache the resolution, and re-serve it whenever the
   * cached file still exists. It is what shipped, and it is why the bug was invisible —
   * every individual step of it looks reasonable.
   */
  it('CONTROL: the pre-fix existence-only guard stays pinned to the predecessor', async () => {
    const cache = new Map<string, string>();
    async function resolveWithExistenceOnlyCache(key: string, home: string) {
      const cached = cache.get(key);
      if (cached) {
        // The old invalidation rule, verbatim: does the cached file still exist?
        try {
          await fs.stat(cached);
          return cached;
        } catch {
          cache.delete(key);
        }
      }
      const fresh = await findCodexRolloutPath(key, { homeOverride: home, nowMs: Date.now() });
      if (fresh) cache.set(key, fresh);
      return fresh;
    }

    const home = await fs.mkdtemp(join(tmpdir(), 'codex-control-'));
    try {
      __resetTranscriptResolverCaches();
      const predecessor = await seedGeneration(home, '2026-08-12T00-02-02-gen2', 60_000);
      expect(await resolveWithExistenceOnlyCache('14976', home)).toBe(predecessor);

      __resetTranscriptResolverCaches(); // isolate: only the CONTROL's cache is under test
      const successor = await seedGeneration(home, '2026-08-12T00-22-17-gen3');

      // The successor exists and is newest, and the control still hands back the dead one.
      // If this assertion ever flips to toBe(successor), the control has stopped modelling
      // the bug and the guard above is no longer known to discriminate.
      expect(await resolveWithExistenceOnlyCache('14976', home)).toBe(predecessor);
      expect(await resolveWithExistenceOnlyCache('14976', home)).not.toBe(successor);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('the UUID leg keeps its no-TTL cache — its key names one FILE, not a home to search', async () => {
    // Guards the distinction the fix rests on: blanket-TTLing every cache would be a
    // pointless re-walk here, because a uuid-keyed answer cannot move while the file lives.
    const home = await fs.mkdtemp(join(tmpdir(), 'codex-uuid-ttl-'));
    const uuid = '019ff420-ebbd-7861-83c2-f5c7f04f4cc1';
    try {
      const day = join(home, 'sessions', '2026', '08', '12');
      await fs.mkdir(day, { recursive: true });
      const p = join(day, `rollout-2026-08-12T00-00-26-${uuid}.jsonl`);
      await fs.writeFile(p, '{}\n');
      expect(await findCodexRolloutPathByUuid(uuid, { homeOverride: home })).toBe(p);
      expect(await findCodexRolloutPathByUuid(uuid, { homeOverride: home })).toBe(p);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

// NOTE (WI-6794): a NUL byte from a mistyped template-literal separator landed
// in this exact module while fixing the cache key, and it is invisible in an
// editor while silently making grep/rg report "binary file matches". I started
// to add a per-file NUL assertion here — and then found the class is ALREADY
// guarded tree-wide by `npm run lint:no-control-bytes`
// (scripts/check-no-control-bytes.mjs, EI-7432, the identical incident), which
// scans every tracked source file and runs in CI. A per-file copy of an
// existing repo-wide guard is the duplication this repo's reuse-first rule
// exists to prevent, so there is deliberately no assertion here. To diagnose
// the symptom by hand: `tr -dc '\000' < FILE | wc -c`.
