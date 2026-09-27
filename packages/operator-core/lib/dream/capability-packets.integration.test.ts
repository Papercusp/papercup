import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the real pinned scanner without changing the workspace's flag store.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: async () => true,
}));

import { DEFAULT_PACKER_EFFECTS, packerFacade } from '../code-intelligence/packer-facade';
import type { CodeIntelAnswer } from '../code-intelligence/contracts';
import { getPilotCapabilityManifest, getCurrentCapabilityManifest } from './capability-catalog';
import { buildCapabilityPacket, verifyCapabilityPacket, type CapabilityPacketDeps } from './capability-packets';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(secretSource = false) {
  const root = await mkdtemp(join(tmpdir(), 'capability-real-pack-'));
  roots.push(root);
  const unit = structuredClone(getPilotCapabilityManifest().units[0]!);
  unit.evidence[0]!.path = secretSource ? '.env' : 'source.ts';
  unit.evidence[1]!.path = 'source.test.ts';
  const code = unit.evidence[0]!.anchor + '\n  candidates: string[],\n) { return candidates; }\n';
  await writeFile(join(root, unit.evidence[0]!.path), code);
  await writeFile(join(root, unit.evidence[1]!.path), unit.evidence[1]!.anchor + ', () => {});\n');
  const artifact = join(root, 'packet.xml');
  const values = new Map<string, unknown>();
  const unknown: CodeIntelAnswer = {
    backend: 'lsp-adapter',
    intent: 'references',
    query: 'isolated fixture',
    sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health: 'unknown', indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: 0,
    error: 'Fixture does not run a language server',
  };
  const deps: CapabilityPacketDeps = {
    cache: {
      get: async (workspace, key) => (values.has(workspace + key) ? { value: values.get(workspace + key) } : undefined),
      set: vi.fn(async (workspace, key, value) => {
        values.set(workspace + key, value);
      }),
    },
    pack: vi.fn(async (rootPath, include) =>
      packerFacade(
        'pack',
        {
          rootPath,
          include,
          format: 'xml',
          compress: false,
        },
        {
          ...DEFAULT_PACKER_EFFECTS,
          // Only artifact placement is replaced; executable, argv and scanner are real.
          writeArtifact: async (body) => {
            await writeFile(artifact, body);
            return artifact;
          },
        },
      ),
    ),
    lookup: async () => unknown,
    resolveSymbol: async () => unknown,
    neighbors: async (direction) => ({ ...unknown, backend: 'gitnexus', intent: direction }),
    readArtifact: (path) => readFile(path, 'utf8'),
    now: Date.now,
  };
  const input = {
    rootPath: root,
    scope: { workspaceId: 'isolated-packet-tests', potSlug: 'fixture', repositoryId: 'fixture' },
    unit,
    manifestRevision: 'isolated-v1',
  };
  return { root, artifact, code, input, deps };
}

describe('capability packets through the pinned secret-scanned packer', () => {
  it.each(getCurrentCapabilityManifest().units.slice(getPilotCapabilityManifest().units.length))(
    'DREAM-CATALOGUE-EVIDENCE: builds and revalidates current repository evidence for $id',
    async (unit) => {
      const f = await fixture();
      const input = { ...f.input, rootPath: resolve(import.meta.dirname, '../../../..'), unit, manifestRevision: getCurrentCapabilityManifest().revision };
      const result = await buildCapabilityPacket(input, f.deps);
      expect(result.status, JSON.stringify(result)).toBe('ready');
      if (result.status !== 'ready') throw new Error(result.reason);
      expect(result.packet.sources.some(s => s.kind === 'implementation')).toBe(true);
      expect(result.packet.sources.some(s => s.kind === 'test')).toBe(true);
      expect(result.packet.coverage.status).toBe('partial');
      expect(result.packet.extraction.securityScan).toBe('passed');
      expect(await verifyCapabilityPacket(result.packet, input, f.deps)).toEqual({ fresh: true });
    }, 120_000,
  );
  it('packs real source, reuses unchanged evidence, and invalidates edited bytes without a commit label', async () => {
    const f = await fixture();
    const first = await buildCapabilityPacket(f.input, f.deps);
    expect(first.status, JSON.stringify(first)).toBe('ready');
    if (first.status !== 'ready') throw new Error(first.reason);
    expect(first.packet.sources[0]!.excerpt).toBe(f.code);
    expect(first.packet.extraction.securityScan).toBe('passed');
    expect(first.packet.extraction.sourceCommit).toBeNull();
    expect(await buildCapabilityPacket(f.input, f.deps)).toMatchObject({ status: 'ready', cacheHit: true });
    expect(f.deps.pack).toHaveBeenCalledTimes(1);

    await writeFile(join(f.root, 'source.ts'), f.code + '// changed without a git commit\n');
    expect((await verifyCapabilityPacket(first.packet, f.input, f.deps)).fresh).toBe(false);
    const next = await buildCapabilityPacket(f.input, f.deps);
    expect(next).toMatchObject({ status: 'ready', cacheHit: false });
    expect(f.deps.pack).toHaveBeenCalledTimes(2);
  }, 120_000);

  it('refuses admission when the real deny-set excludes required evidence', async () => {
    const f = await fixture(true);
    const result = await buildCapabilityPacket(f.input, f.deps);
    expect(result).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('differs or is excluded') });
    expect(f.deps.cache.set).not.toHaveBeenCalled();
    const packed = await readFile(f.artifact, 'utf8');
    expect(packed).toContain('source.test.ts');
    expect(packed).not.toContain(f.code.trim());
    expect(packed).not.toContain('<file path=".env">');
  }, 120_000);
});
