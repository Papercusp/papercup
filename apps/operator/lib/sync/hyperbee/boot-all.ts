/**
 * boot-all — workspace-scoped Hyperbee substrate orchestrator.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24
 *       (instrumentation-node.ts wiring task).
 *
 * One entry point per process. Discovers every harness in the active
 * workspace, calls `bootHarnessSubstrate` per harness, stashes the
 * handle in a module-level Map keyed by
 * `${workspaceId}::${harnessSlug}`, and exposes lookup + teardown.
 *
 * Idempotent at every level:
 *   - Re-booting an already-booted harness returns the cached handle.
 *   - Booting after partial failure retries only the failed harnesses.
 *   - Closing a non-existent handle is a no-op.
 *
 * What this DOES NOT do:
 *   - Hyperswarm replication. The bootHarnessSubstrate caller is
 *     responsible for handing the corestore to a swarm topic, since
 *     not every harness joins a swarm at boot (private harnesses
 *     skip it entirely).
 *   - Boot retry / backoff. A failure logs + moves on; the next
 *     bootAllHarnessesForActiveWorkspace() call retries.
 *
 * Gated by PAPERCUSP_DOGFOOD_SUBSTRATE_ENABLE=1 in the
 * instrumentation-node.ts call site so the default dev loop is
 * unchanged until you opt in.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  bootHarnessSubstrate,
  type BootedHarnessHandle,
} from './boot';

const handles: Map<string, BootedHarnessHandle> = new Map();
const inflight: Map<string, Promise<BootedHarnessHandle>> = new Map();

function key(workspaceId: string, harnessSlug: string): string {
  return `${workspaceId}::${harnessSlug}`;
}

/**
 * Resolve the workspace root on disk for a given workspaceId. Mirrors
 * `apps/operator/lib/papercusp-root.ts` resolution but stops one level
 * above `.papercusp/` so the substrate (which appends `.papercusp/...`)
 * lands in the right place.
 */
function workspaceRootForId(workspaceId: string): string {
  return join(homedir(), '.papercusp-workspaces', workspaceId);
}

