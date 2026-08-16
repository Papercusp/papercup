/**
 * child-driver.ts — parent-side harness for `peer-child.ts` processes
 * (P-005/P-006 multi-process scenarios).
 *
 * Spawns one OS process per peer (`node --import tsx peer-child.ts`, config
 * via env), parses the child's ndjson stdout into typed events, and exposes
 * await-helpers for the scenario scripts (`waitFor('ready')`, `sendGo()`, …).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import type { PeerChildConfig, PeerChildResult } from './peer-child';
import type { PerfArtifact } from './artifact';
import { recomputeConvergenceVerdict, type ScenarioMeter } from './metrics';
import { MeshFormationError } from './mesh-outcome';
import {
  capacityOverridesFromEnv,
  decideMeshCapacity,
  HostCapacityError,
  readMemAvailableBytes,
} from './host-capacity';

const CHILD_PATH = fileURLToPath(new URL('./peer-child.ts', import.meta.url));

export interface ChildEvent {
  evt: string;
  [k: string]: unknown;
}

/** Minimal structural shape of something awaitable for a child event (lets tests drive fakes). */
export interface CaughtUpWaitable {
  waitFor(pred: string, timeoutMs: number): Promise<ChildEvent | null>;
}

/**
 * Await `evt` on EVERY reader CONCURRENTLY, against a SHARED deadline: all timers
 * start at the same instant, so a reader is judged on the run's wall clock and never
 * on its position in the iteration order.
 *
 * EI-20581532536662596 — the scenarios previously did this SERIALLY, giving each reader
 * a FRESH budget as the loop reached it. Because `waitFor` resolves immediately for an
 * already-fired event, the reader polled FIRST got the full budget measured from loop
 * start while the Nth effectively got the budget PLUS all the time already spent waiting
 * on readers 0..N-1. The first slow reader was penalised hardest and, by burning its
 * budget, widened everyone else's — producing the giveaway signature that every failing
 * run missed by EXACTLY ONE reader. That made a red convergence verdict unable to
 * separate "the substrate failed" from "the box was loaded", which on a shared host
 * running an agent fleet is the difference between a release blocker and noise.
 *
 * Returns one entry per reader, in the SAME ORDER as `readers`; `event` is null on timeout.
 * `elapsedMs` is measured from the ONE shared start instant below — not from when this
 * reader's promise happened to be created — so the times are mutually comparable and
 * `budgetMs - max(elapsedMs)` is the run's true headroom (EI-20581532536662596).
 */
export async function awaitAllChildEvent<T extends CaughtUpWaitable>(
  readers: readonly T[],
  evt: string,
  budgetMs: number,
): Promise<Array<{ reader: T; event: ChildEvent | null; elapsedMs: number }>> {
  const startedAt = Date.now();
  return Promise.all(
    readers.map((reader) =>
      reader.waitFor(evt, budgetMs).then((event) => ({
        reader,
        event,
        elapsedMs: Date.now() - startedAt,
      })),
    ),
  );
}

export class PeerChildHandle {
  readonly events: ChildEvent[] = [];
  private waiters: Array<{
    pred: (e: ChildEvent) => boolean;
    resolve: (e: ChildEvent) => void;
  }> = [];
  exited = false;

