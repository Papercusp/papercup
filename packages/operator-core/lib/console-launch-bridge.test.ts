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
  requestRemoteWorkspaceConsoleLaunch,
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

function emittedTicket(): string {
  const call = vi.mocked(notifySyncInvalidate).mock.calls.at(-1);
  expect(call?.[0]).toBe(CONSOLE_LAUNCH_REQUEST_EVENT);
  return (call?.[1] as { ticket: string }).ticket;
}

beforeEach(() => {
  vi.mocked(notifySyncInvalidate).mockReset();
  vi.mocked(notifySyncInvalidate).mockResolvedValue(undefined);
});

describe('requestDesktopConsoleLaunch ticket lifecycle', () => {
  it('emits only an opaque ticket and resolves after the webview redeems the envelope', async () => {
    const p = requestDesktopConsoleLaunch({ envelope, label: 'L', planSlug: 'plan-x' });
    // The emit is awaited before the promise can settle — flush a microtask.
    await Promise.resolve();
    const ticket = emittedTicket();
    const args = vi.mocked(notifySyncInvalidate).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(args).not.toHaveProperty('envelope');
    expect(args).not.toHaveProperty('requestId');
    expect(args.targetClientId).toBeNull();
    expect(args.label).toBe('L');
    expect(args.planSlug).toBe('plan-x');

    expect(claimConsoleLaunch(ticket, 'desktop-a')).toEqual({ granted: true, envelope });
    expect(completeConsoleLaunch(ticket, { ok: true, pid: 4242 })).toBe(true);
    await expect(p).resolves.toEqual({ ok: true, pid: 4242, error: null });
    expect(pendingBridgeLaunchCount()).toBe(0);
  });

  it('a target mismatch cannot consume the ticket and the envelope is redeemed exactly once', async () => {
    const p = requestDesktopConsoleLaunch({ envelope, targetClientId: 'desktop-target' });
    await Promise.resolve();
    const ticket = emittedTicket();
    const args = vi.mocked(notifySyncInvalidate).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(args.targetClientId).toBe('desktop-target');

    expect(claimConsoleLaunch(ticket, 'desktop-wrong')).toEqual({ granted: false });
    expect(claimConsoleLaunch(ticket, 'desktop-target')).toEqual({ granted: true, envelope });
    expect(claimConsoleLaunch(ticket, 'desktop-target')).toEqual({ granted: false });
    expect(completeConsoleLaunch(ticket, { ok: true, pid: 1 })).toBe(true);
    await p;
  });

  it('refuses a result before the ticket has been redeemed', async () => {
    const p = requestDesktopConsoleLaunch({ envelope, timeoutMs: 20 });
    await Promise.resolve();
    const ticket = emittedTicket();
    expect(completeConsoleLaunch(ticket, { ok: true, pid: 1 })).toBe(false);
    await expect(p).resolves.toMatchObject({ ok: false });
  });

  it('an error completion carries the Tauri error through to the awaiting caller', async () => {
    const p = requestDesktopConsoleLaunch({ envelope });
    await Promise.resolve();
    const ticket = emittedTicket();
    claimConsoleLaunch(ticket, 'desktop-a');
    completeConsoleLaunch(ticket, { ok: false, error: 'console_launch failed: wt.exe not found' });
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

  it('claim/complete on an unknown or expired ticket are refused, never throw', async () => {
    expect(claimConsoleLaunch('nope', 'desktop-a')).toEqual({ granted: false });
    expect(completeConsoleLaunch('nope', { ok: true })).toBe(false);
    const p = requestDesktopConsoleLaunch({ envelope, timeoutMs: 20 });
    await Promise.resolve();
    const ticket = emittedTicket();
    await p; // let it time out
    expect(claimConsoleLaunch(ticket, 'desktop-a')).toEqual({ granted: false }); // expired
    expect(completeConsoleLaunch(ticket, { ok: true })).toBe(false); // double-report
  });
});

describe('requestRemoteWorkspaceConsoleLaunch', () => {
  it('builds a secret-free psu connection envelope and targets the initiating desktop', async () => {
    const p = requestRemoteWorkspaceConsoleLaunch({
      targetClientId: 'desktop-remote',
      profileName: 'gcp.main-1',
      cwd: '/workspace/repo',
      label: 'Remote workspace',
    });
    await Promise.resolve();
    const ticket = emittedTicket();
    const event = vi.mocked(notifySyncInvalidate).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(event).toMatchObject({ ticket, targetClientId: 'desktop-remote', label: 'Remote workspace' });
    expect(event).not.toHaveProperty('envelope');

    const claim = claimConsoleLaunch(ticket, 'desktop-remote');
    expect(claim).toEqual({
      granted: true,
      envelope: {
        cwd: '/workspace/repo',
        env: {},
        mcpJsonContents: '',
        greetingCmd: 'psu --connect=gcp.main-1',
        needsSuperuserBootstrap: false,
        sessionId: expect.any(String),
      },
    });
    completeConsoleLaunch(ticket, { ok: true, pid: 7 });
    await expect(p).resolves.toEqual({ ok: true, pid: 7, error: null });
  });

  it.each(['', '-leading', 'space name', 'name;touch /tmp/nope', 'a'.repeat(65)])(
    'rejects unsafe profile name %j without emitting a ticket',
    async (profileName) => {
      const result = await requestRemoteWorkspaceConsoleLaunch({
        targetClientId: 'desktop-remote',
        profileName,
      });
      expect(result).toMatchObject({ ok: false, pid: null });
      expect(result.error).toMatch(/profile name/i);
      expect(notifySyncInvalidate).not.toHaveBeenCalled();
    },
  );

  it('rejects an empty target desktop id without emitting a ticket', async () => {
    const result = await requestRemoteWorkspaceConsoleLaunch({
      targetClientId: '',
      profileName: 'gcp-main',
    });
    expect(result).toMatchObject({ ok: false, pid: null });
    expect(result.error).toMatch(/target client id/i);
    expect(notifySyncInvalidate).not.toHaveBeenCalled();
  });
});
