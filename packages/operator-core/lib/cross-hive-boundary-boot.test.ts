/**
 * cross-hive-boundary-boot.test.ts — unit tests for the boot-wiring policy
 * (hive-network-surface-2026-06-11 P-001, brief B-01): directory-published
 * Hives wire, private Hives stay dark, re-ensure is idempotent, a visibility
 * flip tears down, a missing identity pubkey skips, and a peer HELLO
 * force-drains that peer's queue. Everything injected — no PG, no swarm.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetCrossHiveBoundaryBootForTests,
  ensureCrossHiveBoundariesWired,
  listWiredCrossHiveBoundaries,
  type EnsureCrossHiveBoundariesOpts,
} from './cross-hive-boundary-boot';
import { getCrossHiveBoundary } from './cross-hive-boundary-registry';
import type { CrossHiveOutbox, CrossHiveTransport, CrossHiveWireEnvelope } from './cross-hive-transport';
import type { DrainableOutbox } from './cross-hive-outbox-drain';
import type { DetailedPendingEnvelope } from './cross-hive-outbox-pg';
import type { HiveDirectoryMeta } from './hive-publish';

// Mock the owner-key-health signal at the boundary so this unit test stays
// hermetic (no real coord broadcast / PG toast) while still asserting the WIRING:
// an OWNED-but-keyless hive must raise signalOwnedHiveKeyMissing, and a hive whose
// key loads must clearOwnedHiveKeyHealth. The signal's own behavior (dedup,
// best-effort) is covered by hive-owner-key-health.test.ts.
const KEYHEALTH = vi.hoisted(() => ({
  missing: [] as Array<{ workspaceId: string; hiveSlug: string; context: string }>,
  cleared: [] as Array<{ workspaceId: string; hiveSlug: string }>,
}));
vi.mock('./hive-owner-key-health', () => ({
  signalOwnedHiveKeyMissing: async (ref: { workspaceId: string; hiveSlug: string; context: string }) => {
    KEYHEALTH.missing.push(ref);
    return true;
  },
  clearOwnedHiveKeyHealth: (ref: { workspaceId: string; hiveSlug: string }) => {
    KEYHEALTH.cleared.push(ref);
  },
}));

const WS = 'ws-test';

const meta = (hiveId: string, visibility: HiveDirectoryMeta['visibility']): HiveDirectoryMeta => ({
  hiveId,
  title: hiveId,
  description: '',
  visibility,
  memberTopics: [],
  createdAt: 1,
  ...(visibility === 'invite' ? { inviteSecret: 'secret' } : {}),
});

/** In-memory outbox satisfying both the wiring port and the drain port. */
function memOutbox() {
  const rows = new Map<string, DetailedPendingEnvelope>();
  const delivered: string[] = [];
  const outbox: CrossHiveOutbox & DrainableOutbox = {
    async enqueue(env) {
      rows.set(env.id, { env, attemptCount: 0, lastAttemptAt: 0 });
    },
    async pending() {
      return [...rows.values()].map((r) => r.env);
    },
    async pendingDetailed() {
      return [...rows.values()];
    },
    async markDelivered(id) {
      rows.delete(id);
      delivered.push(id);
    },
    async noteAttempt(id) {
      const r = rows.get(id);
      if (r) {
        r.attemptCount += 1;
        r.lastAttemptAt = Date.now();
      }
    },
  };
  return { outbox, rows, delivered };
}

interface Fixture {
  opts: EnsureCrossHiveBoundariesOpts;
  transports: Map<string, { sends: Array<{ to: string; id: string }>; closed: boolean; hello(pk: string): void }>;
  outboxes: Map<string, ReturnType<typeof memOutbox>>;
  setHives(metas: HiveDirectoryMeta[]): void;
  upPeers: Set<string>;
}

function fixture(initial: HiveDirectoryMeta[]): Fixture {
  let metas = initial;
  const transports: Fixture['transports'] = new Map();
  const outboxes: Fixture['outboxes'] = new Map();
  const upPeers = new Set<string>();
  const opts: EnsureCrossHiveBoundariesOpts = {
    listHives: async () => metas,
    loadPubkey: async (_ws, slug) => (slug === 'no-key' ? null : `pk-${slug}`),
    makeTransport: ({ hiveSlug, onPeerHello }) => {
      const rec = { sends: [] as Array<{ to: string; id: string }>, closed: false, hello: onPeerHello };
      transports.set(hiveSlug, rec);
      const t: CrossHiveTransport & { close(): Promise<void> } = {
        async send(to: string, env: CrossHiveWireEnvelope) {
          rec.sends.push({ to, id: env.id });
          if (!upPeers.has(to)) throw new Error('peer offline');
        },
        subscribe() {},
        async close() {
          rec.closed = true;
        },
      };
      return t;
    },
    makeOutbox: (_ws, slug) => {
      const ob = memOutbox();
      outboxes.set(slug, ob);
      return ob.outbox;
    },
    wireDeps: {
      requestPorts: {
        async openAsk() {
          return { ref: 'conv' };
        },
        async createWorkRequest() {
          return { ref: 'wi' };
        },
      },
      loadGrants: async () => [],
      signer: async () => Buffer.from('sig'),
    },
    drainOnWire: false,
  };
  return { opts, transports, outboxes, setHives: (m) => (metas = m), upPeers };
}

afterEach(() => {
  __resetCrossHiveBoundaryBootForTests();
  KEYHEALTH.missing.length = 0;
  KEYHEALTH.cleared.length = 0;
});

