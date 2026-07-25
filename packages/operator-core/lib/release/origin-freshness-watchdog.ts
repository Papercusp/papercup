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
import { getPotGitMode } from '../harness/git-sync/hive-git-mode';
import { canonicalRepoKey } from '../sync/pot-git/repo-identity';
import { hiveGitRepoPath, readNamespaceRef, defaultRunGit, type RunGit } from '../sync/pot-git/storage';
import { githubOriginDevicePubkey } from '../sync/pot-git/github-ingress';
import { BRIDGE_CANONICAL_REF } from '../sync/pot-git/github-bridge-tick';
import { DEFAULT_WORKSPACE_ID } from '../workspace-id-constant';
import {
  evaluateOriginFreshness,
  DEFAULT_AHEAD_COUNT_MAX,
  DEFAULT_TIP_AGE_STALE_MS,
  type OriginFreshnessThresholds,
} from './origin-freshness';

const WATCHDOG_PHASE = 'origin-freshness-watchdog';
const WATCHDOG_KIND = 'origin-freshness-watchdog';
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

export interface OriginFreshnessWatchdogResult {
  alarmed: string[];
  recovered: string[];
  checked: number;
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
  const workspaceId = opts.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const stallSustainMinSweeps = opts.stallSustainMinSweeps ?? DEFAULT_STALL_SUSTAIN_MIN_SWEEPS;
  const now = Date.now();
  const recoveredForBroadcast: string[] = [];

  try {
    let projects: ProjectEntry[];
    try {
      projects = (await loadHarnessRegistry(workspaceId)).projects;
    } catch {
      return out;
    }

    for (const entry of projects) {
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
      if (!existsSync(repoPath)) continue; // not on this host — best-effort, never a false alarm

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
      const originSha = row?.egress_head ?? ingressMirrorSha;
      const alerted = row?.of_alerted ?? false;
      const prevOriginSha = row?.of_origin_sha ?? null;
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
    });
  };

  run(); // boot check
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval('origin-freshness-watchdog', intervalMs, run, { category: 'watchdog' });
}

export { DEFAULT_AHEAD_COUNT_MAX, DEFAULT_TIP_AGE_STALE_MS };
