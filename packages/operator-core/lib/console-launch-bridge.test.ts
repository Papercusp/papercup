/**
 * console-launch-bridge — the operator half of the WI-3289 Windows agent
 * console-launch relay. Covers the request/claim/complete lifecycle the
 * launch-claim/launch-result routes + DesktopConsoleLaunchBridge drive, and
 * the two loud-failure modes (no webview claims → timeout; bus emit fails).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  claimConsoleLaunch,
  completeConsoleLaunch,
  pendingBridgeLaunchCount,
  requestDesktopConsoleLaunch,
  CONSOLE_LAUNCH_REQUEST_EVENT,
} from './console-launch-bridge';
import { notifySyncInvalidate } from './sync-sse';
import type { ConsoleEnvelope } from './console-launcher';

vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const envelope: ConsoleEnvelope = {
  cwd: '/tmp',
  env: {},
  mcpJsonContents: '',
  greetingCmd: 'psu --no-picker',
  needsSuperuserBootstrap: false,
  sessionId: 'sid-1',
};

function emittedRequestId(): string {
  const call = vi.mocked(notifySyncInvalidate).mock.calls.at(-1);
  expect(call?.[0]).toBe(CONSOLE_LAUNCH_REQUEST_EVENT);
  return (call?.[1] as { requestId: string }).requestId;
}

beforeEach(() => {
  vi.mocked(notifySyncInvalidate).mockReset();
  vi.mocked(notifySyncInvalidate).mockResolvedValue(undefined);
});

describe('requestDesktopConsoleLaunch lifecycle', () => {
  it('emits the sync-bus event and resolves when the webview completes it', async () => {
    const p = requestDesktopConsoleLaunch({ envelope, label: 'L', planSlug: 'plan-x' });
    // The emit is awaited before the promise can settle — flush a microtask.
    await Promise.resolve();
    const requestId = emittedRequestId();
    const args = vi.mocked(notifySyncInvalidate).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(args.envelope).toEqual(envelope);
    expect(args.label).toBe('L');
    expect(args.planSlug).toBe('plan-x');

    expect(claimConsoleLaunch(requestId)).toBe(true);
    expect(completeConsoleLaunch(requestId, { ok: true, pid: 4242 })).toBe(true);
    await expect(p).resolves.toEqual({ ok: true, pid: 4242, error: null });
    expect(pendingBridgeLaunchCount()).toBe(0);
  });

  it('claim is single-consumer: the second webview is refused', async () => {
    const p = requestDesktopConsoleLaunch({ envelope });
    await Promise.resolve();
    const requestId = emittedRequestId();
    expect(claimConsoleLaunch(requestId)).toBe(true);
    expect(claimConsoleLaunch(requestId)).toBe(false); // N webviews ⇒ ONE window
    completeConsoleLaunch(requestId, { ok: true, pid: 1 });
    await p;
  });

  it('an error completion carries the Tauri error through to the awaiting caller', async () => {
    const p = requestDesktopConsoleLaunch({ envelope });
    await Promise.resolve();
    const requestId = emittedRequestId();
    claimConsoleLaunch(requestId);
    completeConsoleLaunch(requestId, { ok: false, error: 'console_launch failed: wt.exe not found' });
    await expect(p).resolves.toEqual({
      ok: false,
      pid: null,
      error: 'console_launch failed: wt.exe not found',
    });
  });

  it('times out LOUDLY when no webview claims (desktop shell closed)', async () => {
    const p = requestDesktopConsoleLaunch({ envelope, timeoutMs: 20 });
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no desktop shell answered/);
    expect(r.error).toMatch(/desktop window must be OPEN/i);
    expect(pendingBridgeLaunchCount()).toBe(0);
  });

  it('a failed sync-bus emit fails the request immediately (no dangling pending entry)', async () => {
    vi.mocked(notifySyncInvalidate).mockRejectedValue(new Error('pg down'));
    const r = await requestDesktopConsoleLaunch({ envelope, timeoutMs: 5_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sync-bus emit failed: pg down/);
    expect(pendingBridgeLaunchCount()).toBe(0);
  });

  it('claim/complete on an unknown or expired requestId are refused, never throw', async () => {
    expect(claimConsoleLaunch('nope')).toBe(false);
    expect(completeConsoleLaunch('nope', { ok: true })).toBe(false);
    const p = requestDesktopConsoleLaunch({ envelope, timeoutMs: 20 });
    await Promise.resolve();
    const requestId = emittedRequestId();
    await p; // let it time out
    expect(claimConsoleLaunch(requestId)).toBe(false); // expired
    expect(completeConsoleLaunch(requestId, { ok: true })).toBe(false); // double-report
  });
});
