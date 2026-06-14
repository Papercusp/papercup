import { describe, it, expect, beforeEach, vi } from 'vitest';
import sweepTool from './sweep';
import { getFlag } from '@papercusp/flags/server';
import { sweepHiveConflicts } from '../../learning-packs/manage';

// PG-free unit: the conflict sweep core has its own suite; this pins the TOOL —
// flag gate, the hive pass-through, and the { ok, ...result } envelope
// (learning-packs-2026-06-11 P-012).
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../../learning-packs/manage', () => ({ sweepHiveConflicts: vi.fn() }));

const mockFlag = vi.mocked(getFlag);
const mockSweep = vi.mocked(sweepHiveConflicts);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    sweepTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe('learning_packs:sweep tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockSweep.mockResolvedValue({ pairs: [], scanned: 12 } as unknown as Awaited<ReturnType<typeof sweepHiveConflicts>>);
  });

  it('refuses when the flag is off', async () => {
    mockFlag.mockResolvedValue(false);
    expect(body(await callTool({ hive: 'h' }))).toMatchObject({ ok: false, reason: 'feature-disabled' });
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('sweeps the named hive and merges the result into an ok envelope', async () => {
    const res = body(await callTool({ hive: 'my-hive' }));
    expect(mockSweep).toHaveBeenCalledWith({ hiveSlug: 'my-hive' });
    expect(res).toMatchObject({ ok: true, scanned: 12, pairs: [] });
  });
});
