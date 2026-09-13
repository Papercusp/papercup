import { describe, expect, it, vi } from 'vitest';

vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
}));

const tool = (await import('./digest')).default;

type Handler = (args: unknown, ctx: unknown) => Promise<unknown>;

function handler(): Handler {
  return (tool as unknown as { handler: Handler }).handler;
}

describe('sessions:digest time-window bounds', () => {
  it('normalizes a documented relative since window before binding PostgreSQL', async () => {
    const before = Date.now();
    const boundValues: unknown[] = [];
    const tx = vi.fn(async (_strings: unknown, ...values: unknown[]) => {
      boundValues.push(...values);
      return [];
    });

    const result = await handler()({ since: '14d' }, { workspaceId: 'ws-test', tx });

    expect(tx).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ data: { ok: true, count: 0, total: 0, digests: [] } });
    const resolvedSince = boundValues.find(
      (value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value),
    );
    expect(resolvedSince).toBeDefined();
    expect(Math.abs(Date.parse(resolvedSince!) - (before - 14 * 86_400_000))).toBeLessThan(10_000);
    expect(boundValues).not.toContain('14d');
  });

  it('rejects an invalid since bound before opening a database query', async () => {
    const tx = vi.fn();

    const result = await handler()({ since: 'yesterday-ish' }, { workspaceId: 'ws-test', tx });

    expect(tx).not.toHaveBeenCalled();
    const text = (result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(text).error).toContain('relative window like "45m", "12h", "7d"');
  });
});
