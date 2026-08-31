/**
 * account-capacity-reprobe system action (EI-21921833535413808) — pins the tick's
 * per-provider fan-out, the quiet-when-nothing-walled behavior, and that a probe failure on
 * one provider does not take down the other provider's tick.
 */
import { describe, expect, it, vi } from 'vitest';
import { makeAccountCapacityReprobeAction, type AccountCapacityReprobeSummary } from './account-capacity-reprobe-action';

const quiet: AccountCapacityReprobeSummary = { probed: 0, serving: [], unwalled: [], confirmedWalled: [], failed: [] };

const withWork: AccountCapacityReprobeSummary = {
  probed: 3,
  serving: ['aviynw'],
  unwalled: ['aviynw'],
  confirmedWalled: ['aviynw2', 'aviynw3'],
  failed: [],
};

describe('account-capacity-reprobe system action', () => {
  it('probes every configured provider with the routine ctx workspace, not a hardcoded value', async () => {
    const probe = vi.fn(async () => quiet);
    const action = makeAccountCapacityReprobeAction({ probe, log: vi.fn() });

    await action({ workspaceId: 'ws-123', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

    expect(probe).toHaveBeenCalledWith({ workspace: 'ws-123', provider: 'claude' });
    expect(probe).toHaveBeenCalledWith({ workspace: 'ws-123', provider: 'codex' });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('logs nothing for a provider with nothing walled — quiet by design', async () => {
    const probe = vi.fn(async () => quiet);
    const log = vi.fn();
    const action = makeAccountCapacityReprobeAction({ probe, log });

    await action({ workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

    expect(log).not.toHaveBeenCalled();
  });

  it('logs a summary — including corrected walls — when the provider had walled accounts to check', async () => {
    const probe = vi.fn(async (opts: { provider: string }) => (opts.provider === 'claude' ? withWork : quiet));
    const log = vi.fn();
    const action = makeAccountCapacityReprobeAction({ probe, log });

    await action({ workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^claude: probed=3 confirmedWalled=2 unwalled=1 \[aviynw\] failed=0$/),
    );
  });

  it('a probe failure on one provider is logged and does not stop the other provider ticking', async () => {
    const probe = vi.fn(async (opts: { provider: string }) => {
      if (opts.provider === 'claude') throw new Error('gateway unreachable');
      return withWork;
    });
    const log = vi.fn();
    const action = makeAccountCapacityReprobeAction({ probe, log });

    await action({ workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

    expect(probe).toHaveBeenCalledTimes(2); // codex still ran despite claude's throw
    expect(log).toHaveBeenCalledWith(expect.stringContaining('claude: probe FAILED — gateway unreachable'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('codex: probed=3'));
  });
});
