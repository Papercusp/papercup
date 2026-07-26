/**
 * EI-11110 / WI-5976: unit tests for `syncLaunchModeToRegistry`.
 *
 * Root cause: a fleet/auto launch used to bake "AUTO mode is ON" (and the
 * watermarked instructionPrecedence snapshot) into the session PROSE ONLY —
 * computed from the launch request's local autoMode/drainMode booleans — and
 * NEVER wrote the actual mode registry (harness_shared.agent_modes) that
 * mode:set / coord:orient read live. A fresh session's first prompt asserted
 * AUTO was on while the very next coord:orient call (reading the real
 * registry) reported no active modes and 'confirm-before-execution' — a live
 * text-vs-registry contradiction, reproduced first-hand while investigating
 * this ticket (EI-11110's own claiming session hit exactly this).
 *
 * These tests pin `syncLaunchModeToRegistry`'s wiring at the store seam
 * (mocked — no PG): it must call setMode with the right modeId(s) for
 * auto-only vs drain (which stacks 'auto'+'drain', different axes), skip
 * entirely when autoMode is false, refresh the control anchor projection on
 * success, and surface (never throw) a message on failure — mirroring
 * stampFleetMembershipAtBoot's contract (bootstrap-su-fleet-stamp.test.ts).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const setModeMock = vi.fn(async (_opts: unknown) => ({ ok: true, noop: false }));
const refreshControlAnchorMock = vi.fn(async (_opts: unknown) => ({}));

vi.mock('../../../modes/store', () => ({
  setMode: (opts: unknown) => setModeMock(opts),
}));
vi.mock('../../../agent-tools/coordination/control-anchor', () => ({
  refreshControlAnchorAfterMutation: (opts: unknown) => refreshControlAnchorMock(opts),
}));
vi.mock('../../../adv-sessions', () => ({
  endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  recordAdvSession: vi.fn(async () => 1),
  markAdvSessionEnded: vi.fn(async () => {}),
  reactivateAdvSession: vi.fn(async () => false),
  reanchorAdvSessionNativeId: vi.fn(async () => ({ reanchored: true, owner: null })),
}));
vi.mock('../../../agent-tools/coordination/presence', () => ({
  touchHeartbeat: vi.fn(async () => {}),
}));

import { syncLaunchModeToRegistry } from './bootstrap-su';

beforeEach(() => {
  setModeMock.mockClear();
  refreshControlAnchorMock.mockClear();
  setModeMock.mockResolvedValue({ ok: true, noop: false });
  refreshControlAnchorMock.mockResolvedValue({});
});

describe('syncLaunchModeToRegistry (EI-11110 / WI-5976)', () => {
  it('no-ops (never touches the registry) when autoMode is false', async () => {
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'ws',
      ownerId: 'su-abc',
      autoMode: false,
      drainMode: false,
      reason: 'irrelevant',
    });
    expect(err).toBeNull();
    expect(setModeMock).not.toHaveBeenCalled();
    expect(refreshControlAnchorMock).not.toHaveBeenCalled();
  });

  it('registers exactly \'auto\' for a plain --auto launch, then refreshes the control anchor', async () => {
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'papercusp-workspace',
      ownerId: 'su-abc',
      autoMode: true,
      drainMode: false,
      reason: 'fleet launch: --auto',
    });
    expect(err).toBeNull();
    expect(setModeMock).toHaveBeenCalledTimes(1);
    expect(setModeMock).toHaveBeenCalledWith({
      workspaceId: 'papercusp-workspace',
      ownerId: 'su-abc',
      modeId: 'auto',
      enabled: true,
      reason: 'fleet launch: --auto',
      setBy: 'su-abc',
    });
    expect(refreshControlAnchorMock).toHaveBeenCalledTimes(1);
    expect(refreshControlAnchorMock).toHaveBeenCalledWith({
      ownerId: 'su-abc',
      workspaceId: 'papercusp-workspace',
      origin: 'system',
      actorId: 'su-abc',
      source: 'mode:set',
    });
  });

  it("registers BOTH 'auto' and 'drain' for a --mode=drain launch (DRAIN implies AUTO, different axes)", async () => {
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'ws',
      ownerId: 'su-xyz',
      autoMode: true,
      drainMode: true,
      reason: 'fleet launch: --mode=drain (DRAIN implies AUTO)',
    });
    expect(err).toBeNull();
    expect(setModeMock).toHaveBeenCalledTimes(2);
    expect(setModeMock.mock.calls.map((c) => (c[0] as { modeId: string }).modeId)).toEqual([
      'auto',
      'drain',
    ]);
    expect(refreshControlAnchorMock).toHaveBeenCalledTimes(1);
  });

  it('does not treat an owner-sticky refusal (stickyConflict) as a hard failure', async () => {
    setModeMock.mockResolvedValueOnce({ ok: false, stickyConflict: true, switchedFrom: 'auto' });
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'ws',
      ownerId: 'su-xyz',
      autoMode: true,
      drainMode: false,
      reason: 'launch: --auto',
    });
    // A peer/earlier launch already armed a stronger owner-directed mode — benign,
    // not a launch-blocking error.
    expect(err).toBeNull();
    expect(refreshControlAnchorMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a genuine setMode failure as a message, never throwing', async () => {
    setModeMock.mockResolvedValueOnce({ ok: false, error: 'boom' });
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'ws',
      ownerId: 'su-xyz',
      autoMode: true,
      drainMode: false,
      reason: 'launch: --auto',
    });
    expect(err).toBe('boom');
    expect(refreshControlAnchorMock).not.toHaveBeenCalled();
  });

  it('catches a thrown error (e.g. PG unreachable) and returns its message rather than throwing', async () => {
    setModeMock.mockRejectedValueOnce(new Error('pg down'));
    const err = await syncLaunchModeToRegistry({
      workspaceId: 'ws',
      ownerId: 'su-xyz',
      autoMode: true,
      drainMode: false,
      reason: 'launch: --auto',
    });
    expect(err).toBe('pg down');
  });
});
