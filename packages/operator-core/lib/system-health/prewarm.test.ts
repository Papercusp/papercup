import { test, vi } from 'vitest';
import assert from 'node:assert/strict';

// preWarmSystemHealth only reads the flag + the workspace registry and kicks the
// (injected) tick — mock those two so the test is DB-free. The real
// runSystemHealthTick is never used here (a fake tick is injected).
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../workspace-registry', () => ({ readRegistry: vi.fn(), activeWorkspaceId: () => 'ws-default' }));

import { preWarmSystemHealth } from './compute';
import { getFlag } from '@papercusp/flags/server';
import { readRegistry } from '../workspace-registry';

const registry = (ids: string[]) =>
  ({ workspaces: ids.map((id) => ({ id })) }) as unknown as ReturnType<typeof readRegistry>;

test('preWarmSystemHealth — flag OFF: returns 0 and never ticks (no work when the feature is dark)', async () => {
  vi.mocked(getFlag).mockResolvedValue(false);
  vi.mocked(readRegistry).mockReturnValue(registry(['ws-a']));
  const tick = vi.fn(async (_ws: string) => ({}));
  const n = await preWarmSystemHealth(tick);
  assert.equal(n, 0);
  assert.equal(tick.mock.calls.length, 0);
});

test('preWarmSystemHealth — flag ON: kicks exactly one tick per registered workspace + returns the count', async () => {
  vi.mocked(getFlag).mockResolvedValue(true);
  vi.mocked(readRegistry).mockReturnValue(registry(['ws-a', 'ws-b']));
  const tick = vi.fn(async (_ws: string) => ({}));
  const n = await preWarmSystemHealth(tick);
  assert.equal(n, 2);
  // The ticks are kicked synchronously (only their settle is deferred) — one per ws.
  assert.deepEqual(
    tick.mock.calls.map((c) => c[0]).sort(),
    ['ws-a', 'ws-b'],
  );
});

test('preWarmSystemHealth — a rejecting tick is swallowed (fire-and-forget; never blocks/fails boot)', async () => {
  vi.mocked(getFlag).mockResolvedValue(true);
  vi.mocked(readRegistry).mockReturnValue(registry(['ws-x']));
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const tick = vi.fn(async (_ws: string) => {
      throw new Error('tick boom');
    });
    // Resolves (does NOT reject) despite the tick throwing — boot must not fail.
    const n = await preWarmSystemHealth(tick);
    assert.equal(n, 1);
    await new Promise((r) => setTimeout(r, 0)); // let the rejected tick's .catch run
    assert.equal(warnSpy.mock.calls.length, 1);
    assert.match(String(warnSpy.mock.calls[0][0]), /boot pre-warm failed for ws-x/);
  } finally {
    warnSpy.mockRestore();
  }
});
