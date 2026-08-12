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
import type { SpawnConsoleResult } from '../../console-spawn';

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

// Stub the spawner — capture what scheme it was called with. Typed against the
// REAL SpawnConsoleResult (type-only import — not mocked away) so the mock cannot
// drift from the spawn contract (WI-4488: the EI-8289 display/desktopEnvResolvedVia
// fields were added to the contract and inferred-shape mocks went stale).
const spawnMock = vi.fn(
  (_opts: unknown): SpawnConsoleResult => ({
    status: 'ok',
    pid: 1234,
    terminal: 'xterm',
    child: {} as any,
    display: null,
    desktopEnvResolvedVia: null,
  }),
);
vi.mock('../../console-spawn', () => ({ spawnConsole: spawnMock }));

// Stub agent-fleets-store — control scheme lookup results.
const getFleetSchemeMock = vi.fn(async (_ws: string, slug: string) =>
  slug === 'alpha-fleet'
    ? { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' }
    : null,
);
vi.mock('../../agent-fleets-store', () => ({
  fleetSlugFromName: (name: string) => name.toLowerCase().replace(/\s+/g, '-'),
  getFleetScheme: (ws: string, slug: string) => getFleetSchemeMock(ws, slug),
}));

// Stub presence-fleet — caller's fleet_slug.
const fetchPresenceFleetMock = vi.fn(async (_ids: string[]) => new Map<string, { fleetSlug: string | null; fleetRole: string | null }>());
vi.mock('../coordination/presence-fleet', () => ({
  fetchPresenceFleet: (ids: string[]) => fetchPresenceFleetMock(ids),
}));

// Stub identity — stable ownerId.
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'owner-bee-1', ownerLabel: 'cup', source: 'fleet-spawn', workspaceId: 'ws-test', userId: null }),
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
  spawnMock.mockReturnValue({
    status: 'ok',
    pid: 1234,
    terminal: 'xterm',
    child: {} as any,
    display: null,
    desktopEnvResolvedVia: null,
  });
  fetchPresenceFleetMock.mockResolvedValue(new Map());
  getFleetSchemeMock.mockImplementation(async (_ws: string, slug: string) =>
    slug === 'alpha-fleet'
      ? { name: 'royal-purple', bg: '#581c87', fg: '#f5e8ff', cursor: '#d8b4fe' }
      : null,
  );
});

