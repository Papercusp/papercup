/**
 * getClaimStrategy tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getClaimStrategy } from '../get-claim-strategy';
import {
  _resetHandleMapForTests,
  _setHandleForTests,
} from '../../sync/hyperbee/boot-all';
import type {
  AutobaseHarnessHandle,
  OpEnvelope,
} from '../../sync/hyperbee/autobase-setup';
import type { BootedHarnessHandle } from '../../sync/hyperbee/boot';

function fakeHandle(workspaceId: string, harnessSlug: string): BootedHarnessHandle {
  const log: OpEnvelope[] = [];
  const view = {
    get length() {
      return log.length;
    },
    async get(seq: number) {
      return log[seq] ?? null;
    },
  };
  const base: AutobaseHarnessHandle = {
    base: { view, local: { key: Buffer.from('aa', 'hex') } } as unknown as AutobaseHarnessHandle['base'],
    append: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  // STAGE-5: legacy Autobase `base` fixture (no longer a declared
  // BootedHarnessHandle property); cast through `unknown`. getClaimStrategy
  // only checks handle presence, so the shape is incidental.
  return {
    workspaceId,
    harnessSlug,
    store: {} as never,
    base,
    close: vi.fn(async () => {}),
  } as unknown as BootedHarnessHandle;
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
