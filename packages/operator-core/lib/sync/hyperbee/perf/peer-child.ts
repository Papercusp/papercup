/**
 * peer-child.ts — one substrate peer as a real OS process, for the
 * multi-process Tier-1/2 scenarios (P-005/P-006).
 *
 * The replication + churn benches need peers in SEPARATE processes: a single
 * process hosting N handles shares one event loop, which both serializes the
 * sync work (hiding contention) and makes the D-003 loop-lag SLO meaningless
 * (whose lag is it?). Each child runs ONE peer — boots the substrate against
 * the parent's local testnet DHT, plays a role, and reports a structured
 * result on stdout.
 *
 * Launch: `node --import tsx <this file>` with the JSON config in the
 * P2P_PERF_CHILD env var (spawned by scenarios/replication.ts / churn.ts —
 * never run by hand).
 *
 * Wire protocol (ndjson, child stdout → parent):
 *   {evt:'ready', keyHex}                — substrate booted, swarm joined
 *   {evt:'progress', appliedKeys, t}     — reader catch-up progress (1Hz)
 *   {evt:'caught-up', t, appliedKeys}    — reader reached expectedWinners
 *   {evt:'result', …}                    — final per-process measurements
 *   {evt:'error', message}               — fatal; child exits 1
 * Parent stdin → child: single lines `go` (writer starts load) and `stop`
 * (finalize + emit result + exit).
 */

import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { closeHarnessStore } from '../corestore';
import type { OpEnvelope } from '../op-envelope-types';
import type { PeerLogOp } from '../peer-log';
import Hyperswarm from 'hyperswarm';
import type { HyperswarmLike } from '../swarm';
import { makePeerIdentity } from './fixture';
import { generateCorpus } from './corpus';
import { ScenarioMeter } from './metrics';
import { summarize } from './metrics';

export interface PeerChildConfig {
  role: 'writer' | 'reader';
  workspaceId: string;
  harnessSlug: string;
  /** Workspace root for this peer's corestore. Reused across churn restarts. */
  root: string;
  /** Local-testnet DHT bootstrap (Tier 1/2). ABSENT or empty → the PUBLIC DHT
   *  (Tier-3 real-WAN peers — p2p-performance-suite D-007). */
  bootstrap?: Array<{ host: string; port: number }>;
  peerIndex: number;
  /** Reader merge-poll cadence (production default 1000). */
  mergePollMs?: number;
  /** Writer: corpus seed for measurement ops. */
  seed?: number;
  /** Writer: sustained append rate (ops/sec). 0 = as-fast-as-possible (ceiling mode). */
  rate?: number;
  /** Writer: total measurement ops to append after `go`. */
  count?: number;
  /** Writer: pre-seed this many corpus history ops into the own log BEFORE `ready` (cold-join / churn). */
  preSeed?: number;
  /**
   * Author pubkey used for CORPUS ops (not the peer's real device identity).
   * Fixed + shared with the parent so corpus keys — and therefore the
   * expected-winner count — are computable on both sides. Default 'a'×64.
   */
  corpusAuthor?: string;
  /** Reader: distinct winner keys to consider "caught up". */
  expectedWinners?: number;
  /** Reader: stop waiting after this long even if not caught up. */
  catchUpTimeoutMs?: number;
}

/** Swarm/DHT network observations over the scenario window (Tier-3 P-011:
 *  real-WAN discovery time + NAT/holepunch behavior; harmless zeros on a
 *  loopback testnet). Punch/relay counters are DELTAS off `swarm.dht.stats`
 *  (hyperdht ≥6.32 exposes `punches` + `relaying`). */
export interface PeerNetStats {
  /** ms from substrate-boot start to the first swarm connection (DHT discovery + connect). Null = never connected. */
  firstConnectionMs: number | null;
  /** Per-connection observations (capped at 200). `remoteHost` distinguishes direct vs relay paths. */
  connections: Array<{ atMs: number; remoteHost?: string; remotePort?: number; peerKey?: string }>;
  punches: { consistent: number; random: number; open: number };
  relaying: { attempts: number; successes: number; aborts: number };
}