describe('launch-tool routing guidance', () => {
  it('keeps capability:terminal scoped to arbitrary commands, never agent launch', () => {
    expect(terminalTool.guidance?.when).toContain('ARBITRARY-COMMAND WINDOW ONLY');
    expect(terminalTool.guidance?.notWhen).toContain('Do NOT use this to launch agents');
    expect(terminalTool.guidance?.notWhen).toContain('capability:launch-agent');
    expect(terminalTool.guidance?.notWhen).toContain('fleet:launch-on-plan');
    expect(terminalTool.description).not.toContain('desktop fleet of agents');
  });

  // WI-4753: the canonical routing doc must stay linked from every door's
  // guidance, not just fleet:launch-on-plan's — a recurrence guard so the
  // cross-link can't silently drop on a future guidance edit.
  it('cross-links the canonical four-door routing table', () => {
    expect(terminalTool.guidance?.notWhen).toContain(
      'launching-agents-which-tool-for-which-door',
    );
  });
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
      expect((call as unknown[])[0]).toMatchObject({ scheme: expect.objectContaining({ name: 'royal-purple' }) });
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

// ── WI-4234: a bare non-agent `psu` command by a fleet caller ────────────────
// auto-joins the CALLER's own fleet, not just its color — previously only an
// explicit `fleet` arg reached injectFleetArg. Actual agent launches are
// intentionally rejected by capability:terminal's wrong-door guard; these
// cases use `psu --version` to exercise fleet injection without bypassing that
// guard.
describe('capability:terminal WI-4234: inferred fleet auto-joins a bare psu command', () => {
  it('no explicit `fleet` arg, caller has a presence fleet → --fleet is injected into a psu command', async () => {
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['owner-bee-1', { fleetSlug: 'alpha-fleet', fleetRole: 'leader' }]]),
    );

    await terminalTool.handler({ command: 'psu --version' }, baseCtx);

    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          greetingCmd:
            'psu --launched-by=owner-bee-1 --fleet=alpha-fleet --version',
        }),
      }),
    );
  });

  it('no explicit `fleet` arg, no presence fleet → psu command is left untouched (no membership to infer)', async () => {
    fetchPresenceFleetMock.mockResolvedValue(new Map());

    await terminalTool.handler({ command: 'psu --version' }, baseCtx);

    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          greetingCmd: 'psu --launched-by=owner-bee-1 --version',
        }),
      }),
    );
  });

  it('an explicit `fleet` arg still wins over the caller\'s own presence fleet for injection', async () => {
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['owner-bee-1', { fleetSlug: 'my-own-fleet', fleetRole: 'member' }]]),
    );

    await terminalTool.handler({ command: 'psu --version', fleet: 'Alpha Fleet' }, baseCtx);

    expect(fetchPresenceFleetMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          greetingCmd: 'psu --launched-by=owner-bee-1 --fleet=alpha-fleet --version',
        }),
      }),
    );
  });

  it('rejects an actual psu agent launch through the wrong door', async () => {
    const result: any = await terminalTool.handler(
      { command: 'psu --no-picker --agent=claude --harness=papercusp' },
      baseCtx,
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('Wrong door: that is an agent launch');
  });

  it('a non-psu command is left untouched even when the caller has a presence fleet', async () => {
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['owner-bee-1', { fleetSlug: 'alpha-fleet', fleetRole: 'member' }]]),
    );

    await terminalTool.handler({ command: 'npm run dev' }, baseCtx);

    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ envelope: expect.objectContaining({ greetingCmd: 'npm run dev' }) }),
    );
  });

  it('output text discloses the auto-injected --fleet for an inferred (non-explicit) fleet too', async () => {
    fetchPresenceFleetMock.mockResolvedValue(
      new Map([['owner-bee-1', { fleetSlug: 'alpha-fleet', fleetRole: 'leader' }]]),
    );

    const result: any = await terminalTool.handler({ command: 'psu --version' }, baseCtx);
    const text = result.content[0].text as string;
    expect(text).toContain('auto-added `--fleet=alpha-fleet`');
  });
});

// ── EI-5835: explicit `fleet` arg auto-injects psu --fleet (membership) ─────────
describe('injectFleetArg (EI-5835: --fleet auto-join for psu launches)', () => {
  it('injects --fleet into a psu launch when an explicit fleet slug is given', async () => {
    const { injectFleetArg } = await import('../../agent-launch-core');
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
    const { injectFleetArg } = await import('../../agent-launch-core');
    const r = injectFleetArg('psu --no-picker --plan=p', null);
    expect(r.injected).toBe(false);
    expect(r.command).toBe('psu --no-picker --plan=p');
  });

  it('does not double-inject when --fleet is already present', async () => {
    const { injectFleetArg } = await import('../../agent-launch-core');
    const cmd = 'psu --fleet=already --no-picker --plan=p';
    const r = injectFleetArg(cmd, 'other');
    expect(r.injected).toBe(false);
    expect(r.command).toBe(cmd);
  });

  it('leaves a non-psu command untouched', async () => {
    const { injectFleetArg } = await import('../../agent-launch-core');
    const r = injectFleetArg('npm run dev', 'bet-pattern');
    expect(r.injected).toBe(false);
    expect(r.command).toBe('npm run dev');
  });

  it('injects after psu even with a leading `cd … &&` (shell-separator boundary)', async () => {
    const { injectFleetArg } = await import('../../agent-launch-core');
    const r = injectFleetArg('cd /repo && psu --no-picker --plan=p', 'f1');
    expect(r.injected).toBe(true);
    expect(r.command).toBe('cd /repo && psu --fleet=f1 --no-picker --plan=p');
  });

  it('does not match psu as a substring of another token (mypsu)', async () => {
    const { injectFleetArg } = await import('../../agent-launch-core');
    const r = injectFleetArg('mypsu --plan=p', 'f1');
    expect(r.injected).toBe(false);
    expect(r.command).toBe('mypsu --plan=p');
  });
});

