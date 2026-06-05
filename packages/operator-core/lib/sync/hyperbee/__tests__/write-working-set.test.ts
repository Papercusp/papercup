import { afterEach, describe, expect, it } from 'vitest';
import { setActiveFeature, clearActiveFeature } from '../write-working-set';
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

describe('setActiveFeature', () => {
  it('appends a put op with cleared_at: null', async () => {
    const { handle, appended } = fakeHandle();
    await setActiveFeature({ handle, githubUserId: 42, featureId: 'F-1', now: 1700000000000 });
    expect(appended).toHaveLength(1);
    const op = appended[0];
    expect(op.type).toBe('put');
    expect(op.table).toBe('working-set');
    expect(op.hbKey).toBe('42/F-1');
    expect(op.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    const row = op.value as Record<string, unknown>;
    expect(row.started_at).toBe(1700000000000);
    expect(row.cleared_at).toBeNull();
    expect(row.harness_slug).toBe('papercup');
  });

  it('rejects non-positive user id + empty feature id', async () => {
    const { handle } = fakeHandle();
    await expect(setActiveFeature({ handle, githubUserId: 0, featureId: 'F' })).rejects.toThrow(/githubUserId/);
    await expect(setActiveFeature({ handle, githubUserId: 1, featureId: '' })).rejects.toThrow(/featureId/);
  });

  it('records local write + fires clobber on later remote override when writerPubkey set', async () => {
    _setNowForTests(() => 1000);
    const events: ClobberEvent[] = [];
    clobberEvents.on('clobber', (e) => events.push(e));
    const { handle } = fakeHandle();
    await setActiveFeature({ handle, githubUserId: 1, featureId: 'F-1', now: 1000, writerPubkey: 'me' });
    _setNowForTests(() => 1500);
    const fired = observeMergedOp({ table: 'working-set', hbKey: '1/F-1', ts: 1200, pubkey: 'remote' });
    expect(fired).toBe(true);
    expect(events[0].theirs.pubkey).toBe('remote');
  });

  it('threads writerPubkey onto the op envelope', async () => {
    const { handle, appended } = fakeHandle();
    await setActiveFeature({ handle, githubUserId: 1, featureId: 'F-1', now: 1, writerPubkey: 'abc' });
    expect(appended[0].writerPubkey).toBe('abc');
  });
});

describe('clearActiveFeature', () => {
  it('appends a put op with cleared_at set (soft delete)', async () => {
    const { handle, appended } = fakeHandle();
    await clearActiveFeature({ handle, githubUserId: 42, featureId: 'F-1', now: 1700000000000 });
    const row = appended[0].value as Record<string, unknown>;
    expect(row.cleared_at).toBe(1700000000000);
    expect(appended[0].type).toBe('put');
  });

  it('never emits a del op', async () => {
    const { handle, appended } = fakeHandle();
    await clearActiveFeature({ handle, githubUserId: 1, featureId: 'F-1', now: 1 });
    expect(appended[0].type).not.toBe('del');
  });
});
