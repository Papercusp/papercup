import { describe, it, expect, vi } from 'vitest';
import { installFrame, waitForSsh } from './frame-installer';
import type { RemoteExec } from './remote-exec';
import type { Frame } from '@papercusp/deployment-driver';

/** A RemoteExec whose first `failures` runScript calls reject (sshd not up yet). */
function flakyExec(failures: number): RemoteExec & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async runScript() {
      state.calls += 1;
      if (state.calls <= failures) throw new Error('Connection refused');
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async copyFile() {},
  };
}

describe('waitForSsh', () => {
  const sleep = vi.fn(async () => {});

  it('retries until sshd accepts (API "ready" ≠ sshd up)', async () => {
    const exec = flakyExec(2);
    await waitForSsh(exec, () => {}, { attempts: 5, delayMs: 1, sleep });
    expect(exec.calls).toBe(3);
  });

  it('throws after exhausting attempts, citing the last error', async () => {
    const exec = flakyExec(99);
    await expect(waitForSsh(exec, () => {}, { attempts: 3, delayMs: 1, sleep })).rejects.toThrow(
      /not reachable after 3 attempt.*Connection refused/s,
    );
  });
});

describe('installFrame desktop threading (hive-frame-desktops P-001/P-003)', () => {
  const FRAME: Frame = { id: 'f1', target: 'latitude', placement: 'remote', host: '203.0.113.9' };

  function recordingExec(): RemoteExec & { scripts: string[] } {
    const scripts: string[] = [];
    return {
      scripts,
      async runScript(script: string) {
        scripts.push(script);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      async copyFile() {},
    };
  }

  it('config.desktop reaches the generated bootstrap (Xvfb section emitted)', async () => {
    const exec = recordingExec();
    await installFrame(
      FRAME,
      { target: 'latitude', desktop: { displays: 2 } },
      { harnessSlug: 'h', workspaceId: 'ws', bootstrap: {} },
      { makeRemoteExec: () => exec, sshWait: { attempts: 1, delayMs: 1 } },
    );
    const bootstrap = exec.scripts.at(-1)!;
    expect(bootstrap).toContain('Xvfb :99');
    expect(bootstrap).toContain('Xvfb :100');
    expect(bootstrap).toContain('export PAPERCUSP_DESKTOP_DISPLAYS=2');
  });

  it('no desktop knob → no Xvfb in the bootstrap', async () => {
    const exec = recordingExec();
    await installFrame(
      FRAME,
      { target: 'latitude' },
      { harnessSlug: 'h', workspaceId: 'ws', bootstrap: {} },
      { makeRemoteExec: () => exec, sshWait: { attempts: 1, delayMs: 1 } },
    );
    expect(exec.scripts.at(-1)!).not.toContain('Xvfb');
  });
});
