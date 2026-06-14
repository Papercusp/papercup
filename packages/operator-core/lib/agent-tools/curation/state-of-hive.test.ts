import { describe, it, expect, beforeEach, vi } from 'vitest';
import stateOfHiveTool from './state-of-hive';
import { synthesizeStateOfHive } from '../../scout/corpus-digest';
import { buildStateOfHiveReaders } from '../../scout/corpus-digest-deps';

// PG-free unit: synthesizeStateOfHive has its own suite; this pins the tool's
// perCategory default + pass-through and the { ok, digest } envelope
// (hive-creative-ideation-2026-06-08 P-003 / build-item B1).
vi.mock('../../scout/corpus-digest');
vi.mock('../../scout/corpus-digest-deps');

const mockSynth = vi.mocked(synthesizeStateOfHive);
const mockReaders = vi.mocked(buildStateOfHiveReaders);

const DIGEST = { friction: [], sinks: [], deferrals: [], gaps: [] } as unknown as Awaited<
  ReturnType<typeof synthesizeStateOfHive>
>;

function callTool(args: Record<string, unknown>) {
  return (
    stateOfHiveTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, {});
}

describe('curation:state-of-hive tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReaders.mockReturnValue({} as ReturnType<typeof buildStateOfHiveReaders>);
    mockSynth.mockResolvedValue(DIGEST);
  });

  it('defaults perCategory to 20', async () => {
    await callTool({});
    expect(mockSynth).toHaveBeenCalledWith({}, { nowMs: expect.any(Number), perCategory: 20 });
  });

  it('passes an explicit perCategory through', async () => {
    await callTool({ perCategory: 75 });
    expect(mockSynth).toHaveBeenCalledWith({}, { nowMs: expect.any(Number), perCategory: 75 });
  });

  it('returns { ok:true, digest } verbatim', async () => {
    const res = await callTool({});
    const body = JSON.parse(res.content[0].text);
    expect(body).toEqual({ ok: true, digest: DIGEST });
  });
});
