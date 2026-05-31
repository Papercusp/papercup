/**
 * swarm-guard — process-global DoS guard for the shared Hyperswarm
 * (hyperswarm-dos-hardening Phases 2-3: P-003 firewall ban-gate, P-004 ban-on-
 * abuse, P-005 per-peer connection rate-limit).
 *
 *   - `firewall(remotePublicKey)` — a SYNC predicate handed to
 *     `new Hyperswarm({ firewall })`; rejects banned keys pre-handshake (cheap).
 *     Hyperswarm only exposes the remote Noise key here, so the firewall is
 *     key-only.
 *   - `recordConnection(keyHex, ip)` — per-connection accounting run by the
 *     connection handler: a per-`(ip | key)` connection-rate limit (the shared
 *     `@papercusp/rate-limit` soft bucket over an IN-MEMORY store — D-004: conn
 *     gating is high-frequency + ephemeral, must cause zero PG writes). Tripping
 *     the limit bans the key + IP for a cooldown.
 *   - Enforcement: the firewall blocks future *key* connects pre-handshake; the
 *     handler's sync `isBanned*` drops an in-flight connection and one from a
 *     banned IP (the key-only firewall can't see IPs). Hyperswarm's own `ban()`
 *     does NOT close an existing connection (D-003), so the handler destroys it.
 *
 * Process-global (like the shared swarm) so a ban fed by any harness's handler
 * is seen by the one firewall. The ban-list TTL uses an injected clock for
 * deterministic tests; the rate-limiter uses its own `Date.now` (burst tests
 * don't advance time). Firewall semantics: `true` = DENY.
 */
import {
  createRateLimiter,
  type BucketStore,
  type BucketPayload,
  type StoredBucket,
} from '@papercusp/rate-limit';

/**
 * In-memory BucketStore for the connection-rate limiter (D-004 — NOT the
 * PG-backed store `auth-rate-limit` uses; per-connection checks must not touch PG).
 */
export function createInMemoryBucketStore(): BucketStore {
  const m = new Map<string, { payload: BucketPayload; touched: number }>();
  return {
    async read(key): Promise<StoredBucket> {
      return (m.get(key)?.payload ?? null) as StoredBucket;
    },
    async write(key, payload): Promise<void> {
      m.set(key, { payload, touched: Date.now() });
    },
    async delete(key): Promise<void> {
      m.delete(key);
    },
    async gcStale(olderThanMs): Promise<void> {
      for (const [k, v] of m) if (v.touched < olderThanMs) m.delete(k);
    },
    async clearPrefix(prefix): Promise<void> {
      for (const k of [...m.keys()]) if (k.startsWith(prefix)) m.delete(k);
    },
  };
}

/** Default ban cooldown (auto-unban after this; a forgotten ban self-heals). */
export const DEFAULT_BAN_TTL_MS = 10 * 60_000;
/** Connection-rate ceiling per `(ip | key)`: a burst above this is a clear
 *  reconnect storm (legitimate reconnects are rare). */
export const CONN_RATE = { windowMs: 10_000, capacity: 30 };

export interface SwarmGuard {
  /** SYNC predicate for `new Hyperswarm({ firewall })`. `true` = reject. */
  firewall(remotePublicKey: Buffer | Uint8Array | null | undefined): boolean;
  isBannedKey(keyHex: string): boolean;
  isBannedIp(ip: string): boolean;
  banKey(keyHex: string, ttlMs?: number): void;
  banIp(ip: string, ttlMs?: number): void;
  /** Per-connection accounting. Resolves `{ allow:false }` when the peer is
   *  already banned (`reason:'banned'`) or just tripped the connection-rate
   *  limit (`reason:'rate_limited'`, which also bans it) — the caller drops the
   *  socket and can record the reason for observability (P-007). */
  recordConnection(
    keyHex?: string,
    ip?: string,
  ): Promise<{ allow: boolean; reason?: 'banned' | 'rate_limited' }>;
}

export interface SwarmGuardOpts {
  now?: () => number;
  store?: BucketStore;
}

export function createSwarmGuard(opts: SwarmGuardOpts = {}): SwarmGuard {
  const now = opts.now ?? Date.now;
  const bannedKeys = new Map<string, number>(); // → expiry ms
  const bannedIps = new Map<string, number>();
  const limiter = createRateLimiter({
    store: opts.store ?? createInMemoryBucketStore(),
    soft: CONN_RATE,
  });

  const banned = (m: Map<string, number>, k: string): boolean => {
    const exp = m.get(k);
    if (exp === undefined) return false;
    if (now() >= exp) {
      m.delete(k); // lazy expiry → auto-unban
      return false;
    }
    return true;
  };
  const isBannedKey = (keyHex: string) => banned(bannedKeys, keyHex);
  const isBannedIp = (ip: string) => banned(bannedIps, ip);
  const banKey = (keyHex: string, ttlMs = DEFAULT_BAN_TTL_MS) =>
    void bannedKeys.set(keyHex, now() + ttlMs);
  const banIp = (ip: string, ttlMs = DEFAULT_BAN_TTL_MS) =>
    void bannedIps.set(ip, now() + ttlMs);

  return {
    isBannedKey,
    isBannedIp,
    banKey,
    banIp,
    firewall(remotePublicKey) {
      const keyHex = toHex(remotePublicKey);
      if (!keyHex) return false; // unidentifiable → allow (never break a legit peer)
      return isBannedKey(keyHex);
    },
    async recordConnection(keyHex, ip) {
      if ((keyHex && isBannedKey(keyHex)) || (ip && isBannedIp(ip))) {
        return { allow: false, reason: 'banned' };
      }
      const res = await limiter.checkSoft(`conn:${ip ?? keyHex ?? 'unknown'}`);
      if (!res.ok) {
        if (keyHex) banKey(keyHex);
        if (ip) banIp(ip);
        return { allow: false, reason: 'rate_limited' };
      }
      return { allow: true };
    },
  };
}

function toHex(rk: Buffer | Uint8Array | null | undefined): string | undefined {
  if (!rk) return undefined;
  try {
    return Buffer.isBuffer(rk) ? rk.toString('hex') : Buffer.from(rk).toString('hex');
  } catch {
    return undefined;
  }
}

// ── process-global singleton + test seam ──
let _guard: SwarmGuard | null = null;
export function getSwarmGuard(): SwarmGuard {
  if (!_guard) _guard = createSwarmGuard();
  return _guard;
}
export function _setSwarmGuardForTests(g: SwarmGuard | null): void {
  _guard = g;
}
