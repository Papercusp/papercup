/**
 * Substrate boot wrapper — conditionally uses IPC or in-process.
 *
 * When SUBSTRATE_SIDECAR flag is ON, spawns the sidecar and calls it over IPC.
 * When OFF, uses in-process bootAllHarnessesForActiveWorkspace (legacy behavior).
 *
 * Failures fall back gracefully: if sidecar spawn or IPC fails, the in-process
 * fallback is used so substrate still boots (the sidecar is optional).
 */

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import {
  spawnSubstrateSidecar,
  registerSidecarShutdownHooks,
} from './substrate-sidecar-spawn';
import { getSubstrateIpcClient } from './substrate-ipc-client';
import { bootAllHarnessesForActiveWorkspace } from './boot-all';

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
    state: 'booted' | 'alreadyBooted' | 'failed';
    error?: string;
  }>;
  usedSidecar: boolean;
}

/**
 * Boot substrate — via IPC sidecar if flag is ON, else in-process.
 */
export async function bootSubstrateWithFallback(
  opts?: BootSubstrateOpts,
): Promise<BootSubstrateResult> {
  const useSidecar = await getFlag(FLAGS.SUBSTRATE_SIDECAR, 'system');

  if (!useSidecar) {
    // Flag OFF: use in-process (legacy)
    const result = await bootAllHarnessesForActiveWorkspace(opts);
    return { ...result, usedSidecar: false };
  }

  try {
    // Flag ON: spawn sidecar and use IPC
    console.log('[substrate-boot] spawning sidecar for process isolation');

    // Spawn sidecar and wait for ready
    await spawnSubstrateSidecar();
    registerSidecarShutdownHooks();

    // Register graceful shutdown for sidecar
    const client = getSubstrateIpcClient();

    // Test healthz to verify connection
    try {
      await client.call('sidecar:healthz');
      console.log('[substrate-boot] sidecar ready, using IPC');
    } catch (err) {
      console.warn('[substrate-boot] healthz check failed, falling back to in-process:', err);
      return await bootAllHarnessesForActiveWorkspace(opts).then((r) => ({
        ...r,
        usedSidecar: false,
      }));
    }

    // TODO: Phase 2 — implement bootAllHarnessesForActiveWorkspace over IPC.
    // For now, fall back to in-process (Phase 1 scope = skeleton + basic methods).
    console.log('[substrate-boot] Phase 1: sidecar running but using in-process boot');
    const result = await bootAllHarnessesForActiveWorkspace(opts);
    return { ...result, usedSidecar: false };
  } catch (err) {
    // Sidecar spawn failed: fall back to in-process
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[substrate-boot] sidecar spawn failed, falling back to in-process:', msg);
    const result = await bootAllHarnessesForActiveWorkspace(opts);
    return { ...result, usedSidecar: false };
  }
}
