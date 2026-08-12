import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: vi.fn(),
}));

vi.mock('../../tool-call-log-store', () => ({
  toolCallRowsFor: h.rows,
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'owner-test' }),
}));

const { default: tool } = await import('./tool-log');

type ArgsSchema = {
  safeParse: (value: unknown) => { success: boolean; data?: Record<string, unknown> };
};
type Guidance = { when?: string };

const argsSchema = (tool as unknown as { args: ArgsSchema }).args;
const guidance = (tool as unknown as { guidance?: Guidance }).guidance;

describe('activity:tool-log timestamp boundaries', () => {
  it('rejects relative durations before they reach the timestamptz query', () => {
    expect(argsSchema.safeParse({ owner: 'self', since: '-15 min' }).success).toBe(false);
    expect(argsSchema.safeParse({ owner: 'self', until: '10m' }).success).toBe(false);
    expect(h.rows).not.toHaveBeenCalled();
  });

  it('accepts offset ISO timestamps and normalizes them to UTC for the store', async () => {
    const parsed = argsSchema.safeParse({
      owner: 'self',
      since: '2026-08-12T18:00:00-04:00',
      until: '2026-08-12T19:30:00+01:00',
      max_lines: 5,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || !parsed.data) throw new Error('expected valid tool args');

    h.rows.mockResolvedValueOnce([]);
    await tool.handler(parsed.data as never, {} as never);

    expect(h.rows).toHaveBeenCalledWith({
      ownerId: 'owner-test',
      sessionId: undefined,
      sinceIso: '2026-08-12T22:00:00.000Z',
      untilIso: '2026-08-12T18:30:00.000Z',
    });
  });

  it('documents that both boundaries are absolute ISO timestamps', () => {
    expect(guidance?.when ?? '').toMatch(/absolute ISO 8601 timestamps/i);
    expect(guidance?.when ?? '').toMatch(/relative durations.*not supported/i);
  });
});