  constructor(
    readonly cfg: PeerChildConfig,
    readonly proc: ChildProcess,
    private readonly log: (line: string) => void,
  ) {
    let buf = '';
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const e = JSON.parse(line) as ChildEvent;
          this.events.push(e);
          this.waiters = this.waiters.filter((w) => {
            if (w.pred(e)) {
              w.resolve(e);
              return false;
            }
            return true;
          });
        } catch {
          this.log(`[child ${cfg.peerIndex}] ${line}`);
        }
      }
    });
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) this.log(`[child ${cfg.peerIndex} stderr] ${line.trim()}`);
      }
    });
    proc.on('exit', () => {
      this.exited = true;
    });
  }

  /** First event (past or future) matching `pred`, bounded by `timeoutMs`. */
  waitFor(pred: string | ((e: ChildEvent) => boolean), timeoutMs: number): Promise<ChildEvent | null> {
    const p = typeof pred === 'string' ? (e: ChildEvent) => e.evt === pred : pred;
    const past = this.events.find(p);
    if (past) return Promise.resolve(past);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped);
        resolve(null);
      }, timeoutMs);
      const wrapped = (e: ChildEvent) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.waiters.push({ pred: p, resolve: wrapped });
    });
  }

  send(line: 'go' | 'stop' | 'ping' | 'wait-snapshot'): void {
    try {
      this.proc.stdin!.write(line + '\n');
    } catch {
      /* child already gone */
    }
  }

  /** `stop` + await result + exit. Null when the child died without a result. */
  async stopAndCollect(timeoutMs = 30_000): Promise<PeerChildResult | null> {
    const resultP = this.waitFor('result', timeoutMs);
    this.send('stop');
    const result = (await resultP) as PeerChildResult | null;
    if (!this.exited) {
      const exitP = once(this.proc, 'exit');
      const killTimer = setTimeout(() => this.proc.kill('SIGKILL'), 5000);
      await exitP;
      clearTimeout(killTimer);
    }
    return result;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    try {
      this.proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export function spawnPeerChild(
  cfg: PeerChildConfig,
  log: (line: string) => void,
  opts: {
    /** Command prefix, e.g. ['ip','netns','exec','p1'] for the Tier-2 netns peers. */
    execPrefix?: string[];
  } = {},
): PeerChildHandle {
  const argv = [...(opts.execPrefix ?? []), process.execPath, '--import', 'tsx', CHILD_PATH];
  const proc = spawn(argv[0], argv.slice(1), {
    env: {
      ...process.env,
      P2P_PERF_CHILD: JSON.stringify(cfg),
      // Children must never inherit a vitest/test PG context by accident.
      NODE_ENV: 'test',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new PeerChildHandle(cfg, proc, log);
}

export interface ProcMesh {
  writer: PeerChildHandle;
  readers: PeerChildHandle[];
  roots: { writer: string; readers: string[] };
  bootstrap: Array<{ host: string; port: number }>;
  workspaceId: string;
  harnessSlug: string;
  teardown(): Promise<void>;
}

/**
 * Spawn a writer + N readers, each its own OS process, all joined to one
 * local-testnet swarm topic. Resolves once every reader has admitted the
 * writer's log (the mesh is ready for a load phase). Pass `bootstrap` to ride
 * an externally-owned testnet (churn re-spawns need the DHT to outlive the
 * mesh); otherwise a testnet is created and torn down with the mesh.
 */
export async function spawnProcMesh(opts: {
  readers: number;
  log: (l: string) => void;
  writerCfg?: Partial<PeerChildConfig>;
  readerCfg?: Partial<PeerChildConfig>;
  meshTimeoutMs?: number;
  bootstrap?: Array<{ host: string; port: number }>;
  /** Reuse roots (churn re-spawn). Default: fresh tmp dirs. */
  roots?: { writer: string; readers: string[] };
  /** Per-peer spawn prefix (Tier-2: ['ip','netns','exec',`p${i}`]). Index 0 = writer. */
  execPrefixFor?: (peerIndex: number) => string[] | undefined;
  /** Test seam: factory for each peer child (default `spawnPeerChild`). Lets a
   *  unit test drive mesh-formation OUTCOMES — and assert the typed
   *  `MeshFormationError` (EI-115) — without spawning real OS processes. */
  spawnChild?: typeof spawnPeerChild;
  /** Test seam: override the host's reported MemAvailable for the capacity
   *  preflight. `null` = host does not report it (guard abstains). */
  availableBytes?: number | null;
}): Promise<ProcMesh> {
  const mkChild = opts.spawnChild ?? spawnPeerChild;

  // Capacity preflight — BEFORE any testnet, tmpdir or child exists, so a mesh
  // that cannot fit costs nothing and leaves nothing to clean up. See
  // host-capacity.ts for the measurement this is anchored on.
  const capacity = decideMeshCapacity({
    peers: opts.readers + 1, // + the writer
    availableBytes: opts.availableBytes !== undefined ? opts.availableBytes : readMemAvailableBytes(),
    ...capacityOverridesFromEnv(),
  });
  if (!capacity.ok) {
    opts.log(`[mesh] REFUSED: ${capacity.reason}`);
    throw new HostCapacityError(capacity.reason ?? 'host capacity exceeded', capacity);
  }

  let ownedTestnet: { destroy(): Promise<void> } | null = null;
  let bootstrap = opts.bootstrap;
  if (!bootstrap) {
    const testnet = await createTestnet(3);
    ownedTestnet = testnet;
    bootstrap = (testnet.bootstrap as Array<{ host: string; port: number }>).map((b) => ({
      host: b.host,
      port: b.port,
    }));
  }
  const workspaceId = 'ws-p2p-perf-proc';
  const harnessSlug = 'perf-proc';
  const dirs: string[] = [];
  const mkRoot = (p: string) => {
    const d = mkdtempSync(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  const roots = opts.roots ?? {
    writer: mkRoot('p2p-perf-w-'),
    readers: Array.from({ length: opts.readers }, (_, i) => mkRoot(`p2p-perf-r${i}-`)),
  };

  const writer = mkChild(
    {
      role: 'writer',
      workspaceId,
      harnessSlug,
      root: roots.writer,
      bootstrap,
      peerIndex: 0,
      ...opts.writerCfg,
    },
    opts.log,
    { execPrefix: opts.execPrefixFor?.(0) },
  );
  // Writer first (it may pre-seed history); readers join once it is ready.
  const meshTimeout = opts.meshTimeoutMs ?? 120_000;
  const writerReady = await writer.waitFor('ready', meshTimeout);
  if (!writerReady) {
    writer.kill('SIGKILL');
    throw new MeshFormationError('proc mesh: writer never became ready');
  }

  const readers = Array.from({ length: opts.readers }, (_, i) =>
    mkChild(
      {
        role: 'reader',
        workspaceId,
        harnessSlug,
        root: roots.readers[i],
        bootstrap,
        peerIndex: i + 1,
        ...opts.readerCfg,
      },
      opts.log,
      { execPrefix: opts.execPrefixFor?.(i + 1) },
    ),
  );

  for (const r of readers) {
    const ok = (await r.waitFor('ready', meshTimeout)) && (await r.waitFor('admitted', meshTimeout));
    if (!ok) {
      writer.kill('SIGKILL');
      for (const rr of readers) rr.kill('SIGKILL');
      throw new MeshFormationError(
        `proc mesh: reader ${r.cfg.peerIndex} never admitted the writer`,
        r.cfg.peerIndex,
      );
    }
  }

  return {
    writer,
    readers,
    roots,
    bootstrap,
    workspaceId,
    harnessSlug,
    async teardown() {
      writer.kill('SIGKILL');
      for (const r of readers) r.kill('SIGKILL');
      if (ownedTestnet) {
        try {
          await ownedTestnet.destroy();
        } catch {
          /* ignore */
        }
      }
      for (const d of dirs) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/** Fold child results into the artifact: worst-child lag is the SLO basis
 *  (the parent's own loop only orchestrates — P-007/D-003 judge the peers). */
export function foldChildResults(
  meter: ScenarioMeter,
  artifactPatch: (a: PerfArtifact) => void,
  results: Array<PeerChildResult | null>,
): PerfArtifact {
  const lagP95 = meter.metric('childLoopLagP95Ms', 'ms');
  const rss = meter.metric('childRssPeak', 'bytes');
  let worst: PeerChildResult['loopLag'] | null = null;
  for (const r of results) {
    if (!r) continue;
    lagP95.push(r.loopLag.p95Ms);
    rss.push(r.rssPeakBytes);
    if (!worst || r.loopLag.p95Ms > worst.p95Ms) worst = r.loopLag;
  }
  const artifact = meter.finish();
  if (worst) {
    artifact.loopLag = worst;
    artifact.sloPassed = worst.p95Ms < artifact.sloLimitMs;
  }
  artifactPatch(artifact);
  // The patch is what attaches `appendToVisibleMs`, so the latency half of the
  // convergence verdict can only be judged here, after it (EI-20576392705164447).
  recomputeConvergenceVerdict(artifact);
  return artifact;
}
