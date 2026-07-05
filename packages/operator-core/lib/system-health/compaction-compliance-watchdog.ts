/**
 * compaction-compliance-watchdog — the backstop for agent-managed compaction
 * (agent-managed-compaction-2026-07-01 P-009).
 *
 * On a cadence (OFF the per-turn hot path) it estimates each limit-setting session's
 * context size and caches it on coord_presence.context_tokens — the value the
 * coord:inbox usage signal reads to render `context: N/L (X%)` (P-007). It also logs
 * a warning when a session has run PAST its own compaction_limit without compacting
 * and force-injects a compact turn into live psu-pty hosts.
 *
 * Trust-the-agent design (D-008): the agent self-manages off the injected signal;
 * this catches the ones that don't. The force-compact rung below is the active
 * mechanical safety net for sessions that miss the nudge.
 *
 * Process-level (NOT a DBOS routine), like the git-sync / green / mcp-dark
 * watchdogs. Kill-switch: PAPERCUSP_COMPACTION_WATCHDOG='0'.
 */
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import {
  detectContextDeathForOwner,
  estimateContextTokensForOwner,
  resolveModelSpecForOwner,
} from '../compaction-usage';
import { setContextEstimate, setCompactionLimit } from '../agent-tools/coordination/presence';
import {
  COMPACTION_LIMIT_DEFAULT_1M_CAP,
  COMPACTION_OVERSHOOT_FACTOR,
  COMPACTION_WINDOW_MARGIN_TOKENS,
  defaultCompactionLimitForSpec,
  modelWindowForSpec,
  type ModelTier,
} from '../agent-config-constants';
import { listActiveClaimFreshnessForOwner } from '../work-item-claims';
import { classifyStaleClaims, type StaleClaim } from '../agent-tools/coordination/tools/inbox-flush-gate';
import { recordContextUsage, setContextGaugeEnabled } from './context-usage-cache';

/** How often the watchdog sweeps. Off the hot path, so a relaxed cadence. */
const DEFAULT_INTERVAL_MS = 2 * 60_000; // 2 min
/** At/over this fraction of the limit ⇒ the agent should have compacted already —
 *  the WARN + surface band (over-limit log, unflushed-claim surfacing). */
const OVER_LIMIT_FRACTION = 1.0;
/** The P-012 FORCE-COMPACT rung fires only past this fraction of the limit (owner
 *  directive 2026-07-04: let an agent run a little over before the watchdog seizes
 *  the turn — the soft limit is a nudge target, not a hard wall). ALWAYS capped at
 *  the hard window − margin: 130% of the 158k default on a 200k window is ~205k,
 *  PAST the window, so an uncapped force would fire only after the session died on
 *  "Prompt is too long" — the cap forces at ~190k instead. Window unresolvable ⇒
 *  fall back to limit × COMPACTION_OVERSHOOT_FACTOR, the bound clampCompactionLimit
 *  already guarantees safe for whatever window legally produced that limit. */
const FORCE_COMPACT_FRACTION = 1.3;
/** Max limit-less live sessions seeded per pass — bounds fs/PG work per sweep. */
const MAX_SEEDS_PER_PASS = 25;

/** In-memory escalation dedup: warn only on the FIRST crossing; clear on recovery. */
const overLimitOwners = new Set<string>();

/** P-019 context-death dedup: one coord escalation per dead owner per process. */
const contextDeathEscalated = new Set<string>();

/** P-012 force-compact dedup: inject /compact ONCE per over-limit crossing;
 *  cleared when the owner recovers (est back under limit) so a later crossing
 *  re-arms it. A failed inject is NOT recorded, so it retries next pass. */
const forceCompactedOwners = new Set<string>();

/** P-018 boot self-assert: one advisory escalation per owner per defect-class per
 *  process (key `${ownerId}:${kind}`). The 2026-07-04 incident's dark-telemetry defect
 *  (a live member whose context estimate never resolved) was latent FROM BOOT and survived
 *  hours silently — this asserts it per member and surfaces the failure. (compaction_limit
 *  sanity is covered upstream: P-016 seeds the tier-aware default, P-017 lowers any >cap
 *  drift, so a boot-time limit re-assert here would be redundant.) */
