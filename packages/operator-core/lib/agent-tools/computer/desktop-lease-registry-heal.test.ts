/**
 * desktop-lease-registry-heal.test.ts — a lease whose registry row could not be
 * written is re-recorded by the next ensure (WI-10002797).
 *
 * On a workspace host the pre-restart row blocked the insert, the write's failure
 * was swallowed, and every later `ensureHiveDesktop` returned the cached lease with
 * no row — so the hosted relay answered `desktop_unavailable` for the life of the
 * process. Separate from `desktop-lease.test.ts` because it mocks the registry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  registerDesktopSession: vi.fn(),
  markDesktopReady: vi.fn(async () => undefined),
  closeDesktopSession: vi.fn(async () => undefined),
  resolveDesktopForScope: vi.fn(async () => undefined),
}));
vi.mock('../../desktop/desktop-session-registry', () => registry);
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-heal' }));

import {
  ensureHiveDesktop,
  hiveDesktopSessionId,
  leasedDesktopBySessionId,
  releaseAllHiveDesktops,
  __setProvisionerForTests,
  __resetProvisioner,
} from './desktop-lease';
import type { SandboxDesktop } from './desktop-provisioner';
import { NO_GL_STRATEGY } from '../../desktop/gl-strategy';

function fakeDesktop(): SandboxDesktop {
  return {
    display: ':110',
    number: 110,
    width: 1024,
    height: 768,
    gl: NO_GL_STRATEGY,
    glProbeSandboxed: false,
    appDiagnostics: () => [],
    taskId: null,
    xServer: 'xvfb',
    release: async () => {},
  };
}

afterEach(async () => {
  await releaseAllHiveDesktops();
  __resetProvisioner();
  vi.clearAllMocks();
});

describe('desktop lease registry mirror', () => {
  it('re-records a nameless lease on the next ensure instead of serving it nameless forever', async () => {
    const provision = vi.fn(async () => fakeDesktop());
    __setProvisionerForTests(provision);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registry.registerDesktopSession
      .mockRejectedValueOnce(
        Object.assign(new Error('duplicate key value violates unique constraint "desktop_sessions_live_display_uq"'), {
          code: '23505',
          constraint_name: 'desktop_sessions_live_display_uq',
        }),
      )
      .mockResolvedValueOnce({ id: 'ds-healed' });

    const first = await ensureHiveDesktop('hosted-workspace');
    expect(hiveDesktopSessionId('hosted-workspace')).toBeUndefined();
    // D-439: the failed write is still best-effort, but it names the pg code and the
    // blocking index so a host's journal says why desktop.start answers unavailable.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /registry write failed for pot=hosted-workspace display=:110 workspace=ws-heal code=23505 constraint=desktop_sessions_live_display_uq/,
    );
    warn.mockRestore();

    const second = await ensureHiveDesktop('hosted-workspace');
    expect(second).toBe(first);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(hiveDesktopSessionId('hosted-workspace')).toBe('ds-healed');
    expect(leasedDesktopBySessionId('ds-healed')).toBe(first);
  });

  it('does not write the row again once the lease is named', async () => {
    __setProvisionerForTests(async () => fakeDesktop());
    registry.registerDesktopSession.mockResolvedValue({ id: 'ds-named' });

    await ensureHiveDesktop('hosted-workspace');
    await ensureHiveDesktop('hosted-workspace');
    expect(registry.registerDesktopSession).toHaveBeenCalledTimes(1);
  });
});
