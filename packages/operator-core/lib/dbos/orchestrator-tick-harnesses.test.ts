import { describe, test, expect, vi, afterEach } from 'vitest';

// resolveTickHarnesses gates the swept set on the Start-Hive bit (#3
// placement-started-gate): only STARTED hives get their work placed, so a
// stopped / never-started hive's backlog is never picked up. Mock the two
// inputs — the workspace harness list + the started-hive set — and assert the
// intersection.
vi.mock('../dev-data', async (orig) => ({
  ...(await orig<typeof import('../dev-data')>()),
  listAllHarnesses: vi.fn(),
}));
vi.mock('../pot/started', async (orig) => ({
  ...(await orig<typeof import('../pot/started')>()),
  listStartedPots: vi.fn(),
}));

import { resolveTickHarnesses } from './orchestrator-loop';
import { listAllHarnesses } from '../dev-data';
import { listStartedPots } from '../pot/started';

const mockAll = vi.mocked(listAllHarnesses);
const mockStarted = vi.mocked(listStartedPots);

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES;
  delete process.env.PAPERCUSP_DBOS_DISPATCH_HARNESSES;
});

describe('resolveTickHarnesses — placement gated on the Start-Hive bit (#3)', () => {
  test('"*" sweeps only STARTED hives; stopped / never-started / other-workspace filtered out', async () => {
    process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES = '*';
    mockAll.mockResolvedValue({
      harnesses: [
        { slug: 'papercup' },
        { slug: 'papercup-hive' },
        { slug: 'sb-devboard-hive' }, // stopped
        { slug: 'smoke-x' }, // never started
      ],
    } as never);
    mockStarted.mockResolvedValue([
      { workspaceId: 'ws', installSlug: 'papercup' },
      { workspaceId: 'ws', installSlug: 'papercup-hive' },
      { workspaceId: 'other', installSlug: 'papercup' }, // other workspace → not counted here
    ]);
    expect(await resolveTickHarnesses('ws')).toEqual(['papercup', 'papercup-hive']);
  });

  test('an explicit allowlist is ALSO gated — a listed-but-stopped hive is not placed', async () => {
    process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES = 'papercup, sb-devboard-hive';
    mockStarted.mockResolvedValue([{ workspaceId: 'ws', installSlug: 'papercup' }]);
    expect(await resolveTickHarnesses('ws')).toEqual(['papercup']);
  });

  test('zero started hives → places nothing (fail-safe)', async () => {
    process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES = '*';
    mockAll.mockResolvedValue({ harnesses: [{ slug: 'papercup' }] } as never);
    mockStarted.mockResolvedValue([]);
    expect(await resolveTickHarnesses('ws')).toEqual([]);
  });

  test('a listStartedPots failure → fail-safe (place nothing)', async () => {
    process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES = '*';
    mockAll.mockResolvedValue({ harnesses: [{ slug: 'papercup' }] } as never);
    mockStarted.mockRejectedValue(new Error('db down'));
    expect(await resolveTickHarnesses('ws')).toEqual([]);
  });
});
