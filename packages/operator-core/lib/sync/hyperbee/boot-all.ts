/**
 * boot-all — workspace-scoped Hyperbee substrate orchestrator.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24
 *       + papercusp-dogfood-phase11-multi-engineer-2026-05-25 (P-078).
 *
 * One entry point per process. Discovers every harness across every
 * workspace FROM THE PG REGISTRY (`harness_shared.harness_registry`, the
 * single source of truth since mig 025 — audit P-078: the old
 * registry.json + readdirSync read silently booted ZERO harnesses when
 * the file was stale), calls `bootHarnessSubstrate` per harness, stashes
 * the handle in a module-level Map keyed by
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

import { existsSync } from 'node:fs';
import { workspacesRoot } from '../../workspace-registry';
import { join } from 'node:path';
import {
  bootHarnessSubstrate,
  type BootedHarnessHandle,
  type BootHarnessOpts,
} from './boot';
import type { SwarmBinding } from './derive-swarm-topic';
import { loadSharedConfigFromProjectDir } from '../../harness/load-shared-config';
import { wireOutboxForHarness } from './wire-outbox';
import { wirePresenceAnnounceForHarness } from './wire-presence';
import { mapWithConcurrency } from '../../gym/concurrency';
import type { BootedHarnessFacts } from './substrate-eviction-policy';
import { RemoteBootedHarnessHandle } from './remote-booted-harness';

const handles: Map<string, BootedHarnessHandle> = new Map();
const inflight: Map<string, Promise<BootedHarnessHandle>> = new Map();

function key(workspaceId: string, harnessSlug: string): string {
  return `${workspaceId}::${harnessSlug}`;
}

/** Split a handle-map key back into (workspaceId, harnessSlug). Workspace ids
 *  never contain "::" (they are slugs like `papercusp-workspace` / `default`),
 *  so a split on the FIRST separator is unambiguous. */
function parseKey(k: string): { workspaceId: string; harnessSlug: string } | null {
  const i = k.indexOf('::');
  if (i < 0) return null;
  return { workspaceId: k.slice(0, i), harnessSlug: k.slice(i + 2) };
}

// ── LAZY_SUBSTRATE_BOOT (P-008) reaper support ──────────────────────────────
// All inert until `enableSubstrateEvictionTracking()` is called (the reaper is
// started, i.e. the flag is ON). With the flag OFF none of this runs, so boot
// is byte-identical to eager all-harness boot.
//
// `lastAccess` is the LRU + idle signal: bumped on every `getBootedHarness` hit
// (any consumer access) + at boot time. `evicted` records engines the reaper
// tore down so a later `getBootedHarness` for one can fire a background re-boot
// (the lazy-boot "reboot-on-access" dual of eviction).
let evictionTrackingEnabled = false;
const lastAccess = new Map<string, number>();
const evicted = new Set<string>();

/** The reboot-on-access trigger — fires a background re-boot for an evicted
 *  engine on its next access. Default calls `bootSingleHarness` fire-and-forget;
 *  overridable in tests so a unit test never triggers a real corestore boot. */
let rebootOnAccess: (workspaceId: string, harnessSlug: string) => void = (
  workspaceId,
  harnessSlug,
) => {
  void bootSingleHarness(workspaceId, harnessSlug).catch(() => {
    // best-effort re-boot; a failure leaves the harness unbooted (a later
    // boot-all reconcile / access retries it) — never throws into the caller.
  });
};

/** Turn on access tracking + reboot-on-access. Called once when the eviction
 *  reaper starts (LAZY_SUBSTRATE_BOOT on). Idempotent. */
export function enableSubstrateEvictionTracking(): void {
  evictionTrackingEnabled = true;
}

/** Test seam: override the reboot-on-access trigger. Never call from production. */
export function _setRebootOnAccessForTests(
  fn: (workspaceId: string, harnessSlug: string) => void,
): void {
  rebootOnAccess = fn;
}

/** Test seam: reset the reaper-support state. Never call from production code. */
export function _resetEvictionTrackingForTests(): void {
  evictionTrackingEnabled = false;
  lastAccess.clear();
  evicted.clear();
}

