import { it, vi } from 'vitest';
vi.mock('@papercusp/db-org', () => ({ getOrgPg: vi.fn() }));
vi.mock('@papercusp/agent-mcp', () => ({ AGENT_ROLES: ['scoper'] }));
vi.mock('../harness-core', () => ({ resolveProject: vi.fn() }));
vi.mock('../harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));
vi.mock('../dbos/orchestrator-runner', () => ({ spawnInvokeOnce: vi.fn() }));
vi.mock('./spawn-tree', () => ({ recordSpawn: vi.fn(), finishSpawn: vi.fn() }));
vi.mock('../rate-limit-config', () => ({ getCachedRateLimitConfig: () => ({ maxSimultaneousAgents: 16 }) }));
vi.mock('./spawn-reclaim', () => ({
  heartbeatSpawns: vi.fn(async () => {}),
  reclaimOrphanedSpawns: vi.fn(async () => ({ reclaimed: 0, spawnIds: [], workspaces: [] })),
  SPAWN_HEARTBEAT_INTERVAL_MS: 60_000,
}));
let n = 0;
vi.mock('../events/await/engine', () => ({ emitAwaitedEvent: vi.fn(async (o) => { console.log('EMIT', o.key); return { ok: true }; }) }));
import { getOrgPg } from '@papercusp/db-org';
import { resolveProject } from '../harness-core';
import { spawnInvokeOnce } from '../dbos/orchestrator-runner';
import { recordSpawn, finishSpawn } from './spawn-tree';
import { reclaimOrphanedSpawns } from './spawn-reclaim';

it('dbg2', async () => {
  const sql = vi.fn(async () => [{ n: '0' }]);
  vi.mocked(getOrgPg).mockReturnValue({ sql } as never);
  vi.mocked(resolveProject).mockResolvedValue({ slug: 'demo', path: '/tmp' } as never);
  vi.mocked(spawnInvokeOnce).mockResolvedValue({ output: '', exitCode: 0, stderr: '' });
  vi.mocked(recordSpawn).mockResolvedValue(undefined);
  vi.mocked(finishSpawn).mockResolvedValue(undefined);
  vi.mocked(reclaimOrphanedSpawns).mockResolvedValue({ reclaimed: 2, spawnIds: ['a','b'], workspaces: ['ws-1','ws-2'] });
  // Call getSpawnHeadroom directly — isolates reclaimAndAnnounce from the spawn path.
  const mod = await import('./operator-spawn');
  const h = await mod.getSpawnHeadroom('ws-1');
  console.log('HEADROOM', JSON.stringify(h));
});
