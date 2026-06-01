/**
 * getClaimStrategy tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { getClaimStrategy } from '../get-claim-strategy';
import {
  _resetHandleMapForTests,
  _setHandleForTests,
} from '../../sync/hyperbee/boot-all';
import { makeFakeBootedHandle } from '../../sync/hyperbee/__tests__/fake-booted-handle';

function fakeHandle(workspaceId: string, harnessSlug: string) {
  return makeFakeBootedHandle({ workspaceId, harnessSlug }).handle;
}

afterEach(() => {
  _resetHandleMapForTests();
});

describe('getClaimStrategy', () => {
  it('returns single-writer when no handle is booted', () => {
    expect(
      getClaimStrategy({ workspaceId: 'ws-1', harnessSlug: 'papercup' }),
    ).toBe('single-writer');
  });

  it('returns distributed when the handle is in the map', () => {
    _setHandleForTests('ws-1', 'papercup', fakeHandle('ws-1', 'papercup'));
    expect(
      getClaimStrategy({ workspaceId: 'ws-1', harnessSlug: 'papercup' }),
    ).toBe('distributed');
  });

  it('keys per (workspace, harness)', () => {
    _setHandleForTests('ws-1', 'a', fakeHandle('ws-1', 'a'));
    expect(getClaimStrategy({ workspaceId: 'ws-1', harnessSlug: 'a' })).toBe(
      'distributed',
    );
    expect(getClaimStrategy({ workspaceId: 'ws-1', harnessSlug: 'b' })).toBe(
      'single-writer',
    );
    expect(getClaimStrategy({ workspaceId: 'ws-2', harnessSlug: 'a' })).toBe(
      'single-writer',
    );
  });
});
