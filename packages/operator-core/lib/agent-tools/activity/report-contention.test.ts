/**
 * report-contention.test.ts — activity:report is FIRE-AND-FORGET telemetry (EI-7439).
 *
 * The per-CLI hooks call activity:report detached on EVERY native tool call, and the
 * telemetry INSERT runs on the harness_admin org pool whose role default caps a lock
 * wait at `lock_timeout=15s`. Under transient heavyweight-lock contention on
 * harness_shared.agent_activity that INSERT can raise `canceling statement due to lock
 * timeout` (pg 55P03) — but a dropped fleet-view row is benign (it self-heals on the
 * worker's next report), so it must be a SOFT no-op, never a hard `handler_error` that
 * the improvement-watchdog counts as "activity:report is failing" (the bug this guards).
 *
 * A GENUINE (non-contention) fault must still surface — we don't want to mask a real
 * DB-down / bug behind the drop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ record: vi.fn(), arm: vi.fn(), cancel: vi.fn(), heal: vi.fn() }));

vi.mock('@papercusp/activity-bridge', () => ({ recordActivity: h.record }));
vi.mock('../../activity-pg-store', () => ({ createPgTelemetryStore: () => ({}) }));
vi.mock('../../events/await/inbox-wake-arm', () => ({
  armInboxWake: h.arm,
  cancelInboxWake: h.cancel,
  ensureInboxWakeArmedForActiveSession: h.heal,
}));

const tool = (await import('./report')).default;
const ctx = { principal: { workspaceId: '*' } } as unknown as Parameters<typeof tool.handler>[1];
const run = (args: Record<string, unknown>) =>
  tool.handler(args as Parameters<typeof tool.handler>[0], ctx);

/** A pg lock_timeout error as postgres.js surfaces it: SQLSTATE on `.code`. */
function lockTimeoutError(): Error & { code: string } {
  return Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
}

beforeEach(() => {
  h.record.mockReset().mockResolvedValue({ id: '42' });
  h.arm.mockReset().mockResolvedValue({ awaitId: 1, eventKey: 'coord:inbox-wake:x', handleNote: 'ok' });
  h.cancel.mockReset().mockResolvedValue(1);
  h.heal.mockReset().mockResolvedValue(false);
});

describe('activity:report — telemetry INSERT is fire-and-forget under contention (EI-7439)', () => {
  it('a transient lock_timeout (55P03) is a SOFT drop, not a hard tool error', async () => {
    h.record.mockRejectedValueOnce(lockTimeoutError());
    const res = await run({ owner: 'su-abc', kind: 'tool', tool_name: 'Edit', summary: 'edited a file' });
    const content = (res as { isError?: boolean; content: { text: string }[] }).content;
    // Not a hard error result …
    expect((res as { isError?: boolean }).isError).toBeUndefined();
    // … and a soft, honest body: accepted (ok) but not persisted (id null + dropped marker).
    expect(JSON.parse(content[0].text)).toMatchObject({ ok: true, id: null, dropped: 'contention' });
  });

  it('a statement_timeout (57014) is likewise a soft drop', async () => {
    h.record.mockRejectedValueOnce(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    const res = await run({ owner: 'su-abc', kind: 'tool', tool_name: 'Bash', summary: 'ran a command' });
    const content = (res as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0].text)).toMatchObject({ ok: true, id: null, dropped: 'contention' });
  });

  it('a GENUINE (non-contention) error still surfaces — the drop never masks a real fault', async () => {
    h.record.mockRejectedValueOnce(new Error('relation does not exist'));
    await expect(run({ owner: 'su-abc', kind: 'tool', tool_name: 'Edit', summary: 'x' })).rejects.toThrow(
      /relation does not exist/,
    );
  });

  it('the happy path is unchanged — a clean INSERT returns { ok, id }', async () => {
    const res = await run({ owner: 'su-abc', kind: 'tool', tool_name: 'Read', summary: 'read a file' });
    const content = (res as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0].text)).toMatchObject({ ok: true, id: '42' });
  });
});
