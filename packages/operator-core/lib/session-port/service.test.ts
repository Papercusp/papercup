import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AdvSessionRow } from '../adv-sessions';
import type { SessionPortRow } from './store';
import {
  acquireTrackedClaudeSource,
  deriveSessionPortIdempotencyKey,
  inspectAcquiredSessionPort,
  prepareInspectedSessionPort,
  publicSessionPortInspection,
} from './service';
import type { StableSource } from './source';

const row: AdvSessionRow = {
  id: 41,
  workspaceId: 'ws',
  planSlug: 'plan-a',
  agent: 'claude',
  role: null,
  feature: null,
  mode: 'console',
  terminalBin: null,
  pid: null,
  windowId: null,
  ompThreadId: null,
  label: null,
  cwd: '/workspace',
  coordOwnerId: 'su-source',
  sessionId: '11111111-1111-4111-8111-111111111111',
  display: null,
  launchArgv: null,
  launchedAt: null,
  startedAt: '2026-07-14T00:00:00.000Z',
  endedAt: null,
  exitCode: null,
  endedBy: null,
  endedSignal: null,
};

const source = (text: string): StableSource => {
  const bytes = Buffer.from([
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: text } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: 'done' } }),
    '',
  ].join('\n'));
  return {
    bytes,
    sha256: 'a'.repeat(64),
    highWaterBytes: bytes.length,
    completeBytes: bytes.length,
    source: 'live-jsonl',
    relpath: null,
  };
};

const target = {
  backend: 'codex' as const,
  provider: 'openai',
  model: 'gpt-5.5',
  account: 'default',
  contextWindow: 200_000,
  availableInputTokens: 40_000,
  contextSize: 'trimmed' as const,
};

describe('tracked Claude source acquisition', () => {
  it('falls back to the canonical archive when cleanup deletes the inspected live JSONL', async () => {
    const archived = {
      ...source('archived history'),
      source: 'archive-manifest' as const,
      relpath: `projects/cwd/${row.sessionId}.jsonl`,
    };
    const readArchive = vi.fn(async () => archived);

    await expect(acquireTrackedClaudeSource(row, {
      configDirForOwner: () => '/config',
      findLive: async () => { throw new Error('canonical live Claude JSONL is missing'); },
      readArchive,
      archiveStore: () => ({} as never),
    })).resolves.toBe(archived);
    expect(readArchive).toHaveBeenCalledWith({ sessionId: row.sessionId }, expect.anything());
  });

  it('falls back when the live JSONL disappears after its path was resolved', async () => {
    const archived = {
      ...source('archived history'),
      source: 'archive-manifest' as const,
      relpath: `projects/cwd/${row.sessionId}.jsonl`,
    };
    const gone = Object.assign(new Error('open live JSONL: no such file'), { code: 'ENOENT' });

    await expect(acquireTrackedClaudeSource(row, {
      configDirForOwner: () => '/config',
      findLive: async () => '/config/projects/cwd/session.jsonl',
      readLive: async () => { throw gone; },
      readArchive: async () => archived,
      archiveStore: () => ({} as never),
    })).resolves.toBe(archived);
  });

  it('does not hide an ambiguous or unsafe live-source failure behind the archive', async () => {
    const readArchive = vi.fn();
    await expect(acquireTrackedClaudeSource(row, {
      configDirForOwner: () => '/config',
      findLive: async () => { throw new Error('canonical live Claude JSONL is ambiguous'); },
      readArchive,
      archiveStore: () => ({} as never),
    })).rejects.toThrow(/ambiguous/);
    expect(readArchive).not.toHaveBeenCalled();
  });

  it('reports both source tiers unavailable when the archive fallback also misses', async () => {
    await expect(acquireTrackedClaudeSource(row, {
      configDirForOwner: () => '/config',
      findLive: async () => { throw new Error('canonical live Claude JSONL is missing'); },
      readArchive: async () => { throw new Error('canonical Claude archive not found'); },
      archiveStore: () => ({} as never),
    })).rejects.toThrow(/live JSONL is missing and archive fallback failed/);
  });
});

