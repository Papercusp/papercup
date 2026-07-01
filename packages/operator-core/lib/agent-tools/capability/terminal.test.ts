/**
 * terminal.test.ts — capability:terminal color-scheme resolution
 * (fleet-color-schemes-2026-06-30 P-003).
 *
 * Pins the scheme-resolution logic:
 *   1. Explicit `fleet` arg → resolves scheme via getFleetScheme(workspaceId, slug).
 *   2. No fleet arg, caller has a presence fleet_slug → resolves from presence.
 *   3. No fleet arg, caller has NO presence fleet → scheme stays null (plan-hash fallback).
 *   4. Scheme is threaded into spawnConsole so the terminal's window inherits the colors.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/capability/terminal.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── mocks (all vi.mock calls must be at module scope, before imports) ──────────

// Spread importOriginal on db-org to keep generated.* intact (avoids agent-mcp
// bootstrap crash — see TESTING.md §Mocking `@papercusp/db-org`).
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getOrgPg: () => ({ sql: {} }) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));

// Stub the console launcher — we only care about the scheme, not the real envelope.
vi.mock('../../console-launcher', () => ({
  buildConsoleEnvelope: vi.fn(async () => ({
    cwd: '/tmp/test',
    env: {},
    greetingCmd: '',
    mcpJsonContents: '',
  })),
}));

// Stub the spawner — capture what scheme it was called with.
const spawnMock = vi.fn(() => ({ status: 'ok' as const, pid: 1234, terminal: 'xterm', child: {} as any }));
vi.mock('../../console-spawn', () => ({ spawnConsole: spawnMock }));

// Stub agent-fleets-store — control scheme lookup results.
const getFleetSchemeMock = vi.fn(async (_ws: string, slug: string) =>
  slug === 'alpha-fleet'
    ? { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' }
    : null,
);
vi.mock('../../agent-fleets-store', () => ({
  fleetSlugFromName: (name: string) => name.toLowerCase().replace(/\s+/g, '-'),
  getFleetScheme: (...args: any[]) => getFleetSchemeMock(...args),
}));

// Stub presence-fleet — caller's fleet_slug.
const fetchPresenceFleetMock = vi.fn(async (_ids: string[]) => new Map<string, { fleetSlug: string | null; fleetRole: string | null }>());
vi.mock('../coordination/presence-fleet', () => ({
  fetchPresenceFleet: (...args: any[]) => fetchPresenceFleetMock(...args),
}));

// Stub identity — stable ownerId.
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'owner-bee-1', ownerLabel: 'bee', source: 'fleet-spawn', workspaceId: 'ws-test', userId: null }),
}));

// ── Import the tool AFTER all mocks are set up ────────────────────────────────
const terminalTool = (await import('./terminal')).default;

// Minimal ctx that satisfies the handler's needs.
const baseCtx = {
  workspaceId: 'ws-test',
  harnessSlug: 'papercusp',
  log: () => {},
  signal: AbortSignal.timeout(5000),
  progress: () => {},
  emit: () => {},
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  spawnMock.mockReturnValue({ status: 'ok', pid: 1234, terminal: 'xterm', child: {} as any });
  fetchPresenceFleetMock.mockResolvedValue(new Map());
  getFleetSchemeMock.mockImplementation(async (_ws: string, slug: string) =>
    slug === 'alpha-fleet'
      ? { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' }
      : null,
  );
});

describe('capability:terminal scheme resolution', () => {
  it('explicit `fleet` arg resolves scheme by fleet name and passes it to spawnConsole', async () => {
    await terminalTool.handler({ command: 'echo hi', fleet: 'Alpha Fleet' }, baseCtx);
    expect(getFleetSchemeMock).toHaveBeenCalledWith('ws-test', 'alpha-fleet');
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: expect.objectContaining({ name: 'royal-purple' }) }),
    );
    expect(fetchPresenceFleetMock).not.toHaveBeenCalled(); // explicit fleet skips presence lookup
  });

  it('no `fleet` arg but caller has a presence fleet_slug → resolves from presence', async () => {
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['owner-bee-1', { fleetSlug: 'alpha-fleet', fleetRole: 'member' }]]),
    );
    getFleetSchemeMock.mockImplementation(async (_ws: string, slug: string) =>
      slug === 'alpha-fleet'
        ? { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' }
        : null,
    );

    await terminalTool.handler({ command: 'echo hi' }, baseCtx);

    expect(fetchPresenceFleetMock).toHaveBeenCalledWith(['owner-bee-1']);
    expect(getFleetSchemeMock).toHaveBeenCalledWith('ws-test', 'alpha-fleet');
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: expect.objectContaining({ name: 'royal-purple' }) }),
    );
  });

  it('no `fleet` arg and caller has NO presence fleet → scheme is null (plan-hash fallback)', async () => {
    fetchPresenceFleetMock.mockResolvedValue(new Map()); // no fleet_slug for this owner

    await terminalTool.handler({ command: 'echo hi' }, baseCtx);

    expect(fetchPresenceFleetMock).toHaveBeenCalledWith(['owner-bee-1']);
    expect(getFleetSchemeMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(expect.objectContaining({ scheme: null }));
  });

  it('presence fleet lookup failure is swallowed — launch still succeeds with null scheme', async () => {
    fetchPresenceFleetMock.mockRejectedValue(new Error('PG timeout'));

    const result = await terminalTool.handler({ command: 'echo hi' }, baseCtx);

    // Terminal should still open (error absorbed, scheme falls back to null → plan-hash).
    expect(spawnMock).toHaveBeenCalledWith(expect.objectContaining({ scheme: null }));
    expect((result as any).isError).not.toBe(true);
  });

  it('explicit fleet lookup failure is swallowed — launch still succeeds with null scheme', async () => {
    getFleetSchemeMock.mockRejectedValue(new Error('PG timeout'));

    const result = await terminalTool.handler({ command: 'echo hi', fleet: 'alpha-fleet' }, baseCtx);

    expect(spawnMock).toHaveBeenCalledWith(expect.objectContaining({ scheme: null }));
    expect((result as any).isError).not.toBe(true);
  });

  it('bulk terminals all receive the same resolved scheme', async () => {
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['owner-bee-1', { fleetSlug: 'alpha-fleet', fleetRole: 'leader' }]]),
    );

    await terminalTool.handler(
      { terminals: [{ command: 'echo 1' }, { command: 'echo 2' }, { command: 'echo 3' }] },
      baseCtx,
    );

    expect(spawnMock).toHaveBeenCalledTimes(3);
    for (const call of spawnMock.mock.calls) {
      expect(call[0]).toMatchObject({ scheme: expect.objectContaining({ name: 'royal-purple' }) });
    }
  });

  it('output text mentions the scheme name when a fleet is resolved (explicit)', async () => {
    const result: any = await terminalTool.handler({ command: 'echo hi', fleet: 'Alpha Fleet' }, baseCtx);
    const text = result.content[0].text;
    expect(text).toContain('royal-purple');
    expect(text).not.toContain('presence fleet');
  });

  it('output text mentions "presence fleet" when the scheme comes from presence fallback', async () => {
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['owner-bee-1', { fleetSlug: 'alpha-fleet', fleetRole: 'member' }]]),
    );

    const result: any = await terminalTool.handler({ command: 'echo hi' }, baseCtx);
    const text = result.content[0].text;
    expect(text).toContain('presence fleet');
    expect(text).toContain('royal-purple');
  });
});

// ── EI-5835: explicit `fleet` arg auto-injects psu --fleet (membership) ─────────
describe('injectFleetArg (EI-5835: --fleet auto-join for psu launches)', () => {
  it('injects --fleet into a psu launch when an explicit fleet slug is given', async () => {
    const { injectFleetArg } = await import('./terminal');
    const r = injectFleetArg(
      'psu --no-picker --agent=claude --harness=oddsmith --plan=p --launch-context=/b.md',
      'bet-pattern',
    );
    expect(r.injected).toBe(true);
    expect(r.command).toBe(
      'psu --fleet=bet-pattern --no-picker --agent=claude --harness=oddsmith --plan=p --launch-context=/b.md',
    );
  });

  it('is a no-op when no fleet slug is given', async () => {
    const { injectFleetArg } = await import('./terminal');
    const r = injectFleetArg('psu --no-picker --plan=p', null);
    expect(r.injected).toBe(false);
    expect(r.command).toBe('psu --no-picker --plan=p');
  });

  it('does not double-inject when --fleet is already present', async () => {
    const { injectFleetArg } = await import('./terminal');
    const cmd = 'psu --fleet=already --no-picker --plan=p';
    const r = injectFleetArg(cmd, 'other');
    expect(r.injected).toBe(false);
    expect(r.command).toBe(cmd);
  });

  it('leaves a non-psu command untouched', async () => {
    const { injectFleetArg } = await import('./terminal');
    const r = injectFleetArg('npm run dev', 'bet-pattern');
    expect(r.injected).toBe(false);
    expect(r.command).toBe('npm run dev');
  });

  it('injects after psu even with a leading `cd … &&` (shell-separator boundary)', async () => {
    const { injectFleetArg } = await import('./terminal');
    const r = injectFleetArg('cd /repo && psu --no-picker --plan=p', 'f1');
    expect(r.injected).toBe(true);
    expect(r.command).toBe('cd /repo && psu --fleet=f1 --no-picker --plan=p');
  });

  it('does not match psu as a substring of another token (mypsu)', async () => {
    const { injectFleetArg } = await import('./terminal');
    const r = injectFleetArg('mypsu --plan=p', 'f1');
    expect(r.injected).toBe(false);
    expect(r.command).toBe('mypsu --plan=p');
  });
});
