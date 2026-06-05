import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { emitIpcTrace } from '@papercusp/desktop-ipc';
import { installIpcInspector, type IpcInspectorApi } from './ipc-inspector-client';

// installIpcInspector publishes window.__ipcInspector and wires the recorder
// into the lib seam, so emitIpcTrace(...) feeds the buffer it reads.
beforeAll(() => {
  (globalThis as unknown as { window: Record<string, unknown> }).window ??= {};
  installIpcInspector();
});

function api(): IpcInspectorApi {
  return (globalThis as unknown as { window: { __ipcInspector: IpcInspectorApi } }).window
    .__ipcInspector;
}

beforeEach(() => api().clear());

describe('ipc-inspector recorder — churn()', () => {
  it('one construction across drops → OK verdict (the fix working)', () => {
    emitIpcTrace({ kind: 'es-open', id: 1, path: '/api/zero-harness/sse' });
    emitIpcTrace({ kind: 'es-connect', id: 1, path: '/api/zero-harness/sse' });
    emitIpcTrace({ kind: 'es-drop', id: 1, path: '/api/zero-harness/sse' });
    emitIpcTrace({ kind: 'es-connect', id: 1, path: '/api/zero-harness/sse' });
    const rows = api().churn();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      path: '/api/zero-harness/sse',
      constructions: 1,
      connects: 2,
      drops: 1,
    });
    expect(rows[0]!.verdict).toContain('OK');
  });

  it('many constructions for one URL → churn warning (the bug)', () => {
    for (let i = 1; i <= 4; i++) {
      emitIpcTrace({ kind: 'es-open', id: i, path: '/api/zero-harness/sse' });
      emitIpcTrace({ kind: 'es-connect', id: i, path: '/api/zero-harness/sse' });
    }
    const rows = api().churn();
    expect(rows[0]!.constructions).toBe(4);
    expect(rows[0]!.verdict).toContain('⚠');
  });
});

describe('ipc-inspector recorder — summary()', () => {
  it('correlates done/error terminals to their start route by id', () => {
    emitIpcTrace({ kind: 'invoke', id: 1, tool: 'sys:http', method: 'POST', path: '/api/ui/presence' });
    emitIpcTrace({ kind: 'invoke-done', id: 1, tool: 'sys:http' }); // no path on terminal
    emitIpcTrace({ kind: 'invoke', id: 2, tool: 'sys:http', method: 'POST', path: '/api/ui/presence' });
    // id 2 left in-flight (no terminal)
    const rows = api().summary();
    const presence = rows.find((r) => r.key.includes('/api/ui/presence'));
    expect(presence).toBeDefined();
    expect(presence).toMatchObject({ started: 2, done: 1, error: 0, open: 1 });
    expect(presence!.key).toBe('sys:http POST /api/ui/presence');
  });

  it('groups direct-dispatch tools under their tool name', () => {
    emitIpcTrace({ kind: 'invoke', id: 5, tool: 'operator:scan' });
    emitIpcTrace({ kind: 'invoke-error', id: 5, tool: 'operator:scan', detail: 'boom' });
    const row = api().summary().find((r) => r.key === 'operator:scan');
    expect(row).toMatchObject({ started: 1, error: 1, open: 0 });
  });
});

describe('ipc-inspector recorder — events()', () => {
  it('filters by path substring and by kind', () => {
    emitIpcTrace({ kind: 'es-open', id: 1, path: '/api/zero-harness/sse' });
    emitIpcTrace({ kind: 'es-open', id: 2, path: '/api/logs/stream' });
    emitIpcTrace({ kind: 'es-drop', id: 1, path: '/api/zero-harness/sse' });
    expect(api().events({ path: 'zero-harness' })).toHaveLength(2);
    expect(api().events({ kind: 'es-open' })).toHaveLength(2);
    expect(api().events({ path: 'logs', kind: 'es-open' })).toHaveLength(1);
  });
});
