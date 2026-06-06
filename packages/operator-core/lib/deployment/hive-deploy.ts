/**
 * Hive deploy orchestration (`cloud-deployment-layer-2026-06-06` P-016/P-017).
 *
 * A **Hive** is a grouping of harnesses + shared settings (the pot-equivalent;
 * owner's D-009/D-010 reframe). It runs LOCALLY or is **deployed to a Swarm** —
 * the cloud fleet of frames its members' execution runs on. Deploying a Hive =
 * deploy each member harness's execution plane to a frame (P-012) + place the
 * Queen (control). All are federated peers (D-004): full-auto Hives run
 * laptop-optional; human-gated items federate to the local control peer and park
 * until acted on (placement is orthogonal to supervision — D-005).
 *
 * Queen placement is a CONFIG OPTION (decision-agnostic — D-008 is still open):
 *   - `local`     — the local app is the Queen; no cloud control frame (cheapest;
 *                   the common human-online case).
 *   - `dedicated` — a small always-on control frame runs the Queen (laptop-optional
 *                   full-auto; decouples supervision from any worker's lifecycle).
 *   - `colocated` — the Queen rides one execution frame (cheaper; couples it).
 *
 * Lifecycle: deploy / pause (destroy-to-stop) / scale / teardown, + cost controls
 * (per-frame budget caps, idle reaper). Deps injected for unit-testability.
 */
import type { DeploymentConfig, Frame, LogLevel } from '@papercusp/deployment-driver';

export type QueenPlacement = 'local' | 'dedicated' | 'colocated';

export interface HiveDeploySpec {
  hiveId: string;
  /** Harness slugs whose execution deploys to the Swarm. */
  members: string[];
  /** The cloud target for the execution frames. */
  swarm: DeploymentConfig;
  queen?: {
    placement: QueenPlacement;
    /** Deployment for the dedicated control frame (defaults to a small `swarm`-like box). */
    deployment?: DeploymentConfig;
  };
  /** Cost controls (P-017). */
  budget?: {
    /** Tear a frame down once it has cost ≥ this (USD). */
    perFrameUsdCap?: number;
    /** Reap a frame idle longer than this (minutes). */
    idleReaperMinutes?: number;
  };
}

export interface HiveDeployDeps {
  /** Set a member harness's deployment config (so it provisions onto the Swarm). */
  setMemberDeployment: (slug: string, workspaceId: string, deployment: DeploymentConfig) => Promise<void>;
  deployHarness: (slug: string, workspaceId: string) => Promise<{ frame: Frame }>;
  teardownHarness: (slug: string, workspaceId: string) => Promise<{ destroyed: boolean }>;
  /** Deploy/teardown the dedicated Queen control frame (only used for `dedicated`). */
  deployControlFrame?: (hiveId: string, workspaceId: string, deployment: DeploymentConfig) => Promise<Frame>;
  teardownControlFrame?: (hiveId: string, workspaceId: string) => Promise<{ destroyed: boolean }>;
  log?: (level: LogLevel, msg: string) => void;
}

export interface HiveMemberResult {
  slug: string;
  frame?: Frame;
  error?: string;
}
export interface HiveDeployResult {
  hiveId: string;
  members: HiveMemberResult[];
  controlFrame?: Frame;
  queenPlacement: QueenPlacement;
}

const placementOf = (spec: HiveDeploySpec): QueenPlacement => spec.queen?.placement ?? 'local';

/**
 * Deploy a Hive to a Swarm: place the Queen, then deploy each member's execution.
 * Per-member failures are captured (not thrown) so one bad member doesn't strand
 * the rest — the result reports which members are live vs errored.
 */