describe('injectLaunchedByArg (solo-launch-provenance: --launched-by auto-inject for psu launches)', () => {
  const OWNER = 'su-94b69875-7d7f-4fcc-9441-0015677b93ed';

  it('injects --launched-by into a psu launch', async () => {
    const { injectLaunchedByArg } = await import('../../agent-launch-core');
    const r = injectLaunchedByArg('psu --no-picker --agent=claude --launch-context=/b.md', OWNER);
    expect(r.injected).toBe(true);
    expect(r.command).toBe(`psu --launched-by=${OWNER} --no-picker --agent=claude --launch-context=/b.md`);
  });

  it('is a no-op when the caller identity is unresolved', async () => {
    const { injectLaunchedByArg } = await import('../../agent-launch-core');
    const r = injectLaunchedByArg('psu --no-picker --plan=p', null);
    expect(r.injected).toBe(false);
    expect(r.command).toBe('psu --no-picker --plan=p');
  });

  it('does not double-inject when --launched-by is already present', async () => {
    const { injectLaunchedByArg } = await import('../../agent-launch-core');
    const cmd = 'psu --launched-by=su-other --no-picker';
    const r = injectLaunchedByArg(cmd, OWNER);
    expect(r.injected).toBe(false);
    expect(r.command).toBe(cmd);
  });

  it('leaves a non-psu command untouched', async () => {
    const { injectLaunchedByArg } = await import('../../agent-launch-core');
    const r = injectLaunchedByArg('npm run dev', OWNER);
    expect(r.injected).toBe(false);
  });

  it('refuses a non-identity-shaped value (shell-injection guard)', async () => {
    const { injectLaunchedByArg } = await import('../../agent-launch-core');
    const r = injectLaunchedByArg('psu --no-picker', 'su-x; rm -rf /');
    expect(r.injected).toBe(false);
    expect(r.command).toBe('psu --no-picker');
  });

  it('composes with injectFleetArg (both flags land, fleet first)', async () => {
    const { injectFleetArg, injectLaunchedByArg } = await import('../../agent-launch-core');
    const fleet = injectFleetArg('cd /repo && psu --no-picker --plan=p', 'f1');
    const prov = injectLaunchedByArg(fleet.command, OWNER);
    expect(prov.injected).toBe(true);
    expect(prov.command).toBe(`cd /repo && psu --launched-by=${OWNER} --fleet=f1 --no-picker --plan=p`);
  });
});

describe('capability:terminal EI-8289 display disclosure', () => {
  it('reports the resolved DISPLAY inline for each opened terminal', async () => {
    spawnMock.mockReturnValue({
      status: 'ok',
      pid: 1234,
      terminal: 'xterm',
      child: {} as any,
      display: ':1',
      desktopEnvResolvedVia: 'active-seat',
    });
    const res = await terminalTool.handler({ command: 'echo hi' }, baseCtx);
    const text = (res as any).content[0].text as string;
    expect(text).toContain('[DISPLAY=:1]');
    expect(text).not.toMatch(/⚠.*socket scan/);
  });

  it('warns loudly when the display was resolved via a raw socket scan (possible virtual/sandbox placement)', async () => {
    spawnMock.mockReturnValue({
      status: 'ok',
      pid: 1234,
      terminal: 'xterm',
      child: {} as any,
      display: ':93',
      desktopEnvResolvedVia: 'socket-scan',
    });
    const res = await terminalTool.handler({ command: 'echo hi' }, baseCtx);
    const text = (res as any).content[0].text as string;
    expect(text).toContain('[DISPLAY=:93]');
    expect(text).toMatch(/⚠ no active login seat was detected.*socket scan.*EI-8289/);
  });
});

