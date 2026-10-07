import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFileSync: mocks.git }));
import { captureTestSourceSnapshot, computeWorktreeDirty } from '@papercusp/operator-core/lib/testing-worktree';

describe('Playwright source snapshots inside a mutation probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '1');
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT', '/committed-proof');
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE_SUBJECT', '/committed-proof/src/subject.ts');
    mocks.git.mockImplementation((_bin, args) => args[1] === '--show-toplevel' ? '/committed-proof'
      : args[0] === 'rev-parse' ? 'snapshot-sha' : ' M src/subject.ts');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('synchronously exempts the declared overlay subject before the native hook can start tests', () => {
    const before = captureTestSourceSnapshot('/committed-proof');
    const after = captureTestSourceSnapshot('/committed-proof');
    expect(before).not.toBeInstanceOf(Promise);
    expect(before).toEqual({ commit: 'snapshot-sha', porcelain: '' });
    expect(computeWorktreeDirty(before, after)).toBe(false);
  });

  it.each([
    { commit: 'snapshot-sha', porcelain: ' M src/unrelated.ts' },
    { commit: 'snapshot-sha', porcelain: null },
    { commit: null, porcelain: '' },
  ])('keeps unrelated edits or unavailable probe provenance dirty: %j', (after) => {
    const before = captureTestSourceSnapshot('/committed-proof');
    mocks.git.mockImplementation((_bin, args) => {
      if (args[1] === '--show-toplevel') return '/committed-proof';
      const value = args[0] === 'rev-parse' ? after.commit : after.porcelain;
      if (value === null) throw new Error('Git snapshot unavailable');
      return value;
    });
    const observed = captureTestSourceSnapshot('/committed-proof');
    expect(computeWorktreeDirty(before, observed)).toBe(true);
  });

  it('does not trust an origin or subject environment variable outside a marked probe', () => {
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '0');
    const observed = captureTestSourceSnapshot('/committed-proof');
    expect(observed.porcelain).toBe('M src/subject.ts');
    expect(mocks.git).toHaveBeenCalledWith('git', expect.any(Array), expect.objectContaining({ cwd: '/committed-proof' }));
  });
});
