/**
 * origin-freshness-watchdog — WI-5607, the DB/git wiring around the pure
 * `evaluateOriginFreshness` verdict (origin-freshness.ts — see that module's header for the
 * full "why" and the two-signal design). git-sync-stall-watchdog's sibling for the ONE class
 * of silent stall it cannot see: a `bridged` hive whose member git-sync routines keep
 * advancing local HEAD every tick (so commit-staleness never fires) while the bridge
 * writer's egress to GitHub origin is actually stuck.
 *
 * Scope: `bridged` hives only (`hiveGit.mode === 'bridged'`, hive-git-mode.ts). `legacy`
 * hives push origin directly every git-sync tick and are already covered by
 * git-sync-stall-watchdog's commit-staleness. `p2p-only` hives have no GitHub remote at all
 * — there is nothing named "origin" for this check to assert freshness against; their
 * propagation liveness is the P2P dial-path's own concern (WI-5210's heal-sweep already
 * covers a dead dial path).
 *
 * DETECTION: for each bridged hive, read the bare pot-git store directly (LOCAL to this
 * host — the same host-scoped, best-effort-degrades-to-null posture git-pipeline-hives.ts
 * already uses for its `stagingMainGap` panel field; a hive ticking on a different host in
 * the federation just reads null here and never alarms, it never false-alarms):
 *   - the LOCAL canonical ref the bridge is trying to publish (`BRIDGE_CANONICAL_REF`);
 *   - the synthetic github-origin namespace ref (`github-ingress.ts`) — the bridge's own
 *     best-effort local mirror of the real GitHub tip, refreshed on every successful
 *     ingress fetch. This stands in for "origin/staging" without any extra network I/O:
 *     ingress already fetches it every tick as a side effect of the bridge's normal work.
 * `aheadCount` = commits the canonical ref has that the namespace ref lacks. The
 * namespace-ref clock (when it last CHANGED) is tracked on the routine metadata — the exact
 * head-unchanged-clock idiom `checkGitSyncStall` uses for the local HEAD, applied here to
 * the origin tip instead — under its OWN metadata keys (`of_*`, never colliding with that
 * sibling's `wd_*` keys or git-sync-action's own `github_bridge` blob).
 *
 * Process-level (NOT a DBOS routine), same rationale as every sibling: a routine-based
 * watchdog queues on the very engine that can wedge.
 *
 * On a SUSTAINED alarm (EI-9030b-style debounce — a transient blip that self-heals within
 * one sweep interval never pages): an urgent owner `notifyAttention` + a durable
 * `harness_escalations` row (own phase, never clobbers git-sync's or the bridge's own rows)
 * + a fleet broadcast so any running agent can claim the rescue. Recovery (origin catches
 * back up) clears the flag + escalation idempotently.
 *
 * Kill-switch: PAPERCUSP_ORIGIN_FRESHNESS_WATCHDOG='0'.
 */
import { existsSync } from 'node:fs';
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { broadcastSevereEvent, broadcastSevereEventResolvedMany } from '../severe-event-broadcast';
import { loadHarnessRegistry, type ProjectEntry } from '../harness-registry';
import { getPotGitMode, POT_GIT_MODE_SETTING_KEY } from '../harness/git-sync/hive-git-mode';
import { canonicalRepoKey } from '../sync/pot-git/repo-identity';
import { hiveGitRepoPath, readNamespaceRef, defaultRunGit, type RunGit } from '../sync/pot-git/storage';
import { githubOriginDevicePubkey } from '../sync/pot-git/github-ingress';
import { BRIDGE_CANONICAL_REF } from '../sync/pot-git/github-bridge-tick';
import {
  evaluateOriginFreshness,
  DEFAULT_AHEAD_COUNT_MAX,
  DEFAULT_TIP_AGE_STALE_MS,
  type OriginFreshnessThresholds,
} from './origin-freshness';

