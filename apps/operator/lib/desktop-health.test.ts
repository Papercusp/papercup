/**
 * desktop-health — P-019 decision logic (fleet-coordination-painpoints).
 *
 * The signal-gatherers are injected so the up/down/present decision is tested
 * without a live desktop, bridge, IPC socket, or PG.
 */
import { describe, it, expect } from 'vitest';
import { probeDesktop, type DesktopSignals, type LiveBridge } from './desktop-health';

const BRIDGE: LiveBridge = { port: 43379, token: 'tok', pid: 4242 };

function signals(over: Partial<DesktopSignals> = {}): DesktopSignals {
  return {
    liveBridge: async () => BRIDGE,
    bridgeEval: async () => true,
    ipcConnectable: async () => true,
    recentErrorCount: async () => 0,
    ...over,
  };
}

describe('probeDesktop', () => {
  it('reports present:false (not up, no alert) when no desktop is running', async () => {
    const r = await probeDesktop(signals({ liveBridge: async () => null }));
    expect(r.present).toBe(false);
    expect(r.up).toBe(false);
    expect(r.name).toBe('desktop');
    expect(r.note).toMatch(/not running/i);
  });

  it('is up when the bridge eval AND the IPC socket are both alive', async () => {
    const r = await probeDesktop(signals());
    expect(r.present).toBe(true);
    expect(r.up).toBe(true);
    expect(r.note).toBe('up');
    expect(r.recentErrors).toBe(0);
  });

  it('stays up but surfaces recent error toasts in the note + count', async () => {
    const r = await probeDesktop(signals({ recentErrorCount: async () => 3 }));
    expect(r.up).toBe(true);
    expect(r.recentErrors).toBe(3);
    expect(r.note).toMatch(/3 recent error toasts/);
  });

  it('singularizes one error toast', async () => {
    const r = await probeDesktop(signals({ recentErrorCount: async () => 1 }));
    expect(r.note).toMatch(/1 recent error toast(?!s)/);
  });

  it('is DOWN (present) when the webview eval fails — names the failed signal', async () => {
    const r = await probeDesktop(signals({ bridgeEval: async () => false }));
    expect(r.present).toBe(true);
    expect(r.up).toBe(false);
    expect(r.note).toMatch(/webview eval/);
    expect(r.note).not.toMatch(/ipc socket/);
  });

  it('is DOWN when the IPC socket is unreachable (the Plans-hang class) — names it', async () => {
    const r = await probeDesktop(signals({ ipcConnectable: async () => false }));
    expect(r.up).toBe(false);
    expect(r.note).toMatch(/ipc socket/);
    expect(r.note).not.toMatch(/webview eval/);
  });

  it('names both failed signals + the error toasts when everything is unhealthy', async () => {
    const r = await probeDesktop(
      signals({
        bridgeEval: async () => false,
        ipcConnectable: async () => false,
        recentErrorCount: async () => 2,
      }),
    );
    expect(r.up).toBe(false);
    expect(r.note).toMatch(/webview eval/);
    expect(r.note).toMatch(/ipc socket/);
    expect(r.note).toMatch(/2 recent error toasts/);
  });

  it('treats a throwing signal as a failed signal (never rejects)', async () => {
    const r = await probeDesktop(
      signals({
        bridgeEval: async () => {
          throw new Error('bridge blew up');
        },
      }),
    );
    expect(r.up).toBe(false);
    expect(r.note).toMatch(/webview eval/);
  });

  it('reports present:false when the liveBridge gatherer itself throws', async () => {
    const r = await probeDesktop(
      signals({
        liveBridge: async () => {
          throw new Error('readdir /tmp failed');
        },
      }),
    );
    expect(r.present).toBe(false);
    expect(r.up).toBe(false);
  });
});
