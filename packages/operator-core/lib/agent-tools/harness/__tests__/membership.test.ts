/**
 * harness:membership tool — list / add / remove / move across workspaces.
 *
 * The handler is a thin operator-facing shell over lib/harness-membership +
 * lib/harness-registry + lib/workspace-registry. These tests mock those module
 * boundaries (vi.doMock + dynamic import, matching harness.test.ts) and drive
 * `tool.handler(args, ctx)` directly, asserting on the JSON payload.
 *
 * M1 focus: the op=add branch re-reads members[0]'s registry and does
 * `srcReg.projects.find((p) => p.slug === slug)!`. If that find MISSES (a
 * concurrent move/remove changed the registry between workspacesForHarness and
 * the re-read), the non-null assertion yields `undefined`. We pin that this
 * never reaches addHarnessToWorkspace as a corrupt entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'operator' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../workspace-registry');
  vi.doUnmock('../../../harness-registry');
  vi.doUnmock('../../../harness-membership');
});

/** Standard workspace-registry mock: two known workspaces. */
function mockWorkspaces(ids: string[] = ['default', 'ws-b']) {
  vi.doMock('../../../workspace-registry', () => ({
    readRegistry: vi.fn(() => ({ current: ids[0], workspaces: ids.map((id) => ({ id })) })),
  }));
}

describe('harness:membership op=list', () => {
  it('returns { slug, workspaces } from workspacesForHarness', async () => {
    mockWorkspaces();
    const workspacesForHarness = vi.fn(async () => ['default', 'ws-b']);
    vi.doMock('../../../harness-membership', () => ({
      workspacesForHarness,
      addHarnessToWorkspace: vi.fn(),
      moveHarness: vi.fn(),
      removeHarnessFromWorkspace: vi.fn(),
    }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));

    const { default: tool } = await import('../membership');
    const result = await tool.handler({ op: 'list', slug: 'sheets' }, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ slug: 'sheets', workspaces: ['default', 'ws-b'] });
    expect(workspacesForHarness).toHaveBeenCalledWith('sheets');
  });
});

