import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveWakeMode, setWakeMode, getDefaultWakeMode, setDefaultWakeMode } = vi.hoisted(() => ({
  resolveWakeMode: vi.fn(),
  setWakeMode: vi.fn(),
  getDefaultWakeMode: vi.fn(),
  setDefaultWakeMode: vi.fn(),
}));

vi.mock('../wake-mode', () => ({
  resolveWakeMode,
  setWakeMode,
  getDefaultWakeMode,
  setDefaultWakeMode,
}));

import wakeMode from './wake-mode';

const parse = (input: unknown) => wakeMode.args.parse(input) as never;
const body = async (args: unknown) => {
  const result = (await wakeMode.handler(args as never, {} as never)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveWakeMode.mockResolvedValue('manual');
  getDefaultWakeMode.mockResolvedValue('auto');
});

describe('coord:wake-mode handler', () => {
  it('accepts and forwards a bounded per-agent reason', async () => {
    const args = parse({ agent: 'su-target', mode: 'manual', reason: 'fence the stale leader' });
    const out = await body(args);

    expect(setWakeMode).toHaveBeenCalledWith('su-target', 'manual', 'fence the stale leader');
    expect(setDefaultWakeMode).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, agent: 'su-target', mode: 'manual', default: 'auto' });
  });

  it('forwards a global-mode reason to the durable default setting', async () => {
    const args = parse({ mode: 'auto', reason: 'replacement leader is live' });
    const out = await body(args);

    expect(setDefaultWakeMode).toHaveBeenCalledWith('auto', 'replacement leader is live');
    expect(setWakeMode).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, agent: null, mode: 'auto', default: 'auto' });
  });

  it('bounds the reason to 500 characters', () => {
    expect(() => parse({ mode: 'manual', reason: 'x'.repeat(501) })).toThrow();
  });
});
