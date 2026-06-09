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

  it('blueprint env AGENT_BACKEND=claude-code → claude backend bootstrap (no Meridian install)', async () => {
    const exec = recordingExec();
    await installFrame(
      FRAME,
      { target: 'hetzner' },
      { harnessSlug: 'h', workspaceId: 'ws', bootstrap: { env: { AGENT_BACKEND: 'claude-code' } } },
      { makeRemoteExec: () => exec, sshWait: { attempts: 1, delayMs: 1 } },
    );
    const bootstrap = exec.scripts.at(-1)!;
    expect(bootstrap).toContain("export AGENT_BACKEND='claude-code'"); // loop-level export (claude → claude-code vocabulary)
    expect(bootstrap).not.toContain('@rynfar/meridian'); // claude frame never installs Meridian
    expect(bootstrap).toContain('backend is not omp');
  });

  it('no AGENT_BACKEND env → historical omp default (Meridian installed + started)', async () => {
    const exec = recordingExec();
    await installFrame(
      FRAME,
      { target: 'hetzner' },
      { harnessSlug: 'h', workspaceId: 'ws', bootstrap: {} },
      { makeRemoteExec: () => exec, sshWait: { attempts: 1, delayMs: 1 } },
    );
    const bootstrap = exec.scripts.at(-1)!;
    expect(bootstrap).toContain('@rynfar/meridian');
    expect(bootstrap).toContain('meridian >/var/log/meridian.log');
  });
});

describe('deriveAgentBackend (blueprint env is the backend authority)', () => {
  it('maps the runtime vocabulary', async () => {
    const { deriveAgentBackend } = await import('./frame-installer');
    expect(deriveAgentBackend({ AGENT_BACKEND: 'claude-code' })).toBe('claude');
    expect(deriveAgentBackend({ AGENT_BACKEND: 'claude' })).toBe('claude');
    expect(deriveAgentBackend({ AGENT_BACKEND: 'Codex' })).toBe('codex');
    expect(deriveAgentBackend({ AGENT_BACKEND: 'omp' })).toBe('omp');
    expect(deriveAgentBackend({})).toBe('omp');
    expect(deriveAgentBackend(undefined)).toBe('omp');
  });
});
