import { describe, it, expect, beforeEach, vi } from 'vitest';
import setEnabledTool from './set_enabled';
import { getFlag } from '@papercusp/flags/server';
import { setPackEnabled } from '../../learning-packs/manage';

// PG-free unit: the mute/unmute core has its own suite; this pins the TOOL —
// flag gate, the workspace + arg wiring, and the { ...result, pack, enabled }
// envelope (learning-packs-2026-06-11 P-009).
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-active') }));
vi.mock('../../learning-packs/manage', () => ({ setPackEnabled: vi.fn() }));

const mockFlag = vi.mocked(getFlag);
const mockSet = vi.mocked(setPackEnabled);

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    setEnabledTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe('learning_packs:set_enabled tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockSet.mockResolvedValue({ ok: true } as unknown as Awaited<ReturnType<typeof setPackEnabled>>);
  });

  it('refuses when the flag is off', async () => {
    mockFlag.mockResolvedValue(false);
    expect(body(await callTool({ hive: 'h', pack: 'p1', enabled: false }))).toMatchObject({ ok: false, reason: 'feature-disabled' });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('wires the workspace + hive + pack + enabled through to the core', async () => {
    await callTool({ hive: 'h', pack: 'p1', enabled: false }, { principal: { workspaceId: 'ws-prin' } });
    expect(mockSet).toHaveBeenCalledWith({ workspaceId: 'ws-prin', hiveSlug: 'h', packId: 'p1', enabled: false });
  });

  it('echoes pack + enabled in the envelope', async () => {
    expect(body(await callTool({ hive: 'h', pack: 'p1', enabled: true }))).toMatchObject({ ok: true, pack: 'p1', enabled: true });
  });
});
