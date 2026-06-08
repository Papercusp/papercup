/**
 * boot-all — workspace-scoped Hyperbee substrate orchestrator.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24
 *       + papercusp-dogfood-phase11-multi-engineer-2026-05-25 (P-078).
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
 * Phase 11 P-078 — when a harness has a committed
 * `.papercusp/shared.json`, this module resolves the harness's project
 * directory (PG-canonical via `resolveHarnessPaths`), reads the
 * config, and synthesizes a `gh:<repository_id>` SwarmBinding so the
 * substrate joins Hyperswarm at boot. Private harnesses (no
 * shared.json) get no binding and stay local-only.
 *
 * What this DOES NOT do:
 *   - Boot retry / backoff. A failure logs + moves on; the next
 *     bootAllHarnessesForActiveWorkspace() call retries.
 *
 * Always runs at host boot (bin/host-bootstrap.ts) — the opt-in gate was
 * removed in Stage 4d; the Model B substrate is the default.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { workspacesRoot } from '../../workspace-registry';
import { join } from 'node:path';
import {
  bootHarnessSubstrate,
  type BootedHarnessHandle,
} from './boot';
import type { SwarmBinding } from './derive-swarm-topic';
import { loadSharedConfigFromProjectDir } from '../../harness/load-shared-config';
import { wireOutboxForHarness } from './wire-outbox';

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
  return join(workspacesRoot(), workspaceId);
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
  /**
   * Override the swarm-binding resolver. Default reads
   * `.papercusp/shared.json` via `resolveHarnessPaths` and returns
   * `{ kind: 'gh', github_repository_id }` when present. Tests
   * inject a synchronous fake.
   */
  resolveSwarmBinding?: SwarmBindingResolver;
}

/**
 * Given (workspaceId, harnessSlug) decide whether the substrate
 * should join a Hyperswarm topic at boot.
 *
 *   - `null` / `undefined` → private harness, skip swarm join.
 *   - `SwarmBinding` → boot joins the derived 32-byte topic.
 *
 * Async so the default resolver can hit PG via `resolveHarnessPaths`
 * for the project directory.
 */
export type SwarmBindingResolver = (
  workspaceId: string,
  harnessSlug: string,
) => Promise<SwarmBinding | null | undefined>;

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

/**
 * Default swarm-binding resolver. Precedence:
 *   1. shared-hive-federation P-004 — if the harness is the home of a SHARED
 *      (directory-published) Hive, federate over the Hive PUBKEY topic
 *      (`resolveHiveSwarmBinding` → `{ kind: 'hive', hive_pubkey }`). This is the
 *      federation re-key: the Hive id, not the harness slug, is the topic key.
 *   2. else read `.papercusp/shared.json` (PG-canonical via `resolveHarnessPaths`)
 *      and return a `gh:<repository_id>` binding when present.
 *   3. else `null` (private / local-only — no swarm join).
 * Errors swallow to `null` so a missing/corrupt config never blocks the boot loop.
 */
export async function defaultResolveSwarmBinding(
  workspaceId: string,
  harnessSlug: string,
): Promise<SwarmBinding | null> {
  try {
    // (1) A SHARED Hive's harness federates over the Hive pubkey topic, replacing
    // the per-harness gh/local topic (D-001/D-003). A non-hive or local-only
    // harness returns null here and falls through to the gh-binding path unchanged.
    const { resolveHiveSwarmBinding } = await import('../../hive-federation');
    const hiveBinding = await resolveHiveSwarmBinding(workspaceId, harnessSlug);
    if (hiveBinding) return hiveBinding;

    // (2) Existing per-harness gh binding from a committed shared.json.
    const { resolveHarnessPaths } = await import('../../resolve-harness-paths');
    const { projectDir } = await resolveHarnessPaths(harnessSlug, workspaceId);
    if (projectDir.startsWith('/tmp/papercusp-unresolved/')) return null;
    const cfg = loadSharedConfigFromProjectDir(projectDir);
    if (!cfg) return null;
    return { kind: 'gh', github_repository_id: cfg.github_repository_id };
  } catch {
    return null;
  }
}

