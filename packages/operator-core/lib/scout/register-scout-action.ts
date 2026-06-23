/**
 * register-scout-action.ts — Scout's PRODUCTION cycle runner provider
 * (cb4b9's buildScoutCycleDeps + runScoutCycle), supplying the three
 * irreducibly-injected deps a Scout cycle owns:
 *
 * RETIRED the bespoke `system:scout-cycle` action (deterministic-blueprints-migration
 * -2026-06-13 P-130): scout now runs as the `scout` BLUEPRINT — its seed fires
 * `system:blueprint-run {blueprintId:'scout'}` → the `scout:cycle` deterministic step
 * → `runScoutCycleTick` (which calls `productionScoutRunner` below). This module no
 * longer registers a system action; it stays as the home of `productionScoutRunner`
 * (the scout:cycle op's production cycle deps) + noopArchive/setScoutArchiveBuilder.
 * Injected deps:
 *
 *   - llmCall — the real stateless LLM client (lib/llm-testing/llm-client; it satisfies
 *     ScoutLlmCall directly via the gym:judge pattern). Lazily imported so a boot
 *     that only REGISTERS the action never loads the llm-client graph (the gym's
 *     ab-run pattern); it loads on the first real cycle.
 *   - createPlanDraft — the system-side `plans:new` DRAFT creator (scout-plan-draft).
 *   - archive — the gym-QD ArchivePort. P-012 production wire: built per cycle from
 *     su-8075f's real archive via {@link buildScoutArchivePort} (snapshot→seed→flush),
 *     so the gym (testable) rail seeds Scout's distant ideas into the MAP-Elites
 *     archive. Falls back to a NO-OP if the archive is unavailable (e.g. PG/migration
 *     193 absent) — the broad + concrete rails are unaffected.
 *
 * No side-effect registration: the scout blueprint's deterministic step
 * (`blueprint-steps/ops/scout-cycle.ts`) imports `productionScoutRunner` directly.
 * The per-hive scout routine is provisioned INACTIVE at hive:create
 * (lib/hive/provision-learning-loop.ts) — bring-up human-gated (D-002).
 */

import { type ScoutCycleRunner } from './scout-cycle-action';
import { runScoutCycle } from './cycle';
import { buildScoutCycleDeps } from './cycle-deps';
import { createScoutPlanDraft } from './scout-plan-draft';
import { buildScoutArchivePort, type ScoutArchivePort } from './scout-archive-port';
import { nicheKey, type ArchivePort } from './gym-bridge';
import { scoutCoordOwnerId } from './coord-identity';
import { runScoutRevisionCycle } from './revise';
import {
  notifyQueenDraftRouted,
  notifyQueenRevised,
  type QueenNotifyMessage,
  type QueenNotifyPorts,
} from './queen-notify';

/**
 * Placeholder gym-QD archive used when the real archive can't be built (PG down /
 * migration 193 absent). Reads empty + admits nothing, so the gym-seed rail is a
 * safe no-op (the broad/concrete rails are unaffected).
 */
export const noopArchive: ScoutArchivePort = {
  listElites: () => [],
  seed: (entry) => ({ admitted: false, nicheKey: nicheKey(entry.descriptor.coords) }),
  flush: async () => {},
};

/** Builds the per-cycle ArchivePort for a harness (overridable for tests / alternate stores). */
export type ScoutArchiveBuilder = (scope: { workspaceId: string; harnessSlug: string }) => Promise<ArchivePort>;

const defaultArchiveBuilder: ScoutArchiveBuilder = (scope) => buildScoutArchivePort(scope);

let activeArchiveBuilder: ScoutArchiveBuilder = defaultArchiveBuilder;

/** Swap the archive builder (a test, or an alternate gym-QD store). */
export function setScoutArchiveBuilder(builder: ScoutArchiveBuilder): void {
  activeArchiveBuilder = builder;
}

/** Build the cycle's archive, degrading to the no-op if the real one is unavailable. */
async function resolveArchive(scope: { workspaceId: string; harnessSlug: string }): Promise<ArchivePort> {
  try {
    return await activeArchiveBuilder(scope);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[register-scout-action] archive unavailable — gym rail no-ops this cycle:', err instanceof Error ? err.message : err);
    return noopArchive;
  }
}

