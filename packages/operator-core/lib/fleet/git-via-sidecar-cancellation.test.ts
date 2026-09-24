import { describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  spawnSidecar: vi.fn(async () => undefined),
  call: vi.fn(),
}));
vi.mock('./spawner-sidecar-spawn', () => ({ spawnSpawnerSidecar: mock.spawnSidecar }));
vi.mock('./spawner-ipc-client', () => ({ getSpawnerIpcClient: () => ({ call: mock.call }) }));

import { runCommandViaSpawnerSidecar } from './git-via-sidecar';

describe('cancellable process:exec caller', () => {
  it('forwards progress, requests cancellation once and waits for the child-exit response', async () => {
    let finish!: (value: { code: number; stdout: string; stderr: string }) => void;
    const original = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => { finish = resolve; });
    const onProgress = vi.fn();
    mock.call.mockImplementation((method: string, _params: unknown, opts?: {
      onRequestId?: (id: number) => void; onOutputActivity?: () => void;
    }) => {
      if (method === 'process:exec') {
        opts?.onRequestId?.(17);
        opts?.onOutputActivity?.();
        return original;
      }
      if (method === 'spawn:cancel') return Promise.resolve({ cancelled: true });
      throw new Error(`unexpected RPC ${method}`);
    });

    const controller = new AbortController();
    const run = runCommandViaSpawnerSidecar('git', ['rev-parse', 'HEAD'], {
      cwd: '/tmp', timeoutMs: 5000, signal: controller.signal, onProgress,
    });
    await vi.waitFor(() => expect(mock.call).toHaveBeenCalledWith('process:exec', expect.anything(), expect.anything()));
    expect(onProgress).toHaveBeenCalledOnce();
    controller.abort();
    controller.abort();
    await vi.waitFor(() => expect(mock.call.mock.calls.filter(([method]) => method === 'spawn:cancel')).toHaveLength(1));
    expect(mock.call).toHaveBeenCalledWith('spawn:cancel', { requestId: 17 }, { timeoutMs: 5000 });

    let settled = false;
    void run.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish({ code: -1, stdout: '', stderr: 'aborted by caller' });
    expect(await run).toMatchObject({ code: -1, stderr: 'aborted by caller' });
  });
});
