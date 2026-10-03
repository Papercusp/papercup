import { describe, expect, it, vi } from 'vitest';
vi.mock('../../code-intelligence/lsp-daemon-client', () => ({ readLspDaemonAdmission: vi.fn() }));
import { buildLspAdmissionStatePayload } from './lsp-admission';
import { LspAdmissionController } from '../../code-intelligence/lsp-admission';
import { LSP_ADMISSION_CELL } from '../../cell-registrations';
import { validateCellSpec } from '../../cell-registry';

describe('daemon LSP admission state lens', () => {
  it('registers a valid cell and reads actual pressure from the owning controller', async () => {
    let done!: () => void;
    const held = new Promise<void>(resolve => { done = resolve; });
    const controller = new LspAdmissionController({ enqueue: async () => ({ start: async () => {}, finish: async () => {}, cancel: async () => {} }) });
    const context = { workspaceId: 'ws', language: 'typescript', projectRoot: '/repo', op: 'references', deadlineAtMs: Date.now() + 10_000 };
    const first = controller.run({ ...context, requestId: 'first' }, () => held);
    const second = controller.run({ ...context, requestId: 'second' }, async () => {});
    expect(validateCellSpec(LSP_ADMISSION_CELL)).toEqual([]);
    const read = vi.fn(async () => controller.snapshot());
    const payload = await buildLspAdmissionStatePayload('ws', read);
    expect(read).toHaveBeenCalledWith('ws');
    expect(payload).toMatchObject({ assessment: 'pressure', measurement: 'measured', unknown: [], admission: { queued: 1, inFlight: 1, measured: true } });
    done(); await Promise.all([first, second]);
    expect(await buildLspAdmissionStatePayload('ws', read)).toMatchObject({ assessment: 'idle', admission: { queued: 0, inFlight: 0 } });
  });

  it('exposes unknown on transport failure or stale state rather than a false empty queue', async () => {
    const failed = await buildLspAdmissionStatePayload('ws', async () => { throw new Error('socket unavailable'); });
    expect(failed).toMatchObject({ admission: null, assessment: 'unknown', measurement: 'unknown' });
    expect(failed.unknown[0]).toContain('socket unavailable');
    const controller = new LspAdmissionController({ enqueue: vi.fn() });
    const stale = await buildLspAdmissionStatePayload('ws', async () => ({ ...controller.snapshot(), sampledAtMs: Date.now() - 30_001 }));
    expect(stale).toMatchObject({ admission: null, assessment: 'unknown' });
  });
});
