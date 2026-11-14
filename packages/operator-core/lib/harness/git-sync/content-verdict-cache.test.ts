/**
 * WI-6554700010048235 — git-sync content-detector verdict memo. An unchanged dirty
 * backlog must not re-pay detector cost on every fire; a changed file, a different
 * detector implementation, an expired entry, or a throwing detector must never be
 * served a memoised verdict.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONTENT_DETECTORS, type ContentDetector } from '../../content-lint/registry';
import type { RunGit } from './run-git-sync';
import { createContentVerdictCache, detectContentOffenders, sharedContentVerdictCache } from './content-guard';

const runGit = (async () => ({ code: 0, stdout: ' M docs/a.mdx\0', stderr: '' })) as unknown as RunGit;

function countingDetector(
  verdict: (text: string) => string | null,
  opts: { cacheable?: boolean; epoch?: (file: string) => string | Promise<string> } = {},
): ContentDetector & { calls: () => number } {
  let calls = 0;
  return {
    key: 'mdx',
    glob: '**/*.mdx',
    fixerRole: 'content-fixer',
    ...(opts.cacheable === false ? {} : { verdictCacheable: true as const }),
    ...(opts.epoch ? { verdictCacheEpoch: opts.epoch } : {}),
    matches: (f) => f.endsWith('.mdx'),
    detect: (_f, text) => {
      calls++;
      return verdict(text);
    },
    calls: () => calls,
  };
}

function run(det: ContentDetector, text: () => string, verdictCache: ReturnType<typeof createContentVerdictCache> | null) {
  return detectContentOffenders({
    runGit,
    repoPath: '/repo',
    readText: async () => text(),
    detectors: [det],
    verdictCache,
  });
}

