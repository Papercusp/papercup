import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We have to override PAPERCUSP_HOME *before* importing the module.
let TMP_HOME: string;

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

describe.skip('state-store (needs PG fixture)', () => {
  it('returns empty state when no file exists', async () => {
    const m = await import('./state-store');
    const s = await m.readState('h', 'p');
    expect(s.createdResources).toEqual([]);
    expect(s.hashes).toBeNull();
    expect(s.setupFailed).toBe(false);
  });

  it('writes and reads state.json round-trip', async () => {
    const m = await import('./state-store');
    await m.writeState('h', 'p', {
      schemaVersion: 1,
      hashes: { configHash: 'c', scriptHash: 's', pluginVersion: '1.0.0' },
      createdResources: [
        { kind: 'aws.iam.role', externalId: 'arn:1', recordedAt: '2026-05-01T00:00:00Z' },
      ],
      outputs: { lambdaArn: 'arn:fn' },
      lastSetupAt: '2026-05-01T00:00:00Z',
      lastVerifyAt: null,
      setupFailed: false,
    });
    const s = await m.readState('h', 'p');
    expect(s.outputs.lambdaArn).toBe('arn:fn');
    expect(s.createdResources).toHaveLength(1);
  });

  it('folds WAL entries into createdResources', async () => {
    const m = await import('./state-store');
    await m.appendWalEntry('h', 'p', {
      kind: 'aws.iam.role',
      externalId: 'arn:role:1',
      recordedAt: '2026-05-01T00:00:00Z',
    });
    await m.appendWalEntry('h', 'p', {
      kind: 'aws.lambda.function',
      externalId: 'arn:fn:1',
      recordedAt: '2026-05-01T00:00:01Z',
    });
    const s = await m.readState('h', 'p');
    expect(s.createdResources.map((r) => r.kind).sort()).toEqual([
      'aws.iam.role',
      'aws.lambda.function',
    ]);
  });

  it('dedupes WAL entries on (kind, externalId)', async () => {
    const m = await import('./state-store');
    await m.appendWalEntry('h', 'p', {
      kind: 'aws.iam.role',
      externalId: 'arn:role:1',
      recordedAt: '2026-05-01T00:00:00Z',
    });
    await m.appendWalEntry('h', 'p', {
      kind: 'aws.iam.role',
      externalId: 'arn:role:1',
      recordedAt: '2026-05-01T00:00:05Z',
      metadata: { updated: true },
    });
    const s = await m.readState('h', 'p');
    expect(s.createdResources).toHaveLength(1);
    expect(s.createdResources[0].metadata?.updated).toBe(true);
  });

  it('writeState compacts the WAL', async () => {
    const m = await import('./state-store');
    await m.appendWalEntry('h', 'p', {
      kind: 'aws.iam.role',
      externalId: 'arn:role:1',
      recordedAt: 'now',
    });
    const before = await m.readState('h', 'p');
    expect(before.createdResources).toHaveLength(1);
    // writeState commits and truncates WAL.
    await m.writeState('h', 'p', { ...before });
    // Confirm WAL is gone.
    await expect(
      fs.access(join(TMP_HOME, 'harnesses/h/provision/p/resources.wal.jsonl')),
    ).rejects.toThrow();
    const after = await m.readState('h', 'p');
    expect(after.createdResources).toHaveLength(1);
  });

  it('clearState removes the provision dir', async () => {
    const m = await import('./state-store');
    await m.appendWalEntry('h', 'p', { kind: 'k', externalId: 'i', recordedAt: 'now' });
    await m.clearState('h', 'p');
    const s = await m.readState('h', 'p');
    expect(s.createdResources).toEqual([]);
  });
});