export async function deployHive(
  spec: HiveDeploySpec,
  workspaceId: string,
  deps: HiveDeployDeps,
): Promise<HiveDeployResult> {
  const placement = placementOf(spec);
  deps.log?.('info', `[hive] deploying ${spec.hiveId} (${spec.members.length} members → ${spec.swarm.target}; queen=${placement})`);

  let controlFrame: Frame | undefined;
  if (placement === 'dedicated') {
    if (!deps.deployControlFrame) throw new Error('deployHive: queen.placement=dedicated requires deps.deployControlFrame');
    const queenDeployment = spec.queen?.deployment ?? spec.swarm;
    controlFrame = await deps.deployControlFrame(spec.hiveId, workspaceId, queenDeployment);
    deps.log?.('info', `[hive] ${spec.hiveId} Queen on dedicated control frame ${controlFrame.id}`);
  } else {
    deps.log?.('info', `[hive] ${spec.hiveId} Queen is ${placement === 'local' ? 'the local control peer' : 'co-located on an execution frame'} — no separate control frame`);
  }

  const members: HiveMemberResult[] = [];
  for (const slug of spec.members) {
    try {
      await deps.setMemberDeployment(slug, workspaceId, spec.swarm);
      const { frame } = await deps.deployHarness(slug, workspaceId);
      members.push({ slug, frame });
    } catch (e) {
      members.push({ slug, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
      deps.log?.('error', `[hive] ${spec.hiveId} member ${slug} failed: ${members[members.length - 1].error}`);
    }
  }
  return { hiveId: spec.hiveId, members, controlFrame, queenPlacement: placement };
}

/**
 * Tear down a Hive — DESTROY every execution frame + the control frame (ends all
 * billing). Best-effort across members; reports each outcome.
 */
export async function teardownHive(
  spec: HiveDeploySpec,
  workspaceId: string,
  deps: HiveDeployDeps,
): Promise<{ hiveId: string; destroyed: string[]; failed: string[] }> {
  const destroyed: string[] = [];
  const failed: string[] = [];
  for (const slug of spec.members) {
    try {
      const r = await deps.teardownHarness(slug, workspaceId);
      if (r.destroyed) destroyed.push(slug);
    } catch {
      failed.push(slug);
    }
  }
  if (placementOf(spec) === 'dedicated' && deps.teardownControlFrame) {
    try {
      const r = await deps.teardownControlFrame(spec.hiveId, workspaceId);
      if (r.destroyed) destroyed.push(`queen:${spec.hiveId}`);
    } catch {
      failed.push(`queen:${spec.hiveId}`);
    }
  }
  deps.log?.('info', `[hive] ${spec.hiveId} torn down: destroyed ${destroyed.length}, failed ${failed.length}`);
  return { hiveId: spec.hiveId, destroyed, failed };
}

/**
 * Pause a Hive = destroy-to-stop its execution frames (the frame model is cattle —
 * there's no "stop", so pause frees billing and redeploy re-provisions). The Hive
 * definition + its federated state persist; only the live compute goes away. The
 * Queen control frame stays up (so the paused Hive is still supervisable) unless
 * `includeQueen`.
 */
export async function pauseHive(
  spec: HiveDeploySpec,
  workspaceId: string,
  deps: HiveDeployDeps,
  opts: { includeQueen?: boolean } = {},
): Promise<{ hiveId: string; paused: string[] }> {
  const paused: string[] = [];
  for (const slug of spec.members) {
    const r = await deps.teardownHarness(slug, workspaceId).catch(() => ({ destroyed: false }));
    if (r.destroyed) paused.push(slug);
  }
  if (opts.includeQueen && placementOf(spec) === 'dedicated' && deps.teardownControlFrame) {
    await deps.teardownControlFrame(spec.hiveId, workspaceId).catch(() => undefined);
  }
  deps.log?.('info', `[hive] ${spec.hiveId} paused (${paused.length} frames destroyed to stop billing)`);
  return { hiveId: spec.hiveId, paused };
}

/**
 * Scale a Hive: deploy newly-added members + tear down removed ones. Returns the
 * delta. The caller updates `spec.members` to the new set.
 */
export async function scaleHive(
  spec: HiveDeploySpec,
  workspaceId: string,
  change: { add?: string[]; remove?: string[] },
  deps: HiveDeployDeps,
): Promise<{ added: HiveMemberResult[]; removed: string[] }> {
  const added: HiveMemberResult[] = [];
  for (const slug of change.add ?? []) {
    try {
      await deps.setMemberDeployment(slug, workspaceId, spec.swarm);
      const { frame } = await deps.deployHarness(slug, workspaceId);
      added.push({ slug, frame });
    } catch (e) {
      added.push({ slug, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  const removed: string[] = [];
  for (const slug of change.remove ?? []) {
    const r = await deps.teardownHarness(slug, workspaceId).catch(() => ({ destroyed: false }));
    if (r.destroyed) removed.push(slug);
  }
  deps.log?.('info', `[hive] ${spec.hiveId} scaled: +${added.length} / -${removed.length}`);
  return { added, removed };
}

// ── Cost controls (P-017) ───────────────────────────────────────────────────

export interface FrameCostState {
  slug: string;
  /** Accrued cost for this frame (USD). */
  costUsd?: number;
  /** Epoch-ms of last activity on this frame. */
  lastActivityMs?: number;
}

/**
 * Decide which frames to reap NOW (pure): a frame is reaped if it's over its
 * per-frame budget cap, OR idle longer than the idle-reaper window. `nowMs` is
 * passed in (no ambient clock) so this is deterministic + testable.
 */
export function computeFramesToReap(
  spec: HiveDeploySpec,
  frames: FrameCostState[],
  nowMs: number,
): { slug: string; reason: 'budget' | 'idle' }[] {
  const out: { slug: string; reason: 'budget' | 'idle' }[] = [];
  const cap = spec.budget?.perFrameUsdCap;
  const idleMs = spec.budget?.idleReaperMinutes != null ? spec.budget.idleReaperMinutes * 60_000 : undefined;
  for (const f of frames) {
    if (cap != null && f.costUsd != null && f.costUsd >= cap) {
      out.push({ slug: f.slug, reason: 'budget' });
    } else if (idleMs != null && f.lastActivityMs != null && nowMs - f.lastActivityMs >= idleMs) {
      out.push({ slug: f.slug, reason: 'idle' });
    }
  }
  return out;
}

/** Reap (destroy-to-stop) the frames `computeFramesToReap` selects. */
export async function reapHiveFrames(
  spec: HiveDeploySpec,
  frames: FrameCostState[],
  nowMs: number,
  workspaceId: string,
  deps: HiveDeployDeps,
): Promise<{ slug: string; reason: 'budget' | 'idle' }[]> {
  const toReap = computeFramesToReap(spec, frames, nowMs);
  for (const { slug, reason } of toReap) {
    deps.log?.('info', `[hive] ${spec.hiveId} reaping ${slug} (${reason}) — destroy-to-stop`);
    await deps.teardownHarness(slug, workspaceId).catch(() => undefined);
  }
  return toReap;
}
