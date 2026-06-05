/**
 * papercusp:list_workspaces — pure bucketing/reduce tests.
 *
 * This is a ROLE-GATED tool (`requirePrincipal: false`) that reads the
 * admin handle via `getOrgPg().sql` directly (it's the cross-workspace
 * enumerator), so — exactly like the artifacts:* tests — we mock
 * `@papercusp/db-org`'s `getOrgPg` and feed crafted rows through the
 * `sql` template tag. No principal / no ctx.tx is required.
 *
 * The logic under test is the in-handler reduce that turns the flat
 * `(workspace_id, harness_slug, last_active_ts)` join result into the
 * bucketed `{ slug, harnesses[], lastActiveTs }[]` shape:
 *   - int8/BIGINT `last_active_ts` arrives as a STRING → coerced via Number()
 *   - lastActiveTs per bucket = MAX over the bucket's rows
 *   - a null harness_slug (LEFT JOIN LATERAL miss) is skipped, not pushed
 *   - defaultWorkspace = the 'default' slug if present, else the first
 *     (highest lastActiveTs) workspace, else null
 *   - empty rows → empty workspaces + null defaultWorkspace
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Intercept getOrgPg().sql — the tool calls `sql\`SELECT ...\`` once and
// awaits the crafted rows.
const sqlImpl = vi.fn(async () => [] as Array<Record<string, unknown>>);
const sqlTag = (...args: unknown[]) => sqlImpl(...args);

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: sqlTag }),
}));

import { lookupByMcpName, dispatchProjectedTool, type UnifiedToolContext } from '@papercusp/tooldef';

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: '*',
  harnessSlug: undefined,
  role: 'architect',
  runId: 'run_T',
  spawnId: 'spw_T',
  ...over,
});

async function call(rows: Array<Record<string, unknown>>): Promise<{
  workspaces: Array<{ slug: string; harnesses: string[]; lastActiveTs: number }>;
  defaultWorkspace: string | null;
}> {
  sqlImpl.mockResolvedValueOnce(rows);
  const tool = lookupByMcpName('papercusp:list_workspaces')!;
  const r = await dispatchProjectedTool(tool, 'papercusp:list_workspaces', {}, MAKE_CTX(), {});
  expect(r.ok).toBe(true);
  return JSON.parse((r.result!.content[0] as { text: string }).text);
}

beforeAll(async () => {
  await import('./list_workspaces');
});

beforeEach(() => {
  sqlImpl.mockReset();
  sqlImpl.mockResolvedValue([]);
});

describe('papercusp:list_workspaces — registration', () => {
  it('is registered, role-gated (no agentRoles whitelist) and cross-workspace', () => {
    const tool = lookupByMcpName('papercusp:list_workspaces')!;
    expect(tool).toBeDefined();
    expect(tool.capabilities).toContain('workspaces:read');
    expect(tool.crossWorkspace).toBe(true);
  });
});

describe('papercusp:list_workspaces — bucketing reduce', () => {
  it('buckets multiple harness rows under one workspace', async () => {
    const out = await call([
      { workspace_id: 'alpha', harness_slug: 'sheets', last_active_ts: '100' },
      { workspace_id: 'alpha', harness_slug: 'docs', last_active_ts: '100' },
    ]);
    expect(out.workspaces).toHaveLength(1);
    expect(out.workspaces[0].slug).toBe('alpha');
    expect(out.workspaces[0].harnesses).toEqual(['sheets', 'docs']);
  });

  it('coerces int8-as-string last_active_ts via Number() (not string concat / NaN)', async () => {
    const out = await call([
      { workspace_id: 'alpha', harness_slug: 'a', last_active_ts: '1780000000000' },
    ]);
    expect(out.workspaces[0].lastActiveTs).toBe(1780000000000);
    expect(typeof out.workspaces[0].lastActiveTs).toBe('number');
  });

  it('takes the MAX last_active_ts across rows of the same workspace', async () => {
    // Rows arrive ordered by slug, so the max (200) is NOT last — proves
    // it is a max-reduce, not a last-write-wins.
    const out = await call([
      { workspace_id: 'alpha', harness_slug: 'a', last_active_ts: '200' },
      { workspace_id: 'alpha', harness_slug: 'b', last_active_ts: '50' },
      { workspace_id: 'alpha', harness_slug: 'c', last_active_ts: '120' },
    ]);
    expect(out.workspaces[0].lastActiveTs).toBe(200);
  });

  it('skips null harness_slug rows (LEFT JOIN LATERAL miss) but keeps the workspace', async () => {
    const out = await call([
      { workspace_id: 'empty-ws', harness_slug: null, last_active_ts: '300' },
    ]);
    expect(out.workspaces).toHaveLength(1);
    expect(out.workspaces[0].slug).toBe('empty-ws');
    expect(out.workspaces[0].harnesses).toEqual([]);
    // The non-null last_active_ts still establishes the bucket's ts.
    expect(out.workspaces[0].lastActiveTs).toBe(300);
  });

  it('treats a null last_active_ts as 0 (Number(null ?? 0))', async () => {
    const out = await call([
      { workspace_id: 'alpha', harness_slug: 'a', last_active_ts: null },
    ]);
    expect(out.workspaces[0].lastActiveTs).toBe(0);
  });

  it('sorts workspaces by lastActiveTs descending', async () => {
    const out = await call([
      { workspace_id: 'low', harness_slug: 'a', last_active_ts: '10' },
      { workspace_id: 'high', harness_slug: 'b', last_active_ts: '999' },
      { workspace_id: 'mid', harness_slug: 'c', last_active_ts: '500' },
    ]);
    expect(out.workspaces.map((w) => w.slug)).toEqual(['high', 'mid', 'low']);
  });
});

describe('papercusp:list_workspaces — defaultWorkspace fallback chain', () => {
  it("returns 'default' when a workspace with that slug exists, even if not first", async () => {
    const out = await call([
      { workspace_id: 'busy', harness_slug: 'a', last_active_ts: '999' },
      { workspace_id: 'default', harness_slug: 'b', last_active_ts: '1' },
    ]);
    // 'busy' sorts first by ts, but the explicit 'default' slug wins.
    expect(out.workspaces[0].slug).toBe('busy');
    expect(out.defaultWorkspace).toBe('default');
  });

  it('falls back to the first (highest-ts) workspace when no default slug', async () => {
    const out = await call([
      { workspace_id: 'busy', harness_slug: 'a', last_active_ts: '999' },
      { workspace_id: 'quiet', harness_slug: 'b', last_active_ts: '1' },
    ]);
    expect(out.defaultWorkspace).toBe('busy');
  });

  it('empty rows → empty workspaces + null defaultWorkspace', async () => {
    const out = await call([]);
    expect(out.workspaces).toEqual([]);
    expect(out.defaultWorkspace).toBeNull();
  });
});
