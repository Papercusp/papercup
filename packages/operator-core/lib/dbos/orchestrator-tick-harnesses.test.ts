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
vi.mock('../hive/started', async (orig) => ({
  ...(await orig<typeof import('../hive/started')>()),
  listStartedHives: vi.fn(),
  getHiveStarted: vi.fn(),
}));
// K1 (workspace-scoped-coordination P-003): stub the flag read; the OFF default
// (the dark default) is what every legacy test below relies on.
vi.mock('../workspace-brain-scope', async (orig) => ({
  ...(await orig<typeof import('../workspace-brain-scope')>()),
  isWorkspaceCoordinationOn: vi.fn(async () => false),
}));

import { resolveTickHarnesses } from './orchestrator-loop';
import { listAllHarnesses } from '../dev-data';
import { listStartedHives, getHiveStarted } from '../hive/started';
import { isWorkspaceCoordinationOn } from '../workspace-brain-scope';

const mockAll = vi.mocked(listAllHarnesses);
const mockStarted = vi.mocked(listStartedHives);
const mockGetStarted = vi.mocked(getHiveStarted);
const mockWsCoord = vi.mocked(isWorkspaceCoordinationOn);

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

  test('a listStartedHives failure → fail-safe (place nothing)', async () => {
    process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES = '*';
    mockAll.mockResolvedValue({ harnesses: [{ slug: 'papercup' }] } as never);
    mockStarted.mockRejectedValue(new Error('db down'));
    expect(await resolveTickHarnesses('ws')).toEqual([]);
  });
});

describe('resolveTickHarnesses — K1 workspace-brain re-key (P-003)', () => {
  test('flag ON → each candidate is gated on the read-fallback-aware getHiveStarted (workspace sentinel widens to all started hives)', async () => {
    process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES = '*';
    mockWsCoord.mockResolvedValue(true);
    mockAll.mockResolvedValue({
      harnesses: [{ slug: 'papercup' }, { slug: 'papercup-hive' }, { slug: 'smoke-x' }],
    } as never);
    // The batch read still backs the fast-path / fail-safe (must resolve), but ON
    // the per-candidate getHiveStarted decides membership.
    mockStarted.mockResolvedValue([{ workspaceId: 'ws', installSlug: 'ws' }]); // sentinel row
    // The workspace sentinel started bit resolves true for the two real hives,
    // false for a never-registered candidate.
    mockGetStarted.mockImplementation(async (_ws: string, slug: string) => slug !== 'smoke-x');
    expect(await resolveTickHarnesses('ws')).toEqual(['papercup', 'papercup-hive']);
  });

  test('flag ON + a per-candidate read failure → that candidate fails closed (not placed)', async () => {
    process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES = '*';
    mockWsCoord.mockResolvedValue(true);
    mockAll.mockResolvedValue({ harnesses: [{ slug: 'papercup' }, { slug: 'boom' }] } as never);
    mockStarted.mockResolvedValue([{ workspaceId: 'ws', installSlug: 'ws' }]);
    mockGetStarted.mockImplementation(async (_ws: string, slug: string) => {
      if (slug === 'boom') throw new Error('read failed');
      return true;
    });
    expect(await resolveTickHarnesses('ws')).toEqual(['papercup']);
  });
});
