/**
 * artifacts:* tool tests — mock @papercusp/db-org.getOrgPg's sql template
 * tag and verify each tool's input validation + output shape + role
 * gate via dispatchProjectedTool.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock getOrgPg so the tool handlers don't require a live PG connection.
// The sql template tag is invoked as `sql\`...\``; we intercept it and
// return whatever rows the test fixture configured.
const sqlImpl = vi.fn(async () => [] as Array<Record<string, unknown>>);
const sqlTag = (...args: unknown[]) => sqlImpl(...args);

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: sqlTag }),
}));

import { lookupByMcpName, type UnifiedToolContext } from '@papercusp/tooldef';
import { dispatchProjectedTool } from '@papercusp/tooldef';

const MAKE_CTX = (over: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  harnessSlug: 'sheets',
  role: 'architect',
  runId: 'run_T',
  spawnId: 'spw_T',
  ...over,
});

// Side-effect-import the 4 tool modules once. They self-register into the
// projection registry; subsequent tests re-use the same registrations.
beforeAll(async () => {
  await import('../load');
  await import('../save');
  await import('../append');
  await import('../delete');
});

beforeEach(() => {
  sqlImpl.mockReset();
  sqlImpl.mockResolvedValue([]);
});

describe('artifacts:load', () => {
  it('returns found:false when no row matches', async () => {
    const tool = lookupByMcpName('artifacts:load')!;
    expect(tool).toBeDefined();
    expect(tool.agentRoles).toContain('worker');
    expect(tool.agentRoles).toContain('curator');

    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { slug: 'test', rel_path: 'memory/raw.md' },
      MAKE_CTX(),
      {},
    );
    expect(r.ok).toBe(true);
    const payload = JSON.parse((r.result!.content[0] as { text: string }).text);
    expect(payload).toEqual({
      slug: 'test',
      rel_path: 'memory/raw.md',
      found: false,
      content: null,
      updated_at: null,
    });
  });

  it('returns found:true with content when row exists', async () => {
    sqlImpl.mockResolvedValueOnce([{ content: 'hello world', updated_at: '1234567' }]);
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { slug: 'test', rel_path: 'memory/raw.md' },
      MAKE_CTX(),
      {},
    );
    const payload = JSON.parse((r.result!.content[0] as { text: string }).text);
    expect(payload.found).toBe(true);
    expect(payload.content).toBe('hello world');
    expect(payload.updated_at).toBe(1234567);
  });

  it('strips a leading .papercusp/ prefix from rel_path', async () => {
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { slug: 'test', rel_path: '.papercusp/memory/raw.md' },
      MAKE_CTX(),
      {},
    );
    const payload = JSON.parse((r.result!.content[0] as { text: string }).text);
    expect(payload.rel_path).toBe('memory/raw.md');
  });

  it('falls back to ctx.harnessSlug when slug arg is omitted', async () => {
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { rel_path: 'memory/raw.md' },
      MAKE_CTX({ harnessSlug: 'fallback-slug' }),
      {},
    );
    const payload = JSON.parse((r.result!.content[0] as { text: string }).text);
    expect(payload.slug).toBe('fallback-slug');
  });

  it('rejects precondition_failed when neither arg slug nor ctx.harnessSlug is set (declarative requires:)', async () => {
    // The former in-handler `if (!slug) throw` (→ handler_error) is lifted into
    // a `requires:` precondition — the DISPATCHER rejects before the handler
    // runs (adopt-event-rules-engines, the requires:-half).
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { rel_path: 'memory/raw.md' },
      MAKE_CTX({ harnessSlug: undefined }),
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('precondition_failed');
    expect(r.error?.message).toMatch(/required/i);
  });

  it('rejects precondition_failed on an invalid ctx.harnessSlug (the valid-ctx-slug spec)', async () => {
    // An arg slug is zod-validated; a CTX slug is only guarded by the
    // `valid-ctx-slug` precondition — the lifted `SLUG_RE.test` guard.
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { rel_path: 'memory/raw.md' },
      MAKE_CTX({ harnessSlug: 'bad slug/with spaces' }),
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('precondition_failed');
    expect(r.error?.message).toMatch(/invalid harnessSlug/i);
  });
});

describe('artifacts:save', () => {
  it('write roles allowlist excludes validator + reviewer', async () => {
    const tool = lookupByMcpName('artifacts:save')!;
    expect(tool.agentRoles).toContain('worker');
    expect(tool.agentRoles).toContain('architect');
    expect(tool.agentRoles).toContain('operator');
    expect(tool.agentRoles).not.toContain('validator');
    expect(tool.agentRoles).not.toContain('reviewer');
  });

  it('returns byte count + updated_at', async () => {
    const tool = lookupByMcpName('artifacts:save')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:save',
      { slug: 'test', rel_path: 'a.md', content: 'hello' },
      MAKE_CTX(),
      {},
    );
    expect(r.ok).toBe(true);
    const payload = JSON.parse((r.result!.content[0] as { text: string }).text);
    expect(payload.bytes).toBe(5);
    expect(payload.updated_at).toEqual(expect.any(Number));
    expect(payload.slug).toBe('test');
  });

  it('rejects validator role via dispatcher gate', async () => {
    const tool = lookupByMcpName('artifacts:save')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:save',
      { slug: 'test', rel_path: 'a.md', content: 'x' },
      MAKE_CTX({ role: 'validator' }),
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('role_not_allowed');
  });
});

describe('artifacts:append', () => {
  it('returns appended_bytes + total_bytes from RETURNING', async () => {
    sqlImpl.mockResolvedValueOnce([{ content: 'previous + appended' }]);
    const tool = lookupByMcpName('artifacts:append')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:append',
      { slug: 'test', rel_path: 'log.md', suffix: ' + appended' },
      MAKE_CTX(),
      {},
    );
    expect(r.ok).toBe(true);
    const payload = JSON.parse((r.result!.content[0] as { text: string }).text);
    expect(payload.appended_bytes).toBe(' + appended'.length);
    expect(payload.total_bytes).toBe('previous + appended'.length);
  });

  it('falls back to suffix when RETURNING produces no rows', async () => {
    sqlImpl.mockResolvedValueOnce([]);
    const tool = lookupByMcpName('artifacts:append')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:append',
      { slug: 'test', rel_path: 'log.md', suffix: 'new content' },
      MAKE_CTX(),
      {},
    );
    const payload = JSON.parse((r.result!.content[0] as { text: string }).text);
    expect(payload.total_bytes).toBe('new content'.length);
  });
});

describe('artifacts:delete', () => {
  it('only architect/operator/curator roles allowed', async () => {
    const tool = lookupByMcpName('artifacts:delete')!;
    expect(tool.agentRoles).toEqual(['architect', 'operator', 'curator']);
  });

  it('rejects worker role via dispatcher gate', async () => {
    const tool = lookupByMcpName('artifacts:delete')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:delete',
      { slug: 'test', rel_path: 'a.md' },
      MAKE_CTX({ role: 'worker', chunkId: 'ck_T' }),
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('role_not_allowed');
  });

  it('returns deleted:true when count > 0', async () => {
    // postgres.js DELETE returns the result with a `count` property.
    Object.defineProperty(sqlTag, 'count', { value: 1, writable: true, configurable: true });
    sqlImpl.mockImplementationOnce(async () => {
      const arr: Array<unknown> = [];
      Object.defineProperty(arr, 'count', { value: 1, configurable: true });
      return arr as never;
    });
    const tool = lookupByMcpName('artifacts:delete')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:delete',
      { slug: 'test', rel_path: 'a.md' },
      MAKE_CTX({ role: 'architect' }),
      {},
    );
    expect(r.ok).toBe(true);
    const payload = JSON.parse((r.result!.content[0] as { text: string }).text);
    expect(payload.deleted).toBe(true);
  });
});

describe('artifacts:* — slug validation', () => {
  it('rejects slug with whitespace', async () => {
    const tool = lookupByMcpName('artifacts:load')!;
    const r = await dispatchProjectedTool(
      tool,
      'artifacts:load',
      { slug: 'has space', rel_path: 'a.md' },
      MAKE_CTX(),
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('handler_error');
    // Zod schema regex catches whitespace before the handler's manual
    // SLUG_RE check; either path is fine.
    expect(r.error?.message).toMatch(/invalid_args|pattern|slug/i);
  });
});
