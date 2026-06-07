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
  bootstrap: Array<{ host: string; port: number }>;
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
  /** Reader: distinct winner keys to consider "caught up". */
  expectedWinners?: number;
  /** Reader: stop waiting after this long even if not caught up. */
  catchUpTimeoutMs?: number;
}

export interface PeerChildResult {
  evt: 'result';
  role: 'writer' | 'reader';
  peerIndex: number;
  keyHex: string;
  /** Reader: replication latency summary (ms) over measurement ops (sentAt → applied). */
  latency?: ReturnType<typeof summarize>;
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
  const swarm = new Hyperswarm({ bootstrap: cfg.bootstrap }) as unknown as HyperswarmLike & {
    destroy(): Promise<void>;
  };

  // Reader measurement state. Measurement ops are table='perf-rep' with
  // value.sentAt; history/corpus ops count toward catch-up via distinct keys.
  const latencies: number[] = [];
  const appliedKeys = new Set<string>();
  let appliedOps = 0;
  const bootT0 = Date.now();
  let caughtUpAt: number | null = null;

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
        authorPubkey: identity.devicePubkey,
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
    const result: PeerChildResult = {
      evt: 'result',
      role: cfg.role,
      peerIndex: cfg.peerIndex,
      keyHex: handle.ownLog.keyHex,
      appliedKeys: appliedKeys.size,
      appliedOps,
      loopLag: artifact.loopLag!,
      cpu: artifact.cpu,
      rssPeakBytes: artifact.rss.peakBytes,
      ...(cfg.role === 'reader'
        ? {
            latency: summarize(latencies, 'ms'),
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