/**
 * Per-harness "send-side wiring" state (EI-521).
 *
 * After a substrate handle boots, two additive loops must come online: the
 * outbox DRAIN (feature/issue/coord federation send-side) and the presence
 * ANNOUNCE. These were previously wired inline AFTER `handles.set`, in a
 * swallowing try/catch — so a transient wiring failure (e.g. a getOrgPg hiccup
 * during boot) left a CACHED handle whose drain never started, and because the
 * handle was cached, every later `bootSingleHarness` short-circuited to
 * `already-booted` and NEVER re-wired. Symptom: `peer_connected` ✓ but the
 * outbox sits undrained forever (0 drain loops) → a joined hive member's writes
 * never federate to the peer.
 *
 * Fix: wiring is idempotent + RETRYABLE. Each step is marked wired ONLY on
 * success, and `ensureSendSideWired` runs on BOTH the fresh-boot and the
 * already-booted paths, so a failed step self-heals on the next boot pass
 * (boot-all reconcile re-invokes `bootSingleHarness` per registry harness).
 * Concurrent calls coalesce on `wiringInflight` so a step never double-starts
 * (a second drain loop would double-append + double-GC the same outbox).
 */
const outboxWired = new Set<string>();
const presenceWired = new Set<string>();
const wiringInflight = new Map<string, Promise<void>>();

export interface SendSideWiringDeps {
  /** Default: getOrgPg() + wireOutboxForHarness. Tests inject a fake. */
  wireOutbox?: (handle: BootedHarnessHandle) => Promise<void>;
  /** Default: wirePresenceAnnounceForHarness. Tests inject a fake. */
  wirePresence?: (handle: BootedHarnessHandle) => Promise<void>;
}

/** Default outbox wiring: resolve the org PG, then wire the drain loop. */
async function defaultWireOutbox(handle: BootedHarnessHandle): Promise<void> {
  const { sql } = (await import('@papercusp/db-org')).getOrgPg();
  await wireOutboxForHarness(handle, sql);
}

/**
 * Bring a booted handle's send-side loops (outbox drain + presence announce)
 * online — idempotently + resiliently. Safe to call repeatedly: each step runs
 * only until it SUCCEEDS, then no-ops. A step failure is LOGGED (never thrown,
 * so it can't block boot) and retried on the next call. Concurrent calls for the
 * same handle coalesce so a step never double-starts.
 *
 * Exported for tests (the retry/idempotence/coalesce contract is the EI-521 fix).
 */