describe('content-guard verdict memo (WI-6554700010048235)', () => {
  it('runs a detector once per unchanged blob across fires and replays both clean and error verdicts', async () => {
    const cache = createContentVerdictCache();
    const clean = countingDetector(() => null);
    expect(await run(clean, () => 'ok', cache)).toEqual([]);
    expect(await run(clean, () => 'ok', cache)).toEqual([]);
    expect(clean.calls()).toBe(1);

    const broken = countingDetector(() => 'does not compile');
    const first = await run(broken, () => 'bad', cache);
    const second = await run(broken, () => 'bad', cache);
    expect(broken.calls()).toBe(1);
    expect(second.map((o) => [o.file, o.error])).toEqual([['docs/a.mdx', 'does not compile']]);
    expect(second).toEqual(first);
  });

  it('re-runs the detector when the file text changes', async () => {
    const cache = createContentVerdictCache();
    let text = 'v1';
    const det = countingDetector((t) => (t === 'v2' ? 'broken' : null));
    expect(await run(det, () => text, cache)).toEqual([]);
    text = 'v2';
    expect((await run(det, () => text, cache)).map((o) => o.error)).toEqual(['broken']);
    expect(det.calls()).toBe(2);
  });

  it('never shares a verdict between two implementations with the same detector key', async () => {
    const cache = createContentVerdictCache();
    const a = countingDetector(() => null);
    const b = countingDetector(() => 'flagged');
    expect(await run(a, () => 'same', cache)).toEqual([]);
    expect((await run(b, () => 'same', cache)).map((o) => o.error)).toEqual(['flagged']);
    expect(b.calls()).toBe(1);
  });

  it('expires entries after the TTL', async () => {
    let now = 0;
    const cache = createContentVerdictCache({ ttlMs: 1000, now: () => now });
    const det = countingDetector(() => null);
    await run(det, () => 'x', cache);
    now = 500;
    await run(det, () => 'x', cache);
    expect(det.calls()).toBe(1);
    now = 1501;
    await run(det, () => 'x', cache);
    expect(det.calls()).toBe(2);
  });

  it('never memoises a throwing detector (it keeps failing open every fire)', async () => {
    const cache = createContentVerdictCache();
    let calls = 0;
    const det: ContentDetector = {
      ...countingDetector(() => null),
      detect: () => {
        calls++;
        throw new Error('boom');
      },
    };
    expect(await run(det, () => 'x', cache)).toEqual([]);
    expect(await run(det, () => 'x', cache)).toEqual([]);
    expect(calls).toBe(2);
  });

  it('verdictCache:null restores the uncached behaviour', async () => {
    const det = countingDetector(() => null);
    await run(det, () => 'x', null);
    await run(det, () => 'x', null);
    expect(det.calls()).toBe(2);
  });

  it('always re-runs a detector that does not declare verdictCacheable, even with a memo', async () => {
    const cache = createContentVerdictCache();
    let exempt = false;
    // Reads state outside (file, text), like the secrets detector's runtime exemptions.
    const det = countingDetector(() => (exempt ? null : 'credential-shaped'), { cacheable: false });
    expect((await run(det, () => 'same', cache)).map((o) => o.error)).toEqual(['credential-shaped']);
    exempt = true;
    expect(await run(det, () => 'same', cache)).toEqual([]);
    expect(det.calls()).toBe(2);
  });

  it('marks exactly the pure (file, text) detectors cacheable in the default registry', () => {
    const cacheable = DEFAULT_CONTENT_DETECTORS.filter((d) => d.verdictCacheable).map((d) => d.key).sort();
    expect(cacheable).toEqual(
      [
        'conflict-markers',
        'constant-conditional',
        'empty-ts-source',
        'esbuild-transform',
        'focused-test',
        'mdx',
        'nul-bytes',
        'shell-syntax',
        'smart-quotes',
        'sql-comment-backtick',
        'ts-parse',
      ].sort(),
    );
    // These read runtime/repo state outside their arguments; a memo could outlive it.
    for (const key of ['secrets', 'identity-leak']) {
      expect(DEFAULT_CONTENT_DETECTORS.find((d) => d.key === key)?.verdictCacheable).toBeUndefined();
    }
    // …so only the one whose state is fingerprinted per file is memoised, via an epoch.
    const epochKeyed = DEFAULT_CONTENT_DETECTORS.filter((d) => d.verdictCacheEpoch).map((d) => d.key);
    expect(epochKeyed).toEqual(['secrets']);
  });

  it('memoises an epoch-keyed detector while its epoch holds and re-runs when it changes', async () => {
    const cache = createContentVerdictCache();
    let exempt = false;
    // The secrets shape: the verdict reads runtime exemptions, fingerprinted per file.
    const det = countingDetector(() => (exempt ? null : 'credential-shaped'), {
      cacheable: false,
      epoch: () => (exempt ? 'exempt' : 'scanned'),
    });
    expect((await run(det, () => 'same', cache)).map((o) => o.error)).toEqual(['credential-shaped']);
    expect((await run(det, () => 'same', cache)).map((o) => o.error)).toEqual(['credential-shaped']);
    expect(det.calls()).toBe(1);
    exempt = true; // an exemption added for this file is a new key, never a stale hit
    expect(await run(det, () => 'same', cache)).toEqual([]);
    expect(det.calls()).toBe(2);
    exempt = false; // and removing it again replays the original memoised verdict
    expect((await run(det, () => 'same', cache)).map((o) => o.error)).toEqual(['credential-shaped']);
    expect(det.calls()).toBe(2);
  });

  it('never memoises when the epoch throws (re-runs against unknown state)', async () => {
    const cache = createContentVerdictCache();
    const det = countingDetector(() => 'credential-shaped', {
      cacheable: false,
      epoch: () => {
        throw new Error('exemptions unavailable');
      },
    });
    expect((await run(det, () => 'same', cache)).map((o) => o.error)).toEqual(['credential-shaped']);
    expect((await run(det, () => 'same', cache)).map((o) => o.error)).toEqual(['credential-shaped']);
    expect(det.calls()).toBe(2);
  });

  it('reports memo hits in the slow-pass diagnostic so a live pass shows whether the cache worked', async () => {
    const cache = createContentVerdictCache();
    const det = countingDetector(() => null);
    const pass = async () => {
      let clockMs = 0;
      const log = vi.fn();
      await detectContentOffenders({
        runGit,
        repoPath: '/repo',
        readText: async () => 'ok',
        detectors: [det],
        verdictCache: cache,
        log,
        clock: () => (clockMs += 5_000),
      });
      const line = log.mock.calls.map(([m]) => String(m)).find((m) => m.startsWith('[git-sync:content-guard] '));
      return JSON.parse(line!.slice('[git-sync:content-guard] '.length));
    };
    expect((await pass()).verdictCacheHits).toBe(0);
    const warm = await pass();
    expect(warm.verdictCacheHits).toBe(1);
    expect(warm.perDetector).toEqual([expect.objectContaining({ key: 'mdx', detectCalls: 0 })]);
  });

  it('production shares one process-wide memo across fires', () => {
    expect(sharedContentVerdictCache()).toBe(sharedContentVerdictCache());
  });
});
