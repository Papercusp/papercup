import { describe, expect, it } from 'vitest';
import { enqueueFeature, dequeueFeature } from '../write-feature-queue';
import type { BootedHarnessHandle } from '../boot';
import type { OpEnvelope } from '../autobase-setup';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';

function fakeHandle(slug = 'papercup'): {
  handle: BootedHarnessHandle;
  appended: OpEnvelope[];
} {
  const appended: OpEnvelope[] = [];
  const handle: BootedHarnessHandle = {
    workspaceId: 'ws-1',
    harnessSlug: slug,
    store: {} as never,
    base: {
      base: {} as never,
      async append(op: OpEnvelope) {
        appended.push(op);
      },
      async close() {},
    },
    async close() {},
  };
  return { handle, appended };
}

describe('enqueueFeature', () => {
  it('appends a put op with removed_at: null', async () => {
    const { handle, appended } = fakeHandle();
    await enqueueFeature({ handle, githubUserId: 42, featureId: 'F-001', now: 1700000000000 });
    expect(appended).toHaveLength(1);
    const op = appended[0];
    expect(op.type).toBe('put');
    expect(op.table).toBe('queue');
    expect(op.hbKey).toBe('42/F-001');
    expect(op.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(op.ts).toBe(1700000000000);
    const row = op.value as Record<string, unknown>;
    expect(row.harness_slug).toBe('papercup');
    expect(row.github_user_id).toBe(42);
    expect(row.feature_id).toBe('F-001');
    expect(row.queued_at).toBe(1700000000000);
    expect(row.removed_at).toBeNull();
  });

  it('uses Date.now() when no clock injected', async () => {
    const { handle, appended } = fakeHandle();
    const before = Date.now();
    await enqueueFeature({ handle, githubUserId: 1, featureId: 'F-1' });
    const after = Date.now();
    expect(appended[0].ts).toBeGreaterThanOrEqual(before);
    expect(appended[0].ts).toBeLessThanOrEqual(after);
  });

  it('binds harness_slug from the handle', async () => {
    const { handle, appended } = fakeHandle('sheets');
    await enqueueFeature({ handle, githubUserId: 7, featureId: 'F-9', now: 1 });
    expect((appended[0].value as Record<string, unknown>).harness_slug).toBe('sheets');
  });

  it('rejects missing handle', async () => {
    await expect(
      enqueueFeature({ handle: null as never, githubUserId: 1, featureId: 'F' }),
    ).rejects.toThrow(/handle/);
  });

  it('rejects non-positive user id', async () => {
    const { handle } = fakeHandle();
    await expect(
      enqueueFeature({ handle, githubUserId: 0, featureId: 'F-1' }),
    ).rejects.toThrow(/githubUserId/);
    await expect(
      enqueueFeature({ handle, githubUserId: -1, featureId: 'F-1' }),
    ).rejects.toThrow(/githubUserId/);
    await expect(
      enqueueFeature({ handle, githubUserId: 1.5, featureId: 'F-1' }),
    ).rejects.toThrow(/githubUserId/);
  });

  it('rejects empty feature id', async () => {
    const { handle } = fakeHandle();
    await expect(
      enqueueFeature({ handle, githubUserId: 1, featureId: '' }),
    ).rejects.toThrow(/featureId/);
  });
});

describe('dequeueFeature', () => {
  it('appends a put op with removed_at set to now (soft delete)', async () => {
    const { handle, appended } = fakeHandle();
    await dequeueFeature({ handle, githubUserId: 42, featureId: 'F-001', now: 1700000000000 });
    expect(appended).toHaveLength(1);
    const op = appended[0];
    expect(op.type).toBe('put');
    expect(op.table).toBe('queue');
    expect(op.hbKey).toBe('42/F-001');
    const row = op.value as Record<string, unknown>;
    expect(row.removed_at).toBe(1700000000000);
    expect(row.queued_at).toBe(1700000000000);
  });

  it('never emits a del op (would be a hard delete in the projection)', async () => {
    const { handle, appended } = fakeHandle();
    await dequeueFeature({ handle, githubUserId: 1, featureId: 'F-1', now: 1 });
    expect(appended[0].type).not.toBe('del');
  });

  it('uses the same key composer as enqueue', async () => {
    const { handle, appended } = fakeHandle();
    await enqueueFeature({ handle, githubUserId: 99, featureId: 'F-X', now: 1 });
    await dequeueFeature({ handle, githubUserId: 99, featureId: 'F-X', now: 2 });
    expect(appended[0].hbKey).toBe(appended[1].hbKey);
  });
});