const bootConfigEscalated = new Set<string>();
/** P-018 dark-telemetry counter: consecutive sweeps a live limit-carrying session's
 *  context estimate stayed null. Cleared when it resolves. */
const nullEstimateStreak = new Map<string, number>();
/** P-018 dark-telemetry: escalate after this many consecutive null estimates. A
 *  normally-booting session reads null for a sweep or two (transcript not yet on
 *  disk); 3 sweeps (~6min) of grace keeps a healthy boot from tripping it, while a
 *  session that stays BLIND — the gauge / per-turn reminder / force-compact all can't
 *  see its usage, the "dark telemetry latent from boot" defect — gets surfaced. */
const DARK_TELEMETRY_MAX_NULL_SWEEPS = 3;

/** Test seam (P-019). */
export function resetContextDeathEscalationsForTests(): void {
  contextDeathEscalated.clear();
}

/** Test seam (P-012). */
export function resetForceCompactedForTests(): void {
  forceCompactedOwners.clear();
}

/** Test seam (P-018). */
export function resetBootConfigAssertForTests(): void {
  bootConfigEscalated.clear();
  nullEstimateStreak.clear();
}

/**
 * P-019 member-death detector: a session whose transcript tail carries the
 * "Prompt is too long" window-overflow error is DEAD (it cannot take another
 * turn — a single-exchange overflow cannot be compacted), and it died
 * SILENTLY: presence keeps beating until the process reaps, so leaders see
 * "alive" while nothing works (6 fleet members died this way on 2026-07-01).
 * Raise ONE coord escalation per dead owner so the leader/owner relaunches it
 * (fleet persona tier / trimmed context / a wider-window model).
 */
