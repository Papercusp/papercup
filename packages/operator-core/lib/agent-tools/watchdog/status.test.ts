import { beforeEach, describe, expect, it, vi } from 'vitest';
import statusTool from './status';
import { readScheduledWatchdogStatus } from '../../watchdog/status';

vi.mock('../../watchdog/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../watchdog/status')>();
  return { ...actual, readScheduledWatchdogStatus: vi.fn() };
});

const readStatus = vi.mocked(readScheduledWatchdogStatus);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    statusTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    }
  ).handler(args, ctx);
}

describe('watchdog:status tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readStatus.mockResolvedValue({ ok: true, effectiveState: 'healthy-idle' } as never);
  });

  it('requires a concrete harness in operator scope', async () => {
    const result = await callTool({ id: 'su-ideate-ungraded' }, { workspaceId: 'ws', harnessSlug: '*' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, error: 'harness_required' });
    expect(readStatus).not.toHaveBeenCalled();
  });

  it('uses explicit scope over request context and returns the joined status', async () => {
    const result = await callTool(
      { id: 'su-ideate-ungraded', scope: { workspace: 'ws-arg', harness: 'pot-arg' } },
      { workspaceId: 'ws-ctx', harnessSlug: 'pot-ctx' },
    );
    expect(readStatus).toHaveBeenCalledWith({
      id: 'su-ideate-ungraded',
      workspaceId: 'ws-arg',
      harnessSlug: 'pot-arg',
    });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: true, effectiveState: 'healthy-idle' });
  });
});
