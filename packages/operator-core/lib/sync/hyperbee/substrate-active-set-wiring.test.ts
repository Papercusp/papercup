/**
 * P-010 wiring tests — a DEFERRED (never-booted) harness must be wake-eligible
 * on exactly the same paths an EVICTED one is.
 *
 * This is the load-bearing safety property of activate-on-demand. Both wake
 * paths previously keyed on the `evicted` set ALONE, so a harness the boot sweep
 * skipped was invisible to them: its `substrate_outbox` NOTIFY was dropped and
 * its captured writes would sit undrained forever (the EI-126 divergence class).
 * If these tests regress, deferral silently loses data — so each asserts the
 * wake FIRES, and is paired with a case proving it does not fire spuriously.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  enableSubstrateEvictionTracking,
  getBootedHarness,
  handleOutboxNotifyForEvictedHarness,
  handleRemoteWakeForDarkHarness,
  isHarnessEngineResident,
  markHarnessActivationDeferred,
  deferredActivationCount,
  _resetEvictionTrackingForTests,
  _resetHandleMapForTests,
  _setHandleForTests,
  _setRebootOnAccessForTests,
} from './boot-all';
import type { BootedHarnessHandle } from './boot';

const WS = 'ws-test';
const SLUG = 'deferred-harness';

let reboots: Array<{ workspaceId: string; harnessSlug: string }>;

beforeEach(() => {
  _resetHandleMapForTests();
  _resetEvictionTrackingForTests();
  reboots = [];
  _setRebootOnAccessForTests((workspaceId, harnessSlug) => {
    reboots.push({ workspaceId, harnessSlug });
  });
});

afterEach(() => {
  _resetHandleMapForTests();
  _resetEvictionTrackingForTests();
  vi.restoreAllMocks();
});

describe('deferred-harness wake eligibility (P-010)', () => {
  it('wakes a DEFERRED harness on access — the never-booted case', () => {
    enableSubstrateEvictionTracking();
    markHarnessActivationDeferred(WS, SLUG);

    expect(getBootedHarness(WS, SLUG)).toBeNull(); // still not resident this call
    expect(reboots).toEqual([{ workspaceId: WS, harnessSlug: SLUG }]);
  });

  it('wakes a DEFERRED harness on a captured local write (substrate_outbox NOTIFY)', () => {
    enableSubstrateEvictionTracking();
    markHarnessActivationDeferred(WS, SLUG);

    handleOutboxNotifyForEvictedHarness(WS, SLUG);
    expect(reboots).toEqual([{ workspaceId: WS, harnessSlug: SLUG }]);
  });

  // ── non-vacuity: the wake must not fire for harnesses nobody deferred ──────

  it('does NOT wake an unknown harness on access (the scoping guard still holds)', () => {
    enableSubstrateEvictionTracking();
    expect(getBootedHarness(WS, 'never-heard-of-it')).toBeNull();
    expect(reboots).toEqual([]);
  });

  it('does NOT wake an unknown harness on a NOTIFY (a stray payload must not boot anything)', () => {
    enableSubstrateEvictionTracking();
    handleOutboxNotifyForEvictedHarness(WS, 'some-other-workspace-harness');
    expect(reboots).toEqual([]);
  });

  // ── the wake is one-shot: a burst must not fan out into duplicate boots ────

  it('wakes only ONCE across repeated accesses (the flag is consumed)', () => {
    enableSubstrateEvictionTracking();
    markHarnessActivationDeferred(WS, SLUG);

    getBootedHarness(WS, SLUG);
    getBootedHarness(WS, SLUG);
    getBootedHarness(WS, SLUG);
    expect(reboots).toHaveLength(1);
  });

  it('wakes only ONCE when an access and a NOTIFY race the same deferred harness', () => {
    enableSubstrateEvictionTracking();
    markHarnessActivationDeferred(WS, SLUG);

    getBootedHarness(WS, SLUG);
    handleOutboxNotifyForEvictedHarness(WS, SLUG);
    expect(reboots).toHaveLength(1);
  });

  // ── the flag-OFF path stays byte-identical ────────────────────────────────

  it('records NOTHING while eviction tracking is off, so the eager path is unchanged', () => {
    // tracking deliberately NOT enabled
    markHarnessActivationDeferred(WS, SLUG);
    expect(deferredActivationCount()).toBe(0);

    getBootedHarness(WS, SLUG);
    handleOutboxNotifyForEvictedHarness(WS, SLUG);
    expect(reboots).toEqual([]);
  });

  it('tracks the deferred count for observability and clears it on wake', () => {
    enableSubstrateEvictionTracking();
    markHarnessActivationDeferred(WS, 'a');
    markHarnessActivationDeferred(WS, 'b');
    expect(deferredActivationCount()).toBe(2);

    getBootedHarness(WS, 'a');
    expect(deferredActivationCount()).toBe(1);
  });
});

/**
 * P-012 slice B (WI-6071) — the REMOTE wake path, the swarm-presence dual of the
 * outbox-NOTIFY path above. substrate-eviction-policy's header always described
 * the keepalive as "swarm presence + a LISTEN substrate_outbox watch", but only
 * the LISTEN half existed, so every wake trigger was LOCAL-side and a remote
 * push to a dark harness was unheard. These pin the third path to the SAME
 * safety properties as the other two — it must fire for both dark populations,
 * and must not fire spuriously.
 */