describe('session-port preparation service', () => {
  it('inspects without exposing internal transcript data and redacts before persistence', async () => {
    const inspection = inspectAcquiredSessionPort({
      sourceRow: row,
      stableSource: source('token sk-ant-abcdefghijklmnop and \u001b[31mred'),
      target,
    });
    expect(inspection.stats.redactions).toBe(1);
    expect(inspection.stats.controlBytesRemoved).toBeGreaterThan(0);
    expect(publicSessionPortInspection(inspection)).not.toHaveProperty('internal');

    const createPrepared = vi.fn(async (input: any): Promise<SessionPortRow> => ({
      ...input,
      status: 'prepared',
      targetAdvSessionId: null,
      error: null,
      preparedAt: '2026-07-14T00:00:00.000Z',
      pendingAt: null,
      deliveredAt: null,
      failedAt: null,
    }));
    const out = await prepareInspectedSessionPort({
      inspection,
      expectedSourceHash: inspection.source.sha256,
      tokenKey: 'server-only-key',
      artifactRoot: mkdtempSync(join(tmpdir(), 'port-service-')),
      findExisting: async () => null,
      createPrepared,
    });
    expect(out.summary.hashes.source).toBe(inspection.source.sha256);
    expect(JSON.stringify(out.summary)).not.toContain('sk-ant-');
    const persisted = createPrepared.mock.calls[0][0];
    expect(persisted.metadata).not.toHaveProperty('contract');
    expect(JSON.stringify(persisted.metadata)).not.toContain('history');
    expect(JSON.stringify(persisted.metadata)).not.toContain('done');
    expect(out.port.id).toBe(out.token.split('.')[0]);
    expect(createPrepared).toHaveBeenCalledTimes(1);
  });

  it('derives stable idempotency and reproduces the same token without a second target artifact', async () => {
    const inspection = inspectAcquiredSessionPort({ sourceRow: row, stableSource: source('history'), target });
    expect(deriveSessionPortIdempotencyKey(inspection)).toBe(deriveSessionPortIdempotencyKey(inspection));
    const existing: SessionPortRow = {
      id: '22222222-2222-4222-8222-222222222222',
      workspaceId: 'ws',
      idempotencyKey: deriveSessionPortIdempotencyKey(inspection),
      protocolVersion: 1,
      sourceAdvSessionId: 41,
      targetAdvSessionId: null,
      sourceBackend: 'claude',
      targetBackend: 'codex',
      targetModel: 'gpt-5.5',
      status: 'prepared',
      sourceHash: inspection.source.sha256,
      normalizedHash: inspection.internal.normalizedHash,
      renderedHash: 'b'.repeat(64),
      tokenHash: 'c'.repeat(64),
      artifactPath: '/managed/path',
      metadata: {
        summary: {
          protocolVersion: 1,
          source: {
            backend: 'claude', workspaceId: 'ws', advSessionId: 41, nativeSessionId: row.sessionId,
            snapshot: { kind: 'live-jsonl', highWaterBytes: 1, completeBytes: 1, sha256: inspection.source.sha256, archiveRelpath: null },
          },
          target,
          fidelity: 'full',
          versions: { adapter: 1, transform: 1, renderer: 1, summaryPrompt: null },
          hashes: { source: inspection.source.sha256, normalized: inspection.internal.normalizedHash, rendered: 'b'.repeat(64) },
          stats: inspection.stats,
          summary: null,
          warnings: [],
        },
      },
      error: null,
      preparedAt: '2026-07-14T00:00:00.000Z',
      pendingAt: null,
      deliveredAt: null,
      failedAt: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const a = await prepareInspectedSessionPort({
      inspection, expectedSourceHash: inspection.source.sha256, tokenKey: 'key', findExisting: async () => existing,
    });
    const b = await prepareInspectedSessionPort({
      inspection, expectedSourceHash: inspection.source.sha256, tokenKey: 'key', findExisting: async () => existing,
    });
    expect(a.reused).toBe(true);
    expect(a.token).toBe(b.token);
  });

  it('fails when the live snapshot changed after inspection', async () => {
    const inspection = inspectAcquiredSessionPort({ sourceRow: row, stableSource: source('history'), target });
    await expect(prepareInspectedSessionPort({
      inspection,
      expectedSourceHash: 'different',
      tokenKey: 'key',
    })).rejects.toThrow(/changed/);
  });
});
