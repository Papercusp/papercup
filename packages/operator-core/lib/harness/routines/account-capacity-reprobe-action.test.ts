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

    const result = await action({ workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

    expect(probe).toHaveBeenCalledTimes(2); // codex still ran despite claude's throw
    expect(log).toHaveBeenCalledWith(expect.stringContaining('claude: probe FAILED — gateway unreachable'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('codex: probed=3'));
    expect(result?.softError).toContain('claude: probe FAILED — gateway unreachable');
    expect(result?.diagnostics).toMatchObject({
      providers: { claude: { error: 'gateway unreachable' }, codex: { probed: 3 } },
    });
  });

  it('retains failed account errors and HTTP status instead of reporting a healthy refresh', async () => {
    const failed: AccountCapacityReprobeSummary = {
      ...quiet,
      probed: 2,
      failed: ['aviynw4', 'aviynw6'],
      rows: [
        { accountId: 'aviynw4', error: 'upstream request timed out' },
        { accountId: 'aviynw6', status: 401, error: 'authentication refused' },
      ],
    };
    const probe = vi.fn(async (opts: { provider: string }) => opts.provider === 'claude' ? failed : withWork);
    const log = vi.fn();
    const action = makeAccountCapacityReprobeAction({ probe, log });

    const result = await action({ workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

    expect(probe).toHaveBeenCalledTimes(2);
    expect(result?.softError).toContain('aviynw4: upstream request timed out');
    expect(result?.softError).toContain('aviynw6: HTTP 401 — authentication refused');
    expect(result?.diagnostics).toMatchObject({ providers: { claude: { rows: failed.rows } } });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('aviynw4: upstream request timed out'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('aviynw6: HTTP 401 — authentication refused'));
  });

  it('marks failed gateway readmission as degraded even when the capacity reading succeeded', async () => {
    const warning = 'projection updated, but gateway exclusions were NOT cleared for aviynw4';
    const probe = vi.fn(async (opts: { provider: string }) => opts.provider === 'claude'
      ? { ...withWork, warning }
      : quiet);
    const log = vi.fn();
    const action = makeAccountCapacityReprobeAction({ probe, log });

    const result = await action({ workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} });

    expect(result?.softError).toContain(warning);
    expect(result?.diagnostics).toMatchObject({ providers: { claude: { warning } } });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(warning));
  });

  it('clears degraded health on the next successful tick without clearing a confirmed usage wall', async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ ...quiet, probed: 1, failed: ['aviynw4'] })
      .mockResolvedValueOnce(quiet)
      .mockResolvedValueOnce(withWork)
      .mockResolvedValueOnce(quiet);
    const action = makeAccountCapacityReprobeAction({ probe, log: vi.fn() });
    const ctx = { workspaceId: 'ws', installSlug: 'papercusp', triggerConfig: {}, payloadTemplate: {} };

    const failed = await action(ctx);
    const recovered = await action(ctx);

    expect(failed?.softError).toContain('aviynw4');
    expect(recovered?.softError).toBeUndefined();
    expect(recovered?.diagnostics).toMatchObject({
      providers: { claude: { unwalled: ['aviynw'], confirmedWalled: ['aviynw2', 'aviynw3'] } },
    });
  });
});