async function escalateContextDeath(ownerId: string, ownerLabel: string): Promise<void> {
  if (contextDeathEscalated.has(ownerId)) return;
  contextDeathEscalated.add(ownerId);
  console.warn(
    `[compaction-watchdog] ${ownerLabel} (${ownerId}) DIED on "Prompt is too long" — escalating for relaunch (P-019).`,
  );
  try {
    const { openEscalation } = await import('../agent-tools/coordination/escalations');
    // Synthetic system identity — the steering-lease precedent shape.
    await openEscalation(
      {
        ownerId: 'compaction-watchdog',
        ownerLabel: 'system · compaction-watchdog',
        source: 'principal',
        workspaceId: null,
        userId: null,
      },
      {
        severity: 'blocker',
        summary: `fleet member ${ownerLabel} (${ownerId}) died on "Prompt is too long" — context overflowed its model window; it cannot take another turn`,
        body:
          `The session's transcript ends in the window-overflow API error, so every subsequent wake fails silently while presence keeps beating. ` +
          `Relaunch it (fleet:launch-on-plan / psu) with less baseline context: --persona-tier=fleet, --context-size=trimmed, or a wider-window ([1m]) model. ` +
          `Its claims are reclaimable via the stale-claim lane. (context-trimming-tiers-2026-07-01 P-019)`,
      },
    );
  } catch (e) {
    // Best-effort — never fail the sweep; un-dedup so the next pass retries.
    contextDeathEscalated.delete(ownerId);
    console.warn(
      `[compaction-watchdog] context-death escalation failed (will retry): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * P-018 boot self-assert (agent-managed-compaction-2026-07-01): raise ONE advisory
 * coord escalation per owner per defect-class when a live member fails a critical-config
 * assertion — a too-high compaction_limit seed (compacts too late for its tier) or dark
 * context telemetry (the watchdog/gauge/force-compact are BLIND to its usage). Both
 * incident defects were latent from boot and survived hours silently; surfacing them
 * (D-008: surface, don't seize) lets a leader/owner fix or relaunch. Advisory band ⇒
 * self-clears once stale (the agent fixes its limit / telemetry resolves). Deduped +
 * best-effort — never fails the sweep; a failed escalation un-dedups to retry next pass.
 */
async function escalateBootConfig(
  ownerId: string,
  ownerLabel: string,
  kind: 'dark-telemetry',
  summary: string,
  body: string,
): Promise<void> {
  const key = `${ownerId}:${kind}`;
  if (bootConfigEscalated.has(key)) return;
  bootConfigEscalated.add(key);
  console.warn(`[compaction-watchdog] ${ownerLabel} (${ownerId}) boot-config assert FAILED (${kind}) — ${summary} (P-018).`);
  try {
    const { openEscalation } = await import('../agent-tools/coordination/escalations');
    await openEscalation(
      {
        ownerId: 'compaction-watchdog',
        ownerLabel: 'system · compaction-watchdog',
        source: 'principal',
        workspaceId: null,
        userId: null,
      },
      { severity: 'advisory', summary, body },
    );
  } catch (e) {
    bootConfigEscalated.delete(key);
    console.warn(
      `[compaction-watchdog] boot-config escalation failed (will retry): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** P-012 force-compact `/compact` FOCUS — the summarizer preserve-hint (mirrors
 *  session:request-compaction's DEFAULT_FOCUS; the watchdog can't know the unit of
 *  work, so it names the standing preserve set). */
const FORCE_COMPACT_FOCUS =
  'keep the identity block, the active plan and its open items, unverified claims awaiting owner ' +
  'confirmation, owner-gated walls, and any in-flight work-item checkpoint; drop resolved tool output ' +
  'and superseded state.';
/** Which arm of `min(limit × 1.3, window − margin | limit × 1.2)` produced forceAt —
 *  the note must name the bound that actually bound (a fixed "≈ 1.3 × soft limit"
 *  gloss renders false math whenever the window cap wins, e.g. "~190k ≈ 1.3 × 400k";
 *  owner 2026-07-05). */
type ForceBound = 'fraction' | 'window' | 'overshoot';
/** The continuation-turn text opened on the compacted context (WI-1804 auto-continue
 *  hosts) — re-orient first (a compaction is a stale-snapshot boundary). Built with
 *  the session's REAL numbers (owner 2026-07-05: the old static text read as "you were
 *  compacted for merely passing the soft limit", which contradicts the model — the
 *  soft limit is the configured NUDGE point; the watchdog seizes only past the FORCE
 *  threshold), naming whichever bound actually set it. */
function forceCompactContinueNote(est: number, limit: number, forceAt: number, bound: ForceBound): string {
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const threshold =
    bound === 'fraction'
      ? `~${k(forceAt)} ≈ 1.3 × your configured soft limit of ${k(limit)}`
      : bound === 'window'
        ? `~${k(forceAt)} — the model-window cap (window − safety margin), which on this session ` +
          `binds below 1.3 × your soft limit of ${k(limit)}`
        : `~${k(forceAt)} — the conservative bound used when the model window is unknown ` +
          `(1.2 × your soft limit of ${k(limit)})`;
  // Window cap AT/BELOW the soft limit ⇒ the configured limit is unreachable on this
  // model and no self-compact band exists — the standard band advice would be
  // impossible to follow.
  const advice =
    bound === 'window' && forceAt <= limit
      ? `Your configured soft limit (~${k(limit)}) exceeds what this model's window allows, so ` +
        `there is no self-compact band — the window cap is the real ceiling. Self-compact ` +
        `(session:request-compaction) well before ~${k(forceAt)}, and lower the soft limit ` +
        `(config:set-compaction-limit) so the nudge fires in time.`
      : `The soft limit itself is only the nudge point — you should self-compact ` +
        `(session:request-compaction) at a clean stopping point anywhere between it and the FORCE ` +
        `threshold; the watchdog seizes the turn only when that band is exhausted.`;
  return (
    `The compaction watchdog force-compacted you: your context (~${k(est)} tokens) crossed the ` +
    `FORCE threshold (${threshold}). ${advice} This is a fresh turn on the ` +
    `compacted context: first re-run coord:orient to reconcile live fleet/claim/inbox state, then ` +
    `resume your current unit of work.`
  );
}

/**
 * P-012 (agent-managed-compaction-2026-07-01) — the L2 mechanical FORCE-COMPACT
 * rung. An over-limit session has ignored the per-turn reminder (rendered since 85%),
 * crossed its own soft limit, AND run through the FORCE_COMPACT_FRACTION grace band
 * (owner 2026-07-04), so the watchdog TYPES `/compact` into its OWN live psu-pty TUI —
 * idle-gated by the host (mode:'turn'/'compact' runs AFTER the current turn ends), so
 * it is safe to fire mid-turn. This catches a non-self-managing session at ~130% of
 * its limit (window-capped) instead of letting it drift toward the model window (the
 * 2026-07-04 836k incident). Best-effort; returns true only when the inject actually
 * reached a live host.
 *
 * Flag-gated (COMPACTION_WATCHDOG_FORCE_COMPACT, default ON) — a runtime kill-switch
 * for this invasive rung. No live psu-pty host (a dead/beating session, or a non-psu
 * host) ⇒ false, no-op: the context-death detector (P-019) + the mechanical CC
 * autoCompactWindow cap (P-014, set at launch) cover those. Dynamic imports mirror
 * escalateContextDeath so the sweep stays dependency-light + the deps stay mockable.
 */
async function maybeForceCompact(
  ownerId: string,
  ownerLabel: string,
  est: number,
  limit: number,
  /** The resolved force threshold (min(limit × 1.3, window − margin)) — named in the
   *  continuation note so the compacted agent (and its owner) see the real numbers. */
  forceAt: number = limit * FORCE_COMPACT_FRACTION,
  /** Which arm produced forceAt — the note words each regime differently. */
  bound: ForceBound = 'fraction',
): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    if (!(await getFlag(FLAGS.COMPACTION_WATCHDOG_FORCE_COMPACT, 'system'))) return false;
  } catch {
    return false; // flag infra unavailable ⇒ do NOT force (fail-safe)
  }
  try {
    const { findLiveHost, hostSupports, injectIntoHost } = await import(
      '../events/await/psu-pty-discovery'
    );
    const host = findLiveHost(ownerId);
    if (!host) return false;
    const ok = hostSupports(host, 'compact')
      ? await injectIntoHost(host.sock, {
          mode: 'compact',
          data: forceCompactContinueNote(est, limit, forceAt, bound),
          focus: FORCE_COMPACT_FOCUS,
        })
      : await injectIntoHost(host.sock, { mode: 'turn', data: `/compact ${FORCE_COMPACT_FOCUS}` });
    if (ok) {
      console.warn(
        `[compaction-watchdog] FORCE-COMPACTED ${ownerLabel} (${ownerId}) at ~${est}/${limit} tokens ` +
          `(${Math.round((est / limit) * 100)}% of the soft limit; force threshold ~${forceAt}) — ` +
          `injected /compact after it exhausted the self-compaction band (soft limit → force threshold; P-012).`,
      );
    }
    return ok;
  } catch (e) {
    console.warn(
      `[compaction-watchdog] force-compact inject failed (will retry): ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

/**
 * D-006 honor leg (context-trimming-tiers P-009): an EXPLICIT per-tier
 * compactionLimit rides the SPAWN RECORD and takes precedence over the
 * model-derived default — spawned_agents.model_tier resolved against the
 * workspace tier menu; a recorded model_spec still beats the fs/argv resolver
 * (a fleet bee's session settings.json rarely names the model). The child's
 * coord ownerId IS its spawnId (sessionOwner: spawnId in operator-spawn), so
 * the lookup keys on either column. Best-effort: null ⇒ resolver fallback.
 */
async function resolveSpawnRecordLimit(
  sql: Sql,
  ownerId: string,
  tierMenu: () => Promise<readonly ModelTier[] | undefined>,
  fleetMember = false,
): Promise<number | null> {
  try {
    const rows = await sql<{ model_spec: string | null; model_tier: string | null }[]>`
      SELECT model_spec, model_tier
        FROM harness_shared.spawned_agents
       WHERE spawn_id = ${ownerId} OR session_owner = ${ownerId}
       ORDER BY started_at DESC
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    if (row.model_tier) {
      const tiers = await tierMenu();
      const tier = tiers?.find((t) => t.name === row.model_tier);
      // parseTiers already clamped a stored explicit limit to the spec's window.
      if (tier?.compactionLimit != null) return tier.compactionLimit;
      if (tier?.spec) return defaultCompactionLimitForSpec(tier.spec, { fleetMember });
    }
    if (row.model_spec) return defaultCompactionLimitForSpec(row.model_spec, { fleetMember });
    return null;
  } catch {
    return null;
  }
}

/**
 * Best-effort hard-window resolve for the force-threshold cap, mirroring the
 * limit-seeding precedence (spawn record's spec/tier beats the fs/argv resolver —
 * a fleet bee's settings.json rarely names the model, and mis-reading a [1m]
 * member as 200k would silently collapse its force grace back to ~100%).
 * null ⇒ unknown window (caller falls back to the overshoot-factor bound).
 */
async function resolveWindowForOwner(
  sql: Sql,
  ownerId: string,
  tierMenu: () => Promise<readonly ModelTier[] | undefined>,
): Promise<number | null> {
  try {
    const rows = await sql<{ model_spec: string | null; model_tier: string | null }[]>`
      SELECT model_spec, model_tier
        FROM harness_shared.spawned_agents
       WHERE spawn_id = ${ownerId} OR session_owner = ${ownerId}
       ORDER BY started_at DESC
       LIMIT 1
    `;
    const row = rows[0];
    let spec = row?.model_spec ?? null;
    if (!spec && row?.model_tier) {
      const tiers = await tierMenu();
      spec = tiers?.find((t) => t.name === row.model_tier)?.spec ?? null;
    }
    spec ??= await resolveModelSpecForOwner(ownerId);
    return spec ? modelWindowForSpec(spec) : null;
  } catch {
    return null;
  }
}

export interface CompactionComplianceResult {
  /** owners whose estimate was refreshed this pass. */
  estimated: string[];
  /** owners currently over their compaction_limit. */
  overLimit: string[];
  /** P-012: over-limit owners the watchdog FORCE-COMPACTED this pass (injected
   *  /compact into their live psu-pty). Subset of overLimit — excludes owners still
   *  inside the FORCE_COMPACT_FRACTION grace band, with no live host, an
   *  already-in-flight force (deduped), or the flag OFF. */
  forceCompacted: string[];
  /** P-017: running sessions whose STALE-above-cap compaction_limit was lowered to
   *  the current shaped default this pass (a policy change reaching a live session
   *  without a relaunch). */
  relimited: Array<{ owner: string; from: number; to: number }>;
  /** owners seeded with a model-derived default limit this pass. */
  seeded: string[];
  /** P-019: owners whose transcript tail carries "Prompt is too long" (dead). */
  contextDeaths: string[];
  /** flush-to-proceed P-003: over-limit sessions holding a work-item claim whose checkpoint is
   *  stale (unflushed work about to be lost to a compaction/reclaim). SURFACED, never seized
   *  (D-008). One entry per (owner, stale claim). */
  unflushedClaims: Array<{ owner: string; workItemId: string; reason: StaleClaim['reason']; staleMs: number }>;
  /** P-018 boot self-assert: live members that FAILED the dark-telemetry assertion this pass —
   *  their context estimate never resolved (the gauge / per-turn reminder / force-compact are all
   *  blind to the session), so it can silently overflow. One entry per owner; escalated once per
   *  owner via escalateBootConfig. */
  bootConfigAlerts: Array<{ owner: string; kind: 'dark-telemetry'; detail: string }>;
}

/**
 * One pass: SEED a model-derived default limit into limit-less live sessions
 * (context-trimming-tiers P-006/D-006 — the hook that arms the whole
 * agent-managed-compaction loop: signal + self-compaction only engage for
 * limit-carrying sessions), then refresh + cache each limit-setting live
 * session's context estimate and flag any that ran past its own limit.
 * Never throws (best-effort backstop).
 */
export async function checkCompactionCompliance(sql: Sql): Promise<CompactionComplianceResult> {
  const out: CompactionComplianceResult = { estimated: [], overLimit: [], forceCompacted: [], relimited: [], seeded: [], contextDeaths: [], unflushedClaims: [], bootConfigAlerts: [] };
  // P-013 flag mirror: read FLAGS.CONTEXT_GAUGE once per pass and mirror it into the
  // in-process gauge switch the (sync) result-annotator reads. Best-effort — a flag-infra
  // hiccup leaves the previous value untouched (fail to the default-ON gauge).
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    setContextGaugeEnabled(await getFlag(FLAGS.CONTEXT_GAUGE, 'system'));
  } catch {
    /* keep the previous mirror value */
  }
  // Lazy per-pass tier menu, HOISTED so the seed pass AND the P-017 re-eval share ONE
  // workspace-config read: memoized, fail-soft to undefined (⇒ spec-derived defaults only).
  let tiersPromise: Promise<readonly ModelTier[] | undefined> | null = null;
  const tierMenu = () =>
    (tiersPromise ??= (async () => {
      try {
        const [{ effectiveTierConfig }, { readAgentConfig }] = await Promise.all([
          import('../fleet/model-tiers'),
          import('../agent-config'),
        ]);
        const cfg = await readAgentConfig().catch(() => null);
        return effectiveTierConfig(cfg, null).tiers;
      } catch {
        return undefined;
      }
    })());
  // Seeding step — one server-side place instead of N spawn paths (D-006).
  // Precedence: the spawn record (explicit tier limit > tier/recorded spec's
  // default) > the argv/fs model resolver (launch argv → session
  // settings.json) > the conservative 200k-window default (~158k). An agent's
  // own config:set-compaction-limit overwrites this at any time.
  try {
    // fleet_slug/fleet_role ride the presence row (mig 418 projection of
    // fleet_membership_events): a named-fleet MEMBER (any role but 'leader')
    // seeds the leaner [1m] member default (owner directive 2026-07-03) —
    // its state reconstructs cheaply from the work-item, so a smaller window
    // cuts per-wake cache spend; leaders keep the full default.
    const unseeded = await sql<
      { owner_id: string; fleet_slug: string | null; fleet_role: string | null }[]
    >`
      SELECT owner_id, fleet_slug, fleet_role
        FROM harness_shared.coord_presence
       WHERE compaction_limit IS NULL
         AND heartbeat_at > now() - interval '10 minutes'
       LIMIT ${MAX_SEEDS_PER_PASS}
    `;
    for (const r of unseeded) {
      try {
        const fleetMember = r.fleet_slug != null && r.fleet_role !== 'leader';
        const fromSpawn = await resolveSpawnRecordLimit(sql, r.owner_id, tierMenu, fleetMember);
        const limit =
          fromSpawn ??
          defaultCompactionLimitForSpec(await resolveModelSpecForOwner(r.owner_id), {
            fleetMember,
          });
        await setCompactionLimit(r.owner_id, limit);
        out.seeded.push(r.owner_id);
      } catch {
        /* best-effort per owner */
      }
    }
    if (out.seeded.length > 0) {
      console.log(`[compaction-watchdog] seeded default compaction limits for ${out.seeded.length} session(s)`);
    }
  } catch (e) {
    console.warn(
      `[compaction-watchdog] seed pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    const rows = await sql<
      {
        owner_id: string;
        owner_label: string;
        compaction_limit: number;
        fleet_slug: string | null;
        fleet_role: string | null;
      }[]
    >`
      SELECT owner_id, owner_label, compaction_limit, fleet_slug, fleet_role
        FROM harness_shared.coord_presence
       WHERE compaction_limit IS NOT NULL
         AND heartbeat_at > now() - interval '10 minutes'
    `;
    for (const r of rows) {
      // P-019 member-death detector: a "Prompt is too long" transcript tail means
      // the session is dead-but-still-beating — escalate once for relaunch. Runs
      // before the estimate gate (a dead session's estimate is exactly the kind
      // that looks "over limit" or fails to resolve).
      try {
        if (await detectContextDeathForOwner(r.owner_id)) {
          out.contextDeaths.push(r.owner_id);
          await escalateContextDeath(r.owner_id, r.owner_label);
          continue; // no point estimating/flagging a dead session
        }
      } catch {
        /* best-effort per owner */
      }
      // P-017 live-config reach: a stored limit ABOVE COMPACTION_LIMIT_DEFAULT_1M_CAP (the
      // ceiling clampCompactionLimit enforces on EVERY config:set-compaction-limit) cannot be a
      // valid explicit override — it is necessarily a STALE default from a superseded policy (the
      // 2026-07-04 incident: live members stuck at the old 500k after the cap dropped to 300k/400k,
      // with no way to push the fix short of a relaunch). Re-derive the current shaped default and
      // lower to it so a policy change reaches running sessions within one sweep. Cheap-gated on the
      // >cap check (steady-state passes resolve NOTHING) and one-directional (only lowers), so it
      // never clobbers an explicit lower override. Mutate r.compaction_limit so the over-limit gate
      // below re-checks against the corrected limit THIS pass (a now-over session force-compacts).
      if (r.compaction_limit > COMPACTION_LIMIT_DEFAULT_1M_CAP) {
        try {
          const fleetMember = r.fleet_slug != null && r.fleet_role !== 'leader';
          const fresh =
            (await resolveSpawnRecordLimit(sql, r.owner_id, tierMenu, fleetMember)) ??
            defaultCompactionLimitForSpec(await resolveModelSpecForOwner(r.owner_id), { fleetMember });
          if (fresh < r.compaction_limit) {
            await setCompactionLimit(r.owner_id, fresh);
            out.relimited.push({ owner: r.owner_id, from: r.compaction_limit, to: fresh });
            console.warn(
              `[compaction-watchdog] re-limited ${r.owner_label} (${r.owner_id}): ` +
                `${r.compaction_limit} → ${fresh} tokens — stale default above the current policy cap ` +
                `reached a live session without a relaunch (P-017).`,
            );
            r.compaction_limit = fresh;
          }
        } catch {
          /* best-effort per owner */
        }
      }
      const est = await estimateContextTokensForOwner(r.owner_id);
      if (est == null) {
        // P-018 boot self-assert (dark telemetry): a live limit-carrying session whose context
        // estimate never resolves is BLIND — the gauge, the per-turn reminder, and the P-012
        // force-compact backstop all read null, so it can silently overflow its model window
        // (the 836k incident class). Grace a few sweeps (a normal boot reads null briefly before
        // its transcript lands), then escalate once. A context-DEAD session (P-019 above) already
        // `continue`d, so this is a live-but-blind session, not a corpse.
        const streak = (nullEstimateStreak.get(r.owner_id) ?? 0) + 1;
        nullEstimateStreak.set(r.owner_id, streak);
        if (streak >= DARK_TELEMETRY_MAX_NULL_SWEEPS) {
          out.bootConfigAlerts.push({ owner: r.owner_id, kind: 'dark-telemetry', detail: `${streak} null sweeps` });
          await escalateBootConfig(
            r.owner_id,
            r.owner_label,
            'dark-telemetry',
            `${r.owner_label} has DARK context telemetry — its estimate has not resolved for ${streak} watchdog sweeps (~${streak * 2}min) since boot`,
            `estimateContextTokensForOwner returns null, so the context gauge, the per-turn usage reminder, and the force-compact backstop are ALL blind to this session — it can silently overflow its model window (the 2026-07-04 836k class). Usually a missing/unreadable transcript or an unresolved model spec. Check the session's transcript path + model resolution; relaunch if wedged. (agent-managed-compaction-2026-07-01 P-018)`,
          );
        }
        continue;
      }
      nullEstimateStreak.delete(r.owner_id); // estimate resolved — clear the dark-telemetry streak
      await setContextEstimate(r.owner_id, est).catch(() => {});
      // P-013/P-015: mirror the fresh estimate into the in-process gauge cache so the
      // result-annotator + native-tool hook render the banded gauge with ZERO per-call
      // DB cost (the watchdog is the single writer; readers never touch PG).
      recordContextUsage(r.owner_id, est, r.compaction_limit);
      out.estimated.push(r.owner_id);
      if (est >= r.compaction_limit * OVER_LIMIT_FRACTION) {
        out.overLimit.push(r.owner_id);
        // flush-to-proceed P-003 SURFACE (not seize, D-008): a session over its compaction limit
        // that holds a work-item whose CHECKPOINT is stale is about to lose unflushed work to the
        // imminent compaction/reclaim — the exact failure the discipline targets. Name it (reusing
        // the P-002 classifier over a fleet-wide freshness read on the watchdog's own sql seam) so
        // the loss is visible in the over-limit warning + the result. Best-effort; auto-reclaim is
        // deliberately NOT wired here. Owner is a globally-unique session uuid ⇒ null workspace.
        let unflushed: StaleClaim[] = [];
        try {
          const fresh = await listActiveClaimFreshnessForOwner(null, r.owner_id, { sql });
          unflushed = classifyStaleClaims(fresh, Date.now());
          for (const s of unflushed) {
            out.unflushedClaims.push({ owner: r.owner_id, workItemId: s.workItemId, reason: s.reason, staleMs: s.staleMs });
          }
        } catch {
          /* best-effort per owner */
        }
        if (!overLimitOwners.has(r.owner_id)) {
          overLimitOwners.add(r.owner_id);
          const flushNote =
            unflushed.length > 0
              ? ` HOLDING UNFLUSHED WORK: ${unflushed.map((s) => s.workItemId).join(', ')} — its checkpoint is stale, so a compaction/reclaim here loses that state (flush-to-proceed P-003).`
              : '';
          console.warn(
            `[compaction-watchdog] ${r.owner_label} (${r.owner_id}) is over its compaction limit: ` +
              `~${est}/${r.compaction_limit} tokens (${Math.round((est / r.compaction_limit) * 100)}%) — ` +
              `should have called session:request_compaction.${flushNote}`,
          );
        }
        // P-012 L2 mechanical backstop — but only past the FORCE grace band
        // (owner 2026-07-04): warned at 100%, forced at min(limit × 1.3,
        // window − margin). Deduped per crossing; a failed/hostless/under-band
        // attempt is NOT recorded, so it retries next pass until it lands (or
        // the session recovers below).
        if (!forceCompactedOwners.has(r.owner_id)) {
          const window = await resolveWindowForOwner(sql, r.owner_id, tierMenu);
          const fractionAt = r.compaction_limit * FORCE_COMPACT_FRACTION;
          const capAt =
            window != null
              ? window - COMPACTION_WINDOW_MARGIN_TOKENS
              : r.compaction_limit * COMPACTION_OVERSHOOT_FACTOR;
          const forceAt = Math.min(fractionAt, capAt);
          const bound: ForceBound =
            fractionAt <= capAt ? 'fraction' : window != null ? 'window' : 'overshoot';
          if (
            est >= forceAt &&
            (await maybeForceCompact(r.owner_id, r.owner_label, est, r.compaction_limit, forceAt, bound))
          ) {
            forceCompactedOwners.add(r.owner_id);
            out.forceCompacted.push(r.owner_id);
          }
        }
      } else {
        overLimitOwners.delete(r.owner_id); // recovered (compacted / back under limit)
        forceCompactedOwners.delete(r.owner_id); // re-arm the force for a future crossing
      }
    }
  } catch (e) {
    console.warn(
      `[compaction-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return out;
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the compaction-compliance watchdog: a recurring process-level sweep.
 * Idempotent. Kill-switch: PAPERCUSP_COMPACTION_WATCHDOG='0'.
 */
export function startCompactionComplianceWatchdog(
  sql: Sql,
  opts: { intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_COMPACTION_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval(
    'compaction-compliance-watchdog',
    intervalMs,
    () => {
      void checkCompactionCompliance(sql);
    },
    { category: 'watchdog' },
  );
}
