/**
 * Tests for roles:* + hooks:known tools.
 *
 * Operator-side tools are tested by importing the tool definition's
 * `handler` directly and asserting on the return value. The dispatcher
 * (role gates, quota, telemetry) is exhaustively covered in the
 * @papercusp/agent-mcp package's own tests; this file only validates
 * each handler's behavior given mocked lib helpers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../role-registry');
  vi.doUnmock('../../../known-roles');
  vi.doUnmock('../../../known-hooks');
});

function parseTextPayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe('roles:list', () => {
  it('passes the given slug to listRoles and wraps the output', async () => {
    const listRoles = vi.fn(() => [{ id: 'architect', whenUseful: 'plan stuff' }]);
    vi.doMock('../../../role-registry', () => ({ listRoles, getRole: vi.fn(), rolesFiringOn: vi.fn() }));
    const { default: tool } = await import('../list');
    const result = await tool.handler({ harnessSlug: 'foo' }, MAKE_CTX());
    expect(listRoles).toHaveBeenCalledWith('foo');
    const payload = parseTextPayload(result as never);
    expect(payload.harnessSlug).toBe('foo');
    expect(Array.isArray(payload.roles)).toBe(true);
    expect((payload.roles as Array<{ id: string }>)[0].id).toBe('architect');
  });

  it('falls back to ctx.harnessSlug when arg is omitted', async () => {
    const listRoles = vi.fn(() => []);
    vi.doMock('../../../role-registry', () => ({ listRoles, getRole: vi.fn(), rolesFiringOn: vi.fn() }));
    const { default: tool } = await import('../list');
    await tool.handler({}, MAKE_CTX({ harnessSlug: 'fallback' }));
    expect(listRoles).toHaveBeenCalledWith('fallback');
  });

  it('passes empty-string slug when neither arg nor ctx has one', async () => {
    const listRoles = vi.fn(() => []);
    vi.doMock('../../../role-registry', () => ({ listRoles, getRole: vi.fn(), rolesFiringOn: vi.fn() }));
    const { default: tool } = await import('../list');
    await tool.handler({}, MAKE_CTX({ harnessSlug: undefined }));
    expect(listRoles).toHaveBeenCalledWith('');
  });

  it("normalizes the operator '*' auto-default to the global registry, not a literal '*' slug (P-004)", async () => {
    const listRoles = vi.fn(() => []);
    vi.doMock('../../../role-registry', () => ({ listRoles, getRole: vi.fn(), rolesFiringOn: vi.fn() }));
    const { default: tool } = await import('../list');
    await tool.handler({}, MAKE_CTX({ harnessSlug: '*' }));
    expect(listRoles).toHaveBeenCalledWith('');
    expect(listRoles).not.toHaveBeenCalledWith('*');
  });
});

describe('roles:get', () => {
  it('returns found:false when getRole returns null', async () => {
    vi.doMock('../../../role-registry', () => ({
      listRoles: vi.fn(),
      getRole: vi.fn(() => null),
      rolesFiringOn: vi.fn(),
      roleConsumes: vi.fn(() => ({ feature: 'none', plan: 'none' })),
    }));
    const { default: tool } = await import('../get');
    const result = await tool.handler({ id: 'unknown', harnessSlug: 'sheets' }, MAKE_CTX());
    const payload = parseTextPayload(result as never);
    expect(payload.found).toBe(false);
    expect(payload.role).toBeNull();
    expect(payload.consumes).toEqual({ feature: 'none', plan: 'none' });
  });

  it('returns found:true when getRole hits + surfaces consumes', async () => {
    vi.doMock('../../../role-registry', () => ({
      listRoles: vi.fn(),
      getRole: vi.fn((id: string) => ({ id, whenUseful: 'fixture' })),
      rolesFiringOn: vi.fn(),
      roleConsumes: vi.fn(() => ({ feature: 'required', plan: 'none' })),
    }));
    const { default: tool } = await import('../get');
    const result = await tool.handler({ id: 'architect', harnessSlug: 'sheets' }, MAKE_CTX());
    const payload = parseTextPayload(result as never);
    expect(payload.found).toBe(true);
    expect((payload.role as { id: string }).id).toBe('architect');
    expect(payload.consumes).toEqual({ feature: 'required', plan: 'none' });
  });
});

describe('roles:firing_on', () => {
  it('passes event + slug and returns matches', async () => {
    const rolesFiringOn = vi.fn((event: string) => [{ id: `match-${event}` }]);
    vi.doMock('../../../role-registry', () => ({ listRoles: vi.fn(), getRole: vi.fn(), rolesFiringOn }));
    const { default: tool } = await import('../firing_on');
    const result = await tool.handler(
      { event: 'feature_completed', harnessSlug: 'sheets' },
      MAKE_CTX(),
    );
    expect(rolesFiringOn).toHaveBeenCalledWith('feature_completed', 'sheets');
    const payload = parseTextPayload(result as never);
    expect(payload.event).toBe('feature_completed');
    expect((payload.roles as Array<{ id: string }>)[0].id).toBe('match-feature_completed');
  });
});

describe('roles:known', () => {
  it('returns getKnownRoles output verbatim', async () => {
    vi.doMock('../../../known-roles', () => ({
      getKnownRoles: vi.fn(() => ['architect', 'worker', 'validator']),
    }));
    const { default: tool } = await import('../known');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parseTextPayload(result as never);
    expect(payload.roles).toEqual(['architect', 'worker', 'validator']);
  });
});

describe('hooks:known', () => {
  it('returns getKnownHooks output verbatim', async () => {
    vi.doMock('../../../known-hooks', () => ({
      getKnownHooks: vi.fn(() => ['pre-worker', 'post-validate']),
    }));
    const { default: tool } = await import('../../hooks/known');
    const result = await tool.handler({}, MAKE_CTX());
    const payload = parseTextPayload(result as never);
    expect(payload.hooks).toEqual(['pre-worker', 'post-validate']);
  });
});

describe('roles:* metadata', () => {
  it('every role tool exposes any-role allowlist', async () => {
    vi.doMock('../../../role-registry', () => ({
      listRoles: vi.fn(() => []),
      getRole: vi.fn(),
      rolesFiringOn: vi.fn(),
    }));
    vi.doMock('../../../known-roles', () => ({ getKnownRoles: vi.fn(() => []) }));
    vi.doMock('../../../known-hooks', () => ({ getKnownHooks: vi.fn(() => []) }));
    const tools = await Promise.all([
      import('../list').then((m) => m.default),
      import('../get').then((m) => m.default),
      import('../firing_on').then((m) => m.default),
      import('../known').then((m) => m.default),
      import('../../hooks/known').then((m) => m.default),
    ]);
    for (const tool of tools) {
      expect(tool.requirePrincipal).toBe(false);
      expect(tool.agentRoles).toBeDefined();
      // Read tools should permit every role.
      expect(tool.agentRoles).toContain('worker');
      expect(tool.agentRoles).toContain('architect');
      expect(tool.agentRoles).toContain('reviewer');
    }
  });
});