export async function ensureSendSideWired(
  handle: BootedHarnessHandle,
  deps: SendSideWiringDeps = {},
): Promise<void> {
  const k = key(handle.workspaceId, handle.harnessSlug);
  if (outboxWired.has(k) && presenceWired.has(k)) return;
  const existing = wiringInflight.get(k);
  if (existing) return existing;

  const wireOutbox = deps.wireOutbox ?? defaultWireOutbox;
  const wirePresence = deps.wirePresence ?? wirePresenceAnnounceForHarness;

  const run = (async () => {
    // (1) Outbox drain — the critical federation send-side (EI-521). Best-effort
    //     so a failure never blocks boot, but RETRYABLE: only marked wired on
    //     success, so the next boot pass re-attempts it.
    if (!outboxWired.has(k)) {
      try {
        await wireOutbox(handle);
        outboxWired.add(k);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
          `[boot-all] outbox wiring failed for ${k} (boot still succeeded; ` +
            `will retry on the next boot pass):`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    // (2) Presence announce — additive (the per-Hive lock authority, P-009,
    //     elects over the live roster). Same retryable best-effort posture; a
    //     no-op for a private/unswarmed harness (handle.swarm null).
    if (!presenceWired.has(k)) {
      try {
        await wirePresence(handle);
        presenceWired.add(k);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
          `[boot-all] presence wiring failed for ${k} (boot still succeeded; ` +
            `will retry on the next boot pass):`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  })();
  wiringInflight.set(k, run);
  try {
    await run;
  } finally {
    wiringInflight.delete(k);
  }
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

/**
 * Harness slugs for a workspace — from the PG registry (audit P-078).
 * `harness_shared.harness_registry` (loadHarnessRegistry, mig 025) is the
 * single source of truth; the old `readdirSync('.papercusp/harnesses')`
 * returned [] on ANY error, silently booting zero harnesses when the dir
 * was stale/missing. PG failures here are LOUD: they throw to the per-
 * workspace catch in `bootAllHarnessesForActiveWorkspace`.
 *
 * PATH-LIVENESS FILTER: only entries whose project `path` exists on disk
 * boot — a substrate needs its on-disk home. Registry debris with deleted
 * paths is real at scale (live DB 2026-06-10: 73 of 99 entries were dead —
 * 72 from a test-clone workspace) and booting ghosts would re-create the
 * EI-125-era thundering herd. Skips are logged once per boot pass; the
 * durable cleanup belongs in the registry, not here.
 */
async function harnessSlugsFromPgRegistry(workspaceId: string): Promise<string[]> {
  const { loadHarnessRegistry } = await import('../../harness-registry');
  const reg = await loadHarnessRegistry(workspaceId);
  const live: string[] = [];
  const dead: string[] = [];
  for (const p of reg.projects) {
    if (p.path && existsSync(p.path)) live.push(p.slug);
    else dead.push(p.slug);
  }
  if (dead.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[boot-all] workspace '${workspaceId}': skipping ${dead.length} registry ` +
        `entr${dead.length === 1 ? 'y' : 'ies'} with missing project path ` +
        `(stale registry debris): ${dead.slice(0, 5).join(', ')}${dead.length > 5 ? ', …' : ''}`,
    );
  }
  return live;
}

export interface BootSingleResult {
  workspaceId: string;
  harnessSlug: string;
  state: 'booted' | 'already-booted' | 'failed';
  error?: string;
}

export interface BootAllOpts {
  /** Override workspace list. Default: every workspace with a
   *  `harness_shared.harness_registry` row (PG — audit P-078). */
  workspaceIds?: string[];
  /** Per-harness boot timeout. Default 30s. */
  perHarnessTimeoutMs?: number;
  /**
   * Max harnesses whose substrate boot runs CONCURRENTLY. Default 4
   * (env `PAPERCUSP_SUBSTRATE_BOOT_CONCURRENCY` overrides). A joiner with
   * many remote-hive members otherwise booted ALL substrates at once via an
   * unbounded `Promise.all`, saturating a shared boot resource (hyperswarm /
   * DHT join) so EVERY substrate — local ones included — exceeded the 30s
   * `perHarnessTimeoutMs` and the node booted ZERO (witnessed live on the
   * fed-rig 2026-06-25: 11 concurrent → all timed out; 2 → booted in 5.5s).
   * Bounding concurrency lets them boot in batches. WI-779.
   */
  bootConcurrency?: number;
  /**
   * Override per-workspace harness discovery (tests inject; unit tests must
   * not touch PG). Default: the PG registry via `loadHarnessRegistry`.
   */
  discoverHarnessSlugs?: (workspaceId: string) => Promise<string[]>;
  /**
   * Override the swarm-binding resolver. Default reads
   * `.papercusp/shared.json` via `resolveHarnessPaths` and returns
   * `{ kind: 'gh', github_repository_id }` when present. Tests
   * inject a synchronous fake.
   */
  resolveSwarmBinding?: SwarmBindingResolver;
  /** Override per-harness boot (sidecar cutover + tests). Default: in-process bootHarnessSubstrate. */
  bootHarness?: (opts: BootHarnessOpts) => Promise<BootedHarnessHandle>;
  /** Remote handles are wired in their owning process; skip main-process send-side loops. */
  skipSendSideWiring?: boolean;
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
  const k = key(workspaceId, harnessSlug);
  const handle = handles.get(k) ?? null;
  if (handle) {
    // LRU/idle signal (P-008): any consumer access marks the harness HOT, so the
    // reaper won't evict an engine something is actively using. No-op when the
    // reaper is off — keeps the OFF path byte-identical.
    if (evictionTrackingEnabled) lastAccess.set(k, Date.now());
    return handle;
  }
  // Reboot-on-access (P-008): if the reaper evicted this engine, bring it back in
  // the BACKGROUND so the next access finds it resident. This access still gets
  // null (the consumer's null-handling is graceful — feature-queue returns
  // `substrate-off`, claims fall back to legacy — never data loss). bootSingleHarness
  // coalesces on `inflight`, so a burst of accesses triggers a single re-boot.
  if (evictionTrackingEnabled && evicted.has(k)) {
    evicted.delete(k);
    rebootOnAccess(workspaceId, harnessSlug);
  }
  return null;
}

/**
 * Default swarm-binding resolver. Precedence:
 *   1. shared-hive-federation P-004 — if the harness is a Hive HOME, or a
 *      member of a shared/joined Hive, federate over the Hive PUBKEY topic
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
    // (1) A Hive-home harness (plus shared/joined member harnesses) federates over
    // the Hive pubkey topic, replacing the per-harness gh/local topic (D-001/D-003).
    // A non-hive or local-only member harness returns null here and falls through
    // to the gh-binding path unchanged.
    const { resolveHiveSwarmBinding } = await import('../../hive-federation');
    const hiveBinding = await resolveHiveSwarmBinding(workspaceId, harnessSlug);
    if (hiveBinding) return hiveBinding;

    // (2) A committed shared.json. PREFER the EXPLICIT topic it carries: a
    // joiner learns a Hive's topic from its member/invite link (persisted here
    // by join-shared-harness) but NOT the Hive's pubkey, so it cannot rebuild a
    // `hive:` binding. Re-deriving a `gh:<repo_id>` topic would split the joiner
    // onto a DIFFERENT topic than the owner's `hive:<pubkey>` topic — the
    // join-vs-owner topic-split bug where the initial join-handshake merge lands
    // but no incremental write ever crosses. Honoring the stored topic lands the
    // joiner on the owner's EXACT topic. For a plain shared harness this is just
    // the gh-repo topic (== what gh:<repo_id> derives), so no behavior change.
    const { resolveHarnessPaths } = await import('../../resolve-harness-paths');
    const { projectDir } = await resolveHarnessPaths(harnessSlug, workspaceId);
    if (projectDir.startsWith('/tmp/papercusp-unresolved/')) return null;
    const cfg = loadSharedConfigFromProjectDir(projectDir);
    if (!cfg) return null;
    if (cfg.topic && /^[0-9a-f]{64}$/i.test(cfg.topic)) {
      return { kind: 'topic', topic_hex: cfg.topic };
    }
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
    /** Test seam — override the send-side wiring fns (default: getOrgPg + the
     *  real wireOutboxForHarness / wirePresenceAnnounceForHarness). */
    wireSendSide?: SendSideWiringDeps;
    /** Override the boot factory. Default: in-process bootHarnessSubstrate. */
    bootHarness?: (opts: BootHarnessOpts) => Promise<BootedHarnessHandle>;
    /** Remote handles are wired in their owning process; skip main-process send-side loops. */
    skipSendSideWiring?: boolean;
  } = {},
): Promise<BootSingleResult> {
  const k = key(workspaceId, harnessSlug);
  const cached = handles.get(k);
  if (cached) {
    // EI-521: re-attempt any send-side wiring that hasn't yet succeeded. A prior
    // boot may have cached the handle but failed to wire the drain (which would
    // otherwise stay broken until restart, since this path short-circuits). No-op
    // once both steps are wired.
    if (!opts.skipSendSideWiring) await ensureSendSideWired(cached, opts.wireSendSide);
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
  const bootHarness = opts.bootHarness ?? bootHarnessSubstrate;
  const bootPromise = (async () => {
    const swarmBinding = (await resolver(workspaceId, harnessSlug)) ?? null;
    return await Promise.race([
      bootHarness({
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
    // P-008: a freshly-booted engine is HOT (seed its access time) and is no
    // longer "evicted". No-op when the reaper is off.
    if (evictionTrackingEnabled) {
      lastAccess.set(k, Date.now());
      evicted.delete(k);
    }
    // Stage 5 (feature-content federation): bring the send-side online — the
    // one-time backfill + outbox drain loop, plus the P-008 presence-announce
    // loop. Both are additive + best-effort (a failure must NEVER block the boot
    // result; PG-direct still works) AND retryable: `ensureSendSideWired` marks
    // each step wired only on success, so a transient failure self-heals on the
    // next boot pass rather than leaving this cached handle drainless forever
    // (EI-521). The drain/presence stoppers register close-hooks on the handle,
    // so closeBootedHarness/closeAllBootedHarnesses tear them down automatically.
    if (!opts.skipSendSideWiring) await ensureSendSideWired(handle, opts.wireSendSide);
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
  const workspaceIds = opts.workspaceIds ?? (await readRegistryWorkspaceIds());
  const discover = opts.discoverHarnessSlugs ?? harnessSlugsFromPgRegistry;
  // Collect (workspace, slug) pairs FIRST (don't start the boots), then run them
  // through a BOUNDED-concurrency mapper. An unbounded `Promise.all` over every
  // harness saturated a shared boot resource on joiners with many members and
  // timed out ALL substrates (WI-779) — see `bootConcurrency`.
  const pairs: Array<{ wsId: string; slug: string }> = [];
  for (const wsId of workspaceIds) {
    let slugs: string[];
    try {
      slugs = await discover(wsId);
    } catch (e) {
      // LOUD per-workspace failure (audit P-078): the old FS read returned []
      // on any error — a silent zero-boot. Other workspaces still boot.
      // eslint-disable-next-line no-console
      console.error(
        `[boot-all] harness discovery failed for workspace '${wsId}' — booting NOTHING for it:`,
        e instanceof Error ? e.message : String(e),
      );
      continue;
    }
    for (const slug of slugs) pairs.push({ wsId, slug });
  }
  const envConcurrency = Number(process.env.PAPERCUSP_SUBSTRATE_BOOT_CONCURRENCY);
  const bootConcurrency =
    opts.bootConcurrency ??
    (Number.isFinite(envConcurrency) && envConcurrency > 0 ? envConcurrency : 4);
  const results = await mapWithConcurrency(pairs, bootConcurrency, ({ wsId, slug }) =>
    bootSingleHarness(wsId, slug, {
      timeoutMs: opts.perHarnessTimeoutMs,
      resolveSwarmBinding: opts.resolveSwarmBinding,
      bootHarness: opts.bootHarness,
      skipSendSideWiring: opts.skipSendSideWiring,
    }),
  );

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

  // hive-network-surface-2026-06-11 P-001 (B-01): light the cross-Hive boundary
  // for each directory-PUBLISHED Hive (private hives stay dark) + run the boot
  // drain of its durable outbox. Same posture as the directory wire above —
  // fully best-effort + fire-and-forget with its own catch; the boundary must
  // NEVER affect harness boot. Re-runs reconcile idempotently (the periodic
  // `system:cross-hive-outbox-drain` routine keeps later publish/visibility
  // changes converging without a restart).
  for (const wsId of workspaceIds) {
    void (async () => {
      try {
        const { ensureCrossHiveBoundariesWired } = await import('../../cross-hive-boundary-boot');
        await ensureCrossHiveBoundariesWired(wsId);
      } catch {
        /* best-effort; boot-all never fails on the boundary */
      }
    })();
  }

  // hive-from-repo-hardening-2026-06-11 P-009: once-per-process registry
  // github-coords revalidation — re-fetch each coord-bearing project by its
  // IMMUTABLE github_repository_id and repair github_remote /
  // github_default_branch drift after an upstream GitHub rename. Same posture
  // as the hive-directory wire above: fully best-effort + fire-and-forget with
  // its own catch — it must NEVER affect harness boot. The once-guard lives in
  // the module, so retry passes of this function no-op. Workspace omitted →
  // the ACTIVE workspace (the registry helpers' default scope).
  void (async () => {
    try {
      const { ensureRepoCoordsRevalidatedOnce } = await import(
        '../../harness/revalidate-repo-coords'
      );
      ensureRepoCoordsRevalidatedOnce();
    } catch {
      /* best-effort; boot-all never fails on coord revalidation */
    }
  })();

  // git-sync-any-hive-2026-06-12 P-004 (B-04): once-per-process reconcile —
  // walk each workspace's registry and seed any MISSING `system:git-sync`
  // routine rows for hive MEMBER checkouts (hives created before the seeding
  // sites existed, or members that slipped past them). ADD-only: existing
  // rows — `papercup`'s hand-tuned one included — are never mutated. Same
  // posture as the hygiene blocks above: lazy-import + fire-and-forget with
  // its own catch — it must NEVER affect harness boot — and the once-guard
  // lives in the module, so retry passes of this function no-op.
  void (async () => {
    try {
      const { ensureGitSyncRoutinesReconciledOnce } = await import(
        '../../harness/git-sync/git-sync-reconcile'
      );
      ensureGitSyncRoutinesReconciledOnce(workspaceIds);
    } catch {
      /* best-effort; boot-all never fails on git-sync reconcile */
    }
  })();

  // plan-federation-regrain-2026-06-13 P-005/P-007: once-per-process per-part
  // plan-federation reconcile/backfill — decompose each plan into harness_plan_parts
  // (origin='local') so local plan edits federate per-part. FLAG-GATED inside the
  // function: it no-ops unless papercusp-plan-part-federation is on, so this is DARK
  // by default. Same fire-and-forget + own-catch posture; must NEVER affect boot.
  void (async () => {
    try {
      const { ensurePlanPartsReconciledOnce } = await import('../../plan-parts/reconcile');
      ensurePlanPartsReconciledOnce(workspaceIds);
    } catch {
      /* best-effort; boot-all never fails on plan-parts reconcile */
    }
  })();

  // shared-hive-hardening-2026-06-13 P-013 (B-04): once-per-process join-state
  // self-heal — re-register the ONE residual boot-all can't heal itself, a join
  // whose clone landed on disk but whose registry write also failed (so this
  // boot never visited it). Registered joins are already federated by the boot
  // loop above; this only closes the unregistered-ghost gap. Joins target the
  // active workspace (activeWorkspaceId at join time), so heal into it. Same
  // posture as the reconcile blocks above: lazy-import + fire-and-forget with
  // its own catch + module once-guard — it must NEVER affect harness boot.
  void (async () => {
    try {
      const { activeWorkspaceId } = await import('../../workspace-registry');
      const { ensureJoinStatesReconciledOnce } = await import('../../harness/join-state-reconcile');
      ensureJoinStatesReconciledOnce(activeWorkspaceId());
    } catch {
      /* best-effort; boot-all never fails on join-state reconcile */
    }
  })();

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
  // Drop the send-side wiring state so a future re-boot re-wires from scratch
  // (the drain/presence loops are torn down by the handle's close-hooks below).
  outboxWired.delete(k);
  presenceWired.delete(k);
  wiringInflight.delete(k);
  // A DELIBERATE close (leave-hive, reboot, shutdown) is not a reaper eviction —
  // drop its access record and never mark it for reboot-on-access.
  lastAccess.delete(k);
  evicted.delete(k);
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

/**
 * Re-key a BOOTED harness onto its freshly-resolved swarm binding IN PLACE —
 * leave the old topic + join the new one while keeping the substrate's store /
 * own log / admitted set / merge loop ALIVE. The "go shared" primitive for an
 * already-running harness whose binding changed (it joined/published a hive, so
 * its `gh:<repo_id>` topic must switch to the hive-pubkey topic).
 *
 * EI-681: PREFER this over `rebootHarness` for a re-key. A full reboot tears
 * down + re-creates the Corestore-backed substrate, which disrupts the OWNER's
 * corestore replication-SERVING of its own log core — the re-keyed owner admits
 * + connects to the joiner but never UPLOADS its log, so the feature never
 * crosses (confirmed via the two-instance hive-from-repo smoke: owner fires zero
 * `upload` events post-reboot; re-key-in-place serves seamlessly). Re-key in
 * place never tears down the replication streams.
 *
 * Falls back to a fresh `bootSingleHarness` when the harness isn't booted yet
 * (which resolves + joins the new binding itself). Idempotent + safe-when-unbooted.
 */
export async function rekeyHarness(
  workspaceId: string,
  harnessSlug: string,
  opts: {
    workspaceRoot?: string;
    resolveSwarmBinding?: SwarmBindingResolver;
    /** Test seam — override the send-side wiring fns (default: getOrgPg + the
     *  real wireOutboxForHarness / wirePresenceAnnounceForHarness). Threaded into
     *  both the fresh-boot (bootSingleHarness) and the in-place re-key wiring. */
    wireSendSide?: SendSideWiringDeps;
    /** Remote handles are wired in their owning (sidecar) process; skip the
     *  main-process send-side loops. Defaults false; a remote handle is also
     *  auto-detected below so a missed flag never double-wires the sidecar. */
    skipSendSideWiring?: boolean;
  } = {},
): Promise<{ rekeyed: boolean; boot?: BootSingleResult }> {
  const handle = handles.get(key(workspaceId, harnessSlug));
  if (!handle) {
    // Not booted yet → a fresh boot resolves + joins the new binding itself
    // (bootSingleHarness wires the outbox drain + presence via ensureSendSideWired).
    const boot = await bootSingleHarness(workspaceId, harnessSlug, opts);
    return { rekeyed: false, boot };
  }
  const resolver = opts.resolveSwarmBinding ?? defaultResolveSwarmBinding;
  const binding = (await resolver(workspaceId, harnessSlug)) ?? null;
  if (!binding) {
    // No binding resolved (still private / unresolvable) — leave as-is rather
    // than dropping the harness off its current topic.
    return { rekeyed: false };
  }
  await handle.rekey(binding);
  // EI-521: a re-key joins the harness's federation topic IN PLACE (so it
  // peer_connects), but — unlike bootSingleHarness — it never wired the outbox
  // DRAIN / presence-announce loops. A harness booted WITHOUT its send-side wired
  // (or whose wiring failed) would then sit peer_connected with its
  // substrate_outbox UNDRAINED forever (content captured but never federated) —
  // the live cross-machine blocker on joined/created hive harnesses, whose ONLY
  // route onto the Hive topic is rekeyHarness (publishCreatedHive / joinHiveAsView).
  // ensureSendSideWired is idempotent (a no-op once wired), so this is safe on an
  // already-wired handle. A REMOTE (sidecar) handle is skipped: its owning sidecar
  // process wires the drain, so re-wiring here would double-append the outbox.
  if (!opts.skipSendSideWiring && !(handle instanceof RemoteBootedHarnessHandle)) {
    await ensureSendSideWired(handle, opts.wireSendSide);
  }
  return { rekeyed: true };
}

/** Tear down every cached handle. For test cleanup + process shutdown. */
export async function closeAllBootedHarnesses(): Promise<number> {
  const entries = Array.from(handles.entries());
  handles.clear();
  outboxWired.clear();
  presenceWired.clear();
  wiringInflight.clear();
  lastAccess.clear();
  evicted.clear();
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

/**
 * Gather each booted harness's eviction-relevant liveness facts for the
 * LAZY_SUBSTRATE_BOOT reaper (P-008). Pure read over the live handle map.
 *
 * ── v1 SAFETY BOUNDARY ── A harness with a LIVE SWARM (`handle.swarm != null`)
 * or any admitted remote peer is reported `pinned`/`hasActivePeer`, so
 * `planSubstrateEviction` NEVER evicts it. Tearing down a shared engine would
 * leave its swarm topic → a later peer couldn't connect → silent divergence (the
 * EI-126 class). The swarm-presence keepalive that makes idle-SHARED eviction
 * safe is the documented v2; v1 evicts ONLY inert private (swarm-less, peerless)
 * engines, which merge nothing and whose local writes are PG-direct.
 *
 * `lastAccessMs` defaults to `now` for a handle with no recorded access (treated
 * HOT — never evicted on a missing signal). The own log seeds `admitted` to size
 * 1, so `admitted.size > 1` means ≥1 remote peer log is admitted.
 */
export function gatherBootedHarnessFacts(now: number): BootedHarnessFacts[] {
  const facts: BootedHarnessFacts[] = [];
  for (const [k, handle] of handles) {
    const hasSwarm = handle.swarm != null;
    const hasRemotePeers = handle.admitted.size > 1;
    facts.push({
      key: k,
      lastAccessMs: lastAccess.get(k) ?? now,
      hasActivePeer: hasRemotePeers,
      // v1: a swarmed harness is pinned (never evicted). Private harnesses fall
      // through to the idle/LRU eviction candidates.
      pinned: hasSwarm,
    });
  }
  return facts;
}

/**
 * Tear down ONE booted harness ENGINE for the reaper (P-008) and mark it for
 * reboot-on-access. Returns whether it actually evicted.
 *
 * Re-checks freshness + swarm/peer state IMMEDIATELY before close to close the
 * access↔evict race: between the reaper's fact snapshot and this call, a consumer
 * may have grabbed the handle (bumping `lastAccess`) or a peer may have connected
 * (swarm/admitted) — in which case we SKIP, leaving the engine resident.
 */
export async function evictBootedHarnessEngine(
  k: string,
  guard: { now: number; idleMs: number },
): Promise<boolean> {
  const handle = handles.get(k);
  if (!handle) return false;
  // Got hot since the snapshot? Skip.
  const last = lastAccess.get(k);
  if (last != null && guard.now - last < guard.idleMs) return false;
  // Acquired a swarm / peer since the snapshot? Skip (v1 boundary).
  if (handle.swarm != null || handle.admitted.size > 1) return false;
  const parsed = parseKey(k);
  if (!parsed) return false;
  const closed = await closeBootedHarness(parsed.workspaceId, parsed.harnessSlug);
  if (closed) {
    // closeBootedHarness cleared lastAccess + evicted; re-mark for reboot-on-access.
    evicted.add(k);
  }
  return closed;
}

/**
 * Re-boot-on-NOTIFY (AC#2 / P-008): called by the process-global outbox keepalive
 * when it receives a `pg_notify('substrate_outbox', '${ws}::${slug}')` for a harness
 * that is NOT currently booted. If the engine was evicted by the reaper (it's in the
 * `evicted` set), clear the mark and fire the same background re-boot-on-access trigger,
 * so the drain starts and the captured rows are consumed instead of piling up.
 *
 * No-op when:
 *   - eviction tracking is off (flag OFF — byte-identical eager path)
 *   - the harness is currently booted (the resident drain handles the NOTIFY)
 *   - the key was never evicted (paranoid check — a non-evicted unbooted harness
 *     shouldn't receive outbox NOTIFYs during normal operation)
 */
export function handleOutboxNotifyForEvictedHarness(
  workspaceId: string,
  harnessSlug: string,
): void {
  if (!evictionTrackingEnabled) return;
  const k = key(workspaceId, harnessSlug);
  if (handles.has(k)) return; // currently booted; running drain handles this NOTIFY
  if (evicted.has(k)) {
    evicted.delete(k);
    rebootOnAccess(workspaceId, harnessSlug);
  }
}

/** For tests. Clears the handle map WITHOUT closing — useful when the
 * handles were faked. Never call from production code. */
export function _resetHandleMapForTests(): void {
  handles.clear();
  inflight.clear();
  outboxWired.clear();
  presenceWired.clear();
  wiringInflight.clear();
}

/** For tests. Inject a handle directly (skips real boot). */
export function _setHandleForTests(
  workspaceId: string,
  harnessSlug: string,
  handle: BootedHarnessHandle,
): void {
  handles.set(key(workspaceId, harnessSlug), handle);
}

/**
 * Workspace ids to boot — every workspace holding a PG harness_registry row
 * (a workspace without one has no harnesses to boot). Replaces the stale-able
 * `~/.papercusp-workspaces/registry.json` read (audit P-078). Throws on a PG
 * failure: host-bootstrap's caller logs it loudly — a visible boot failure
 * beats the old silent zero-harness boot.
 */
async function readRegistryWorkspaceIds(): Promise<string[]> {
  const { sql } = (await import('@papercusp/db-org')).getOrgPg();
  const rows = await sql<{ workspace_id: string }[]>`
    SELECT workspace_id FROM harness_shared.harness_registry`;
  return rows.map((r) => r.workspace_id);
}
