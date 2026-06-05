import { afterEach, describe, expect, it } from 'vitest';
import { enqueueFeature, dequeueFeature } from '../write-feature-queue';
import type { BootedHarnessHandle, LocalWriteOp } from '../boot';
import { CURRENT_SCHEMA_VERSION } from '../schema-version';
import {
  clobberEvents,
  observeMergedOp,
  _resetForTests,
  _setNowForTests,
  type ClobberEvent,
} from '../clobber-events';
import { makeFakeBootedHandle } from './fake-booted-handle';

afterEach(() => _resetForTests());

function fakeHandle(slug = 'papercup'): {
  handle: BootedHarnessHandle;
  appended: LocalWriteOp[];
} {
  return makeFakeBootedHandle({ harnessSlug: slug });
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

describe('enqueueFeature — clobber-events integration', () => {
  it('does NOT call recordLocalWrite when writerPubkey is omitted', async () => {
    _setNowForTests(() => 1000);
    const { handle } = fakeHandle();
    await enqueueFeature({ handle, githubUserId: 1, featureId: 'F-1', now: 1000 });
    // A subsequent observeMergedOp with no recorded write returns false.
    const fired = observeMergedOp({
      table: 'queue',
      hbKey: '1/F-1',
      ts: 1500,
      pubkey: 'remote',
    });
    expect(fired).toBe(false);
  });

  it('records the local write when writerPubkey is provided', async () => {
    _setNowForTests(() => 1000);
    const events: ClobberEvent[] = [];
    clobberEvents.on('clobber', (e) => events.push(e));
    const { handle } = fakeHandle();
    await enqueueFeature({
      handle,
      githubUserId: 1,
      featureId: 'F-1',
      now: 1000,
      writerPubkey: 'me-hex',
    });
    // Now a later remote write with a greater (ts, pubkey) tuple fires a clobber.
    _setNowForTests(() => 1500);
    const fired = observeMergedOp({
      table: 'queue',
      hbKey: '1/F-1',
      ts: 1200,
      pubkey: 'remote-hex',
    });
    expect(fired).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].my.pubkey).toBe('me-hex');
    expect(events[0].theirs.pubkey).toBe('remote-hex');
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
