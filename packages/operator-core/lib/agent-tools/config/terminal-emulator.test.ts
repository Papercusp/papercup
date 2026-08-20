import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readMock, writeMock } = vi.hoisted(() => ({
  readMock: vi.fn(),
  writeMock: vi.fn(),
}));

vi.mock('../../agent-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-config')>()),
  readAgentConfig: readMock,
  writeAgentConfig: writeMock,
}));

import tool from './terminal-emulator';

describe('config:terminal-emulator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readMock.mockResolvedValue({ backend: 'codex', cmd: '', models: {}, terminal: '' });
    writeMock.mockImplementation(async (cfg) => {
      if (cfg.terminal) process.env.TERMINAL = cfg.terminal;
      else delete process.env.TERMINAL;
      return cfg;
    });
  });

  it('stores a workspace preference without changing the product default', async () => {
    const result = (await tool.handler({ op: 'set', terminal: 'gnome-terminal' }, {} as never)) as {
      data: Record<string, unknown>;
    };
    expect(writeMock).toHaveBeenCalledWith(expect.objectContaining({ terminal: 'gnome-terminal' }));
    expect(result.data).toMatchObject({ ok: true, stored: 'gnome-terminal', effective: 'gnome-terminal' });
  });

  it('clear restores inheritance rather than writing another terminal as a global default', async () => {
    const result = (await tool.handler({ op: 'clear' }, {} as never)) as { data: Record<string, unknown> };
    expect(writeMock).toHaveBeenCalledWith(expect.objectContaining({ terminal: '' }));
    expect(result.data).toMatchObject({ ok: true, stored: null });
  });
});