export interface PeerChildResult {
  evt: 'result';
  role: 'writer' | 'reader';
  peerIndex: number;
  keyHex: string;
  /** Network-path observations (always present; zeros on loopback testnets). */
  net?: PeerNetStats;
  /** Reader: replication latency summary (ms) over measurement ops (sentAt → applied). */
  latency?: ReturnType<typeof summarize>;
  /** Reader: the raw latency samples (capped) so the parent can compute exact cross-reader distributions. */
  latenciesRaw?: number[];
  /** Reader: catch-up wall time from boot to expectedWinners, if it happened. */
  catchUpMs?: number;
  caughtUp?: boolean;
  appliedKeys: number;
  appliedOps: number;
  /** Writer: ops appended + the append-call latency summary. */
  appended?: number;
  appendMs?: ReturnType<typeof summarize>;
  loopLag: { p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
  cpu: { userMs: number; systemMs: number };
  rssPeakBytes: number;
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main(): Promise<void> {
  const cfg = JSON.parse(process.env.P2P_PERF_CHILD ?? '{}') as PeerChildConfig;
  if (!cfg.role) throw new Error('peer-child: P2P_PERF_CHILD config missing');

  const meter = new ScenarioMeter({
    scenario: `child.${cfg.role}`,
    tier: 1,
    params: { peerIndex: cfg.peerIndex },
  });

  const identity = makePeerIdentity(`peer-${cfg.peerIndex}`, 1000 + cfg.peerIndex);
  // No bootstrap (or empty) = the PUBLIC DHT — the Tier-3 real-WAN posture (D-007).
  const swarm = new Hyperswarm(
    cfg.bootstrap && cfg.bootstrap.length ? { bootstrap: cfg.bootstrap } : {},
  ) as unknown as HyperswarmLike & {
    destroy(): Promise<void>;
    on(ev: 'connection', cb: (socket: unknown, peerInfo: unknown) => void): void;
    dht?: { stats?: { punches?: Record<string, number>; relaying?: Record<string, number> } };
  };

  // Net probe (Tier-3 P-011): first-connection time, per-connection remote
  // addresses, and dht punch/relay counter deltas over the scenario window.
  const dhtStats = () => {
    const s = swarm.dht?.stats;
    return {
      punches: {
        consistent: s?.punches?.consistent ?? 0,
        random: s?.punches?.random ?? 0,
        open: s?.punches?.open ?? 0,
      },
      relaying: {
        attempts: s?.relaying?.attempts ?? 0,
        successes: s?.relaying?.successes ?? 0,
        aborts: s?.relaying?.aborts ?? 0,
      },
    };
  };
  const statsAtBoot = dhtStats();
  const netConnections: PeerNetStats['connections'] = [];
  let firstConnectionAt: number | null = null;

  // Reader measurement state. Measurement ops are table='perf-rep' with
  // value.sentAt; history/corpus ops count toward catch-up via distinct keys.
  const latencies: number[] = [];
  const appliedKeys = new Set<string>();
  let appliedOps = 0;
  const bootT0 = Date.now();
  let caughtUpAt: number | null = null;

  swarm.on('connection', (socket, peerInfo) => {
    const at = Date.now();
    if (firstConnectionAt === null) firstConnectionAt = at;
    if (netConnections.length >= 200) return;
    const raw = (socket as { rawStream?: { remoteHost?: string; remotePort?: number } }).rawStream;
    const key = (peerInfo as { publicKey?: Buffer } | undefined)?.publicKey;
    netConnections.push({
      atMs: at - bootT0,
      ...(raw?.remoteHost ? { remoteHost: raw.remoteHost } : {}),
      ...(typeof raw?.remotePort === 'number' ? { remotePort: raw.remotePort } : {}),
      ...(key ? { peerKey: key.toString('hex') } : {}),
    });
  });

  const apply = async (op: OpEnvelope): Promise<boolean> => {
    appliedOps++;
    if (op.table && op.hbKey) appliedKeys.add(`${op.table}::${op.hbKey}`);
    if (op.table === 'perf-rep' && op.type === 'put') {
      const sentAt = (op.value as { sentAt?: number } | undefined)?.sentAt;
      // Re-applied winners on later passes would double-count: first sight only.
      if (typeof sentAt === 'number' && !seenRep.has(op.hbKey!)) {
        seenRep.add(op.hbKey!);
        latencies.push(Date.now() - sentAt);
      }
    }
    if (
      caughtUpAt === null &&
      cfg.expectedWinners &&
      appliedKeys.size >= cfg.expectedWinners
    ) {
      caughtUpAt = Date.now();
      out({ evt: 'caught-up', t: caughtUpAt - bootT0, appliedKeys: appliedKeys.size });
    }
    return true;
  };
  const seenRep = new Set<string>();

  const binding = {
    kind: 'local' as const,
    workspace_id: cfg.workspaceId,
    harness_slug: cfg.harnessSlug,
  };

  let handle: BootedHarnessHandle | null = null;
  try {
    handle = await bootHarnessSubstrate({
      workspaceRoot: cfg.root,
      workspaceId: cfg.workspaceId,
      harnessSlug: cfg.harnessSlug,
      swarmBinding: binding,
      swarmOverride: swarm,
      verifyBindingOverride: async () => 'verified',
      applyOverride: apply,
      mergePollMs: cfg.mergePollMs ?? 1000,
      pendingRetryMs: 1000,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(),
      announceIdentityOverride: identity.override,
    });

    // Writer pre-seed (history for cold-join / churn scenarios).
    if (cfg.role === 'writer' && cfg.preSeed && cfg.preSeed > 0) {
      const BATCH = 2000;
      let batch: PeerLogOp[] = [];
      for (const op of generateCorpus({
        seed: cfg.seed ?? 1,
        count: cfg.preSeed,
        authorPubkey: cfg.corpusAuthor ?? 'a'.repeat(64),
      })) {
        batch.push(op);
        if (batch.length >= BATCH) {
          await handle.ownLog.appendBatch(batch);
          batch = [];
        }
      }
      if (batch.length) await handle.ownLog.appendBatch(batch);
    }

    out({ evt: 'ready', keyHex: handle.ownLog.keyHex });

    // Mesh-readiness: emit `admitted` once this peer has admitted at least one
    // remote log (the parent gates the load phase on every reader reporting it).
    let admittedReported = false;
    const admissionTimer = setInterval(() => {
      if (!admittedReported && handle!.admitted.size >= 2) {
        admittedReported = true;
        out({ evt: 'admitted', size: handle!.admitted.size });
      }
    }, 100);
    admissionTimer.unref();

    // Reader: 1Hz progress so the parent can watch catch-up.
    const progressTimer =
      cfg.role === 'reader'
        ? setInterval(() => {
            out({ evt: 'progress', appliedKeys: appliedKeys.size, t: Date.now() - bootT0 });
          }, 1000)
        : null;
    progressTimer?.unref();

    // Command loop over stdin.
    let appended = 0;
    const appendDurations: number[] = [];
    const stdinLines = createLineReader();

    for (;;) {
      const line = await stdinLines.next();
      if (line === null || line === 'stop') break;
      if (line === 'ping') {
        // Clock probe (Tier-3): the parent estimates this machine's clock offset
        // over the ALREADY-OPEN channel (min-RTT sample wins), so cross-machine
        // sentAt→applied latencies can be skew-corrected/sanity-checked.
        out({ evt: 'pong', tRemote: Date.now() });
        continue;
      }
      if (line === 'go' && cfg.role === 'writer') {
        const count = cfg.count ?? 0;
        const rate = cfg.rate ?? 0;
        const intervalMs = rate > 0 ? 1000 / rate : 0;
        let next = Date.now();
        for (let i = 0; i < count; i++) {
          if (intervalMs > 0) {
            next += intervalMs;
            const wait = next - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          }
          const t0 = Date.now();
          await handle.append({
            type: 'put',
            table: 'perf-rep',
            hbKey: `rep-${cfg.peerIndex}-${i}`,
            value: { sentAt: t0 },
            ts: t0,
            schema_version: 1,
            writerPubkey: identity.devicePubkey,
          });
          appendDurations.push(Date.now() - t0);
          appended++;
        }
        out({ evt: 'writer-done', appended });
      }
    }

    if (progressTimer) clearInterval(progressTimer);

    const artifact = meter.finish();
    const statsAtEnd = dhtStats();
    const net: PeerNetStats = {
      firstConnectionMs: firstConnectionAt === null ? null : firstConnectionAt - bootT0,
      connections: netConnections,
      punches: {
        consistent: statsAtEnd.punches.consistent - statsAtBoot.punches.consistent,
        random: statsAtEnd.punches.random - statsAtBoot.punches.random,
        open: statsAtEnd.punches.open - statsAtBoot.punches.open,
      },
      relaying: {
        attempts: statsAtEnd.relaying.attempts - statsAtBoot.relaying.attempts,
        successes: statsAtEnd.relaying.successes - statsAtBoot.relaying.successes,
        aborts: statsAtEnd.relaying.aborts - statsAtBoot.relaying.aborts,
      },
    };
    const result: PeerChildResult = {
      evt: 'result',
      role: cfg.role,
      peerIndex: cfg.peerIndex,
      keyHex: handle.ownLog.keyHex,
      net,
      appliedKeys: appliedKeys.size,
      appliedOps,
      loopLag: artifact.loopLag!,
      cpu: artifact.cpu,
      rssPeakBytes: artifact.rss.peakBytes,
      ...(cfg.role === 'reader'
        ? {
            latency: summarize(latencies, 'ms'),
            latenciesRaw: latencies.slice(0, 50_000),
            caughtUp: caughtUpAt !== null,
            ...(caughtUpAt !== null ? { catchUpMs: caughtUpAt - bootT0 } : {}),
          }
        : { appended, appendMs: summarize(appendDurations, 'ms') }),
    };
    out(result);
  } catch (e) {
    out({ evt: 'error', message: e instanceof Error ? e.message : String(e) });
    process.exitCode = 1;
  } finally {
    try {
      await handle?.close();
      await closeHarnessStore({ workspaceRoot: cfg.root, harnessSlug: cfg.harnessSlug });
    } catch {
      /* ignore */
    }
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
  }
  // Timers in hyperswarm/corestore internals can linger; the result is out.
  process.exit(process.exitCode ?? 0);
}

/** Minimal async line reader over stdin. `next()` resolves null on EOF. */
function createLineReader(): { next(): Promise<string | null> } {
  let buf = '';
  const queue: string[] = [];
  let resolveWait: ((v: string | null) => void) | null = null;
  let eof = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (resolveWait) {
        resolveWait(line);
        resolveWait = null;
      } else {
        queue.push(line);
      }
    }
  });
  process.stdin.on('end', () => {
    eof = true;
    if (resolveWait) {
      resolveWait(null);
      resolveWait = null;
    }
  });
  return {
    next(): Promise<string | null> {
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (eof) return Promise.resolve(null);
      return new Promise((r) => {
        resolveWait = r;
      });
    },
  };
}

void main();