const WATCHDOG_PHASE = 'origin-freshness-watchdog';
const WATCHDOG_KIND = 'origin-freshness-watchdog';
/** WI-5791: stable condition key for "this watchdog is watching nothing". */
const WATCHDOG_BLIND_CONDITION_KEY = 'origin-freshness:watchdog-blind';
/**
 * WI-5791: edge-trigger state for the blindness broadcast, so a persistent
 * blindness alarms ONCE rather than every sweep. Process-level by design — a
 * restart re-announcing a still-blind watchdog is correct, not noise.
 */
let lastSweepWasBlind = false;
/** EI-9030b idiom: consecutive sweeps the verdict must hold before it broadcasts. */
const DEFAULT_STALL_SUSTAIN_MIN_SWEEPS = 2;
/** git-sync ticks every 3 min; 15m matches every sibling watchdog's sweep cadence. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 15 * 60 * 1000;

export interface OriginFreshnessWatchdogOptions extends OriginFreshnessThresholds {
  stallSustainMinSweeps?: number;
  intervalMs?: number;
  runGit?: RunGit;
  workspaceId?: string;
}

/** `git -C repoPath rev-parse --verify --quiet <ref>` — null on any error/missing ref. */
async function readRefSha(repoPath: string, ref: string, runGit: RunGit): Promise<string | null> {
  const r = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** `git -C repoPath rev-list --count from..to` — null on any error (incl. either sha missing). */
async function revListCount(repoPath: string, from: string, to: string, runGit: RunGit): Promise<number | null> {
  const r = await runGit(['rev-list', '--count', `${from}..${to}`], repoPath);
  if (r.code !== 0) return null;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Resolve the hive HOME slug for a registry entry — mirrors git-sync-action's
 *  `runGithubBridgeLeg` derivation exactly (never re-import that module: it is huge and
 *  side-effecting; this one line of shared logic is cheap to keep in sync by inspection). */
function potHomeSlugOf(entry: ProjectEntry): string | undefined {
  return entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
}

/**
 * WI-5791 — every workspace that owns a harness registry.
 *
 * Deliberately NOT falling back to `DEFAULT_WORKSPACE_ID` when this read fails:
 * that fallback is exactly how this watchdog spent its whole life sweeping an
 * empty workspace while reporting a clean pass. An empty list makes the sweep
 * check nothing, which the zero-coverage self-report then reports LOUDLY —
 * silence must never read as health.
 */
async function listRegistryWorkspaceIds(sql: Sql): Promise<string[]> {
  try {
    const rows = await sql<{ workspace_id: string }[]>`
      SELECT DISTINCT workspace_id
        FROM harness_shared.harness_registry
       WHERE workspace_id IS NOT NULL AND workspace_id <> ''
       ORDER BY workspace_id`;
    return rows.map((r) => r.workspace_id);
  } catch (e) {
    console.warn(
      `[origin-freshness-watchdog] workspace enumeration failed — this sweep covers NOTHING: ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

/**
 * WI-5791 — does this watchdog have anything to watch?
 *
 * The bug this guards against is not "the verdict was wrong", it is "the verdict
 * was never computed" — a sweep that examines zero entries returns exactly the
 * same shape as a sweep where everything is healthy. So ask the question the
 * sweep itself cannot: are there bridged pots in the DB that a covering sweep
 * MUST have checked? If yes and we checked none, the watchdog is blind and says
 * so, instead of reporting a clean pass forever.
 */
async function countBridgedPots(sql: Sql): Promise<number> {
  try {
    const rows = await sql<{ n: string | number }[]>`
      SELECT count(*) AS n
        FROM harness_shared.pot_settings
       WHERE setting_key = ${POT_GIT_MODE_SETTING_KEY}
         AND value #>> '{}' = 'bridged'`;
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0; // unknown — never manufacture a false blindness alarm
  }
}

export interface OriginFreshnessWatchdogResult {
  alarmed: string[];
  recovered: string[];
  checked: number;
  /**
   * WI-5791 — the sweep covered NOTHING while bridged pots exist, i.e. this
   * watchdog is not watching anything. Distinct from `checked: 0` alone, which
   * is legitimate on an install with no bridged pots. Never set on a healthy
   * pass, so a caller can treat its presence as a defect signal.
   */
  blind?: boolean;
}

/**
 * WI-5738 — which sha this watchdog treats as "where origin actually is".
 *
 * Extracted as a pure function because the PRECEDENCE is the whole bug. The
 * original watchdog measured the ingress mirror of `github_default_branch`, and
 * that is why a five-day egress outage read healthy the entire time: the RELEASE
 * pipeline fast-forwards that branch hourly, so it reported a fresh tip and a
 * small ahead-count no matter how wedged egress was — and it RESET the staleness
 * clock every hour.
 *
 * Order, strongest evidence first:
 *   1. `egressHead`   — what egress LAST ACTUALLY LANDED. The only signal that
 *                       is a fact about the mechanism being watched.
 *   2. `lastObserved` — this watchdog's own previous observation. Reusing it
 *                       when a fresh reading is missing leaves the staleness
 *                       clock RUNNING, so a genuine wedge still alarms. Silence
 *                       must never read as health.
 *   3. `ingressMirror`— last resort, for a hive that has NEVER observed an
 *                       egress head (pre-upgrade metadata). A weak signal beats
 *                       none, but it must never PREEMPT a real one.
 *
 * The trap this encodes: (2) exists so that a single quiet tick cannot demote
 * the watchdog back to (3). Skipping straight from (1) to (3) silently restores
 * the exact blindness this incident was about.
 */
export function selectOriginWatermark(input: {
  egressHead: string | null;
  lastObserved: string | null;
  ingressMirror: string | null;
}): string | null {
  return input.egressHead ?? input.lastObserved ?? input.ingressMirror ?? null;
}

/**
 * One watchdog pass: scan every registry entry whose hive is in `bridged` mode and has a
 * GitHub remote configured, read the local bare store (best-effort — a missing/foreign-host
 * repo just degrades to "unknown", never a false alarm), evaluate freshness, and alarm/clear
 * exactly like `checkGitSyncStall`. Never throws.
 */
export async function checkOriginFreshness(
  sql: Sql,
  opts: OriginFreshnessWatchdogOptions = {},
): Promise<OriginFreshnessWatchdogResult> {
  const out: OriginFreshnessWatchdogResult = { alarmed: [], recovered: [], checked: 0 };
  const runGit = opts.runGit ?? defaultRunGit;
  const stallSustainMinSweeps = opts.stallSustainMinSweeps ?? DEFAULT_STALL_SUSTAIN_MIN_SWEEPS;
  const now = Date.now();
  const recoveredForBroadcast: string[] = [];

  try {
    // WI-5791 — sweep EVERY workspace that owns a harness registry, not one
    // hard-coded default.
    //
    // This used to be `loadHarnessRegistry(opts.workspaceId ?? DEFAULT_WORKSPACE_ID)`,
    // and no caller has ever passed `opts.workspaceId` — `startOriginFreshnessWatchdog`
    // calls `checkOriginFreshness(sql, opts)` with the boot's empty opts. So every
    // sweep since this watchdog shipped (WI-5607) loaded the registry of workspace
    // `'default'`, which holds 14 unrelated scratch pots and not one bridged hive,
    // while every real pot lives in `'papercusp-workspace'`. The pass returned
    // `checked: 0` — it never entered the per-entry body, never wrote `of_origin_sha`,
    // and therefore could never age a tip or raise `tipAgeStale`. The watchdog built
    // to catch a silently-stalled egress was itself silently stalled, for its whole
    // life, and nothing said so: `checked: 0` is indistinguishable from a clean pass
    // at every surface that reads this result.
    //
    // That is the same shape as the bug this watchdog exists to catch, and as
    // EI-10103 in the sibling main-behind watchdog (a workspace it could not resolve
    // meant its escalation write threw into an outer catch). See
    // agent-insights/absorbing-state-guards-and-self-report-detectors. The
    // zero-coverage self-report below is the guard that makes the class visible.
    const workspaceIds = opts.workspaceId ? [opts.workspaceId] : await listRegistryWorkspaceIds(sql);
    const workspaceIdsSwept = workspaceIds.length;
    const targets: { workspaceId: string; entry: ProjectEntry }[] = [];
    for (const wsId of workspaceIds) {
      let projects: ProjectEntry[];
      try {
        projects = (await loadHarnessRegistry(wsId)).projects;
      } catch {
        continue; // one unreadable workspace must never abort the whole sweep
      }
      for (const entry of projects) targets.push({ workspaceId: wsId, entry });
    }

    for (const { workspaceId, entry } of targets) {
      if (!entry.github_remote) continue; // nothing to be "origin"-fresh against
      const potHomeSlug = potHomeSlugOf(entry);
      if (!potHomeSlug) continue;

      let mode: Awaited<ReturnType<typeof getPotGitMode>>;
      try {
        mode = await getPotGitMode(workspaceId, potHomeSlug, sql);
      } catch {
        continue;
      }
      if (mode !== 'bridged') continue; // legacy covered elsewhere; p2p-only has no origin

      out.checked += 1;
      const repoKey = canonicalRepoKey(entry);
      const repoPath = hiveGitRepoPath(potHomeSlug, repoKey);
      if (!existsSync(repoPath)) {
        // Not on this host — best-effort, never a false alarm.
        //
        // WI-5738 (found by su-e3b21's "check the RESET path too" prompt): this
        // `continue` skips the verdict block, and the verdict block's `else`
        // branch is the ONLY place `of_alerted` is cleared. So a pot that had
        // alarmed and then lost its bare store — a host migration, or a repoKey
        // change like WI-5168's slug→gh-<id> move, which relocates this very
        // path — stranded the latch `true` forever and could never alarm again.
        // Same absorbing-state shape as the guards this incident was about:
        // state that only advances through the success path, with an early exit
        // bypassing the clear. Clear a stranded latch on the way out.
        // Single targeted statement — no prior read needed, and a no-op unless
        // the latch is actually stranded.
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"of_alerted":false}'::jsonb,
                 updated_at = now()
           WHERE install_slug = ${entry.slug}
             AND target_role = 'system:git-sync'
             AND COALESCE((metadata->>'of_alerted')::boolean, false) = true`;
        continue;
      }

      const branch = entry.github_default_branch ?? 'main';
      const devicePubkey = githubOriginDevicePubkey(entry.github_remote);

      const [canonicalSha, ingressMirrorSha] = await Promise.all([
        readRefSha(repoPath, BRIDGE_CANONICAL_REF, runGit),
        readNamespaceRef(repoPath, devicePubkey, `refs/heads/${branch}`, runGit),
      ]);

      // Read the watchdog's own tracked clock for this entry's git-sync routine row.
      const rows = await sql<
        {
          of_origin_sha: string | null;
          of_origin_since_ms: string | number | null;
          of_alerted: boolean | null;
          of_stall_sweeps: number | null;
          of_publish_refused_sweeps: number | null;
          publish_refused: string | null;
          egress_head: string | null;
        }[]
      >`
        SELECT metadata->>'of_origin_sha' AS of_origin_sha,
               (metadata->>'of_origin_since_ms')::bigint AS of_origin_since_ms,
               COALESCE((metadata->>'of_alerted')::boolean, false) AS of_alerted,
               COALESCE((metadata->>'of_stall_sweeps')::int, 0) AS of_stall_sweeps,
               COALESCE((metadata->>'of_publish_refused_sweeps')::int, 0) AS of_publish_refused_sweeps,
               metadata->'own_head_publish'->>'refused' AS publish_refused,
               metadata->'github_bridge'->>'egress_head' AS egress_head
          FROM harness_shared.routines
         WHERE install_slug = ${entry.slug} AND target_role = 'system:git-sync'
         LIMIT 1`;
      const row = rows[0];
      // WI-5738 — measure against the EGRESS target, not the ingress mirror.
      //
      // This read used to be `readNamespaceRef(..., github_default_branch)`,
      // i.e. the mirror of the branch the bridge INGESTS. On papercusp that is
      // `main`, while the bridge EGRESSES to `refs/heads/staging`. main is
      // fast-forwarded hourly by the release pipeline, so the watchdog's two
      // signals were both permanently pinned healthy — ahead-count sat at ~24
      // (< the 50 threshold) and the tracked tip never aged past ~1h — while
      // origin/staging, the ref the bridge actually writes, stayed frozen for
      // five days, 358 commits behind. The watchdog was watching a branch that
      // could not tell it anything about the thing it was built to watch.
      //
      // `github_bridge.egress_head` is what egress last actually landed. The
      // ingress mirror remains a fallback ONLY for a hive whose egress has not
      // reported yet (pre-upgrade metadata), where the old signal is still
      // better than none.
      // Defence in depth for the same trap, from the READ side. Even with the
      // sticky write, `egress_head` can be absent (pre-upgrade metadata, or a
      // hive whose egress has genuinely never reported). Falling straight back
      // to the ingress mirror is what made this watchdog blind for five days —
      // that branch is fast-forwarded hourly by the RELEASE pipeline, so it
      // reports healthy no matter how wedged egress is, and it RESETS the
      // staleness clock every hour.
      //
      // `of_origin_sha` is this watchdog's OWN last real observation. Preferring
      // it means a vanished signal leaves the clock RUNNING (so a genuine wedge
      // still alarms) instead of being reset by an unrelated branch. The
      // ingress mirror survives only as the last resort for a hive that has
      // never once observed an egress head — there, a weak signal beats none.
      const prevOriginSha = row?.of_origin_sha ?? null;
      const originSha = selectOriginWatermark({
        egressHead: row?.egress_head ?? null,
        lastObserved: prevOriginSha,
        ingressMirror: ingressMirrorSha,
      });
      const alerted = row?.of_alerted ?? false;
      const prevOriginSinceMs = row?.of_origin_since_ms != null ? Number(row.of_origin_since_ms) : null;

      let originTipAgeMs: number | null = null;
      if (originSha == null) {
        originTipAgeMs = null; // never observed an origin tip yet
      } else if (originSha !== prevOriginSha || prevOriginSinceMs == null) {
        // Origin tip advanced (or first observation) — (re)start its clock.
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('of_origin_sha', ${originSha}::text, 'of_origin_since_ms', ${now}::bigint),
                 updated_at = now()
           WHERE install_slug = ${entry.slug} AND target_role = 'system:git-sync'`;
        originTipAgeMs = 0;
      } else {
        originTipAgeMs = now - prevOriginSinceMs;
      }

      const aheadCount =
        canonicalSha != null && originSha != null ? await revListCount(repoPath, originSha, canonicalSha, runGit) : null;

      // WI-5738: the publish leg's OWN refusal self-report — recorded on every
      // tick at metadata.own_head_publish.refused since the guard shipped, and
      // until now raising absolutely nothing.
      const publishRefusalCode = row?.publish_refused ?? null;
      const prevRefusedSweeps = row?.of_publish_refused_sweeps ?? 0;
      const publishRefusedSweeps = publishRefusalCode ? prevRefusedSweeps + 1 : 0;
      if (publishRefusedSweeps !== prevRefusedSweeps) {
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('of_publish_refused_sweeps', ${publishRefusedSweeps}::int),
                 updated_at = now()
           WHERE install_slug = ${entry.slug} AND target_role = 'system:git-sync'`;
      }

      const verdict = evaluateOriginFreshness(
        { aheadCount, originTipAgeMs, publishRefusedSweeps, publishRefusalCode },
        opts,
      );

      const prevStallSweeps = row?.of_stall_sweeps ?? 0;
      const stallSweeps = verdict.state === 'stale' ? prevStallSweeps + 1 : 0;
      if (stallSweeps !== prevStallSweeps) {
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('of_stall_sweeps', ${stallSweeps}::int),
                 updated_at = now()
           WHERE install_slug = ${entry.slug} AND target_role = 'system:git-sync'`;
      }

      if (verdict.state === 'stale') {
        if (alerted) continue; // one-shot until recovery
        if (stallSweeps < stallSustainMinSweeps) continue; // debounce a transient blip

        const flip = await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"of_alerted":true}'::jsonb,
                 updated_at = now()
           WHERE install_slug = ${entry.slug}
             AND target_role = 'system:git-sync'
             AND COALESCE((metadata->>'of_alerted')::boolean, false) = false`;
        if (flip.count !== 1) continue; // another process won the flip

        try {
          const { notifyAttention } = await import('../attention-notify');
          await notifyAttention({
            kind: 'intervention',
            title: 'origin freshness STALLED — GitHub origin is falling behind local',
            body: `${entry.slug} (bridged hive ${potHomeSlug}): ${verdict.reason}. The bridge's own divergence classifier reports clear — this is an independent freshness backstop.`,
            importance: 'urgent',
            workspaceId,
            data: {
              aheadCountStale: verdict.aheadCountStale,
              tipAgeStale: verdict.tipAgeStale,
              publishRefused: verdict.publishRefused,
              publishRefusalCode,
            },
          });
        } catch (e) {
          console.warn(`[origin-freshness-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
        }

        await broadcastSevereEvent({
          summary: `origin freshness STALLED on ${entry.slug} (bridged) — GitHub origin is falling behind local; bridge divergence classifier reports clear.`,
          body:
            `${verdict.reason}\n\nWhy it matters: the github-bridge divergence classifier only fires on structured residues ` +
            `(rejectedNonFF / blockedSecrets / …) — a bridge that is reachable but simply stuck (a starved integrator lease, ` +
            `a wedged egress fire) still reports 'clear' while origin freezes. Claim it: inspect the ${entry.slug} git-sync ` +
            `routine's metadata.github_bridge for the last tick's outcome, and check whether the bridge writer (integrator ` +
            `lock-authority lease holder) is actually running.`,
          category: 'severe-event',
          conditionKey: `origin-freshness:${entry.slug}`,
        });

        try {
          await sql`
            INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
            VALUES (${entry.slug}, ${WATCHDOG_PHASE}, ${JSON.stringify({
              kind: WATCHDOG_KIND,
              harness_slug: entry.slug,
              pot_home_slug: potHomeSlug,
              aheadCount,
              originTipAgeHrs: originTipAgeMs != null ? Math.round(originTipAgeMs / 3_600_000) : null,
              emitted_at: now,
              detail: `origin-freshness watchdog: ${verdict.reason}`,
            })}, ${now}, ${workspaceId})
            ON CONFLICT (harness_slug, phase)
            DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
        } catch (e) {
          console.warn(`[origin-freshness-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
        }
        out.alarmed.push(entry.slug);
        console.warn(`[origin-freshness-watchdog] ALARM ${entry.slug}: ${verdict.reason}`);
      } else {
        const cleared = await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = NULL, mtime_ms = ${now}
           WHERE harness_slug = ${entry.slug}
             AND phase = ${WATCHDOG_PHASE}
             AND escalation IS NOT NULL`;
        if (alerted) {
          await sql`
            UPDATE harness_shared.routines
               SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"of_alerted":false}'::jsonb,
                   updated_at = now()
             WHERE install_slug = ${entry.slug} AND target_role = 'system:git-sync'`;
          recoveredForBroadcast.push(entry.slug);
          out.recovered.push(entry.slug);
        } else if (cleared.count > 0) {
          console.warn(
            `[origin-freshness-watchdog] cleared a STRANDED escalation for ${entry.slug} (alerted flag was already false)`,
          );
        }
      }
    }

    if (recoveredForBroadcast.length > 0) {
      const list = recoveredForBroadcast.join(', ');
      await broadcastSevereEventResolvedMany({
        conditionKeys: recoveredForBroadcast.map((slug) => `origin-freshness:${slug}`),
        summary:
          recoveredForBroadcast.length === 1
            ? `origin freshness RECOVERED on ${list} — GitHub origin has caught back up; the earlier stall alarm is stale.`
            : `origin freshness RECOVERED on ${recoveredForBroadcast.length} hives (${list}) — origin has caught back up.`,
      });
    }
    // WI-5791 — the self-report. A sweep that checked nothing is not a healthy
    // sweep, and until now it was reported as one. Only meaningful when bridged
    // pots actually exist: a workspace with none legitimately checks zero.
    //
    // This deliberately does NOT stop at a console.warn. The whole lesson of this
    // incident is that a signal nobody reads is not a detector — a warn buried in
    // the bg-host journal would be the same mistake one level up. It goes to the
    // same severe-event surface a real origin-freshness stall uses, keyed on a
    // stable conditionKey so it dedupes rather than storms, and edge-triggered off
    // module state so a persistent blindness broadcasts once, not every 15 minutes.
    if (out.checked === 0) {
      const bridged = await countBridgedPots(sql);
      if (bridged > 0) {
        out.blind = true;
        console.warn(
          `[origin-freshness-watchdog] BLIND: checked 0 entries across ${workspaceIdsSwept} workspace(s) while ${bridged} bridged pot(s) exist. ` +
            `This watchdog is not watching anything — treat every 'clean' origin-freshness pass as unverified until fixed.`,
        );
        if (!lastSweepWasBlind) {
          lastSweepWasBlind = true;
          await broadcastSevereEvent({
            summary: `origin-freshness watchdog is BLIND — it checked 0 pots while ${bridged} bridged pot(s) exist. Origin freshness is NOT being monitored.`,
            body:
              `The sweep enumerated ${workspaceIdsSwept} workspace(s) and found no eligible entry, so no origin tip was measured, aged, or judged ` +
              `on this pass. A 'clean' origin-freshness result right now means NOTHING WAS CHECKED — not that origin is healthy.\n\n` +
              `This is the failure mode described in agent-insights/absorbing-state-guards-and-self-report-detectors (Shape D): a correctly ` +
              `written detector aimed at an empty set reports a clean pass forever. Claim it: check which workspaces own a harness registry ` +
              `(harness_shared.harness_registry) versus which own the bridged pots (harness_shared.pot_settings, setting_key='hiveGit.mode'), ` +
              `and confirm the sweep's scope covers the latter.`,
            category: 'severe-event',
            conditionKey: WATCHDOG_BLIND_CONDITION_KEY,
          });
        }
      }
    } else if (lastSweepWasBlind) {
      // Coverage came back — retract the blindness alarm, same as any recovery.
      lastSweepWasBlind = false;
      await broadcastSevereEventResolvedMany({
        conditionKeys: [WATCHDOG_BLIND_CONDITION_KEY],
        summary: `origin-freshness watchdog RECOVERED coverage — it is checking ${out.checked} pot(s) again.`,
      });
    }

    return out;
  } catch (e) {
    console.warn(`[origin-freshness-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the watchdog: an immediate boot check + a recurring process-level sweep. Idempotent.
 * Kill-switch: PAPERCUSP_ORIGIN_FRESHNESS_WATCHDOG='0'.
 */
export function startOriginFreshnessWatchdog(sql: Sql, opts: OriginFreshnessWatchdogOptions = {}): void {
  if (process.env.PAPERCUSP_ORIGIN_FRESHNESS_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;

  const run = (): void => {
    void checkOriginFreshness(sql, opts).then((r) => {
      if (r.alarmed.length > 0) {
        console.warn(`[origin-freshness-watchdog] alarmed on: ${r.alarmed.join(', ')}`);
      }
      // WI-5791: surface the watchdog's OWN failure at the same volume as the
      // failures it watches for. Without this the blind state is only visible to
      // a caller that inspects the result object — and nothing ever did, which is
      // how it stayed blind from the day it shipped.
      if (r.blind) {
        console.warn(
          `[origin-freshness-watchdog] BLIND — this sweep watched nothing. Origin-freshness is NOT being monitored.`,
        );
      }
    });
  };

  run(); // boot check
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval('origin-freshness-watchdog', intervalMs, run, { category: 'watchdog' });
}

export { DEFAULT_AHEAD_COUNT_MAX, DEFAULT_TIP_AGE_STALE_MS };
