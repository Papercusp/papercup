import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../cell-registrations-wiring';

const { sqlMock, controlMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  controlMock: vi.fn(),
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));
vi.mock('../../workspace-registry', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  activeWorkspaceId: () => 'ws-default',
}));
vi.mock('../../gateway-control/control-harness', () => ({ runControlMutation: controlMock }));

const tool = (await import('./revert')).default;

const previous = {
  triggerConfig: { cron: '0 */30 * * * *', throttle_min: 2 },
  payloadTemplate: { payload: { budget: { maxIdeators: 1 } } },
  active: true,
  nextFireAtIso: '2030-01-01T00:00:00.000Z',
  groupSlug: null,
  metadata: { source: 'before' },
};
const next = {
  triggerConfig: { cron: '0 */10 * * * *', throttle_min: 4 },
  payloadTemplate: { payload: { budget: { maxIdeators: 4 } } },
  active: true,
  nextFireAtIso: '2030-01-01T00:10:00.000Z',
  groupSlug: null,
  metadata: { source: 'after' },
};

function body(result: unknown): Record<string, unknown> {
  const out = result as { content: Array<{ text: string }> };
  return JSON.parse(out.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  controlMock.mockImplementation(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) return { dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    const applied = await spec.apply();
    const verify = spec.verify ? await spec.verify(applied) : undefined;
    return { dryRun: false, applied: true, prev, next: applied, verify, auditId: 'gwc-revert-1' };
  });
});

describe('routines:revert MCP boundary', () => {
  it('loads audited snapshots, restores the exact prior state, and tags the new audit with source id', async () => {
    sqlMock
      .mockResolvedValueOnce([
        {
          action: 'gateway-control.routines:set',
          subject: 'calendar/cross-hive-outbox-drain',
          details: { prev: previous, next },
        },
      ])
      .mockResolvedValueOnce([next])
      .mockResolvedValueOnce([next])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([previous]);

    const result = body(
      await tool.handler({ auditId: 'gwc-source-1' } as never, { role: 'operator' } as never),
    );

    expect(result).toMatchObject({
      ok: true,
      routine: 'calendar/cross-hive-outbox-drain',
      sourceAuditId: 'gwc-source-1',
      applied: true,
      auditId: 'gwc-revert-1',
      verify: { ok: true },
    });
    expect(controlMock).toHaveBeenCalledOnce();
    expect(controlMock.mock.calls[0]![0]).toMatchObject({
      action: 'routines:set:revert',
      subject: 'calendar/cross-hive-outbox-drain',
      revertOf: 'gwc-source-1',
    });
    expect(sqlMock).toHaveBeenCalledTimes(5);
  });

  it('refuses to overwrite a routine changed after the source audit', async () => {
    sqlMock
      .mockResolvedValueOnce([
        {
          action: 'gateway-control.routines:set',
          subject: 'calendar/cross-hive-outbox-drain',
          details: { prev: previous, next },
        },
      ])
      .mockResolvedValueOnce([{ ...next, active: false }]);

    await expect(
      tool.handler({ auditId: 'gwc-source-1' } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/changed after audit.*refusing/i);
    expect(sqlMock).toHaveBeenCalledTimes(3);
  });

  it('rejects an audit id from another control action', async () => {
    sqlMock.mockResolvedValueOnce([
      { action: 'gateway-control.quota:set_tool', subject: 'thing', details: { prev: {}, next: {} } },
    ]);

    await expect(
      tool.handler({ auditId: 'gwc-not-routines' } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/not a routines:set mutation/i);
    expect(controlMock).not.toHaveBeenCalled();
  });
});
