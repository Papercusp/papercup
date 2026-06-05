/**
 * harness:create — E2b-ii import-time TOOL-dependency gate
 * (harness-blueprint-distribution-2026-06-03 P-003/P-004). A blueprint that
 * declares a tool not in the in-process catalog must fail at CREATE (fail-fast,
 * before any dir/registry/schema side effect) — closing the call-time
 * `unknown_tool` gap. A blueprint with no tool deps must pass the gate untouched.
 *
 * Both cases are PG-free: the gate (and the dest-exists check) return before
 * `scaffoldHarnessSchema`. The registry read is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'x',
    role: 'architect' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
    ...over,
  } as never);

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, any> {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  vi.resetModules();
  vi.doMock('../../../harness-registry', () => ({
    loadHarnessRegistry: async () => ({ projects: [] }),
    saveHarnessRegistry: async () => {},
  }));
});
afterEach(() => {
  vi.doUnmock('../../../harness-registry');
});

describe('harness:create — E2b-ii tool-dep gate', () => {
  it('fails fast when the blueprint declares a tool absent from the catalog', async () => {
    const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
    const res = await tool.handler(
      {
        slug: 'deptest',
        parentDir: '/tmp/should-never-be-created-by-this-test',
        folderName: 'deptest-x',
        blueprint: {
          id: 'deptest',
          extends: 'coding',
          dependencies: { tools: ['definitely-not-a-real-tool-xyz'] },
        },
      },
      MAKE_CTX(),
    );
    const payload = parsePayload(res);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/tool dependencies unmet/);
    expect(payload.missing.tools).toContain('definitely-not-a-real-tool-xyz');
  });

  it('fails when a declared plugin is neither installed nor in the Cupboard (Cupboard reachable)', async () => {
    vi.doMock('../../../cupboard/plugin-listings', () => ({
      listInstalledPluginNames: async () => new Set<string>(),
      resolveCupboardPluginNames: async () => ({ names: new Set<string>(), reachable: true }),
    }));
    try {
      const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
      const res = await tool.handler(
        {
          slug: 'plugtest',
          parentDir: '/tmp/should-never-be-created-by-this-test',
          folderName: 'plugtest-x',
          blueprint: { id: 'plugtest', extends: 'coding', dependencies: { plugins: ['ghost-plugin'] } },
        },
        MAKE_CTX(),
      );
      const payload = parsePayload(res);
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(/plugin dependencies unmet/);
      expect(payload.missing.plugins).toContain('ghost-plugin');
    } finally {
      vi.doUnmock('../../../cupboard/plugin-listings');
    }
  });

  it('passes the gate when a declared plugin is installable from the Cupboard', async () => {
    // Plugin present in the Cupboard (not installed) → `installable`, not missing →
    // gate passes; execution reaches step 2 and rejects on dest-exists.
    vi.doMock('../../../cupboard/plugin-listings', () => ({
      listInstalledPluginNames: async () => new Set<string>(),
      resolveCupboardPluginNames: async () => ({ names: new Set<string>(['cool-plugin']), reachable: true }),
    }));
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-plug-'));
    try {
      await fs.mkdir(join(dir, 'already'));
      const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
      const res = await tool.handler(
        {
          slug: 'plugok',
          parentDir: dir,
          folderName: 'already',
          blueprint: { id: 'plugok', extends: 'coding', dependencies: { plugins: ['cool-plugin'] } },
        },
        MAKE_CTX(),
      );
      const payload = parsePayload(res);
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(/destination already exists/);
    } finally {
      vi.doUnmock('../../../cupboard/plugin-listings');
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does NOT hard-fail a missing plugin when the Cupboard is unreachable', async () => {
    // A transient cupboard-unreachable must not false-fail — the plugin may be
    // installable there. Gate passes; execution reaches step 2 (dest-exists).
    vi.doMock('../../../cupboard/plugin-listings', () => ({
      listInstalledPluginNames: async () => new Set<string>(),
      resolveCupboardPluginNames: async () => ({ names: new Set<string>(), reachable: false }),
    }));
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-plug-unreach-'));
    try {
      await fs.mkdir(join(dir, 'already'));
      const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
      const res = await tool.handler(
        {
          slug: 'plugunreach',
          parentDir: dir,
          folderName: 'already',
          blueprint: { id: 'plugunreach', extends: 'coding', dependencies: { plugins: ['ghost-plugin'] } },
        },
        MAKE_CTX(),
      );
      const payload = parsePayload(res);
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(/destination already exists/);
    } finally {
      vi.doUnmock('../../../cupboard/plugin-listings');
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('short-circuits (no-op) for a blueprint with no tool deps — gate passes through', async () => {
    // `coding` declares no dependencies.tools → the gate short-circuits and
    // execution reaches step 2 (dir resolution), which rejects because the
    // destination already exists. That proves the gate did NOT block creation.
    const dir = await fs.mkdtemp(join(tmpdir(), 'create-noop-'));
    try {
      await fs.mkdir(join(dir, 'already'));
      const tool = (await import('../create')).default as { handler: (a: unknown, c: unknown) => Promise<any> };
      const res = await tool.handler(
        { slug: 'noopt', parentDir: dir, folderName: 'already', blueprintId: 'coding' },
        MAKE_CTX(),
      );
      const payload = parsePayload(res);
      expect(payload.ok).toBe(false);
      expect(payload.error).toMatch(/destination already exists/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
