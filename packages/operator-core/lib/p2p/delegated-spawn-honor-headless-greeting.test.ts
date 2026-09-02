/**
 * delegated-spawn-honor-headless-greeting.test.ts — WI-2142501.
 *
 * ONE invariant: when the WI-5211 headless FALLBACK fires (spawnConsole failed
 * because the honoring host has no display), the greeting handed to spawnHeadless
 * MUST carry psu's `--headless`.
 *
 * Why this is load-bearing rather than cosmetic: `--headless` is what makes
 * psu-launcher take the managed-pty host despite non-TTY stdio. spawnHeadless
 * states the precondition in its own options doc — "greetingCmd MUST be a
 * `psu --headless …` command for the session to stay injectable". Reusing the
 * CONSOLE greeting there produces a member with no managed pty: the kickoff turn
 * can never be injected, the CLI falls through to `--print` with no prompt, and it
 * exits 1 — after the delegated seat has already been consumed. Measured live
 * 2026-09-02 on the physical tower<->VM rig: 2 of 3 delegated spawns died exactly
 * that way, and the third survived only because spawnConsole succeeded so this
 * fallback never ran. That intermittency is why no existing test caught it.
 *
 * Lives in its own file because the mocks below are module-wide and the sibling
 * delegated-spawn-honor.test.ts deliberately runs pure-DI against the real modules.
 *
 * Run: cd packages/operator-core && npx vitest run lib/p2p/delegated-spawn-honor-headless-greeting.test.ts
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Greetings captured from each spawn backend, per test. */
const captured: { console: string[]; headless: string[] } = { console: [], headless: [] };

// Partial mocks throughout (importOriginal): these modules have many other exports
// that unrelated importers in the graph still need — a total mock breaks collection.
vi.mock('../console-spawn', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The honoring host is headless: the window backend hard-fails, exactly as it
  // does on a rig VM sitting at the loginwindow. This is what arms the fallback.
  spawnConsole: vi.fn(async (opts: { envelope: { greetingCmd: string } }) => {
    captured.console.push(opts.envelope.greetingCmd);
    return { status: 'error' as const, error: 'no X display', terminal: null, pid: null };
  }),
  spawnHeadless: vi.fn(async (opts: { envelope: { greetingCmd: string } }) => {
    captured.headless.push(opts.envelope.greetingCmd);
    return { status: 'ok' as const, error: null, terminal: 'headless', pid: 4242 };
  }),
}));

vi.mock('../console-launcher', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildConsoleEnvelope: vi.fn(async () => ({ cwd: tmpdir(), env: {}, greetingCmd: '' })),
}));

vi.mock('../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createFleetIfAbsent: vi.fn(async () => undefined),
}));

vi.mock('../papercusp-root', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  papercuspPathForWorkspace: vi.fn(() => join(tmpdir(), 'wi-2142501-guard')),
}));

import { defaultSpawnMembers, type SpawnMembersRequest } from './delegated-spawn-honor';

function request(overrides: Partial<SpawnMembersRequest> = {}): SpawnMembersRequest {
  return {
    workspaceId: 'papercusp-workspace',
    potHomeSlug: 'papercusp',
    fleetSlug: 'wi-2142501-guard-fleet',
    planSlug: 'p2p-public-release-endgame-2026-09-01',
    count: 1,
    seatRef: 'sonnet-5:high:default',
    launch: { model: 'sonnet-5', account: 'default' },
    launchContext: null,
    requesterOwnerId: 'su-0300ecfc-09e0-4874-9346-3587ab4a617a',
    requestOfferId: 'spawnreq-wi2142501guard',
    ...overrides,
  };
}

describe('WI-2142501 — the headless fallback greeting must keep the member injectable', () => {
  beforeEach(() => {
    captured.console = [];
    captured.headless = [];
  });

  it('hands spawnHeadless a `--headless` greeting when the console backend fails', async () => {
    const result = await defaultSpawnMembers(request());

    // CALIBRATION FIRST. Without this the `not.toContain` control below passes
    // vacuously on an empty string, and a guard that passes when it measured
    // nothing is the exact false-green this file exists to prevent.
    expect(captured.headless).toHaveLength(1);
    expect(captured.headless[0]).toContain('psu');
    expect(captured.headless[0]).toContain('--fleet=wi-2142501-guard-fleet');

    // THE INVARIANT.
    expect(captured.headless[0]).toContain('--headless');

    // The fallback is what produced the opened member, not the console backend.
    expect(result.opened).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('keeps the CONSOLE greeting free of --headless (permanent falsifiability control)', async () => {
    await defaultSpawnMembers(request());

    // Same calibration discipline: prove we captured a real command first.
    expect(captured.console).toHaveLength(1);
    expect(captured.console[0]).toContain('--fleet=wi-2142501-guard-fleet');

    // A windowed console launch has a real TTY and must NOT be sent --headless.
    expect(captured.console[0]).not.toContain('--headless');

    // Together with the test above this is the control: the two greetings are
    // genuinely DIFFERENT strings. If someone reverts the fix so the fallback
    // reuses the console command, the two expectations become unsatisfiable at
    // once and the first test fails loudly instead of drifting back to silence.
    expect(captured.headless[0]).not.toBe(captured.console[0]);
  });

  it('sends --headless for every member of a multi-member delegated request', async () => {
    await defaultSpawnMembers(request({ count: 3 }));

    expect(captured.headless).toHaveLength(3);
    for (const greeting of captured.headless) {
      expect(greeting).toContain('--headless');
    }
  });
});
