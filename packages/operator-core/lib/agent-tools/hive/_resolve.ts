/**
 * resolveHive — the single canonical read path for a local hive
 * (hive-tool-namespace-2026-06-08 P-001, D-001/D-003; P-012 landed).
 *
 * A hive is the registry-enumerated unit — a registered project whose
 * `harness_kind === 'hive'` (the built-in `hive` blueprint, HIVE_BLUEPRINT_ID),
 * plus its per-home-slug `hive-wake` routine + (workspace-scoped) event
 * subscriptions, plus a live Queen woken via the parentless system path —
 * keyed to the FIRST-CLASS Hive entity for identity. That entity shipped:
 * `harness_shared.hives` holds each hive's stable Ed25519 keypair
 * (shared-hive-federation-2026-06-08 P-002, owner-ratified multiplicity D-008 =
 * many hives per workspace), and this descriptor composes the two — the registry
 * is the enumeration source (D-008: hives ARE the `kind:'hive'` projects), the
 * `hives` table is identity. So `resolveHive` enumerates via the registry and
 * layers the first-class identity on each (the `pubkey`, pubkey-addressability),
 * lazy-backfilling the keypair on first resolve. This is the P-012 re-point:
 * every `hive:*` read goes through this one descriptor and the tool signatures
 * stay fixed.
 *
 * This is identity + deployment + wake ONLY — the live aggregate view (bees,
 * frontier depth, harness health) is layered on top by `pot:get`, which joins
 * fleet:assignments / work_items / harness:status. Keeping that out of here
 * keeps `pot:list` cheap (no per-hive fleet fan-out).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { DeploymentConfig, Frame } from '@papercusp/deployment-driver';
import { loadHarnessRegistry, type ProjectEntry } from '../../harness-registry';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  getHiveTimeWake,
  readHiveWakeState,
  type HiveEventSubscription,
} from '../../hive/wake';
import { resolveHivePubkey } from '../../hive-identity';
import { getHiveByPubkey } from '../../hive-store';

/** The `harness_kind` marker a hive's home harness carries in the registry. */
export const HIVE_KIND = 'hive';

/** The Queen's declared next/last wake for a hive. The time wake is per-home-slug
 *  (a `hive-wake` routine row); the event subscriptions + lastWakeAt are
 *  workspace-scoped today (`hive_wake` state is one row per workspace) — a known
 *  limitation the first-class Hive entity fixes (then they become per-hive). */
export interface HiveWakeView {
  active: boolean;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  subscriptions: HiveEventSubscription[];
  lastWakeAt: string | null;
}

export interface HiveDescriptor {
  /** The home-harness slug — the local hive identity TODAY (D-003). */
  slug: string;
  path: string;
  kind: typeof HIVE_KIND;
  /**
   * The deployment-frame federated id, when this hive has been deployed/published
   * and its control/deployment frame carries a `hive_id`. Undefined for a purely
   * -local hive. Distinct from the first-class `pubkey` identity below: this is the
   * frame-derived deployment handle; `pubkey` is the canonical dial-able Hive id.
   */
  hiveId?: string;
  /**
   * The Hive's first-class identity: its raw-32 base64 Ed25519 PUBLIC key
   * (shared-hive-federation-2026-06-08 P-002). This is the dial-able id and the
   * federation topic key (P-003, deriveHiveFederationTopic). Minted on
   * pot:create and lazy-backfilled on first resolve; undefined only when identity
   * backfill failed (e.g. the keychain is unavailable). The secret never leaves
   * the owning Swarm's keychain.
   */
  pubkey?: string;
  /**
   * P-007 (hive-from-repo-hardening D-007): a joiner-side VIEW of someone
   * else's hive — local grouping only; no identity, no listing, never
   * announces. Absent for owned hives.
   */
  remote?: true;
  deployment: DeploymentConfig;
  deployed: boolean;
  wake: HiveWakeView;
}

/** Is this registry project a hive (its home harness)? */
export function isHiveProject(p: ProjectEntry): boolean {
  return p.harness_kind === HIVE_KIND;
}

/** Best-effort federated id for a deployed hive (its frame's hive_id). */
function frameHiveId(p: ProjectEntry): string | undefined {
  const frame = p.deploymentFrame as (Frame & { hive_id?: string }) | undefined;
  return frame?.hive_id;
}

async function buildWakeView(
  sql: Sql,
  homeSlug: string,
  workspaceId: string,
): Promise<HiveWakeView> {
  // K1 (workspace-scoped-coordination P-003): read the workspace-sentinel wake
  // routine when the flag is ON (OFF ⇒ per-hive, unchanged).
  const time = await getHiveTimeWake(sql, homeSlug, { workspaceId });
  const state = await readHiveWakeState(workspaceId);
  return {
    active: time?.active ?? false,
    nextFireAt: time?.nextFireAt ? new Date(time.nextFireAt).toISOString() : null,
    lastFiredAt: time?.lastFiredAt ? new Date(time.lastFiredAt).toISOString() : null,
    subscriptions: state.subscriptions,
    lastWakeAt: state.lastWakeAt ? new Date(state.lastWakeAt).toISOString() : null,
  };
}

