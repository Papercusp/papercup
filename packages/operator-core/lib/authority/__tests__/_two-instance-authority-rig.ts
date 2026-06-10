/**
 * _two-instance-authority-rig — shared test rig for the cross-machine lock
 * authority E2Es (coord-system-e2e-testing-2026-06-10 P-003 / P-007).
 *
 * Two simulated machines, each with its OWN lock store (per-machine
 * `papercusp_su` in production), the REAL file-lock op handlers
 * (`buildFileLockAuthorityHandlers`), a real loopback HTTP server wrapping the
 * REAL `handleAuthorityRpc`, HARDENED authority verification
 * (`resolveHardenedAuthority` — epoch fencing + anti-flap over a shared record
 * store standing in for the federated `authority_grants` row), and the D-005
 * `LockSetReconstructor` handover. The clock and presence roster are injected
 * and mutable so staleness / grace / cooldown windows are driven
 * deterministically — no sleeps.
 *
 * Underscore-prefixed: not a test file; consumed by the *.integration.test.ts
 * suites beside it (the `_multi-session-testbed.ts` convention).
 */
import { createServer, type Server } from 'node:http';

import type { FileLockRoutingDeps } from '../file-lock-routing';
import type { LockAuthorityDeps } from '../lock-authority';
import {
  handleAuthorityRpc,
  type AuthorityOpHandler,
  type AuthorityRpcEnvelope,
} from '../authority-op-registry';
import {
  buildFileLockAuthorityHandlers,
  type FileLockCoordinator,
} from '../file-lock-authority-ops';
import { resolveHardenedAuthority } from '../hardened-authority';
import type { AuthorityRecord, HardeningTiming } from '../authority-hardening';
import { LockSetReconstructor } from '../lock-set-reconstructor';
import { __resetPeerRpcTransportForTests } from '../peer-rpc-transport';
import {
  wireAuthorityRpcTransport,
  configurePeerAddressResolver,
  _testing as transportTesting,
} from '../transport-wiring';

export interface StoredLock {
  owner: string;
  lockId: string;
}

export interface RigOpts {
  harness: string;
  /** heartbeat 1s → stale 3s, grace 1s, cooldown 2s unless overridden. */
  timing?: HardeningTiming;
  startMs?: number;
  pubkeys?: { x: string; y: string; requester: string };
}

export interface GrantResult {
  ok: boolean;
  lockId?: string;
  epoch?: number;
  busy?: Array<{ path: string; owner: string }>;
}

export class RigInstance {
  readonly held = new Map<string, StoredLock>();
  reconstructor: LockSetReconstructor | null = null;
  epoch = 0;
  /** Inbound envelopes this instance's server received (wire-traffic probe). */
  readonly received: AuthorityRpcEnvelope[] = [];
  server!: Server;
  port = 0;
  private lockSeq = 0;

  constructor(
    readonly pubkey: string,
    private readonly rig: TwoInstanceAuthorityRig,
  ) {}

  /** Hardened resolution from THIS instance's point of view; manages the
   *  takeover lifecycle (epoch + a fresh reconstructor on becoming authority). */
  async resolve() {
    const r = await resolveHardenedAuthority(this.rig.harness, {
      fetchPresenceRows: async () => this.rig.presenceRows(),
      resolveSelf: async () => ({ githubUserId: 99, devicePubkey: this.pubkey }),
      loadRecord: async (slug) => this.rig.records.get(slug) ?? null,
      saveRecord: async (slug, rec) => {
        this.rig.records.set(slug, rec);
      },
      now: () => this.rig.clock,
      timing: this.rig.timing,
    });
    if (r.isSelf && r.epoch !== this.epoch) {
      this.epoch = r.epoch;
      this.reconstructor = new LockSetReconstructor({
        becameAuthorityAtMs: r.electedAtMs,
        heartbeatMs: this.rig.timing.heartbeatMs,
      });
    }
    return r;
  }

  /** Per-machine store behind the REAL op handlers, composed with the D-005
   *  handover reconstruction for the contended check. */
  coordinator(): FileLockCoordinator {
    return {
      acquire: async (p) => {
        const busy: Array<{ path: string; owner: string }> = [];
        for (const path of p.paths) {
          const cur = this.held.get(path);
          if (cur && cur.owner !== p.owner) busy.push({ path, owner: cur.owner });
          else if (this.reconstructor?.isHeldByOther(path, p.owner, this.rig.clock)) {
            busy.push({ path, owner: 'reasserted-holder' });
          }
        }
        if (busy.length) return { ok: false, busy };
        const lockId = `lk-${this.pubkey}-${++this.lockSeq}`;
        for (const path of p.paths) this.held.set(path, { owner: p.owner, lockId });
        return {
          ok: true,
          lockId,
          expiresTs: new Date(this.rig.clock + p.ttlSec * 1000).toISOString(),
          // Fencing token: the grant carries the epoch that minted it.
          epoch: this.epoch,
        } as never;
      },
      release: async (p) => {
        const released: string[] = [];
        for (const [path, lock] of this.held) {
          const match =
            lock.owner === p.owner && (p.allMine || p.lockId === lock.lockId || p.paths?.includes(path));
          if (match) {
            this.held.delete(path);
            released.push(path);
          }
        }
        return { ok: true, released };
      },
      queue: async () => ({
        active_locks: [...this.held.entries()].map(([path, l]) => ({ path, owner: l.owner })),
      }),
    };
  }

