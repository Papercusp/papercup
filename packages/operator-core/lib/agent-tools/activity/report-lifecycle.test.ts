/**
 * report-lifecycle.test.ts — activity:report's always-arm side effect
 * (turn-lifecycle-control-2026-06-08 P-003/P-004/P-008).
 *
 * A lifecycle report (SessionStart / SessionEnd) must (un)arm the worker's
 * inbox-wake watch — the universal, client-agnostic arm point (D-001). A tool
 * report, or an unrecognized lifecycle summary, must not. Mocks the PG sink +
 * the arm primitive so this stays a pure handler unit test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ arm: vi.fn(), cancel: vi.fn() }));

vi.mock('@papercusp/activity-bridge', () => ({ recordActivity: vi.fn(async () => ({ id: 42 })) }));
vi.mock('../../activity-pg-store', () => ({ createPgTelemetryStore: () => ({}) }));
vi.mock('../../events/await/inbox-wake-arm', () => ({ armInboxWake: h.arm, cancelInboxWake: h.cancel }));

const tool = (await import('./report')).default;
const ctx = { principal: { workspaceId: '*' } } as unknown as Parameters<typeof tool.handler>[1];
const run = (args: Record<string, unknown>) =>
  tool.handler(args as Parameters<typeof tool.handler>[0], ctx);

beforeEach(() => {
  h.arm.mockReset().mockResolvedValue({ awaitId: 1, eventKey: 'coord:inbox-wake:x', handleNote: 'ok' });
  h.cancel.mockReset().mockResolvedValue(1);
});

describe('activity:report lifecycle → inbox-wake (always-arm)', () => {
  it('SessionStart (▶ session started) ARMS the worker inbox-wake watch', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started', session_id: 'sid', agent: 'claude' });
    expect(h.arm).toHaveBeenCalledTimes(1);
    expect(h.arm.mock.calls[0][0]).toMatchObject({ ownerId: 'su-abc' });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('SessionEnd (■ session ended) CANCELS the worker inbox-wake watch (D-003)', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.cancel.mock.calls[0][0]).toBe('su-abc');
    expect(h.arm).not.toHaveBeenCalled();
  });

  it('a non-lifecycle (tool) report neither arms nor cancels', async () => {
    await run({ owner: 'su-abc', kind: 'tool', tool_name: 'Edit', summary: 'edited a file' });
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('an unrecognized lifecycle summary is a defensive no-op', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: 'todos updated' });
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('an arm failure never breaks the activity report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.arm.mockRejectedValueOnce(new Error('pg down'));
    const res = await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started' });
    // The report still returns ok despite the arm hiccup (the warn is best-effort).
    expect(JSON.parse((res.content[0] as { text: string }).text)).toMatchObject({ ok: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
