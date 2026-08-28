/**
 * Cluster coherence for persisted Pot wake subscriptions (WI-4890).
 *
 * :3070 has many request workers plus a background primary, while the reaction
 * registry is deliberately process-local. These tests simulate one process
 * receiving another process's sync_invalidate notification and a reconnect
 * after a missed notification.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetReactionsForTests, listReactionRules } from '../events/registry';

const state = new Map<string, { subscriptions: Array<{ on: string; note?: string }>; declaredAt?: number }>();
let subscriber: ((event: { name: string; args?: Record<string, unknown> }) => void) | null = null;
let reconnectHook: (() => void | Promise<void>) | null = null;
const close = vi.fn();
const notifySyncInvalidate = vi.fn(async () => {});

vi.mock('../operator-state-pg', () => ({
  readOperatorState: async (_table: string, workspaceId?: string) => state.get(workspaceId ?? '') ?? null,
  updateOperatorState: async (
    _table: string,
    empty: { subscriptions: [] },
    update: (current: { subscriptions: Array<{ on: string; note?: string }>; declaredAt?: number }) => {
      subscriptions: Array<{ on: string; note?: string }>;
      declaredAt?: number;
    },
    workspaceId?: string,
  ) => {
    const key = workspaceId ?? '';
    state.set(key, update(state.get(key) ?? empty));
  },
}));

vi.mock('../workspace-registry', () => ({
  activeWorkspaceId: () => 'ws-a',
  backgroundWorkspaceIds: () => ['ws-a', 'ws-b'],
}));

// P-068/D-098 retired every Pot actuator, so `mugKettleSystemEnabled` is a hard
// `false` in production and this default is that truth. Only `registerPotWakeRules`
// consults it; the retired tier is re-opened LOCALLY in the one describe whose
// contract IS that gated body (see below), so no case here starts in a state
// production cannot reach.
const { mugKettleSystemEnabled } = vi.hoisted(() => ({
  mugKettleSystemEnabled: vi.fn().mockResolvedValue(false),
}));
vi.mock('./started', () => ({ mugKettleSystemEnabled }));

vi.mock('../sync-sse', () => ({
  subscribe: vi.fn(async (send: typeof subscriber) => {
    subscriber = send;
    return { send, close };
  }),
  registerInvalidationListenHook: vi.fn((hook: typeof reconnectHook) => {
    reconnectHook = hook;
    return () => {
      reconnectHook = null;
    };
  }),
  notifySyncInvalidate,
}));

const {
  POT_WAKE_RULES_INVALIDATION,
  _resetPotWakeRuleSyncForTests,
  ensurePotWakeRuleSync,
  setPotEventSubscriptions,
} = await import('./wake');

beforeEach(() => {
  state.clear();
  subscriber = null;
  reconnectHook = null;
  close.mockClear();
  notifySyncInvalidate.mockClear();
  _resetPotWakeRuleSyncForTests();
  _resetReactionsForTests();
});

afterEach(() => {
  _resetPotWakeRuleSyncForTests();
  _resetReactionsForTests();
});

const potRules = (workspaceId: string) =>
  listReactionRules().filter((rule) => rule.id.startsWith(`pot-wake:${workspaceId}#`));

describe('Pot wake-rule cluster coherence', () => {
  describe('the projection path behind the retired-tier gate', () => {
    // `registerPotWakeRules` — the only reader of the predicate — short-circuits to
    // `syncPotWakeRules(ws, [])` while the tier is retired, so the push/reconnect
    // coherence contract below is only observable with the gate forced open. The
    // gated body is still live code and this is what pins it; re-open it here, not
    // file-wide, so every other case runs against production truth.
    beforeEach(() => {
      mugKettleSystemEnabled.mockResolvedValue(true);
    });
    afterEach(() => {
      mugKettleSystemEnabled.mockResolvedValue(false);
    });

    it('re-projects another worker\'s declaration on push and heals a missed push on reconnect', async () => {
      await expect(ensurePotWakeRuleSync()).resolves.toBe(true);
      expect(subscriber).not.toBeNull();

      // Worker B persisted a new declaration. This process sees it only when the
      // cross-process invalidation arrives.
      state.set('ws-b', { subscriptions: [{ on: 'coord:escalate' }], declaredAt: 1 });
      subscriber?.({ name: POT_WAKE_RULES_INVALIDATION, args: { workspaceId: 'ws-b' } });
      await vi.waitFor(() => expect(potRules('ws-b')).toHaveLength(1));
      expect(potRules('ws-b')[0].on).toBe('coord:escalate');

      // A later declaration landed while this process's LISTEN was down. No push
      // is delivered; reconnect's full persisted-state rebuild must still heal it.
      state.set('ws-b', { subscriptions: [{ on: 'work_items:create' }], declaredAt: 2 });
      await reconnectHook?.();
      await vi.waitFor(() => expect(potRules('ws-b')[0]?.on).toBe('work_items:create'));
    });

    it('CALIBRATION — at production truth the same reconnect CLEARS the projection instead', async () => {
      // The other half of the contract, and what makes the case above mean
      // something: with the tier retired, `registerPotWakeRules` short-circuits
      // to an empty projection, which is also how a worker holding pre-retirement
      // rules heals. Rules must go 1 → 0, so this cannot pass vacuously.
      mugKettleSystemEnabled.mockResolvedValue(false);
      await expect(ensurePotWakeRuleSync()).resolves.toBe(true);
      await expect(setPotEventSubscriptions('ws-a', [{ on: 'plans:start' }])).resolves.toBe(1);
      expect(potRules('ws-a')).toHaveLength(1);

      await reconnectHook?.();
      await vi.waitFor(() => expect(potRules('ws-a')).toHaveLength(0));
    });
  });

  it('projects locally and publishes every declaration with dedupe disabled', async () => {
    await expect(setPotEventSubscriptions('ws-a', [{ on: 'plans:start' }])).resolves.toBe(1);
    expect(potRules('ws-a')).toHaveLength(1);
    expect(notifySyncInvalidate).toHaveBeenCalledWith(
      POT_WAKE_RULES_INVALIDATION,
      { workspaceId: 'ws-a' },
      undefined,
      { dedupeWindowMs: 0 },
    );
  });
});
