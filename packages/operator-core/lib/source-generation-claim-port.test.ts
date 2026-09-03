import { describe, expect, it } from 'vitest';
import { candidateSourcePaths, getClaimTimeSourceGenerationSignal } from './source-generation-claim-port';

const REPO = '/tmp/repo-under-test';

const envelope = (over: Record<string, unknown> = {}) => ({
  freshnessEnvelope: {
    observedAt: '2026-09-03T00:00:00.000Z',
    observedSourceSha: '6e898b6cf8',
    observedRuntimeSha: '6e898b6cf8',
    linkedFixRefs: [],
    ...over,
  },
});

/** A git seam that answers `log` per path from a fixture map; null ⇒ unreadable. */
const gitFor = (byPath: Record<string, string | null>) => async (args: string[]) => {
  const relPath = args[args.length - 1];
  return relPath in byPath ? byPath[relPath] : '';
};

describe('claim-time source-generation measurement (EI-22283949842250645)', () => {
  it('reports paths-moved when a stored path carries newer commits', async () => {
    const signal = await getClaimTimeSourceGenerationSignal({
      payload: { ...envelope(), paths: ['packages/a.ts', 'packages/b.ts'] },
      repoRoot: REPO,
      git: gitFor({ 'packages/a.ts': 'deadbeef\ncafebabe', 'packages/b.ts': '' }),
    });
    expect(signal).toEqual({ kind: 'paths-moved', paths: ['packages/a.ts'] });
  });

  it('reports paths-unchanged only when EVERY path read cleanly', async () => {
    const signal = await getClaimTimeSourceGenerationSignal({
      payload: { ...envelope(), paths: ['packages/a.ts', 'packages/b.ts'] },
      repoRoot: REPO,
      git: gitFor({ 'packages/a.ts': '', 'packages/b.ts': '' }),
    });
    expect(signal).toEqual({ kind: 'paths-unchanged', checked: ['packages/a.ts', 'packages/b.ts'] });
  });

  /**
   * The false-clean guard. One unreadable path means "nothing moved" was never
   * established for the item — reporting it as unchanged would manufacture exactly
   * the affirmed-but-unmeasured verdict this port exists to remove.
   */
  it('a partially-readable path set is unmeasured, NEVER unchanged', async () => {
    const signal = await getClaimTimeSourceGenerationSignal({
      payload: { ...envelope(), paths: ['packages/a.ts', 'packages/b.ts'] },
      repoRoot: REPO,
      git: gitFor({ 'packages/a.ts': '', 'packages/b.ts': null }),
    });
    expect(signal.kind).toBe('unmeasured');
    expect((signal as { reason: string }).reason).toContain('1 of 2');
  });

  it('a moved path still wins over an unreadable sibling', async () => {
    // Positive evidence of movement is a real verdict even if the rest is unreadable.
    const signal = await getClaimTimeSourceGenerationSignal({
      payload: { ...envelope(), paths: ['packages/a.ts', 'packages/b.ts'] },
      repoRoot: REPO,
      git: gitFor({ 'packages/a.ts': 'deadbeef', 'packages/b.ts': null }),
    });
    expect(signal).toEqual({ kind: 'paths-moved', paths: ['packages/a.ts'] });
  });

  it('is unmeasured — not fresh — when the item carries no freshness envelope', async () => {
    const signal = await getClaimTimeSourceGenerationSignal({
      payload: { paths: ['packages/a.ts'] },
      repoRoot: REPO,
      git: gitFor({}),
    });
    expect(signal).toMatchObject({ kind: 'unmeasured' });
    expect((signal as { reason: string }).reason).toContain('no observed generation');
  });

  it('is unmeasured when the item names no resolvable source paths', async () => {
    const signal = await getClaimTimeSourceGenerationSignal({
      payload: envelope(),
      title: 'something broke',
      summary: 'no paths cited here',
      repoRoot: REPO,
      git: gitFor({}),
    });
    expect(signal).toMatchObject({ kind: 'unmeasured' });
    expect((signal as { reason: string }).reason).toContain('no resolvable source paths');
  });

  it('falls back to the runtime generation when only that sha is recorded', async () => {
    const signal = await getClaimTimeSourceGenerationSignal({
      payload: { ...envelope({ observedSourceSha: null }), paths: ['packages/a.ts'] },
      repoRoot: REPO,
      git: gitFor({ 'packages/a.ts': 'deadbeef' }),
    });
    expect(signal).toEqual({ kind: 'paths-moved', paths: ['packages/a.ts'] });
  });

  it('never throws — a failing git seam degrades to unmeasured', async () => {
    const signal = await getClaimTimeSourceGenerationSignal({
      payload: { ...envelope(), paths: ['packages/a.ts'] },
      repoRoot: REPO,
      git: async () => {
        throw new Error('git exploded');
      },
    });
    expect(signal).toMatchObject({ kind: 'unmeasured' });
  });

  it('reads the item through the sibling-port `workItem` shape', async () => {
    const signal = await getClaimTimeSourceGenerationSignal({
      workItem: { payload: { ...envelope(), paths: ['packages/a.ts'] } },
      repoRoot: REPO,
      git: gitFor({ 'packages/a.ts': 'deadbeef' }),
    });
    expect(signal).toEqual({ kind: 'paths-moved', paths: ['packages/a.ts'] });
  });
});

describe('candidateSourcePaths', () => {
  it('prefers stored payload paths', () => {
    expect(
      candidateSourcePaths({ payload: { paths: ['packages/stored.ts'] }, summary: 'packages/prose.ts' }),
    ).toEqual(['packages/stored.ts']);
  });

  /**
   * The coverage lift that makes the axis worth measuring at all: most filed items
   * name their file in prose and never populate the structured field (measured
   * 2026-09-03 over 1,369 open bugs — stored paths 26%, either source 38%).
   */
  it('falls back to repo paths cited in the item prose', () => {
    expect(
      candidateSourcePaths({
        payload: {},
        title: 'scheduler:get_next collapses two axes',
        summary: 'see packages/operator-core/lib/agent-tools/scheduler/get_next.ts lines 1661-1662',
      }),
    ).toContain('packages/operator-core/lib/agent-tools/scheduler/get_next.ts');
  });

  it('returns nothing when neither source names a path', () => {
    expect(candidateSourcePaths({ payload: {}, title: 'broken', summary: 'it broke' })).toEqual([]);
  });
});
