/**
 * substrate-sidecar-observability.test.ts — recurrence guard for the bg-host
 * memory-leak hunt (bg-host-freeze-eventloop-stall-2026-06-30 P-005 / WI-1089).
 *
 * THE GAP THIS GUARDS. Under the `papercusp-substrate-sidecar` flag the whole
 * harness substrate (corestore + merge loops + Hyperswarm + replication) runs in
 * the SIDECAR process, so the freeze's +1GB/min RSS leak lives there. For a long
 * time the sidecar started NO `startEventLoopLagMonitor`, so the
 * heap-snapshot-on-high-RSS capture (P-002, main-process only) never saw the
 * leaking heap — the leak could not be pinpointed (WI-1088 conclusion). These
 * tests assert `runSubstrateSidecarServer`'s observability bootstrap
 * (`startSidecarObservability`) actually starts the per-process gauge, so the
 * sidecar can never again be shipped blind to its own leak.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startSidecarObservability } from './substrate-sidecar-server';
import { currentLoopLag, type LagMonitorHandle } from '../../event-loop-lag-monitor';

let handle: LagMonitorHandle | null = null;

afterEach(() => {
  // Stop the per-process monitor so each test starts from a clean gauge (stop()
  // clears the module-global live read + one-per-process guard).
  try {
    handle?.stop();
  } catch {
    /* best-effort */
  }
  handle = null;
});

describe('substrate sidecar observability (P-005 leak instrumentation)', () => {
  it('starts an event-loop-lag monitor so the sidecar leak self-pinpoints', () => {
    handle = startSidecarObservability();
    expect(handle).not.toBeNull();
    // The live loop-lag gauge is now published IN THIS PROCESS — the prerequisite
    // for heap-snapshot-on-high-RSS to ever fire in the sidecar.
    expect(currentLoopLag()).not.toBeNull();
  });

  it('still starts the always-on gauge when the capture knobs are disabled', () => {
    const prev = {
      heap: process.env.PAPERCUSP_HEAP_SNAPSHOT,
      sidecarHeap: process.env.PAPERCUSP_SIDECAR_HEAP_SNAPSHOT,
      prof: process.env.PAPERCUSP_LOOP_PROFILER,
      sidecarProf: process.env.PAPERCUSP_SIDECAR_LOOP_PROFILER,
    };
    process.env.PAPERCUSP_HEAP_SNAPSHOT = '0';
    process.env.PAPERCUSP_LOOP_PROFILER = '0';
    delete process.env.PAPERCUSP_SIDECAR_HEAP_SNAPSHOT;
    delete process.env.PAPERCUSP_SIDECAR_LOOP_PROFILER;
    try {
      handle = startSidecarObservability();
      // Capture is opt-out-able, but the cheap always-on lag gauge must still run
      // (it is the live-pressure signal + the RSS-watch host for the snapshot).
      expect(handle).not.toBeNull();
      expect(currentLoopLag()).not.toBeNull();
    } finally {
      restoreEnv('PAPERCUSP_HEAP_SNAPSHOT', prev.heap);
      restoreEnv('PAPERCUSP_SIDECAR_HEAP_SNAPSHOT', prev.sidecarHeap);
      restoreEnv('PAPERCUSP_LOOP_PROFILER', prev.prof);
      restoreEnv('PAPERCUSP_SIDECAR_LOOP_PROFILER', prev.sidecarProf);
    }
  });

  it('is best-effort: returns a handle without throwing', () => {
    expect(() => {
      handle = startSidecarObservability();
    }).not.toThrow();
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