describe('ensureCrossHiveBoundariesWired — publish-gated wiring', () => {
  it('wires public + invite hives; a private hive stays dark', async () => {
    const f = fixture([meta('pub', 'public'), meta('inv', 'invite'), meta('priv', 'private')]);
    const res = await ensureCrossHiveBoundariesWired(WS, f.opts);
    expect(res.wired.sort()).toEqual(['inv', 'pub']);
    expect(res.closed).toEqual([]);
    expect(getCrossHiveBoundary(WS, 'pub')).toBeDefined();
    expect(getCrossHiveBoundary(WS, 'inv')).toBeDefined();
    expect(getCrossHiveBoundary(WS, 'priv')).toBeUndefined();
    expect(f.transports.has('priv')).toBe(false); // never even constructed a transport
    expect(listWiredCrossHiveBoundaries().map((b) => b.hivePubkey).sort()).toEqual(['pk-inv', 'pk-pub']);
  });

  it('re-ensure is idempotent: same wiring object, nothing closed (republish no-op)', async () => {
    const f = fixture([meta('pub', 'public')]);
    await ensureCrossHiveBoundariesWired(WS, f.opts);
    const first = getCrossHiveBoundary(WS, 'pub');
    const res2 = await ensureCrossHiveBoundariesWired(WS, f.opts);
    expect(res2).toMatchObject({ wired: [], alreadyWired: ['pub'], closed: [] });
    expect(getCrossHiveBoundary(WS, 'pub')).toBe(first);
    expect(f.transports.get('pub')!.closed).toBe(false);
  });

  it('a visibility flip converges: newly-private closes, newly-public wires', async () => {
    const f = fixture([meta('a', 'public'), meta('b', 'private')]);
    await ensureCrossHiveBoundariesWired(WS, f.opts);
    expect(getCrossHiveBoundary(WS, 'a')).toBeDefined();

    f.setHives([meta('a', 'private'), meta('b', 'public')]);
    const res = await ensureCrossHiveBoundariesWired(WS, f.opts);
    expect(res).toMatchObject({ wired: ['b'], closed: ['a'] });
    expect(getCrossHiveBoundary(WS, 'a')).toBeUndefined();
    expect(f.transports.get('a')!.closed).toBe(true); // the boundary went dark for real
    expect(getCrossHiveBoundary(WS, 'b')).toBeDefined();
  });

  it('an unpublished (removed) hive closes on the next ensure', async () => {
    const f = fixture([meta('a', 'public')]);
    await ensureCrossHiveBoundariesWired(WS, f.opts);
    f.setHives([]);
    const res = await ensureCrossHiveBoundariesWired(WS, f.opts);
    expect(res.closed).toEqual(['a']);
    expect(listWiredCrossHiveBoundaries()).toEqual([]);
  });

  it('a published hive without an identity pubkey is skipped (stays dark, loud owner-key signal, no throw)', async () => {
    const f = fixture([meta('no-key', 'public'), meta('ok', 'public')]);
    const res = await ensureCrossHiveBoundariesWired(WS, f.opts);
    expect(res.skipped).toEqual(['no-key']);
    expect(res.wired).toEqual(['ok']);
    expect(getCrossHiveBoundary(WS, 'no-key')).toBeUndefined();
    // The OWNED-but-keyless hive raised the deduped owner-key-missing escalation
    // instead of a silent skip (D-024 / D-023 BUG A).
    expect(KEYHEALTH.missing).toEqual([{ workspaceId: WS, hiveSlug: 'no-key', context: 'cross-hive-boot' }]);
    // The hive whose key DID load cleared any stale alert (recovery re-arm).
    expect(KEYHEALTH.cleared).toContainEqual({ workspaceId: WS, hiveSlug: 'ok' });
  });

  it('a hive-listing failure leaves existing boundaries untouched', async () => {
    const f = fixture([meta('a', 'public')]);
    await ensureCrossHiveBoundariesWired(WS, f.opts);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await ensureCrossHiveBoundariesWired(WS, {
      ...f.opts,
      listHives: async () => {
        throw new Error('registry unreachable');
      },
    });
    expect(res).toMatchObject({ wired: [], closed: [], skipped: [] });
    expect(getCrossHiveBoundary(WS, 'a')).toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('owned-hive listing failed'));
    warn.mockRestore();
  });
});

describe('peer HELLO → force-drain (the reconnect trigger)', () => {
  it("drains the reconnected peer's queued envelopes immediately, ignoring backoff", async () => {
    const f = fixture([meta('pub', 'public')]);
    await ensureCrossHiveBoundariesWired(WS, f.opts);

    // A deeply backed-off envelope for peer-x sits in the outbox.
    const ob = f.outboxes.get('pub')!;
    ob.rows.set('m1', {
      env: {
        id: 'm1',
        fromHivePubkey: 'pk-pub',
        toHivePubkey: 'peer-x',
        kind: 'ask',
        subject: 's',
        body: 'b',
        sig: 'g',
      },
      attemptCount: 8,
      lastAttemptAt: Date.now(),
    });

    // The peer comes back online and its HELLO arrives.
    f.upPeers.add('peer-x');
    f.transports.get('pub')!.hello('peer-x');

    await vi.waitFor(() => expect(ob.delivered).toEqual(['m1']));
    expect(f.transports.get('pub')!.sends.map((s) => s.id)).toEqual(['m1']);
  });
});
