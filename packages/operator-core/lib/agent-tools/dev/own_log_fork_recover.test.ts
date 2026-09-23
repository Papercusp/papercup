/**
 * dev:own_log_fork_recover — EI-21150671414510762.
 *
 * The decision logic is covered by own-log-fork-recovery-run.test.ts. This file
 * pins the TOOL's wiring: dry run by default, the production seams it binds
 * (close → rename-aside → rebootHarness, the substrate-owner predicate, the
 * kill-switch flag), and workspace resolution from the call context.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../sync/hyperbee/boot-all', () => ({
  closeBootedHarness: vi.fn(async () => true),
  rebootHarness: vi.fn(async () => ({ closed: false, boot: { status: 'booted' } })),
  workspaceRootForId: vi.fn((ws: string) => `/tmp/own-log-fork-tool-test/${ws}`),
}));
vi.mock('../../background-workers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../background-workers')>()),
  isSubstrateOwnerProcess: vi.fn(() => true),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  rename: vi.fn(async () => {}),
}));

import { rename } from 'node:fs/promises';
import { getFlag } from '@papercusp/flags/server';
import { closeBootedHarness, rebootHarness } from '../../sync/hyperbee/boot-all';
import { isSubstrateOwnerProcess } from '../../background-workers';
import {
  _resetOwnLogForkGuardForTests,
  reportOwnLogForkConflict,
} from '../../sync/hyperbee/own-log-fork-guard';
import tool from './own_log_fork_recover';

const WS = 'ws-tool';
const HS = 'hello-world-3-pot';
const KEY = 'f417b935852af51e7bdf676effa8a29f59e7db23413690521c5d39810e8c087a';
const STORE = `/tmp/own-log-fork-tool-test/${WS}/.papercusp/${HS}/hyperbee`;

function ctx(workspaceId: string | undefined = WS): Record<string, unknown> {
  return {
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    workspaceId,
    runId: 'r-own-log-fork',
    role: 'operator',
  };
}

async function call(args: Record<string, unknown>, c = ctx()) {
  const res = (await tool.handler(args as never, c as never)) as { data: unknown };
  return res.data as Record<string, unknown> & { plan: Record<string, unknown> };
}

beforeEach(() => {
  reportOwnLogForkConflict(
    { workspaceId: WS, harnessSlug: HS, keyHex: KEY, detail: 'conflict at 50141' },
    { onEpisode: () => {} },
  );
});

afterEach(() => {
  _resetOwnLogForkGuardForTests();
  vi.clearAllMocks();
});

describe('dev:own_log_fork_recover', () => {
  it('is registered under its documented name', () => {
    expect(tool.name).toBe('dev:own_log_fork_recover');
  });

  it('is a dry run unless confirm:true — nothing is closed, moved or re-booted', async () => {
    const r = await call({ harnessSlug: HS, keyHex: KEY });
    expect(r.outcome).toBe('dry_run');
    expect(r.blockers).toEqual([]);
    expect(r.plan).toMatchObject({ workspaceId: WS, forkedKeyHex: KEY, storePath: STORE });
    expect(closeBootedHarness).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(rebootHarness).not.toHaveBeenCalled();
  });

  it('confirm:true executes close → rename aside → rebootHarness on the resolved store', async () => {
    const r = await call({ harnessSlug: HS, keyHex: KEY, confirm: true });
    expect(r.outcome).toBe('recovered');
    expect(closeBootedHarness).toHaveBeenCalledWith(WS, HS);
    expect(rename).toHaveBeenCalledTimes(1);
    const [from, to] = vi.mocked(rename).mock.calls[0]!;
    expect(from).toBe(STORE);
    expect(String(to)).toMatch(new RegExp(`^${STORE}\\.forked-f417b935852a-`));
    expect(rebootHarness).toHaveBeenCalledWith(WS, HS, {
      workspaceRoot: `/tmp/own-log-fork-tool-test/${WS}`,
    });
  });

  it('refuses outside the substrate-owner process without touching anything', async () => {
    vi.mocked(isSubstrateOwnerProcess).mockReturnValueOnce(false);
    const r = await call({ harnessSlug: HS, keyHex: KEY, confirm: true });
    expect(r).toMatchObject({ outcome: 'refused', reason: 'not_substrate_owner' });
    expect(closeBootedHarness).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('reads the owner-authority kill-switch flag and refuses while it is off', async () => {
    vi.mocked(getFlag).mockResolvedValueOnce(false);
    const r = await call({ harnessSlug: HS, keyHex: KEY, confirm: true });
    expect(r).toMatchObject({ outcome: 'refused', reason: 'flag_off' });
    expect(vi.mocked(getFlag).mock.calls[0]![0]).toBe('papercusp-own-log-fork-auto-recovery');
    expect(rename).not.toHaveBeenCalled();
  });

  it('falls back to the active workspace when the call carries the wildcard scope', async () => {
    const r = await call({ harnessSlug: HS }, ctx('*'));
    expect(r.plan).toMatchObject({ workspaceId: 'ws-active' });
    // No fork was recorded for ws-active, so a reset would not be warranted there.
    expect(r.blockers).toContain('not_forked');
  });

  it('rejects a malformed keyHex at the argument schema', () => {
    const parsed = tool.args.safeParse({ harnessSlug: HS, keyHex: 'f417b935' });
    expect(parsed.success).toBe(false);
  });
});
