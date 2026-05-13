/**
 * End-to-end test for dev:state_counter — proves the state-shaped
 * tool dispatch flow: ctx.publishState → state-channel → snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetStateChannelForTests,
  getSnapshot,
  openRun,
  setToolState,
} from '@papercusp/agent-mcp';

import tool from './state_counter';

describe('dev:state_counter', () => {
  beforeEach(() => {
    _resetStateChannelForTests();
  });
  afterEach(() => {
    _resetStateChannelForTests();
  });

  function makeCtx(over?: Record<string, unknown>) {
    return {
      log: vi.fn(),
      signal: new AbortController().signal,
      progress: vi.fn(),
      emit: vi.fn(),
      workspaceId: 'workspace-dc',
      runId: 'r-counter',
      role: 'operator',
      publishState: (snap: unknown) => {
        // Real impl is installed by the dispatcher; the unit test
        // bypasses dispatch and supplies a thin pass-through that
        // mirrors the dispatcher's behavior.
        setToolState('r-counter', snap);
      },
      ...over,
    };
  }

  it('publishes a snapshot per tick; final snapshot has phase=done', async () => {
    openRun({ workspaceId: 'workspace-dc', runId: 'r-counter' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (tool as any).handler(
      { steps: 3, delayMs: 0 },
      makeCtx(),
    );
    expect(r.isError).toBeUndefined();
    const snap = getSnapshot('r-counter')!;
    expect(snap.snapshot.toolState).toEqual({
      count: 3,
      total: 3,
      phase: 'done',
    });
    // version increments: openRun=0, then +1 per publishState (count 0..3 → 4 snapshots).
    expect(snap.version).toBeGreaterThanOrEqual(4);
  });

  it('returns isError when ctx.publishState is missing (no chat surface)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (tool as any).handler(
      { steps: 1, delayMs: 0 },
      makeCtx({ publishState: undefined }),
    );
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/no_state_channel/);
  });

  it('respects ctx.signal.aborted — stops emitting further snapshots', async () => {
    openRun({ workspaceId: 'workspace-dc', runId: 'r-counter' });
    const ac = new AbortController();
    const ctx = makeCtx({ signal: ac.signal });
    ac.abort();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await (tool as any).handler({ steps: 50, delayMs: 0 }, ctx);
    expect(r.isError).toBeUndefined();
    const snap = getSnapshot('r-counter')!;
    // Loop broke after the first publishState (count=0); never advanced.
    expect((snap.snapshot.toolState as { count: number }).count).toBe(0);
  });
});
