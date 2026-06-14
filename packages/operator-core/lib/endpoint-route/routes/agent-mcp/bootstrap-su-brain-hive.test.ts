import { describe, test, expect, vi, afterEach } from 'vitest';

// resolveBrainHiveSlug picks the hive the interactive brain briefs about
// (queen-interactive-brain-fresh-context P-002): the started hive she's
// operating — the launch harness if it's started, else the first started hive,
// else null (→ no brief, fail-soft).
vi.mock('../../../hive/started', () => ({ listStartedHives: vi.fn() }));

import { resolveBrainHiveSlug } from './bootstrap-su';
import { listStartedHives } from '../../../hive/started';

const mockStarted = vi.mocked(listStartedHives);
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