describe('harness:membership op=add', () => {
  it('errors when toWorkspace is unknown', async () => {
    mockWorkspaces(['default', 'ws-b']);
    vi.doMock('../../../harness-membership', () => ({
      workspacesForHarness: vi.fn(),
      addHarnessToWorkspace: vi.fn(),
      moveHarness: vi.fn(),
      removeHarnessFromWorkspace: vi.fn(),
    }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));

    const { default: tool } = await import('../membership');
    const result = await tool.handler(
      { op: 'add', slug: 'sheets', toWorkspace: 'nope' },
      MAKE_CTX(),
    );
    expect(parsePayload(result as never)).toEqual({ error: 'unknown toWorkspace' });
  });

  it("errors when the harness isn't registered in any workspace", async () => {
    mockWorkspaces();
    const addHarnessToWorkspace = vi.fn();
    vi.doMock('../../../harness-membership', () => ({
      workspacesForHarness: vi.fn(async () => []),
      addHarnessToWorkspace,
      moveHarness: vi.fn(),
      removeHarnessFromWorkspace: vi.fn(),
    }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));

    const { default: tool } = await import('../membership');
    const result = await tool.handler(
      { op: 'add', slug: 'sheets', toWorkspace: 'ws-b' },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload.error).toMatch(/not registered in any workspace/);
    expect(addHarnessToWorkspace).not.toHaveBeenCalled();
  });

  it('links the harness into the destination workspace (happy path)', async () => {
    mockWorkspaces();
    const sheetsEntry = { slug: 'sheets', path: '/home/u/sheets', harness_kind: 'coding' };
    const addHarnessToWorkspace = vi.fn(async () => ({
      workspaceId: 'ws-b',
      slug: 'sheets',
      changed: true,
    }));
    vi.doMock('../../../harness-membership', () => ({
      workspacesForHarness: vi.fn(async () => ['default']),
      addHarnessToWorkspace,
      moveHarness: vi.fn(),
      removeHarnessFromWorkspace: vi.fn(),
    }));
    vi.doMock('../../../harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [sheetsEntry] })),
    }));

    const { default: tool } = await import('../membership');
    const result = await tool.handler(
      { op: 'add', slug: 'sheets', toWorkspace: 'ws-b' },
      MAKE_CTX(),
    );
    expect(parsePayload(result as never)).toEqual({
      ok: true,
      result: { workspaceId: 'ws-b', slug: 'sheets', changed: true },
    });
    // The exact entry from members[0]'s registry is carried to the destination.
    expect(addHarnessToWorkspace).toHaveBeenCalledWith('ws-b', sheetsEntry);
  });

  it('M1 repro: when the re-read registry no longer carries the slug, does NOT write an undefined/corrupt entry', async () => {
    mockWorkspaces();
    const addHarnessToWorkspace = vi.fn(async (_ws: string, entry: unknown) => ({
      workspaceId: 'ws-b',
      // surface whatever entry was handed in so the assertion can inspect it
      slug: (entry as { slug?: string } | undefined)?.slug,
      changed: true,
    }));
    vi.doMock('../../../harness-membership', () => ({
      // workspacesForHarness still reports a member (the stale read) ...
      workspacesForHarness: vi.fn(async () => ['default']),
      addHarnessToWorkspace,
      moveHarness: vi.fn(),
      removeHarnessFromWorkspace: vi.fn(),
    }));
    vi.doMock('../../../harness-registry', () => ({
      // ... but the re-read of members[0] no longer has the slug (concurrent
      // move/remove between workspacesForHarness and this load).
      loadHarnessRegistry: vi.fn(async () => ({ projects: [{ slug: 'other', path: '/x' }] })),
    }));

    const { default: tool } = await import('../membership');
    const result = await tool.handler(
      { op: 'add', slug: 'sheets', toWorkspace: 'ws-b' },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);

    // The corrupt-write must NOT happen: addHarnessToWorkspace must never be
    // called with an undefined entry (which would push undefined into the
    // destination registry — a persistent data-corruption bug).
    for (const call of addHarnessToWorkspace.mock.calls) {
      expect(call[1]).not.toBeUndefined();
    }
    // And the result the operator sees must be a clean error, not ok:true with
    // a corrupt slug.
    expect(payload.error).toBeDefined();
    expect(payload.ok).not.toBe(true);
    expect(String(payload.error)).toMatch(/sheets/);
  });
});

describe('harness:membership op=remove', () => {
  it('errors when the workspace is unknown', async () => {
    mockWorkspaces(['default', 'ws-b']);
    const removeHarnessFromWorkspace = vi.fn();
    vi.doMock('../../../harness-membership', () => ({
      workspacesForHarness: vi.fn(),
      addHarnessToWorkspace: vi.fn(),
      moveHarness: vi.fn(),
      removeHarnessFromWorkspace,
    }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));

    const { default: tool } = await import('../membership');
    const result = await tool.handler(
      { op: 'remove', slug: 'sheets', workspace: 'nope' },
      MAKE_CTX(),
    );
    expect(parsePayload(result as never)).toEqual({ error: 'unknown workspace' });
    expect(removeHarnessFromWorkspace).not.toHaveBeenCalled();
  });

  it('unlinks the harness from a known workspace', async () => {
    mockWorkspaces(['default', 'ws-b']);
    const removeHarnessFromWorkspace = vi.fn(async () => ({
      workspaceId: 'ws-b',
      slug: 'sheets',
      changed: true,
    }));
    vi.doMock('../../../harness-membership', () => ({
      workspacesForHarness: vi.fn(),
      addHarnessToWorkspace: vi.fn(),
      moveHarness: vi.fn(),
      removeHarnessFromWorkspace,
    }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));

    const { default: tool } = await import('../membership');
    const result = await tool.handler(
      { op: 'remove', slug: 'sheets', workspace: 'ws-b' },
      MAKE_CTX(),
    );
    expect(parsePayload(result as never)).toEqual({
      ok: true,
      result: { workspaceId: 'ws-b', slug: 'sheets', changed: true },
    });
    expect(removeHarnessFromWorkspace).toHaveBeenCalledWith('ws-b', 'sheets');
  });
});