/**
 * The production Scout cycle runner the `system:scout-cycle` action invokes:
 * assembles cb4b9's cycle deps with the real llmCall + the system-side plan-draft
 * creator + the per-cycle archive, runs one budgeted cycle, then flushes any
 * buffered scout seeds to the archive (P-012).
 */
export const productionScoutRunner: ScoutCycleRunner = async ({ harnessSlug, workspaceId, budget, cycleId, scoutConfig, queenFeedback }) => {
  // FB-16 PARITY (the gym's `gym-cycle-inprocess-llm-bypasses-gateway` insight, applied to
  // Scout): Scout's IN-PROCESS ideator/critic/recombine llmCalls are anthropic-direct and
  // never pass the spawn chokepoint that patches `ANTHROPIC_BASE_URL` onto bee subprocesses —
  // so (unlike bees) they egress STRAIGHT to api.anthropic.com on a SINGLE account. Under the
  // busy fleet that account is perpetually at its Anthropic limit → every ideator 429s → the
  // cycle returns `no-ideas` with $0 spent. That is why the @singleton Scout produced 0 ideas
  // across 49/49 ticks since the 2026-06-14 re-scope (root-caused 2026-06-18). When the
  // INFERENCE_GATEWAY flag is on, point the in-process SDK (PAPERCUSP_ANTHROPIC_URL) AND any
  // claude-CLI subprocess (ANTHROPIC_BASE_URL) at the localhost pacing gateway so Scout
  // load-balances across the bound pool accounts exactly like the gym (autoloop-cycle.ts) and
  // the fleet. Flag-OFF → unchanged direct egress; a pre-set override is respected.
  const { FLAGS } = await import('@papercusp/flags');
  const { getFlag } = await import('@papercusp/flags/server');
  if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
    const { gatewayLlmEnv } = await import('../inference-gateway/spawn-env');
    for (const [k, v] of Object.entries(gatewayLlmEnv(true))) {
      if (!process.env[k]) process.env[k] = v;
    }
  }

  const { llmCall: rawLlmCall } = await import('../llm-testing/llm-client');
  const { DEFAULT_WORKSPACE_ID } = await import('../workspace-id-constant');

  // Gateway admission-tier label (gateway-priority-tiers-2026-06-22): stamp every
  // in-process Scout LLM call (ideators/critics/recombine/revise) with the `scout`
  // role so the localhost pacing gateway routes it through TIER 1 — the protected,
  // reserved-floor lane the map already assigns to scout/queen/overwatch/interactive
  // (DEFAULT_GATEWAY_PRIORITY_MAP). Until this, the FB-16 fix pointed the in-process
  // SDK at the gateway (gatewayLlmEnv) but never identified the caller, so Scout's 8
  // ideators arrived UNTIERED → the lowest `default` band (tier 4), which the AIMD
  // shrink sheds FIRST under fleet load → all 8 bailed every fire ("rate-limit pause
  // exceeds maxWait"), 0 ideas for 12 days while bees (tier 3) crowded the pool.
  const llmCall: typeof rawLlmCall = (o) => rawLlmCall({ ...o, priority: 'scout' });

  // ── Queen↔Scout feedback loop (queen-scout-feedback-loop-2026-06-20) ──────────
  // Scout's coord identity (P-003) + the two Scout→Queen ping ports (queen-notify).
  // The coord/PG/ALS edge is lazily imported inside the closures so a boot that
  // only references the runner never loads it; best-effort everywhere (a notify
  // can never break ideation/revision).
  const scoutOwner = scoutCoordOwnerId(harnessSlug);
  const queenSend = async (msg: QueenNotifyMessage): Promise<void> => {
    const { sendMessage } = await import('../agent-tools/coordination/messages');
    const { runWithWorkspace } = await import('../workspace-als');
    const identity = {
      ownerId: scoutOwner,
      ownerLabel: `scout · ${harnessSlug}`,
      source: 'principal' as const,
      workspaceId,
      userId: null,
    };
    await runWithWorkspace(workspaceId, () =>
      sendMessage(identity, {
        to: msg.to,
        summary: msg.summary,
        body: msg.body,
        plan_slug: msg.planSlug,
        harnessSlug,
      }),
    );
  };
  const queenNotifyPorts: QueenNotifyPorts = {
    // resolveQueenOwner takes workspaceId explicitly (no ALS needed); the routine's
    // ctx workspace is where the hive's adv_sessions / coord live (NOT the DEFAULT
    // plan workspace the drafts are pinned to).
    resolveQueenOwner: async () => {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { resolveQueenOwner } = await import('../hive/placement-watchdog');
      const { sql } = getOrgPg();
      return resolveQueenOwner(sql, workspaceId, harnessSlug);
    },
    send: queenSend,
  };

  // P-001: a queen-feedback tick runs a TARGETED revision of the Queen's draft(s)
  // — NOT a fresh ideation cycle (which would route NEW plans, starving the loop).
  // Same gateway-routed llmCall (FB-16 parity above applies). Pings the Queen back
  // per draft so she re-reviews (D-001 step 3). Returns a cycle-shaped result the
  // scheduler ledgers + acks (the scheduler only acks on a non-throwing return).
  if (queenFeedback && queenFeedback.length > 0) {
    const result = await runScoutRevisionCycle(queenFeedback, {
      llmCall,
      planWorkspaceId: DEFAULT_WORKSPACE_ID,
      harnessSlug,
    });
    try {
      await notifyQueenRevised(queenNotifyPorts, result.revisions);
    } catch {
      /* best-effort — a ping-back failure never fails the revision tick */
    }
    return result;
  }

  const archive = await resolveArchive({ workspaceId, harnessSlug });
  const deps = buildScoutCycleDeps({
    harnessSlug,
    llmCall,
    // Draft plans are pinned to the DEFAULT workspace, NOT the routine's ctx
    // workspace: the whole plan surface (plans:* dispatch, Create tab, plan
    // projections) lives under 'default', so a draft written under the
    // routine's 'papercusp-workspace' is invisible to every plan UI/read
    // (live miss 2026-06-11 — 3 routed drafts stranded). The routed-idea
    // LEDGER row keeps the ctx workspace (learning.scout reads it there).
    // route→coord:send (D-003 #1): a NEWLY-routed draft pings the Queen so she
    // reviews it — this is what STARTS the feedback loop. Only on `created` (a
    // re-derived/idempotent existing slug is not re-announced). Best-effort: the
    // ping never fails the routing path.
    createPlanDraft: async (args) => {
      const res = await createScoutPlanDraft({ ...args, harnessSlug, workspaceId: DEFAULT_WORKSPACE_ID });
      if (res.created) {
        try {
          await notifyQueenDraftRouted(queenNotifyPorts, { slug: res.slug, title: args.title, scoutOwner });
        } catch {
          /* best-effort — a notify never breaks routing */
        }
      }
      return res;
    },
    archive,
    limits: { maxCostUsd: budget.maxCostUsd, maxIdeators: budget.maxIdeators },
    cycleId,
    // P-009: per-blueprint Scout tuning (lenses/novelty/buckets/routing). Undefined ⇒
    // buildScoutCycleDeps falls back to DEFAULT_SCOUT_CONFIG (behavior-neutral).
    ...(scoutConfig ? { scoutConfig } : {}),
  });
  try {
    return await runScoutCycle(deps);
  } finally {
    // Persist scout seeds (P-012) even if the cycle threw mid-route.
    if (isFlushable(archive)) {
      try {
        await archive.flush();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[register-scout-action] archive flush failed:', err instanceof Error ? err.message : err);
      }
    }
  }
};

function isFlushable(a: ArchivePort): a is ScoutArchivePort {
  return typeof (a as ScoutArchivePort).flush === 'function';
}

// No self-registration: `system:scout-cycle` is RETIRED (P-130). Scout runs via the
// `scout` blueprint; the scout:cycle op imports `productionScoutRunner` above.
