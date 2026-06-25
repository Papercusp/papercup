/**
 * Substrate boot wrapper — conditionally uses IPC or in-process, and starts the
 * LAZY_SUBSTRATE_BOOT eviction reaper.
 *
 * Two independent feature gates ride here:
 *
 *  - LAZY_SUBSTRATE_BOOT (P-008, WI-596): after the in-process boot, start the
 *    eviction reaper so idle INERT private harness engines are torn down to bound
 *    operator RSS sub-linearly in harness count. OFF ⇒ the reaper never starts;
 *    boot is byte-identical to eager all-harness boot.
 *
 *  - SUBSTRATE_SIDECAR (P-009/WI-604): Option B "replication-offload". The
 *    sidecar owns the full per-harness substrate engine (Corestore + own-log +
 *    merge/projection loop + swarm/admission + outbox/presence send-side). The
 *    main process caches `RemoteBootedHarnessHandle` proxies and routes append /
 *    control calls over IPC. OFF (the default) remains byte-identical in-process.
 */

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import {
  spawnSubstrateSidecar,
  registerSidecarShutdownHooks,
} from './substrate-sidecar-spawn';
import { getSubstrateIpcClient } from './substrate-ipc-client';
import { RemoteBootedHarnessHandle } from './remote-booted-harness';
import {
  bootAllHarnessesForActiveWorkspace,
  enableSubstrateEvictionTracking,
  gatherBootedHarnessFacts,
  evictBootedHarnessEngine,
} from './boot-all';
import {
  startSubstrateEvictionReaper,
  type SubstrateEvictionReaper,
} from './substrate-eviction-reaper';
import type { BootHarnessOpts } from './boot';

export interface BootSubstrateOpts {
  perHarnessTimeoutMs?: number;
}

export interface BootSubstrateResult {
  attempted: number;
  booted: number;
  alreadyBooted: number;
  failed: number;
  results: Array<{
    workspaceId: string;
    harnessSlug: string;
    state: 'booted' | 'already-booted' | 'failed';
    error?: string;
  }>;
  usedSidecar: boolean;
  /** Whether the LAZY_SUBSTRATE_BOOT eviction reaper was started this boot. */
  evictionReaperStarted: boolean;
}

/** Module singleton — one reaper per process; never started twice. */
let reaper: SubstrateEvictionReaper | null = null;

/**
 * Start the LAZY_SUBSTRATE_BOOT eviction reaper if the flag is ON and it isn't
 * already running. Returns whether the reaper is now active. Best-effort: a
 * failure to start never fails boot.
 */
export async function maybeStartSubstrateEvictionReaper(): Promise<boolean> {
  if (reaper) return true;
  let on = false;
  try {
    on = await getFlag(FLAGS.LAZY_SUBSTRATE_BOOT, 'system');
  } catch {
    on = false; // fail-closed: a flag-read error keeps eager behavior
  }
  if (!on) return false;
  try {
    enableSubstrateEvictionTracking();
    reaper = startSubstrateEvictionReaper({
      gatherFacts: (now) => gatherBootedHarnessFacts(now),
      evict: (key, guard) => evictBootedHarnessEngine(key, guard),
    });
    registerEvictionReaperShutdown();
    console.log('[substrate-boot] LAZY_SUBSTRATE_BOOT eviction reaper started');
    return true;
  } catch (e) {
    console.warn(
      '[substrate-boot] failed to start eviction reaper (continuing eager):',
      e instanceof Error ? e.message : String(e),
    );
    reaper = null;
    return false;
  }
}

let reaperShutdownRegistered = false;
function registerEvictionReaperShutdown(): void {
  if (reaperShutdownRegistered) return;
  reaperShutdownRegistered = true;
  const stop = (): void => {
    try {
      reaper?.stop();
    } catch {
      // best-effort
    }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

/** Stop the reaper (tests + shutdown). Idempotent. */
export function stopSubstrateEvictionReaper(): void {
  try {
    reaper?.stop();
  } finally {
    reaper = null;
  }
}

/**
 * Boot substrate — via IPC sidecar if the (dark) SUBSTRATE_SIDECAR flag is ON,
 * else in-process — then start the LAZY_SUBSTRATE_BOOT reaper.
 */
export async function bootSubstrateWithFallback(
  opts?: BootSubstrateOpts,
): Promise<BootSubstrateResult> {
  const useSidecar = await getFlag(FLAGS.SUBSTRATE_SIDECAR, 'system').catch(() => false);

  const finish = async (
    r: Awaited<ReturnType<typeof bootAllHarnessesForActiveWorkspace>>,
    usedSidecar: boolean,
  ): Promise<BootSubstrateResult> => {
    const evictionReaperStarted = await maybeStartSubstrateEvictionReaper();
    return { ...r, usedSidecar, evictionReaperStarted };
  };

  if (!useSidecar) {
    // Flag OFF (the default + correct state): in-process boot, then the reaper.
    const result = await bootAllHarnessesForActiveWorkspace(opts);
    return finish(result, false);
  }

  try {
    console.log('[substrate-boot] SUBSTRATE_SIDECAR on: spawning sidecar for relocated substrate boot');
    await spawnSubstrateSidecar();
    registerSidecarShutdownHooks();
    const client = getSubstrateIpcClient();
    await client.call('sidecar:healthz');
    const result = await bootAllHarnessesForActiveWorkspace({
      ...opts,
      skipSendSideWiring: true,
      bootHarness: async (bootOpts: BootHarnessOpts) => {
        const booted = await client.call<{
          storeId: string;
          ownLogKey: string;
          ownLogLength?: number;
        }>('substrate:bootHarness', {
          workspaceRoot: bootOpts.workspaceRoot,
          workspaceId: bootOpts.workspaceId,
          harnessSlug: bootOpts.harnessSlug,
          swarmBinding: bootOpts.swarmBinding ?? null,
        });
        return new RemoteBootedHarnessHandle({
          workspaceId: bootOpts.workspaceId,
          harnessSlug: bootOpts.harnessSlug,
          storeId: booted.storeId,
          ownLogKey: booted.ownLogKey,
          ownLogLength: booted.ownLogLength,
          client,
        });
      },
    });
    return finish(result, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[substrate-boot] sidecar spawn failed, falling back to in-process:', msg);
    const result = await bootAllHarnessesForActiveWorkspace(opts);
    return finish(result, false);
  }
}
