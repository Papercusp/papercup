/**
 * The Queen decision-ledger ACTION-CHOKEPOINT emit — agent-capability-confinement-2026-06-13
 * B-06 (P-011) ⨯ queen-autonomy-policy-2026-06-13 D-012 / P-110.
 *
 * One compressed row per GOVERNED action, written from the shared endpoint dispatch
 * `postInvoke` seam (best-effort, fire-and-forget, never blocks/breaks the trigger — same
 * contract as the event-reaction postInvoke). "Complete for actions by construction" once
 * capability-confinement lands: every governed action MUST pass dispatch.
 *
 * This is a DIFFERENT projection from `harness_shared.tool_invocations` (which records
 * EVERY call incl. reads). The ledger keeps only:
 *   - GOVERNED actions — `tier != 'low'` (reads are not governance actions, D-003);
 *   - by NON-superuser principals — SU = supervised human, not autonomous Queen activity (D-002);
 * and adds the decision-semantics columns (posture / category / why / links + the
 * NULLABLE risk_tier·reversibility·authority the autonomy briefs B-01/B-02/B-04 populate).
 *
 * The DECIDER-DISPOSITION layer (queen-autonomy P-111), the ledger SURFACE (P-113), and
 * the back-fill of model-tier/gym-judge/budget (P-112) are queen-autonomy B-13 — they
 * CONSUME these rows; B-06 produces them.
 *
 * Default-ON (`papercusp-decision-ledger`): pure additive record-keeping, no LLM spend, a
 * subset of tool_invocations — the same Phase-0-foundation call as `papercusp-change-ledger`
 * (the rows must accumulate before B-13's surface + the autonomy gate consume them). The
 * flag is the kill-switch.
 */

import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { papercuspTierFor, type CapabilityTier, type PostInvokeEvent } from '@papercusp/agent-mcp';

const TIER_RANK: Record<CapabilityTier, number> = { low: 0, medium: 1, high: 2 };

/** Fire-and-forget entry point wired into PROJECTED_DEPS.postInvoke. Never throws. */
export function recordDecisionLedger(event: PostInvokeEvent): void {
  void recordDecisionLedgerImpl(event).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn(`[decision-ledger] emit failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function recordDecisionLedgerImpl(event: PostInvokeEvent): Promise<void> {
  const { ctx, toolName, result, durationMs } = event;
  if (!ctx.workspaceId) return;
  // SU = supervised human driving directly, not the autonomous Queen/fleet (D-002).
  if (ctx.isSuperuser) return;

  const caps = event.capabilities ?? [];
  // No declared capability ⇒ a public/ungated utility — not a classifiable governed action.
  if (caps.length === 0) return;
  const tier = highestTier(caps);
  // Reads (tier 'low') are execution, not governance — they belong in tool_invocations only.
  if (tier === 'low') return;

  // Kill-switch (checked AFTER the cheap governed-action filter so a disabled ledger costs
  // nothing on the read-heavy bulk of traffic). getFlag is cached (no per-call network).
  if (!(await getFlag(FLAGS.DECISION_LEDGER, 'system'))) return;

  const verdict = event.envelopeVerdict ?? null;
  const posture = verdict?.posture ?? 'auto';
  const primaryCap = caps[0] ?? null;
  const category = categoryFor(primaryCap, toolName);
  const outcome = result.ok ? 'ok' : 'error';
  const outcomeCode = result.ok ? null : (result.error?.code ?? null);
  const why = verdict?.reason ?? null;
  const links = buildLinks(ctx);
  const argsDigest = digestArgs(event.args);

  try {
    const { sql } = getOrgPg();
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [ctx.workspaceId]);
      await tx.unsafe(
        `INSERT INTO harness_shared.decision_ledger
           (workspace_id, harness_slug, action, capability, tier, category,
            posture, outcome, outcome_code, why, links,
            actor_role, actor_spawn_id, actor_principal, transport, duration_ms, args_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17)`,
        [
          ctx.workspaceId,
          ctx.harnessSlug ?? null,
          toolName,
          primaryCap,
          tier,
          category,
          posture,
          outcome,
          outcomeCode,
          why,
          links ? JSON.stringify(links) : null,
          ctx.role ?? null,
          ctx.spawnId ?? null,
          ctx.principal?.slug ?? null,
          ctx.transport ?? null,
          Number.isFinite(durationMs) ? Math.round(durationMs) : null,
          argsDigest,
        ],
      );
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[decision-ledger] insert failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function highestTier(capabilities: readonly string[]): CapabilityTier {
  let best: CapabilityTier = 'low';
  for (const cap of capabilities) {
    const t = papercuspTierFor(cap);
    if (TIER_RANK[t] > TIER_RANK[best]) best = t;
  }
  return best;
}

/**
 * Coarse functional-domain category: the capability group (the token before the first
 * ':'), e.g. `plans:write` → `plans`, `fleet:spawn` → `fleet`. The AUTHORITATIVE
 * 13-category taxonomy + capability→category map is queen-autonomy B-04 (P-015 / P-020);
 * this is the best-effort placeholder until that lands.
 */
function categoryFor(capability: string | null, toolName: string): string | null {
  const src = capability ?? toolName;
  const sep = src.indexOf(':');
  if (sep > 0) return src.slice(0, sep);
  const dot = src.indexOf('.');
  if (dot > 0) return src.slice(0, dot);
  return src || null;
}

/** Provenance links — enough to drill from a ledger row to its run/transcript. */
function buildLinks(ctx: PostInvokeEvent['ctx']): Record<string, unknown> | null {
  const links: Record<string, unknown> = {};
  if (ctx.runId) links.runId = ctx.runId;
  if (ctx.spawnId) links.spawnId = ctx.spawnId;
  if (ctx.parentSpawnId) links.parentSpawnId = ctx.parentSpawnId;
  if (ctx.featureId) links.featureId = ctx.featureId;
  if (ctx.chunkId) links.chunkId = ctx.chunkId;
  if (ctx.uiClientId) links.uiClientId = ctx.uiClientId;
  if (ctx.reactionCause) links.reaction = ctx.reactionCause;
  return Object.keys(links).length > 0 ? links : null;
}

/**
 * A privacy-preserving digest of the call args: the sorted top-level key names only (never
 * the values — those live in tool_invocations.args_json). Shows the call SHAPE in the
 * ledger without duplicating payloads.
 */
function digestArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const keys = Object.keys(args as Record<string, unknown>).sort();
  if (keys.length === 0) return null;
  const joined = keys.join(',');
  return joined.length > 512 ? `${joined.slice(0, 509)}...` : joined;
}
