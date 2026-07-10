/**
 * semantic-dupe-guard.test — the P-008 dedup-on-create prescreen's contract:
 * hard/soft classification, threshold env overrides, and (most load-bearing)
 * that EVERY failure mode — embed throw, query throw, disabled embedder, dims
 * mismatch, budget expiry, kill switch — returns null, because a create must
 * never be blocked by embedder health.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findSemanticDupes,
  dupeThresholds,
  type SemanticDupeDeps,
  type SemanticDupeCandidate,
} from './semantic-dupe-guard';

const cand = (id: string, similarity: number): SemanticDupeCandidate => ({
  id,
  title: `title of ${id}`,
  state: 'open',
  harness: 'papercusp',
  similarity,
});

const okDeps = (candidates: SemanticDupeCandidate[], dims = 384): SemanticDupeDeps => ({
  resolveEmbedder: async () => ({ mode: 'gemma', dims, embed: async () => new Array(dims).fill(0.1) }),
  queryCandidates: async () => candidates,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('classification', () => {
  it('splits candidates into hard (≥0.93) and soft (≥0.85, <hard), sorted by similarity desc', async () => {
    const r = await findSemanticDupes(
      { title: 't', summary: 's' },
      okDeps([cand('EI-1', 0.9), cand('EI-2', 0.95), cand('WI-3', 0.86), cand('WI-4', 0.5)]),
    );
    expect(r).not.toBeNull();
    expect(r!.hard.map((c) => c.id)).toEqual(['EI-2']);
    expect(r!.soft.map((c) => c.id)).toEqual(['EI-1', 'WI-3']);
    expect(r!.thresholds).toEqual({ hard: 0.93, soft: 0.85 });
  });

  it('returns empty bands (not null) when nothing is close — "screened, no dupes"', async () => {
    const r = await findSemanticDupes({ title: 't' }, okDeps([cand('EI-1', 0.2)]));
    expect(r).toEqual({ hard: [], soft: [], thresholds: { hard: 0.93, soft: 0.85 } });
  });

  it('embeds title + truncated summary in the stored bodySql shape', async () => {
    const seen: string[] = [];
    const deps: SemanticDupeDeps = {
      resolveEmbedder: async () => ({
        mode: 'gemma',
        dims: 384,
        embed: async (t: string) => {
          seen.push(t);
          return new Array(384).fill(0.1);
        },
      }),
      queryCandidates: async () => [],
    };
    await findSemanticDupes({ title: 'the title', summary: 'x'.repeat(3000) }, deps);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(`the title\n${'x'.repeat(2000)}`);
  });

  it('passes the resolved mode + harness through to the candidate query (space filter)', async () => {
    const calls: Array<{ mode: string; harness?: string }> = [];
    const deps: SemanticDupeDeps = {
      resolveEmbedder: async () => ({ mode: 'local', dims: 384, embed: async () => new Array(384).fill(0.1) }),
      queryCandidates: async (_vec, mode, harness) => {
        calls.push({ mode, harness });
        return [];
      },
    };
    await findSemanticDupes({ title: 't', harness: 'papercusp' }, deps);
    expect(calls).toEqual([{ mode: 'local', harness: 'papercusp' }]);
  });
});

describe('threshold env overrides', () => {
  it('PAPERCUSP_WI_DUPE_HARD / _SOFT override the defaults when sane', () => {
    vi.stubEnv('PAPERCUSP_WI_DUPE_HARD', '0.97');
    vi.stubEnv('PAPERCUSP_WI_DUPE_SOFT', '0.8');
    expect(dupeThresholds()).toEqual({ hard: 0.97, soft: 0.8 });
  });

  it('garbage / out-of-range overrides fall back to the defaults', () => {
    vi.stubEnv('PAPERCUSP_WI_DUPE_HARD', 'not-a-number');
    vi.stubEnv('PAPERCUSP_WI_DUPE_SOFT', '1.7');
    expect(dupeThresholds()).toEqual({ hard: 0.93, soft: 0.85 });
  });
});

describe('fail-open — every failure mode returns null (create proceeds)', () => {
  it('embed throw', async () => {
    const deps: SemanticDupeDeps = {
      resolveEmbedder: async () => ({
        mode: 'gemma',
        dims: 384,
        embed: async () => {
          throw new Error('sidecar down');
        },
      }),
      queryCandidates: async () => [cand('EI-1', 0.99)],
    };
    expect(await findSemanticDupes({ title: 't' }, deps)).toBeNull();
  });

  it('candidate-query throw (e.g. migration 548 not applied)', async () => {
    const deps: SemanticDupeDeps = {
      resolveEmbedder: async () => ({ mode: 'gemma', dims: 384, embed: async () => new Array(384).fill(0.1) }),
      queryCandidates: async () => {
        throw new Error('column "embedding" does not exist');
      },
    };
    expect(await findSemanticDupes({ title: 't' }, deps)).toBeNull();
  });

  it('resolver throw + disabled embedder + dims mismatch (harrier@1024)', async () => {
    const throwing: SemanticDupeDeps = {
      resolveEmbedder: async () => {
        throw new Error('resolve failed');
      },
      queryCandidates: async () => [],
    };
    expect(await findSemanticDupes({ title: 't' }, throwing)).toBeNull();

    const disabled: SemanticDupeDeps = {
      resolveEmbedder: async () => ({ mode: 'disabled' }),
      queryCandidates: async () => [],
    };
    expect(await findSemanticDupes({ title: 't' }, disabled)).toBeNull();

    expect(await findSemanticDupes({ title: 't' }, okDeps([cand('EI-1', 0.99)], 1024))).toBeNull();
  });

  it('budget expiry: a hung embed forfeits the verdict instead of blocking the create', async () => {
    vi.useFakeTimers();
    try {
      const deps: SemanticDupeDeps = {
        resolveEmbedder: async () => ({
          mode: 'gemma',
          dims: 384,
          embed: () => new Promise<number[]>(() => {}), // never settles
        }),
        queryCandidates: async () => [cand('EI-1', 0.99)],
      };
      const p = findSemanticDupes({ title: 't' }, deps);
      await vi.advanceTimersByTimeAsync(2600);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('kill switch PAPERCUSP_WI_SEMANTIC_DUPE=off short-circuits before any embed work', async () => {
    vi.stubEnv('PAPERCUSP_WI_SEMANTIC_DUPE', 'off');
    let touched = false;
    const deps: SemanticDupeDeps = {
      resolveEmbedder: async () => {
        touched = true;
        return { mode: 'gemma', dims: 384, embed: async () => new Array(384).fill(0.1) };
      },
      queryCandidates: async () => [cand('EI-1', 0.99)],
    };
    expect(await findSemanticDupes({ title: 't' }, deps)).toBeNull();
    expect(touched).toBe(false);
  });

  it('inert under vitest WITHOUT injected deps (never lazy-loads the real model in tests)', async () => {
    expect(await findSemanticDupes({ title: 't' })).toBeNull();
  });
});
