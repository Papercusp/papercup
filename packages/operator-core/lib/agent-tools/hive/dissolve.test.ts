/**
 * hive:dissolve unwinds the hive (hive-tool-namespace-2026-06-08 P-009, D-005/
 * D-006). PG-free: the readers/teardown primitives are mocked; asserts the
 * orchestration — clears the Queen wake, cancels every LIVE bee (dead skipped),
 * deregisters the home harness, and only drops the schema (via dropHarnessSchema,
 * which sanitizes the slug) when asked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ROOT_CTX = { isSuperuser: true, uiClientId: 'su-test', workspaceId: 'default' } as never;
const parse = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
  JSON.parse(r.content[0].text);
type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }> };

let cancelCalls: string[];
let clearWakeCalls: string[];
let deregCalls: string[];
let dropSchemaCalls: string[];
let bees: Array<{ holderAlive: boolean; agentId: string | null; harnessSlug: string | null }>;
// B11 / P-014: the owner-action tier gate is mocked here (it has its own
// dedicated integration test, member-tier-gate.integration.test.ts). Default
// allow; a test flips this to prove the dissolve chokepoint honors a denial.
let gateResult: { ok: boolean; tier?: string; reason?: string; message?: string };

beforeEach(() => {
  vi.resetModules();
  cancelCalls = [];
  clearWakeCalls = [];
  deregCalls = [];
  dropSchemaCalls = [];
  gateResult = { ok: true, tier: 'owner', reason: 'solo-unbound' };
  bees = [
    { holderAlive: true, agentId: 's-bee-a', harnessSlug: 'h' },
    { holderAlive: true, agentId: 's-bee-b', harnessSlug: 'h' },
    { holderAlive: false, agentId: 's-dead', harnessSlug: 'h' }, // dead → skipped
  ];
  vi.doMock('./_resolve', () => ({
    resolveHive: async () => ({
      slug: 'h',
      path: '/h',
      kind: 'hive',
      deployment: { target: 'local' },
      deployed: false,
      wake: {},
    }),
  }));
  vi.doMock('../../fleet/assignments', () => ({ listFleetAssignments: async () => bees }));
  vi.doMock('../../fleet/nursery', () => ({
    cancelSubtree: async (_sql: unknown, opts: { rootSpawnId: string }) => {
      cancelCalls.push(opts.rootSpawnId);
      return { cancelled: [{ spawnId: opts.rootSpawnId }] };
    },
  }));
  vi.doMock('../../hive/wake', () => ({
    clearHiveTimeWake: async (_sql: unknown, slug: string) => {
      clearWakeCalls.push(slug);
    },
  }));
  vi.doMock('../../scaffold-harness-schema', () => ({
    dropHarnessSchema: async (slug: string) => {
      dropSchemaCalls.push(slug);
    },
  }));
  vi.doMock('../../harness-membership', () => ({
    removeHarnessFromWorkspace: async (_ws: string, slug: string) => {
      deregCalls.push(slug);
      return { changed: true };
    },
  }));
  vi.doMock('../../fleet/operator-spawn', () => ({ abortLocalSpawn: () => true }));
  vi.doMock('@papercusp/db-org', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@papercusp/db-org')>()),
    getOrgPg: () => ({ sql: {} }),
  }));
  vi.doMock('../../hive/member-tier-gate', () => ({
    requireHiveTier: async () => gateResult,
  }));
});

afterEach(() => {
  for (const m of [
    './_resolve',
    '../../fleet/assignments',
    '../../fleet/nursery',
    '../../hive/wake',
    '../../scaffold-harness-schema',
    '../../harness-membership',
    '../../fleet/operator-spawn',
    '@papercusp/db-org',
    '../../hive/member-tier-gate',
  ]) {
    vi.doUnmock(m);
  }
});

describe('hive:dissolve', () => {
  it('clears the wake, cancels live bees (dead skipped), deregisters — no schema drop by default', async () => {
    const tool = (await import('./dissolve')).default as unknown as Tool;
    const res = parse(await tool.handler({ slug: 'h', confirm: true, workspace: 'default' }, ROOT_CTX));
    expect(res.ok).toBe(true);
    expect(clearWakeCalls).toEqual(['h']);
    expect(cancelCalls.sort()).toEqual(['s-bee-a', 's-bee-b']);
    expect((res.cancelledSpawns as string[]).sort()).toEqual(['s-bee-a', 's-bee-b']);
    expect(deregCalls).toEqual(['h']);
    expect(res.deregistered).toBe(true);
    expect(res.schemaDropped).toBe(false);
    expect(dropSchemaCalls).toEqual([]);
  });

  it('requires confirm:true', async () => {
    const tool = (await import('./dissolve')).default as unknown as Tool;
    const res = parse(await tool.handler({ slug: 'h', workspace: 'default' }, ROOT_CTX));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('confirm_required');
  });

  it('drops the schema via dropHarnessSchema when dropSchema:true', async () => {
    const tool = (await import('./dissolve')).default as unknown as Tool;
    const res = parse(
      await tool.handler({ slug: 'h', confirm: true, dropSchema: true, workspace: 'default' }, ROOT_CTX),
    );
    expect(res.ok).toBe(true);
    expect(res.schemaDropped).toBe(true);
    expect(dropSchemaCalls).toEqual(['h']); // sanitized name handled inside dropHarnessSchema
  });

  it('B11: a sub-owner tier is REFUSED — none of the destructive steps run', async () => {
    gateResult = { ok: false, tier: 'read-only', reason: 'github', message: 'access is read-only' };
    const tool = (await import('./dissolve')).default as unknown as Tool;
    const res = parse(await tool.handler({ slug: 'h', confirm: true, workspace: 'default' }, ROOT_CTX));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('insufficient_tier');
    expect(res.tier).toBe('read-only');
    // The gate runs AFTER confirm but BEFORE any teardown — nothing destructive fired.
    expect(clearWakeCalls).toEqual([]);
    expect(cancelCalls).toEqual([]);
    expect(deregCalls).toEqual([]);
    expect(dropSchemaCalls).toEqual([]);
  });
});
