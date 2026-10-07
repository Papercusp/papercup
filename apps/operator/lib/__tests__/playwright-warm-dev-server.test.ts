import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullConfig } from '@playwright/test';

const rig = vi.hoisted(() => {
  const waitFor = vi.fn();
  const page = {
    route: vi.fn(), goto: vi.fn(), waitForFunction: vi.fn(), waitForLoadState: vi.fn(),
    locator: vi.fn(() => ({ waitFor })),
  };
  const browser = { newPage: vi.fn(() => page), close: vi.fn() };
  return { page, browser, waitFor, launch: vi.fn(() => browser) };
});

vi.mock('@playwright/test', () => ({ chromium: { launch: rig.launch } }));
vi.mock('@papercusp/test-config/admin-test-runs-reporter', () => ({
  resolveTestRunWorkspaceId: () => 'real workspace',
}));

import warmDevServer, { WARMUP_PATHS } from '../../e2e/_warm-dev-server';
import warmOngoingWork from '../../e2e/_warm-ongoing-work';

const config = { projects: [{ use: { baseURL: 'http://localhost:3427' } }] } as FullConfig;

describe('Playwright view preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rig.waitFor.mockResolvedValue(undefined);
    rig.page.waitForFunction.mockResolvedValue(undefined);
    rig.page.waitForLoadState.mockResolvedValue(undefined);
    vi.stubEnv('OPERATOR_E2E_SKIP_WARMUP', '0');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('keeps default route preparation available to the ordinary suite', async () => {
    await warmDevServer(config);
    expect(rig.page.goto.mock.calls.map(([url]) => url)).toEqual(
      WARMUP_PATHS.map(path => new URL(path, 'http://localhost:3427').toString()),
    );
    expect(rig.page.waitForFunction).toHaveBeenCalledTimes(WARMUP_PATHS.length);
    expect(rig.browser.close).toHaveBeenCalledOnce();
  });

  it('prepares the actual scoped HUD and waits for its view instead of only the shell', async () => {
    await warmOngoingWork(config);
    expect(rig.page.goto).toHaveBeenCalledOnce();
    expect(rig.page.goto.mock.calls[0][0]).toBe(
      'http://localhost:3427/adv?tab=hud&scope=all&hudtab=goals&welcome=0&ws=real%20workspace',
    );
    expect(rig.page.locator).toHaveBeenCalledWith('[role="tablist"][aria-label="HUD board"]');
    expect(rig.waitFor).toHaveBeenCalledWith({ state: 'visible', timeout: 120_000 });
    expect(rig.page.waitForFunction).not.toHaveBeenCalled();
    expect(rig.browser.close).toHaveBeenCalledOnce();
  });

  it('refuses strict preparation when the required view never mounts and closes the browser', async () => {
    rig.waitFor.mockRejectedValue(new Error('HUD never mounted'));
    await expect(warmOngoingWork(config)).rejects.toThrow('HUD never mounted');
    expect(rig.browser.close).toHaveBeenCalledOnce();
  });

  it('retains fail-soft default preparation when ordinary shell readiness fails', async () => {
    rig.page.waitForFunction.mockRejectedValue(new Error('shell never mounted'));
    await expect(warmDevServer(config)).resolves.toBeUndefined();
    expect(rig.browser.close).toHaveBeenCalledOnce();
  });
});