/** Boot a single (workspace, harness). Idempotent; safe to race. */
export async function bootSingleHarness(
  workspaceId: string,
  harnessSlug: string,
  opts: {
    workspaceRoot?: string;
    timeoutMs?: number;
    resolveSwarmBinding?: SwarmBindingResolver;
  } = {},
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
  const resolver = opts.resolveSwarmBinding ?? defaultResolveSwarmBinding;
  const bootPromise = (async () => {
    const swarmBinding = (await resolver(workspaceId, harnessSlug)) ?? null;
    return await Promise.race([
      bootHarnessSubstrate({
        workspaceRoot,
        workspaceId,
        harnessSlug,
        swarmBinding,
      }),
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
    // Stage 5 (feature-content federation): bring the send-side online —
    // one-time backfill of existing local rows + the outbox drain loop. The
    // drain's stopper is registered as a close-hook on the handle, so
    // closeBootedHarness/closeAllBootedHarnesses (which call handle.close())
    // tear it down automatically — no parallel stopper Map needed. Best-effort:
    // a wiring failure must NEVER block the boot result (federation is additive;
    // PG-direct still works), so swallow + log.
    try {
      const { sql } = (await import('@papercusp/db-org')).getOrgPg();
      await wireOutboxForHarness(handle, sql);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[boot-all] outbox wiring failed for ${k} (boot still succeeded):`,
        e instanceof Error ? e.message : String(e),
      );
    }
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
          resolveSwarmBinding: opts.resolveSwarmBinding,
        }),
      );
    }
  }
  const results = await Promise.all(tasks);

  // p2p-hive-directory P-003 boot-join: after the harnesses boot, join the global
  // hive-directory topic + announce this workspace's owned public/invite hives.
  // Fully best-effort + fire-and-forget — a directory failure (e.g. gh
  // unauthenticated → no announce identity) must NEVER affect harness boot, so
  // this is a detached promise with its own catch.
  for (const wsId of workspaceIds) {
    void (async () => {
      try {
        const { wireHiveDirectoryForWorkspace } = await import('../../hive-directory-boot');
        await wireHiveDirectoryForWorkspace(wsId);
      } catch {
        /* best-effort; boot-all never fails on the directory */
      }
    })();
  }

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

export interface RebootHarnessResult {
  /** True if a live handle was torn down before re-booting. */
  closed: boolean;
  /** Result of the (re)boot attempt. */
  boot: BootSingleResult;
}

/**
 * Tear down a harness's substrate handle (if booted) and boot it fresh.
 *
 * Why this exists: `bootSingleHarness` short-circuits to `already-booted`
 * for a cached handle and never re-resolves the swarm binding. So after a
 * harness writes `.papercusp/shared.json` (the "go shared" flip), nothing
 * makes the already-booted, `swarm: null` handle actually join the swarm.
 * `rebootHarness` closes the stale handle — which drops it from the map —
 * then boots again, so the boot re-runs `defaultResolveSwarmBinding`
 * against the now-present config and joins the derived Hyperswarm topic.
 *
 * Idempotent + safe when not booted: `closeBootedHarness` no-ops (returns
 * false) and `bootSingleHarness` boots fresh. The substrate always boots
 * (Stage 4d), so this can be called whenever a harness's shared.json changes.
 */
export async function rebootHarness(
  workspaceId: string,
  harnessSlug: string,
  opts: {
    workspaceRoot?: string;
    timeoutMs?: number;
    resolveSwarmBinding?: SwarmBindingResolver;
  } = {},
): Promise<RebootHarnessResult> {
  const closed = await closeBootedHarness(workspaceId, harnessSlug);
  const boot = await bootSingleHarness(workspaceId, harnessSlug, opts);
  return { closed, boot };
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

/**
 * Snapshot of every booted handle. Read-only — returns a fresh array
 * each call. Used by the admin status endpoint + diagnostic tools.
 */
export interface BootedHandleSummary {
  workspaceId: string;
  harnessSlug: string;
}

export function listBootedHandles(): BootedHandleSummary[] {
  const out: BootedHandleSummary[] = [];
  for (const handle of handles.values()) {
    out.push({
      workspaceId: handle.workspaceId,
      harnessSlug: handle.harnessSlug,
    });
  }
  return out;
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
    const path = join(workspacesRoot(), 'registry.json');
    if (!existsSync(path)) return [];
    const text = readFileSync(path, 'utf8');
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
