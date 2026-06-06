/**
 * Step A (Tier-1 follow-up arc): mem0 dual-scope memory injection in
 * composeOraclePrompt.
 *
 * Verifies the memory block lands when buildMemoryContextBlock returns
 * a non-null string, AND that graceful degradation works (empty hits,
 * client throw → unchanged prompt).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The first test in this file pays the cold-ESM-import cost of
// oracle/prompts.ts's dependency graph (agent-mcp, memory/injection,
// system-principal, agents-list). vi.resetModules() in beforeEach means
// every test re-imports fresh, so that cost recurs per-test and can
// exceed the 5s vitest default. Bump the ceiling. See the 2026-05-20
// SSE-migration audit (flaky-timeout finding).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../memory/injection');
  vi.doUnmock('../../operator-state-pg');
  vi.doUnmock('../../workspace-registry');
  vi.doUnmock('../../system-principal');
  vi.doUnmock('../../agents-list');
});

function mockBaseDeps() {
  vi.doMock('../../operator-state-pg', () => ({
    readOperatorState: vi.fn(async (key: string) => {
      if (key === 'operator_oracle_prompt') return { content: 'You are the Oracle.' };
      if (key === 'operator_oracle_memory') return { content: '' };
      return null;
    }),
    writeOperatorState: vi.fn(),
  }));
  vi.doMock('../../workspace-registry', () => ({
    activeWorkspaceId: () => 'default',
  }));
  vi.doMock('../../system-principal', () => ({
    readSystemPrincipal: vi.fn(async () => null),
  }));
  vi.doMock('../../agents-list', () => ({
    listAgentsAcrossWorkspace: vi.fn(async () => []),
  }));
}

describe('composeOraclePrompt — memory injection', () => {
  it('includes the memory heading + body when buildMemoryContextBlock returns a block', async () => {
    mockBaseDeps();
    vi.doMock('../../memory/injection', () => ({
      buildMemoryContextBlock: vi.fn(async () =>
        '## Oracle memory (relevant entries)\n\n- [preference] User prefers dark mode\n- [preference [shared]] Operator favors terse replies',
      ),
    }));
    const { composeOraclePrompt } = await import('./prompts');
    const { promptText } = await composeOraclePrompt(
      [{ role: 'user', content: 'switch to light mode?' }],
      { currentPath: '/', tutorialMode: false, userId: 'user-abc' },
    );
    expect(promptText).toContain('## Oracle memory (relevant entries)');
    expect(promptText).toContain('User prefers dark mode');
    expect(promptText).toContain('Operator favors terse replies');
  });

  it('omits the memory section when buildMemoryContextBlock returns null', async () => {
    mockBaseDeps();
    vi.doMock('../../memory/injection', () => ({
      buildMemoryContextBlock: vi.fn(async () => null),
    }));
    const { composeOraclePrompt } = await import('./prompts');
    const { promptText } = await composeOraclePrompt(
      [{ role: 'user', content: 'hi' }],
      { currentPath: '/', tutorialMode: false, userId: 'user-abc' },
    );
    expect(promptText).not.toContain('Oracle memory (relevant entries)');
    // Verify no orphan separators are emitted — the prompt should not have
    // back-to-back '---' separators where the memory block would have been.
    expect(promptText).not.toMatch(/---\s*\n\s*\n---/);
  });

  it('degrades silently when buildMemoryContextBlock throws', async () => {
    mockBaseDeps();
    vi.doMock('../../memory/injection', () => ({
      buildMemoryContextBlock: vi.fn(async () => {
        throw new Error('mem0 connection refused');
      }),
    }));
    const { composeOraclePrompt } = await import('./prompts');
    // Must not throw — the .catch(() => null) wrapper absorbs the error.
    const { promptText } = await composeOraclePrompt(
      [{ role: 'user', content: 'hi' }],
      { currentPath: '/', tutorialMode: false, userId: 'user-abc' },
    );
    expect(promptText).not.toContain('Oracle memory');
  });

  it('passes the userId through to buildMemoryContextBlock', async () => {
    mockBaseDeps();
    const buildSpy = vi.fn(async () => null);
    vi.doMock('../../memory/injection', () => ({
      buildMemoryContextBlock: buildSpy,
    }));
    const { composeOraclePrompt } = await import('./prompts');
    await composeOraclePrompt(
      [{ role: 'user', content: 'q' }],
      { currentPath: '/', tutorialMode: false, userId: 'user-xyz' },
    );
    expect(buildSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-xyz',
        workspaceId: 'default',
        queryContext: 'q',
        heading: 'Oracle memory (relevant entries)',
      }),
    );
  });

  it('passes userId=null when caller omits userId (workspace-shared only)', async () => {
    mockBaseDeps();
    const buildSpy = vi.fn(async () => null);
    vi.doMock('../../memory/injection', () => ({
      buildMemoryContextBlock: buildSpy,
    }));
    const { composeOraclePrompt } = await import('./prompts');
    await composeOraclePrompt(
      [{ role: 'user', content: 'q' }],
      { currentPath: '/', tutorialMode: false },
    );
    expect(buildSpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null }),
    );
  });
});
