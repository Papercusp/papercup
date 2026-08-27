/**
 * WI-662 production composition: P-010's activation policy and P-012's remote
 * wake keepalive must compose in boot-all without a caller-only option flip.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetEvictionTrackingForTests,
  _resetHandleMapForTests,
  bootAllHarnessesForActiveWorkspace,
  closeAllBootedHarnesses,
} from '../boot-all';
import {
  _resetSubstrateWakeWiringForTests,
  _setSubstrateWakeGossipForTests,
  substrateWakeKeepaliveStatus,
} from '../substrate-wake-wiring';
import type { BootedHarnessHandle } from '../boot';
import type { SwarmBinding } from '../derive-swarm-topic';
import type { SubstrateWakeGossipHandle } from '../substrate-wake-gossip';
import { makeFakeBootedHandle } from './fake-booted-handle';

const { getFlagMock, loadHarnessRegistryMock, saveHarnessRegistryMock } = vi.hoisted(() => ({
  getFlagMock: vi.fn(async () => true),
  loadHarnessRegistryMock: vi.fn(async () => ({
    projects: [
      { slug: 'shared-member', path: '/tmp/wi-662-shared-member', hive_slug: 'shared-home' },
    ],
  })),
  saveHarnessRegistryMock: vi.fn(async () => {}),
}));

vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: getFlagMock,
}));

vi.mock('../../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../harness-registry')>()),
  loadHarnessRegistry: loadHarnessRegistryMock,
  saveHarnessRegistry: saveHarnessRegistryMock,
}));

const WORKSPACE = 'ws-wi-662-default';
const HARNESS = 'shared-member';
const BINDING: SwarmBinding = {
  kind: 'hive',
  hive_pubkey: Buffer.alloc(32, 6).toString('base64'),
};

function recordingGossip(): SubstrateWakeGossipHandle {
  const watched = new Map<string, string>();
  return {
    watch(key, topic) {
      watched.set(key, topic.toString('hex'));
    },
    async unwatch(key) {
      watched.delete(key);
    },
    announceActivity() {},
    async close() {
      watched.clear();
    },
    get watchedKeys() {
      return [...watched.keys()];
    },
    get topicCount() {
      return new Set(watched.values()).size;
    },
    topicHexFor: (key) => watched.get(key),
    openChannelCount: () => 0,
  };
}

beforeEach(() => {
  getFlagMock.mockReset();
  getFlagMock.mockResolvedValue(true);
  loadHarnessRegistryMock.mockReset();
  loadHarnessRegistryMock.mockResolvedValue({
    projects: [
      { slug: HARNESS, path: '/tmp/wi-662-shared-member', hive_slug: 'shared-home' },
    ],
  });
  saveHarnessRegistryMock.mockReset();
  saveHarnessRegistryMock.mockResolvedValue(undefined);
  _resetHandleMapForTests();
  _resetEvictionTrackingForTests();
  _resetSubstrateWakeWiringForTests();
  _setSubstrateWakeGossipForTests(recordingGossip());
});

afterEach(async () => {
  await closeAllBootedHarnesses();
  _resetHandleMapForTests();
  _resetEvictionTrackingForTests();
  _resetSubstrateWakeWiringForTests();
  vi.restoreAllMocks();
});

describe('boot-all shared-harness lazy default (WI-662)', () => {
  it('defers an idle federating harness by default after arming remote wake coverage', async () => {
    const bootHarness = vi.fn(
      async ({ workspaceId, harnessSlug }): Promise<BootedHarnessHandle> =>
        makeFakeBootedHandle({ workspaceId, harnessSlug }).handle,
    );

    const result = await bootAllHarnessesForActiveWorkspace({
      workspaceIds: [WORKSPACE],
      discoverHarnessSlugs: async () => [HARNESS],
      activationFactDeps: {
        pendingOutboxCounts: async () => new Map(),
        lastPresenceMs: async () => new Map(),
      },
      resolveSwarmBinding: async () => BINDING,
      bootHarness,
      skipSendSideWiring: true,
      // Deliberately omit deferFederatingHarnesses: the production default is
      // the behavior under test, not an injected test-only option.
    });

    expect(result).toMatchObject({ attempted: 0, booted: 0, failed: 0, deferred: 1 });
    expect(result.results).toEqual([
      {
        workspaceId: WORKSPACE,
        harnessSlug: HARNESS,
        state: 'deferred',
        deferReason: 'inactive',
      },
    ]);
    expect(bootHarness).not.toHaveBeenCalled();
    expect(substrateWakeKeepaliveStatus()).toEqual({
      armed: [{ workspaceId: WORKSPACE, harnessSlug: HARNESS }],
      topicCount: 1,
    });
  });
});