// ── WI-4272: `display` arg — demo-stage override threading + disclosure ────────
describe('capability:terminal WI-4272 display (demo-stage) override', () => {
  it('threads `display` to spawnConsole as displayOverride for every terminal in the call', async () => {
    await terminalTool.handler(
      { terminals: [{ command: 'echo 1' }, { command: 'echo 2' }], display: ':110' },
      baseCtx,
    );
    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const call of spawnMock.mock.calls) {
      expect((call as unknown[])[0]).toMatchObject({ displayOverride: ':110' });
    }
  });

  it('omitted `display` ⇒ displayOverride is undefined (default seat path untouched)', async () => {
    await terminalTool.handler({ command: 'echo hi' }, baseCtx);
    expect(spawnMock).toHaveBeenCalledWith(expect.objectContaining({ displayOverride: undefined }));
  });

  it('a caller-override result gets the demo-stage disclosure line, NOT the EI-8289 socket-scan warning', async () => {
    spawnMock.mockReturnValue({
      status: 'ok',
      pid: 1234,
      terminal: 'xterm',
      child: {} as any,
      display: ':110',
      desktopEnvResolvedVia: 'caller-override',
    });
    const res = await terminalTool.handler({ command: 'echo hi', display: ':110' }, baseCtx);
    const text = (res as any).content[0].text as string;
    expect(text).toContain('[DISPLAY=:110]');
    expect(text).toMatch(/demo-stage override.*WI-4272/);
    expect(text).not.toMatch(/⚠ no active login seat/);
  });

  it('a dead-display loud-fail from spawnConsole surfaces as the terminal failure, not a silent ok', async () => {
    spawnMock.mockReturnValue({
      status: 'error',
      error: 'displayOverride :777: no X socket at /tmp/.X11-unix/X777 — the display is not alive. (WI-4272)',
      code: 412,
    });
    const res: any = await terminalTool.handler({ command: 'echo hi', display: ':777' }, baseCtx);
    const text = res.content[0].text as string;
    expect(text).toMatch(/no X socket/);
    expect(text).toMatch(/WI-4272/);
  });
});

// ── EI-11543: capability:terminal must reliably RUN the command ────────────────
// A visible client-server terminal (gnome-terminal → gnome-terminal-server via the
// D-Bus factory) opened a window on the owner's seat but silently did NOT run the
// arbitrary command — the factory dropped the `-- CMD` handoff (the same server-side
// client-server fragility EI-11578 hit for resumed psu sessions). Process-per-window
// emulators (xterm/alacritty/…) bind DISPLAY and exec the command directly, so
// capability:terminal forces that ordering via spawnConsole's `preferProcessPerWindow`
// — exactly the reliability knob capability:launch-agent's resume/fork path uses.
// If this regresses (the flag stops being passed), an arbitrary command can once
// again land in a window that never runs it.
describe('capability:terminal EI-11543: forces the reliable process-per-window terminal', () => {
  it('single command → spawnConsole is called with preferProcessPerWindow: true', async () => {
    await terminalTool.handler({ command: 'echo capterm-alive > /tmp/x' }, baseCtx);
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ preferProcessPerWindow: true }),
    );
  });

  it('every terminal in a bulk call gets preferProcessPerWindow: true', async () => {
    await terminalTool.handler(
      { terminals: [{ command: 'npm run dev' }, { command: 'tail -f log' }] },
      baseCtx,
    );
    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const call of spawnMock.mock.calls) {
      expect((call as unknown[])[0]).toMatchObject({ preferProcessPerWindow: true });
    }
  });

  it('still forces process-per-window even on a demo-stage `display` override', async () => {
    await terminalTool.handler({ command: 'echo hi', display: ':110' }, baseCtx);
    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({ preferProcessPerWindow: true, displayOverride: ':110' }),
    );
  });
});
