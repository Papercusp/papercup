/**
 * Unit tests for the overwatch wake-bridge seam (overwatch-role-2026-06-15 B-07).
 *
 * Pin the B-07 ↔ B-04 contract: before B-04 registers a waker every call is a
 * fail-soft no-op ({ wired: false }); once registered the call delegates and a
 * thrown waker is swallowed into { wired: true, error } — the control tool must
 * never fail because the wake path failed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerOverwatchWaker,
  isOverwatchWakerWired,
  requestOverwatchWake,
  clearOverwatchWake,
} from './wake-bridge';

beforeEach(() => {
  registerOverwatchWaker(null);
});

describe('unwired (B-04 not landed)', () => {
  it('reports not wired and no-ops', async () => {
    expect(isOverwatchWakerWired()).toBe(false);
    expect(await requestOverwatchWake({ reason: 'r', harness: 'h', workspaceId: 'w' })).toEqual({ wired: false });
    expect(await clearOverwatchWake({ harness: 'h', workspaceId: 'w' })).toEqual({ wired: false });
  });
});

describe('wired (B-04 registered)', () => {
  it('delegates requestWake / clearWake and returns the result', async () => {
    const requestWake = vi.fn().mockResolvedValue({ fired: true });
    const clearWake = vi.fn().mockResolvedValue({ cleared: true });
    registerOverwatchWaker({ requestWake, clearWake });

    expect(isOverwatchWakerWired()).toBe(true);
    const req = { reason: 'start', harness: 'my-hive', workspaceId: 'ws-1' };
    expect(await requestOverwatchWake(req)).toEqual({ wired: true, result: { fired: true } });
    expect(requestWake).toHaveBeenCalledWith(req);

    expect(await clearOverwatchWake({ harness: 'my-hive', workspaceId: 'ws-1' })).toEqual({
      wired: true,
      result: { cleared: true },
    });
    expect(clearWake).toHaveBeenCalledWith({ harness: 'my-hive', workspaceId: 'ws-1' });
  });

  it('swallows a thrown waker into { wired: true, error } (never throws)', async () => {
    registerOverwatchWaker({
      requestWake: vi.fn().mockRejectedValue(new Error('boom')),
      clearWake: vi.fn().mockRejectedValue(new Error('nope')),
    });
    expect(await requestOverwatchWake({ reason: 'r', harness: 'h', workspaceId: 'w' })).toEqual({
      wired: true,
      error: 'boom',
    });
    expect(await clearOverwatchWake({ harness: 'h', workspaceId: 'w' })).toEqual({ wired: true, error: 'nope' });
  });
});
