import { describe, it, expect, vi } from 'vitest';
import { waitForSsh } from './frame-installer';
import type { RemoteExec } from './remote-exec';

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