/** True if the workspace dir holds at least one `harnesses/<slug>/` entry. */
function harnessSlugsFor(workspaceId: string): string[] {
  const wsRoot = workspaceRootForId(workspaceId);
  const harnessesDir =
    process.env.PAPERCUSP_HARNESSES_DIR ?? join(wsRoot, '.papercusp', 'harnesses');
  if (!existsSync(harnessesDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(harnessesDir);
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const candidate = join(harnessesDir, name);
    try {
      if (statSync(candidate).isDirectory()) slugs.push(name);
    } catch {
      // ignore — racing readdir / unlink etc.
    }
  }
  return slugs;
}

export interface BootSingleResult {
  workspaceId: string;
  harnessSlug: string;
  state: 'booted' | 'already-booted' | 'failed';
  error?: string;
}

export interface BootAllOpts {
  /** Override workspace list. Default: every workspace in the registry. */
  workspaceIds?: string[];
  /** Per-harness boot timeout. Default 30s. */
  perHarnessTimeoutMs?: number;
}

export interface BootAllResult {
  attempted: number;
  booted: number;
  alreadyBooted: number;
  failed: number;
  results: BootSingleResult[];
}

/** Resolve the cached handle for (workspace, harness). */
export function getBootedHarness(
  workspaceId: string,
  harnessSlug: string,
): BootedHarnessHandle | null {
  return handles.get(key(workspaceId, harnessSlug)) ?? null;
}

/** Boot a single (workspace, harness). Idempotent; safe to race. */
export async function bootSingleHarness(
  workspaceId: string,
  harnessSlug: string,
  opts: { workspaceRoot?: string; timeoutMs?: number } = {},
): Promise<BootSingleResult> {
  const k = key(workspaceId, harnessSlug);
  if (handles.has(k)) {
    return {
      workspaceId,
      harnessSlug,
      state: 'already-booted',
    };
  }
  const existing = inflight.get(k);
  if (existing) {
    try {
      await existing;
      return {
        workspaceId,
        harnessSlug,
        state: 'already-booted',
      };
    } catch (e) {
      return {
        workspaceId,
        harnessSlug,
        state: 'failed',
        error: (e as Error)?.message ?? String(e),
      };
    }
  }
  const workspaceRoot = opts.workspaceRoot ?? workspaceRootForId(workspaceId);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const bootPromise = (async () => {
    return await Promise.race([
      bootHarnessSubstrate({ workspaceRoot, workspaceId, harnessSlug }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`boot timeout after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  })();
  inflight.set(k, bootPromise);
  try {
    const handle = await bootPromise;
    handles.set(k, handle);
    return { workspaceId, harnessSlug, state: 'booted' };
  } catch (e) {
    return {
      workspaceId,
      harnessSlug,
      state: 'failed',
      error: (e as Error)?.message ?? String(e),
    };
  } finally {
    inflight.delete(k);
  }
}

/**
 * Discover + boot every harness across every workspace in the registry
 * (or just the workspaceIds passed in). Errors per harness are caught;
 * the result rolls them up so callers can log + continue.
 */
export async function bootAllHarnessesForActiveWorkspace(
  opts: BootAllOpts = {},
): Promise<BootAllResult> {
  const workspaceIds = opts.workspaceIds ?? readRegistryWorkspaceIds();
  const tasks: Array<Promise<BootSingleResult>> = [];
  for (const wsId of workspaceIds) {
    const slugs = harnessSlugsFor(wsId);
    for (const slug of slugs) {
      tasks.push(
        bootSingleHarness(wsId, slug, {
          timeoutMs: opts.perHarnessTimeoutMs,
        }),
      );
    }
  }
  const results = await Promise.all(tasks);
  return {
    attempted: results.length,
    booted: results.filter((r) => r.state === 'booted').length,
    alreadyBooted: results.filter((r) => r.state === 'already-booted').length,
    failed: results.filter((r) => r.state === 'failed').length,
    results,
  };
}

/** Tear down a single handle. Idempotent. */
export async function closeBootedHarness(
  workspaceId: string,
  harnessSlug: string,
): Promise<boolean> {
  const k = key(workspaceId, harnessSlug);
  const handle = handles.get(k);
  if (!handle) return false;
  handles.delete(k);
  try {
    await handle.close();
  } catch {
    // close errors are non-fatal; the handle is gone from the map
  }
  return true;
}

/** Tear down every cached handle. For test cleanup + process shutdown. */
export async function closeAllBootedHarnesses(): Promise<number> {
  const entries = Array.from(handles.entries());
  handles.clear();
  let closed = 0;
  await Promise.all(
    entries.map(async ([, h]) => {
      try {
        await h.close();
        closed += 1;
      } catch {
        // ignore
      }
    }),
  );
  return closed;
}

/** For tests. Clears the handle map WITHOUT closing — useful when the
 * handles were faked. Never call from production code. */
export function _resetHandleMapForTests(): void {
  handles.clear();
  inflight.clear();
}

/** For tests. Inject a handle directly (skips real boot). */
export function _setHandleForTests(
  workspaceId: string,
  harnessSlug: string,
  handle: BootedHarnessHandle,
): void {
  handles.set(key(workspaceId, harnessSlug), handle);
}

function readRegistryWorkspaceIds(): string[] {
  try {
    const path = join(homedir(), '.papercusp-workspaces', 'registry.json');
    if (!existsSync(path)) return [];
    // Use require-style read so the function stays small + sync.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    const text = fs.readFileSync(path, 'utf8');
    const parsed = JSON.parse(text) as {
      workspaces?: Array<{ id?: string }>;
    };
    return (parsed.workspaces ?? [])
      .map((w) => w.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

/** Exposed for tests + diagnostics. */
export function _harnessSlugsFor(workspaceId: string): string[] {
  return harnessSlugsFor(workspaceId);
}