  handlers(): Record<string, AuthorityOpHandler> {
    return {
      ...buildFileLockAuthorityHandlers(this.coordinator()),
      // The holder→authority heartbeat re-assert (D-005). Production carries
      // this over the same transport seam; the op kind is rig-local for now —
      // logged in the coverage matrix as the heartbeat-wiring residual.
      'lock.assert': async (payload) => {
        const p = payload as { path: string; owner: string; ttlMs: number };
        this.reconstructor?.assert(p.path, p.owner, p.ttlMs, this.rig.clock);
        return { ok: true, rebuilt: this.reconstructor?.isRebuilt(this.rig.clock) ?? false };
      },
    };
  }

  async start(): Promise<void> {
    const handlers = this.handlers();
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const env = JSON.parse(body) as AuthorityRpcEnvelope;
          this.received.push(env);
          const result = await handleAuthorityRpc(env, {
            verifyIsAuthority: async () => (await this.resolve()).isSelf,
            handlers,
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'handler_error', message: String(e) }));
        }
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export class TwoInstanceAuthorityRig {
  readonly harness: string;
  readonly timing: HardeningTiming;
  readonly staleMs: number;
  clock: number;
  readonly roster = new Map<string, number>();
  readonly records = new Map<string, AuthorityRecord>();
  readonly X: RigInstance;
  readonly Y: RigInstance;
  readonly requesterPubkey: string;
  /** When true, the address resolver answers null for X — models a crashed box
   *  (connection refused / unreachable), distinct from presence staleness. */
  xCrashed = false;

  constructor(opts: RigOpts) {
    this.harness = opts.harness;
    this.timing = opts.timing ?? { heartbeatMs: 1_000 };
    this.staleMs = this.timing.staleMs ?? this.timing.heartbeatMs * 3;
    this.clock = opts.startMs ?? 1_700_000_000_000;
    const pk = opts.pubkeys ?? {
      x: 'aaa-instance-x',
      y: 'mmm-instance-y',
      requester: 'zzz-requester',
    };
    this.X = new RigInstance(pk.x, this);
    this.Y = new RigInstance(pk.y, this);
    this.requesterPubkey = pk.requester;
    for (const key of [pk.x, pk.y, pk.requester]) this.roster.set(key, this.clock);
  }

  presenceRows() {
    return [...this.roster.entries()].map(([pubkey, seen], i) => ({
      device_pubkey: pubkey,
      github_user_id: i + 1,
      machine_label: pubkey,
      last_seen_ms: seen,
    }));
  }

  /** Bump presence heartbeats to `clock` for the given pubkeys. */
  beat(...pubkeys: string[]): void {
    for (const pk of pubkeys) this.roster.set(pk, this.clock);
  }

  beatAllButX(): void {
    this.beat(this.Y.pubkey, this.requesterPubkey);
  }

  requesterAuthorityDeps(): LockAuthorityDeps {
    return {
      now: () => this.clock,
      staleMs: this.staleMs,
      resolveSelf: async () => ({ githubUserId: 3, devicePubkey: this.requesterPubkey }),
      fetchPresenceRows: async () => this.presenceRows(),
    };
  }

  requesterDeps(domain: string): FileLockRoutingDeps {
    return {
      ...this.requesterAuthorityDeps(),
      domainToHarnessSlug: (d) => (d === domain ? this.harness : null),
      harnessToHiveSlug: () => null,
      skipRemotePeersFastPath: true,
    };
  }

  async start(): Promise<void> {
    await this.X.start();
    await this.Y.start();
    transportTesting.reset();
    __resetPeerRpcTransportForTests();
    wireAuthorityRpcTransport();
    configurePeerAddressResolver((peer) => {
      if (peer.devicePubkey === this.X.pubkey) {
        return this.xCrashed ? null : `http://127.0.0.1:${this.X.port}`;
      }
      if (peer.devicePubkey === this.Y.pubkey) return `http://127.0.0.1:${this.Y.port}`;
      return null;
    });
  }

  async stop(): Promise<void> {
    transportTesting.reset();
    __resetPeerRpcTransportForTests();
    await this.X.stop();
    await this.Y.stop();
  }
}
