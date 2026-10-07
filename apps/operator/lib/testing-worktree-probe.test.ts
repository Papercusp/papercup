import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  probeSnapshot: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFileSync: mocks.git }));
vi.mock('@papercusp/test-config/admin-test-runs-reporter', async (importOriginal) => ({
  ...await importOriginal<typeof import('@papercusp/test-config/admin-test-runs-reporter')>(),
  captureWorktreeSnapshot: mocks.probeSnapshot,
}));

import { captureTestSourceSnapshot, computeWorktreeDirty } from '@papercusp/operator-core/lib/testing-worktree';

describe('Playwright source snapshots inside a mutation probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '1');
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT', '/committed-proof');
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE_SUBJECT', '/committed-proof/src/subject.ts');
    mocks.git.mockImplementation((_bin, args) => args[0] === 'rev-parse' ? 'snapshot-sha' : ' M src/subject.ts');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('uses the maintained probe snapshot rather than counting the intentional overlay as dirt', async () => {
    mocks.probeSnapshot.mockResolvedValue({ commit: 'snapshot-sha', porcelain: '' });
    const before = await captureTestSourceSnapshot('/committed-proof');
    const after = await captureTestSourceSnapshot('/committed-proof');
    expect(mocks.probeSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.git).not.toHaveBeenCalled();
    expect(computeWorktreeDirty(before, after)).toBe(false);
  });

  it.each([
    { commit: 'snapshot-sha', porcelain: ' M src/unrelated.ts' },
    { commit: 'snapshot-sha', porcelain: null },
    { commit: null, porcelain: '' },
  ])('keeps unrelated edits or unavailable probe provenance dirty: %j', async (after) => {
    mocks.probeSnapshot.mockResolvedValueOnce({ commit: 'snapshot-sha', porcelain: '' }).mockResolvedValueOnce(after);
    const before = await captureTestSourceSnapshot('/committed-proof');
    const observed = await captureTestSourceSnapshot('/committed-proof');
    expect(observed).toEqual(after);
    expect(computeWorktreeDirty(before, observed)).toBe(true);
  });

  it('does not trust an origin or subject environment variable outside a marked probe', async () => {
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '0');
    const observed = await captureTestSourceSnapshot('/committed-proof');
    expect(mocks.probeSnapshot).not.toHaveBeenCalled();
    expect(observed.porcelain).toBe('M src/subject.ts');
    expect(mocks.git).toHaveBeenCalledWith('git', expect.any(Array), expect.objectContaining({ cwd: '/committed-proof' }));
  });
});
