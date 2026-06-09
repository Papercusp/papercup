import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./injection', () => ({
  buildMemoryContextBlock: vi.fn(),
}));
vi.mock('./insights-index', async () => {
  const actual = await vi.importActual<typeof import('./insights-index')>('./insights-index');
  return {
    ...actual,
    readInsightsDir: vi.fn(),
  };
});

import { buildMcpPrelude, _testing } from './mcp-prelude';
import { buildMemoryContextBlock } from './injection';
import { readInsightsDir } from './insights-index';

const origEnv = { ...process.env };

beforeEach(() => {
  vi.mocked(buildMemoryContextBlock).mockReset();
  vi.mocked(readInsightsDir).mockReset();
  process.env = { ...origEnv, PAPERCUSP_SU_MEMORY_INJECTION: 'on' };
});

afterEach(() => {
  process.env = origEnv;
});

describe('injectionEnabled', () => {
  it('on when env=on', () => {
    process.env.PAPERCUSP_SU_MEMORY_INJECTION = 'on';
    expect(_testing.injectionEnabled()).toBe(true);
  });

  it('off when env=off', () => {
    process.env.PAPERCUSP_SU_MEMORY_INJECTION = 'off';
    expect(_testing.injectionEnabled()).toBe(false);
  });

  it('default on in NODE_ENV=development', () => {
    delete process.env.PAPERCUSP_SU_MEMORY_INJECTION;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    expect(_testing.injectionEnabled()).toBe(true);
  });

  it('default ON in production too (P-050: never ships dark; =off is the kill switch)', () => {
    delete process.env.PAPERCUSP_SU_MEMORY_INJECTION;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    expect(_testing.injectionEnabled()).toBe(true);
  });
});

describe('buildMcpPrelude — flag gating', () => {
  it('returns null when flag off', async () => {
    process.env.PAPERCUSP_SU_MEMORY_INJECTION = 'off';
    const r = await buildMcpPrelude({ userId: 'u1', workspaceId: 'w1' });
    expect(r).toBeNull();
    expect(buildMemoryContextBlock).not.toHaveBeenCalled();
  });
});

describe('buildMcpPrelude — harness slug resolution', () => {
  it('reads harness from URL param', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- foo');
    const url = new URL('http://op/api/mcp?superuser=1&harness=sheets');
    const r = await buildMcpPrelude({ userId: 'u1', workspaceId: 'w1', url });
    expect(buildMemoryContextBlock).toHaveBeenCalledWith({
      userId: 'u1',
      workspaceId: 'w1',
      harnessSlugs: ['sheets'],
      queryContext: '',
    });
    expect(r?.sources.harnessSlug).toBe('sheets');
    expect(r?.sources.harnessSource).toBe('env');
  });

  it('omits harness when no URL param + no cwd', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- foo');
    const r = await buildMcpPrelude({ userId: 'u1', workspaceId: 'w1' });
    expect(buildMemoryContextBlock).toHaveBeenCalledWith({
      userId: 'u1',
      workspaceId: 'w1',
      harnessSlugs: [],
      queryContext: '',
    });
    expect(r?.sources.harnessSlug).toBeNull();
  });
});

describe('buildMcpPrelude — composition', () => {
  it('returns memory block alone when insights not provided', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- u prefers terse');
    const r = await buildMcpPrelude({ userId: 'u1', workspaceId: 'w1' });
    expect(r?.text).toContain('## Memory');
    expect(r?.sources.userMemoryIncluded).toBe(true);
    expect(r?.sources.insightsIncluded).toBe(false);
  });

  it('returns insights block alone when memory is empty', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue(null);
    vi.mocked(readInsightsDir).mockResolvedValue([
      { slug: 'foo', title: 'Foo', description: 'Bar.', status: 'active', tags: [] },
    ]);
    const r = await buildMcpPrelude({
      userId: 'u1',
      workspaceId: 'w1',
      insightsDir: '/fake/dir',
    });
    expect(r?.text).toContain('## Agent insights');
    expect(r?.sources.userMemoryIncluded).toBe(false);
    expect(r?.sources.insightsIncluded).toBe(true);
  });

  it('composes memory + insights together', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- u prefers terse');
    vi.mocked(readInsightsDir).mockResolvedValue([
      { slug: 'foo', title: 'Foo', description: 'Bar.', status: 'active', tags: [] },
    ]);
    const r = await buildMcpPrelude({
      userId: 'u1',
      workspaceId: 'w1',
      insightsDir: '/fake/dir',
    });
    expect(r?.text).toContain('## Memory');
    expect(r?.text).toContain('## Agent insights');
  });

  it('returns null when both sources produce nothing', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue(null);
    vi.mocked(readInsightsDir).mockResolvedValue([]);
    const r = await buildMcpPrelude({
      userId: 'u1',
      workspaceId: 'w1',
      insightsDir: '/fake/dir',
    });
    expect(r).toBeNull();
  });
});

describe('buildMcpPrelude — failure handling', () => {
  it('survives buildMemoryContextBlock throwing', async () => {
    vi.mocked(buildMemoryContextBlock).mockRejectedValue(new Error('mem0 down'));
    vi.mocked(readInsightsDir).mockResolvedValue([
      { slug: 'foo', title: 'Foo', description: 'Bar.', status: 'active', tags: [] },
    ]);
    const r = await buildMcpPrelude({
      userId: 'u1',
      workspaceId: 'w1',
      insightsDir: '/fake/dir',
    });
    expect(r?.sources.userMemoryIncluded).toBe(false);
    expect(r?.sources.insightsIncluded).toBe(true);
  });

  it('survives readInsightsDir throwing', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- x');
    vi.mocked(readInsightsDir).mockRejectedValue(new Error('fs down'));
    const r = await buildMcpPrelude({
      userId: 'u1',
      workspaceId: 'w1',
      insightsDir: '/fake/dir',
    });
    expect(r?.sources.userMemoryIncluded).toBe(true);
    expect(r?.sources.insightsIncluded).toBe(false);
  });

  it('returns null when everything throws + nothing else available', async () => {
    vi.mocked(buildMemoryContextBlock).mockRejectedValue(new Error('mem0 down'));
    vi.mocked(readInsightsDir).mockRejectedValue(new Error('fs down'));
    const r = await buildMcpPrelude({
      userId: 'u1',
      workspaceId: 'w1',
      insightsDir: '/fake/dir',
    });
    expect(r).toBeNull();
  });
});
