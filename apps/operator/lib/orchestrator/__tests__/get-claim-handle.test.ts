/**
 * get-claim-handle — Model B Stage-5 lookup tests.
 *
 * The own log IS the claim handle now (D-002). getClaimHandleForHarness
 * returns the booted handle's ownLog, or null when not booted.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getClaimHandleForHarness } from '../get-claim-handle';
import {
  _resetHandleMapForTests,
  _setHandleForTests,
} from '../../sync/hyperbee/boot-all';
import { makeFakeBootedHandle } from '../../sync/hyperbee/__tests__/fake-booted-handle';

function fakeHandle(workspaceId: string, harnessSlug: string, keyHex?: string) {
  return makeFakeBootedHandle({ workspaceId, harnessSlug, keyHex }).handle;
}

afterEach(() => {
  _resetHandleMapForTests();
});

describe('get-claim-handle — Stage-5 lookup', () => {
  it('returns null when no substrate is booted', () => {
    const result = getClaimHandleForHarness({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
    });
    expect(result).toBeNull();
  });

  it('returns the own-log claim handle when substrate is booted', () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup', 'cd'.repeat(32)));
    const handle = getClaimHandleForHarness({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
    });
    expect(handle).not.toBeNull();
    expect(handle!.keyHex).toBe('cd'.repeat(32));
    expect(typeof handle!.append).toBe('function');
    expect(typeof handle!.length).toBe('number');
  });

  it('the returned handle appends to the booted own log', async () => {
    const fake = makeFakeBootedHandle({ workspaceId: 'ws-1', harnessSlug: 'papercup' });
    _setHandleForTests('ws-1', 'papercup', fake.handle);
    const handle = getClaimHandleForHarness({
      workspaceId: 'ws-1',
      harnessSlug: 'papercup',
    });
    expect(handle).not.toBeNull();
    await handle!.append({
      type: 'put',
      table: 'claims',
      hbKey: 'F-1/0',
      value: { feature_id: 'F-1' },
      ts: 100,
      schema_version: 1,
      author_pubkey: handle!.keyHex,
    });
    // The op flows through the booted handle's own log.
    expect(fake.handle.ownLog.length).toBe(1);
  });

  it('keys per (workspace, harness)', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    expect(
      getClaimHandleForHarness({ workspaceId: 'ws-1', harnessSlug: 'a' }),
    ).not.toBeNull();
    expect(
      getClaimHandleForHarness({ workspaceId: 'ws-1', harnessSlug: 'b' }),
    ).toBeNull();
    expect(
      getClaimHandleForHarness({ workspaceId: 'ws-2', harnessSlug: 'a' }),
    ).toBeNull();
  });
});