describe('remote-wake eligibility (P-012 slice B)', () => {
  const fakeHandle = (): BootedHarnessHandle =>
    ({ workspaceId: WS, harnessSlug: SLUG }) as unknown as BootedHarnessHandle;

  it('wakes a DEFERRED harness on a peer frame — the never-booted case', () => {
    enableSubstrateEvictionTracking();
    markHarnessActivationDeferred(WS, SLUG);

    expect(handleRemoteWakeForDarkHarness(WS, SLUG)).toBe(true);
    expect(reboots).toEqual([{ workspaceId: WS, harnessSlug: SLUG }]);
  });

  it('does NOT wake a harness whose engine is resident — the peer has a live partner', () => {
    enableSubstrateEvictionTracking();
    markHarnessActivationDeferred(WS, SLUG);
    _setHandleForTests(WS, SLUG, fakeHandle());

    expect(handleRemoteWakeForDarkHarness(WS, SLUG)).toBe(false);
    expect(reboots).toEqual([]);
  });

  it('does NOT wake a harness that was never evicted or deferred', () => {
    enableSubstrateEvictionTracking();

    expect(handleRemoteWakeForDarkHarness(WS, 'never-dark')).toBe(false);
    expect(reboots).toEqual([]);
  });

  it('fires only ONCE across a burst of peer frames (eligibility is consumed)', () => {
    enableSubstrateEvictionTracking();
    markHarnessActivationDeferred(WS, SLUG);

    expect(handleRemoteWakeForDarkHarness(WS, SLUG)).toBe(true);
    expect(handleRemoteWakeForDarkHarness(WS, SLUG)).toBe(false);
    expect(reboots).toHaveLength(1);
  });

  it('shares ONE eligibility with the local wake paths — a remote wake disarms them too', () => {
    enableSubstrateEvictionTracking();
    markHarnessActivationDeferred(WS, SLUG);

    handleRemoteWakeForDarkHarness(WS, SLUG);
    getBootedHarness(WS, SLUG);
    handleOutboxNotifyForEvictedHarness(WS, SLUG);
    expect(reboots).toHaveLength(1);
  });

  it('is inert while eviction tracking is off, so the eager path stays byte-identical', () => {
    // tracking deliberately NOT enabled
    markHarnessActivationDeferred(WS, SLUG);

    expect(handleRemoteWakeForDarkHarness(WS, SLUG)).toBe(false);
    expect(reboots).toEqual([]);
  });

  it('isHarnessEngineResident reports handle-map residency (the gossip residency probe)', () => {
    expect(isHarnessEngineResident(WS, SLUG)).toBe(false);
    _setHandleForTests(WS, SLUG, fakeHandle());
    expect(isHarnessEngineResident(WS, SLUG)).toBe(true);
    expect(isHarnessEngineResident(WS, 'other')).toBe(false);
  });

  it('residency is reported independently of eviction tracking', () => {
    // The probe must answer truthfully even on the flag-OFF path — the gossip
    // may be wired in a context where tracking was never enabled.
    _setHandleForTests(WS, SLUG, fakeHandle());
    expect(isHarnessEngineResident(WS, SLUG)).toBe(true);
  });
});
