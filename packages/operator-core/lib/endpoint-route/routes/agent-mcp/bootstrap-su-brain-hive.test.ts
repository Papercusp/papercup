import { describe, test, expect, vi, afterEach } from 'vitest';

// The brain helpers' dynamic-import deps (queen-interactive-brain-fresh-context
// P-002/P-003): the QUEEN_BRAIN_FRESH flag, the D-013 brain pin, the started-hive
// scope, and the precomputed wake brief.
vi.mock('../../../hive/started', () => ({ listStartedHives: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../../../brain-pin', () => ({ getBrainSession: vi.fn(), setBrainSession: vi.fn() }));
vi.mock('../../../hive/queen-brief-launch', () => ({ computeQueenWakeBrief: vi.fn() }));

import { resolveBrainHiveSlug, resolveBrainPin, maybeAppendBrainBrief } from './bootstrap-su';
import { listStartedHives } from '../../../hive/started';
import { getFlag } from '@papercusp/flags/server';
import { getBrainSession } from '../../../brain-pin';
import { computeQueenWakeBrief } from '../../../hive/queen-brief-launch';

const mockStarted = vi.mocked(listStartedHives);
const mockFlag = vi.mocked(getFlag);
const mockBrainSession = vi.mocked(getBrainSession);
const mockBrief = vi.mocked(computeQueenWakeBrief);
afterEach(() => vi.clearAllMocks());

describe('resolveBrainHiveSlug — interactive brain hive scope (P-002)', () => {
  test('prefers the launch harness when it is a started hive', async () => {
    mockStarted.mockResolvedValue([
      { workspaceId: 'ws', installSlug: 'papercup-hive' },
      { workspaceId: 'ws', installSlug: 'other-hive' },
    ]);
    expect(await resolveBrainHiveSlug('ws', 'other-hive')).toBe('other-hive');
  });

  test('falls back to the first started hive when the harness is not started / null', async () => {
    mockStarted.mockResolvedValue([
      { workspaceId: 'ws', installSlug: 'papercup-hive' },
      { workspaceId: 'other', installSlug: 'elsewhere' }, // other workspace → ignored
    ]);
    expect(await resolveBrainHiveSlug('ws', 'sb-devboard-hive')).toBe('papercup-hive'); // harness not started
    expect(await resolveBrainHiveSlug('ws', null)).toBe('papercup-hive');
  });

  test('null when nothing is started in the workspace', async () => {
    mockStarted.mockResolvedValue([{ workspaceId: 'other', installSlug: 'elsewhere' }]);
    expect(await resolveBrainHiveSlug('ws', null)).toBeNull();
  });

  test('null (fail-soft) when listStartedHives throws', async () => {
    mockStarted.mockRejectedValue(new Error('db down'));
    expect(await resolveBrainHiveSlug('ws', 'papercup-hive')).toBeNull();
  });
});

describe('resolveBrainPin — the GET brain-pin flag branch (P-003)', () => {
  test('flag ON (fresh-context) → null pin, so psu --brain takes the fresh mint-launch path', async () => {
    mockFlag.mockResolvedValue(true);
    expect(await resolveBrainPin()).toBeNull();
    expect(mockBrainSession).not.toHaveBeenCalled(); // never reads the D-013 pin under the flag
  });

  test('flag OFF → the persistent D-013 pinned session (unchanged resume behavior)', async () => {
    mockFlag.mockResolvedValue(false);
    mockBrainSession.mockResolvedValue('pinned-native-uuid');
    expect(await resolveBrainPin()).toBe('pinned-native-uuid');
  });
});

describe('maybeAppendBrainBrief — the POST Queen-brief injection (P-002)', () => {
  test('flag ON + a started hive + a brief → appends computeQueenWakeBrief to the prompt', async () => {
    mockFlag.mockResolvedValue(true);
    mockStarted.mockResolvedValue([{ workspaceId: 'ws', installSlug: 'papercup-hive' }]);
    mockBrief.mockResolvedValue('## Your wake brief — precomputed snapshot');
    const out = await maybeAppendBrainBrief('SU LAUNCH CTX', { workspace: 'ws', harnessSlug: 'papercup-hive' });
    expect(out).toBe('SU LAUNCH CTX\n\n## Your wake brief — precomputed snapshot');
    expect(mockBrief).toHaveBeenCalledWith('ws', 'papercup-hive', { wokeBy: 'interactive-brain' });
  });

  test('no brief (computeQueenWakeBrief → null) → prompt unchanged', async () => {
    mockFlag.mockResolvedValue(true);
    mockStarted.mockResolvedValue([{ workspaceId: 'ws', installSlug: 'papercup-hive' }]);
    mockBrief.mockResolvedValue(null);
    expect(await maybeAppendBrainBrief('SU LAUNCH CTX', { workspace: 'ws', harnessSlug: 'papercup-hive' })).toBe('SU LAUNCH CTX');
  });

  test('no started hive → unchanged; the brief is never computed', async () => {
    mockFlag.mockResolvedValue(true);
    mockStarted.mockResolvedValue([]);
    expect(await maybeAppendBrainBrief('SU LAUNCH CTX', { workspace: 'ws', harnessSlug: null })).toBe('SU LAUNCH CTX');
    expect(mockBrief).not.toHaveBeenCalled();
  });

  test('flag OFF → unchanged; neither the hive scope nor the brief is read', async () => {
    mockFlag.mockResolvedValue(false);
    expect(await maybeAppendBrainBrief('SU LAUNCH CTX', { workspace: 'ws', harnessSlug: 'papercup-hive' })).toBe('SU LAUNCH CTX');
    expect(mockStarted).not.toHaveBeenCalled();
    expect(mockBrief).not.toHaveBeenCalled();
  });

  test('fail-soft: a throw in the brief computation leaves the prompt unchanged (never blocks the launch)', async () => {
    mockFlag.mockResolvedValue(true);
    mockStarted.mockResolvedValue([{ workspaceId: 'ws', installSlug: 'papercup-hive' }]);
    mockBrief.mockRejectedValue(new Error('brief compute boom'));
    expect(await maybeAppendBrainBrief('SU LAUNCH CTX', { workspace: 'ws', harnessSlug: 'papercup-hive' })).toBe('SU LAUNCH CTX');
  });
});