/** Pure: project a registry entry + its wake view into the descriptor. Exported
 *  so the shaping is unit-testable without PG (mirrors fleet/assignments' pure
 *  selectors). */
export function describeHive(
  p: ProjectEntry,
  wake: HiveWakeView,
  pubkey?: string,
): HiveDescriptor {
  const hiveId = frameHiveId(p);
  return {
    slug: p.slug,
    path: p.path,
    kind: HIVE_KIND,
    ...(hiveId ? { hiveId } : {}),
    ...(pubkey ? { pubkey } : {}),
    ...(p.remote_hive ? { remote: true as const } : {}),
    deployment: p.deployment ?? { target: 'local' },
    deployed: Boolean(p.deploymentFrame),
    wake,
  };
}

/** Pure: distinct live agents per harness slug, from raw fleet-assignment rows —
 *  the per-hive count `pot:list` shows, extracted so it unit-tests without PG. */
export function liveAgentCountByHarness(
  rows: ReadonlyArray<{ holderAlive: boolean; harnessSlug: string | null; agentId: string | null }>,
): Map<string, number> {
  const byHarness = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.holderAlive && r.harnessSlug && r.agentId) {
      let s = byHarness.get(r.harnessSlug);
      if (!s) {
        s = new Set<string>();
        byHarness.set(r.harnessSlug, s);
      }
      s.add(r.agentId);
    }
  }
  const out = new Map<string, number>();
  for (const [h, s] of byHarness) out.set(h, s.size);
  return out;
}

/**
 * Resolve one hive by its home-slug (or, forward-compat, its hiveId). Returns
 * null when no `kind:'hive'` project matches — callers surface a clean
 * `hive_not_found` rather than guessing.
 */
export async function resolveHive(
  idOrSlug: string,
  workspaceId?: string,
): Promise<HiveDescriptor | null> {
  const ws = workspaceId ?? activeWorkspaceId();
  const reg = await loadHarnessRegistry(ws);
  let p = reg.projects.find(
    (x) => isHiveProject(x) && (x.slug === idOrSlug || frameHiveId(x) === idOrSlug),
  );
  // Forward-compat: a Hive is addressable by its pubkey identity, not just its
  // home-slug (D-002). When the id is neither a slug nor a frame id, resolve the
  // pubkey -> home-slug via the entity table.
  if (!p) {
    const byKey = await getHiveByPubkey(ws, idOrSlug);
    if (byKey) p = reg.projects.find((x) => isHiveProject(x) && x.slug === byKey.homeSlug);
  }
  if (!p) return null;
  const { sql } = getOrgPg();
  const wake = await buildWakeView(sql, p.slug, ws);
  const pubkey = await resolveHivePubkey(ws, p.slug);
  return describeHive(p, wake, pubkey);
}

/** Every hive (kind:'hive' project) in the workspace, resolved. */
export async function listHives(workspaceId?: string): Promise<HiveDescriptor[]> {
  const ws = workspaceId ?? activeWorkspaceId();
  const reg = await loadHarnessRegistry(ws);
  const hives = reg.projects.filter(isHiveProject);
  if (hives.length === 0) return [];
  const { sql } = getOrgPg();
  const out: HiveDescriptor[] = [];
  for (const p of hives) {
    const pubkey = await resolveHivePubkey(ws, p.slug);
    out.push(describeHive(p, await buildWakeView(sql, p.slug, ws), pubkey));
  }
  return out;
}

/**
 * The workspace's HOME hive slug — `PAPERCUSP_HIVE_HOME_SLUG` when set, else the
 * FIRST formal hive in the registry (the same slug the 👑-tab UI writes steering
 * to via `resolveHomeHive`). The env var is unset on the dev/green operators, so
 * the env-only `resolveHiveHomeSlug()` returns null there — which silently skipped
 * the owner-steering MODEL-TIER override read at the spawn chokepoint (the override
 * was written to the formal hive but never read). This registry fallback makes the
 * read resolve the SAME slug the UI wrote to, so the override actually applies.
 * (queen-steering-panel GAP 1, 2026-06-17.) Async (registry); fail-soft.
 */
export async function resolveHomeHiveSlug(workspaceId?: string): Promise<string | null> {
  const env = process.env.PAPERCUSP_HIVE_HOME_SLUG?.trim();
  if (env) return env;
  const hives = await listHives(workspaceId).catch(() => []);
  return hives[0]?.slug ?? null;
}
