/**
 * Regression test for EI-18758340172989350: the leader-bridge SSE stream
 * getting duplicated when this module is evaluated more than once in the
 * same page (a dual-bundling edge case — two different bundler-resolved
 * specifiers landing on the same physical file each get their own copy of
 * module-level state).
 *
 * A module-level `let active = ...` cannot defend against this: each
 * evaluation of the module has its OWN `active`, so one instance's
 * `reconnect()` never sees — and therefore never closes — the OTHER
 * instance's stream, leaving two identical EventSources open to the same
 * URL. The fix parks the singleton on `globalThis` instead, so it is
 * necessarily shared no matter how many times the module gets evaluated.
 *
 * This test simulates "evaluated twice" the same way two separate bundled
 * copies would behave: `vi.resetModules()` between imports gives each
 * import its own fresh module instance (own closures, own module-level
 * `let`s) while still running in the same JS realm — exactly the shared-
 * `globalThis` / independent-module-scope shape a real dual-bundle produces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Reset through the module's OWN seam, never by deleting a globalThis key: the
// state is realm-pinned via pinModuleState, so a key-delete would target the
// storage LOCATION and silently reset nothing (EI-19479108855357092). This
// statically-imported instance's reset mutates the SAME shared object that
// every dynamically re-imported instance below reads — which is exactly the
// property the pin provides, so importing it once up here is sufficient.
import { resetLeaderBridgeForTest } from './leader-bridge';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  readyState = 0;
  private listeners = new Map<string, Set<(ev: unknown) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, cb: (ev: unknown) => void): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(cb);
  }
  removeEventListener(name: string, cb: (ev: unknown) => void): void {
    this.listeners.get(name)?.delete(cb);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

describe('startLeaderBridge — cross-module-instance dedupe', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    (globalThis as Record<string, unknown>).EventSource = FakeEventSource;
    resetLeaderBridgeForTest();
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).EventSource;
    resetLeaderBridgeForTest();
  });

  it('closes a stream opened by a PRIOR module instance instead of leaving it live', async () => {
    const opts = {
      getWorkspace: () => 'ws1',
      isLeader: () => true,
      onLeaderChange: () => () => {},
      tabId: 'tab-fixed',
    };

    // "Instance A" of the module.
    const modA = await import('./leader-bridge');
    modA.startLeaderBridge(opts);
    expect(FakeEventSource.instances).toHaveLength(1);
    const first = FakeEventSource.instances[0];
    expect(first.closed).toBe(false);

    // Simulate a second, independently-evaluated copy of the SAME module
    // (as a genuine dual bundle would produce) reconnecting for the same
    // tab/workspace — the real-world trigger being e.g. a popstate re-bridge
    // firing from whichever copy the browser happened to run.
    vi.resetModules();
    const modB = await import('./leader-bridge');
    modB.startLeaderBridge(opts);

    // The first stream must have been closed by instance B (via the shared
    // globalThis singleton) — never left orphaned and still connected.
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    const second = FakeEventSource.instances[1];
    expect(second.closed).toBe(false);

    // Exactly one LIVE stream at a time, however many module instances exist.
    const liveCount = FakeEventSource.instances.filter((es) => !es.closed).length;
    expect(liveCount).toBe(1);
  });

  it('a single module instance still closes its own prior stream on reconnect (no regression)', async () => {
    const opts = {
      getWorkspace: () => 'ws1',
      isLeader: () => true,
      onLeaderChange: () => () => {},
      tabId: 'tab-fixed',
    };
    const mod = await import('./leader-bridge');
    mod.startLeaderBridge(opts);
    expect(FakeEventSource.instances).toHaveLength(1);

    // Same instance, reconnect again (e.g. a real popstate handler).
    mod.startLeaderBridge(opts);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(FakeEventSource.instances[1].closed).toBe(false);
  });
});