describe('harness:membership op=move', () => {
  it('errors when fromWorkspace is unknown', async () => {
    mockWorkspaces(['default', 'ws-b']);
    const moveHarness = vi.fn();
    vi.doMock('../../../harness-membership', () => ({
      workspacesForHarness: vi.fn(),
      addHarnessToWorkspace: vi.fn(),
      moveHarness,
      removeHarnessFromWorkspace: vi.fn(),
    }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));

    const { default: tool } = await import('../membership');
    const result = await tool.handler(
      { op: 'move', slug: 'sheets', fromWorkspace: 'nope', toWorkspace: 'ws-b' },
      MAKE_CTX(),
    );
    expect(parsePayload(result as never)).toEqual({ error: 'unknown fromWorkspace' });
    expect(moveHarness).not.toHaveBeenCalled();
  });

  it('errors when toWorkspace is unknown', async () => {
    mockWorkspaces(['default', 'ws-b']);
    const moveHarness = vi.fn();
    vi.doMock('../../../harness-membership', () => ({
      workspacesForHarness: vi.fn(),
      addHarnessToWorkspace: vi.fn(),
      moveHarness,
      removeHarnessFromWorkspace: vi.fn(),
    }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));

    const { default: tool } = await import('../membership');
    const result = await tool.handler(
      { op: 'move', slug: 'sheets', fromWorkspace: 'default', toWorkspace: 'nope' },
      MAKE_CTX(),
    );
    expect(parsePayload(result as never)).toEqual({ error: 'unknown toWorkspace' });
    expect(moveHarness).not.toHaveBeenCalled();
  });

  it('moves the harness and returns moveHarness result on success', async () => {
    mockWorkspaces(['default', 'ws-b']);
    const moveHarness = vi.fn(async () => ({
      from: { workspaceId: 'default', slug: 'sheets', changed: true },
      to: { workspaceId: 'ws-b', slug: 'sheets', changed: true },
    }));
    vi.doMock('../../../harness-membership', () => ({
      workspacesForHarness: vi.fn(),
      addHarnessToWorkspace: vi.fn(),
      moveHarness,
      removeHarnessFromWorkspace: vi.fn(),
    }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));

    const { default: tool } = await import('../membership');
    const result = await tool.handler(
      { op: 'move', slug: 'sheets', fromWorkspace: 'default', toWorkspace: 'ws-b' },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(payload.ok).toBe(true);
    expect(moveHarness).toHaveBeenCalledWith('sheets', 'default', 'ws-b');
  });

  it("rethrows moveHarness's error as { error } (no throw out of handler)", async () => {
    mockWorkspaces(['default', 'ws-b']);
    const moveHarness = vi.fn(async () => {
      throw new Error("moveHarness: harness 'sheets' is not registered in workspace 'default'");
    });
    vi.doMock('../../../harness-membership', () => ({
      workspacesForHarness: vi.fn(),
      addHarnessToWorkspace: vi.fn(),
      moveHarness,
      removeHarnessFromWorkspace: vi.fn(),
    }));
    vi.doMock('../../../harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));

    const { default: tool } = await import('../membership');
    const result = await tool.handler(
      { op: 'move', slug: 'sheets', fromWorkspace: 'default', toWorkspace: 'ws-b' },
      MAKE_CTX(),
    );
    const payload = parsePayload(result as never);
    expect(String(payload.error)).toMatch(/not registered in workspace/);
  });
});
