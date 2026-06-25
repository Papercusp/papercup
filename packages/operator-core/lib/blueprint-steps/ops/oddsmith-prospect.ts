/**
 * `oddsmith:prospect` — the oddsmith market-prospector cadence as a papercusp
 * DETERMINISTIC blueprint step (the producer that feeds the `bet-analysis`
 * backlog the `oddsmith-ops` Queen/bee hive drains).
 *
 * WHY THIS LIVES HERE (the contract-mirror + read-bridge seam).
 * The sweep's *logic* is repo-owned by `@oddsmith/prospector` (`prospectSweep`,
 * `selectCandidates`, `rankCandidates`) — pure, no DB. The op CONTRACT (name,
 * args, the `bet-analysis` work_item payload) is owned by that repo's
 * `packages/prospector/src/op.ts`. This file is the framework half the oddsmith
 * design always called for: a CoordOp registered in operator-core so
 * `blueprint:validate` resolves `oddsmith:prospect` and the `oddsmith-prospector`
 * program blueprint runs durably as a checkpointed DBOS step — WITHOUT
 * operator-core importing `@oddsmith/*` (separate repo + separate DB).
 *
 * THE SPLIT (build-on-papercusp, audit 2026-06-25). The op owns every
 * papercusp-side concern and reuses papercusp primitives:
 *   • dedup — the cross-tick `alreadyQueued` set is read from papercusp
 *     `work_items` (the bet-analysis backlog), not an oddsmith table;
 *   • enqueue — each surviving candidate becomes a papercusp `work_items` row
 *     (`createWorkItem`, generic `kind:'task'` + the `bet-analysis` domain
 *     payload), so the oddsmith-ops Queen places it like any other work;
 *   • durability — running as a CoordOp means `coordProgramWorkflow` checkpoints
 *     the step for free.
 * The ONE domain-owned seam is the LIVE MARKET READ (`listMarkets` over the
 * Kalshi / Polymarket connectors + the structural idle/cost gate): that code +
 * credentials live in the oddsmith engine, so it is injected as a `bridge` port
 * rather than linked. The oddsmith install wires the production bridge via
 * `setOddsmithProspectDeps`; unconfigured, the op fails fast with a clear error
 * (the cron is seeded INACTIVE / `singletonActive:false`, so this never fires
 * silently). This is the same DI shape every deterministic op uses (cf.
 * `scout-cycle.ts`'s `_deps`).
 *
 * Blueprint spine step (`blueprints/oddsmith-prospector/blueprint.yaml`):
 *   op: oddsmith:prospect
 *   args: { limit: "{{ payload.limit }}", minLiquidity: "{{ payload.minLiquidity }}" }
 */
import { z } from 'zod';
import type { CoordOp, CoordOpCtx } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';

/** The domain kind the analyst pipeline consumes (mirrors `@oddsmith/prospector`). */
export const BET_ANALYSIS_KIND = 'bet-analysis';
/** The generic live work_items kind that carries a bet-analysis job. */
export const BET_ANALYSIS_WORK_ITEM_KIND = 'task';

/**
 * Raw args as the blueprint spine delivers them (post-interpolation). An unfilled
 * `{{ payload.x }}` template arrives as the literal template string or `""`; the
 * schema is tolerant (string | number | bool | null) and `parseProspectArgs`
 * coerces "unset" → absent, mirroring `@oddsmith/prospector`'s
 * `parseProspectSweepArgs` so the blueprint can pass overrides without every tick
 * supplying them.
 */
const args = z
  .object({
    limit: z.union([z.number(), z.string()]).nullish(),
    minLiquidity: z.union([z.number(), z.string()]).nullish(),
    maxEnqueue: z.union([z.number(), z.string()]).nullish(),
    preferNiche: z.union([z.boolean(), z.string()]).nullish(),
  })
  .passthrough();

/** Per-tick telemetry the op binds — the papercusp-visible subset of the sweep result. */
const result = z.object({
  /** Markets listed across all venues this tick. */
  swept: z.number().int(),
  /** Markets matching ≥1 structural reason (before dedup). */
  candidates: z.number().int(),
  /** Distinct, not-already-queued candidates (after intra-tick + backlog dedup). */
  deduped: z.number().int(),
  /** work_items actually created this tick (≤ cap; 0 when the gate withheld). */
  enqueued: z.number().int(),
  /** Deduped candidates dropped by the cap. */
  capped: z.number().int(),
  /** True iff the structural idle/cost gate withheld enqueue this tick. */
  gated: z.boolean(),
  /** The gate's reason, when it withheld. */
  gateReason: z.string().optional(),
  /** Markets listed per venue (a `listMarkets` failure leaves the venue absent). */
  byVenue: z.record(z.string(), z.number()),
  /** Per-venue list failures + per-item enqueue failures (all caught). */
  errors: z.number().int(),
  /** The `${venue}:${ticker}` keys enqueued this tick. */
  enqueuedKeys: z.array(z.string()),
});

export type ProspectArgs = z.infer<typeof args>;
export type ProspectResult = z.infer<typeof result>;

/** A candidate the bridge selected to enqueue — the up-going `(venue,ticker)` key + why. */
export interface ProspectCandidate {
  venue: string;
  ticker: string;
  reasons: string[];
}

/** The parsed, coerced sweep knobs handed to the bridge. */
export interface ParsedProspectOptions {
  limit?: number;
  minLiquidity?: number;
  maxEnqueue?: number;
  preferNiche?: boolean;
}

/**
 * The result of one engine sweep, MINUS the enqueue (the op does the enqueue into
 * papercusp `work_items`). The bridge runs `@oddsmith/prospector`'s `prospectSweep`
 * with the live connectors + idle/cost gate, deduped against `alreadyQueued`,
 * ranked + capped, and returns the candidates to enqueue plus telemetry.
 */
export interface ProspectBridgeResult {
  toEnqueue: ProspectCandidate[];
  swept: number;
  candidates: number;
  deduped: number;
  capped: number;
  gated: boolean;
  gateReason?: string;
  byVenue: Record<string, number>;
  /** Per-venue list failures inside the engine sweep (enqueue errors are tallied op-side). */
  errors: number;
}

/**
 * The LIVE MARKET READ seam — the one piece operator-core cannot own (connector
 * code + venue credentials live in the oddsmith engine). The production adapter
 * runs the engine's `prospectSweep` (enqueue collected to an array, not fired)
 * and returns the candidates; the op enqueues them into papercusp `work_items`.
 */
export type OddsmithProspectBridge = (input: {
  options: ParsedProspectOptions;
  /** `${venue}:${ticker}` keys already in the bet-analysis backlog (cross-tick dedup). */
  alreadyQueued: string[];
  ctx: { workspaceId: string; harnessSlug: string };
}) => Promise<ProspectBridgeResult>;

/** Read the bet-analysis backlog's `${venue}:${ticker}` keys for cross-tick dedup. */
export type ListAlreadyQueued = (ctx: {
  workspaceId: string;
  harnessSlug: string;
}) => Promise<string[]>;

/** Enqueue one candidate as a papercusp `work_items` row; returns the new id. */
export type EnqueueProspectCandidate = (
  candidate: ProspectCandidate,
  ctx: { workspaceId: string; harnessSlug: string },
) => Promise<{ id: string }>;

export interface OddsmithProspectDeps {
  bridge: OddsmithProspectBridge;
  listAlreadyQueued: ListAlreadyQueued;
  enqueue: EnqueueProspectCandidate;
}

/**
 * Coerce one raw arg → a finite, non-negative number, or `undefined` for anything
 * that should mean "unset" (empty string, an un-substituted `{{…}}` template,
 * null/undefined, NaN, < 0). Mirrors `@oddsmith/prospector`'s `coerceNumber`.
 */
function coerceNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '' || s.includes('{{')) return undefined;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  return undefined;
}

/** Coerce a boolean arg (bool or `"true"`/`"false"`/`"yes"`/…), `undefined` for unset. */
function coerceBoolean(v: unknown): boolean | undefined {
  if (v == null) return undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '' || s.includes('{{')) return undefined;
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
  }
  return undefined;
}

/** Coerce blueprint-interpolated args → the engine's sweep options (mirror of the contract). */
export function parseProspectArgs(raw: ProspectArgs | null | undefined): ParsedProspectOptions {
  const r = (raw ?? {}) as Record<string, unknown>;
  const options: ParsedProspectOptions = {};
  const limit = coerceNumber(r.limit);
  if (limit != null) options.limit = limit;
  const minLiquidity = coerceNumber(r.minLiquidity);
  if (minLiquidity != null) options.minLiquidity = minLiquidity;
  const maxEnqueue = coerceNumber(r.maxEnqueue);
  if (maxEnqueue != null) options.maxEnqueue = maxEnqueue;
  const preferNiche = coerceBoolean(r.preferNiche);
  if (preferNiche != null) options.preferNiche = preferNiche;
  return options;
}

/** `${venue}:${ticker}` — the cross-tick dedup key (mirror of `candidateKey`). */
export function candidateKey(c: { venue: string; ticker: string }): string {
  return `${c.venue}:${c.ticker}`;
}

/**
 * The default production `enqueue` — one papercusp `work_items` row per candidate,
 * generic `kind:'task'` carrying the `bet-analysis` domain payload (mirrors
 * `@oddsmith/prospector`'s `betAnalysisWorkItemCreateInput`). The item lands
 * UNCLAIMED; the oddsmith-ops Queen places it onto an analyst bee.
 */
async function productionEnqueue(
  candidate: ProspectCandidate,
  ctx: { workspaceId: string; harnessSlug: string },
): Promise<{ id: string }> {
  const { createWorkItem } = await import('../../work-items.js');
  const marketKey = candidateKey(candidate);
  const reasons = candidate.reasons ?? [];
  const reasonSummary = reasons.length > 0 ? reasons.join(', ') : 'prospector-candidate';
  const item = await createWorkItem({
    kind: BET_ANALYSIS_WORK_ITEM_KIND,
    title: `Analyze prediction market ${marketKey}`,
    summary:
      `Prospector flagged ${marketKey} for bet-analysis (${reasonSummary}). ` +
      `Run the bet-analysis analyst pipeline and complete with a Signal payload.`,
    harness: ctx.harnessSlug,
    workspaceId: ctx.workspaceId,
    createdBy: 'oddsmith:prospect',
    payload: {
      domainKind: BET_ANALYSIS_KIND,
      blueprintId: BET_ANALYSIS_KIND,
      input: { venue: candidate.venue, ticker: candidate.ticker },
      venue: candidate.venue,
      ticker: candidate.ticker,
      reasons,
    },
  });
  return { id: item.id };
}

/**
 * The default production `alreadyQueued` reader — the bet-analysis backlog's
 * `${venue}:${ticker}` keys, drawn straight from papercusp `work_items` (the
 * dedup substrate is papercusp's, not oddsmith's). Open items only: a completed /
 * closed analysis should be re-proposable on a later tick.
 */
async function productionListAlreadyQueued(ctx: {
  workspaceId: string;
  harnessSlug: string;
}): Promise<string[]> {
  const { listWorkItems } = await import('../../work-items.js');
  const items = await listWorkItems({
    harness: ctx.harnessSlug,
    kind: BET_ANALYSIS_WORK_ITEM_KIND,
    state: 'open',
    limit: 5000,
  });
  const keys: string[] = [];
  for (const item of items) {
    const payload = (item as { payload?: unknown }).payload as
      | { domainKind?: unknown; venue?: unknown; ticker?: unknown }
      | undefined;
    if (!payload || payload.domainKind !== BET_ANALYSIS_KIND) continue;
    if (typeof payload.venue === 'string' && typeof payload.ticker === 'string') {
      keys.push(`${payload.venue}:${payload.ticker}`);
    }
  }
  return keys;
}

/** The unconfigured-bridge default — fail fast and tell the operator how to wire it. */
const unconfiguredBridge: OddsmithProspectBridge = async () => {
  throw new Error(
    'oddsmith:prospect bridge not configured — the live market read (Kalshi/Polymarket ' +
      'listMarkets + idle gate) lives in the oddsmith engine. The oddsmith install must wire ' +
      'it via setOddsmithProspectDeps({ bridge }). The oddsmith-prospector cron is seeded ' +
      'INACTIVE (singletonActive:false), so this never fires until both the cron is armed and ' +
      'the bridge is wired.',
  );
};

/**
 * Test / install seam — inject the live-read bridge (and, in tests, the
 * work_items ports). `null` ⇒ the production wiring: papercusp `work_items` for
 * dedup + enqueue, and the unconfigured bridge (which errors until the oddsmith
 * install supplies one). Mirrors `scout-cycle.ts`'s `_deps`.
 */
let _deps: OddsmithProspectDeps | null = null;
export function setOddsmithProspectDeps(deps: Partial<OddsmithProspectDeps> | null): void {
  if (deps === null) {
    _deps = null;
    return;
  }
  _deps = {
    bridge: deps.bridge ?? unconfiguredBridge,
    listAlreadyQueued: deps.listAlreadyQueued ?? productionListAlreadyQueued,
    enqueue: deps.enqueue ?? productionEnqueue,
  };
}

function resolveDeps(): OddsmithProspectDeps {
  return (
    _deps ?? {
      bridge: unconfiguredBridge,
      listAlreadyQueued: productionListAlreadyQueued,
      enqueue: productionEnqueue,
    }
  );
}

export const oddsmithProspectOp: CoordOp<ProspectArgs, ProspectResult> = {
  name: 'oddsmith:prospect',
  description:
    'Deterministic step: run one oddsmith market-prospector tick — read live Kalshi/Polymarket ' +
    'markets (engine bridge), select+rank candidates worth pricing, dedup against the ' +
    'bet-analysis backlog, and enqueue one papercusp work_item per survivor for the oddsmith-ops ' +
    'analyst hive. Read-only + propose-only: never trades.',
  argsSchema: args,
  resultSchema: result,
  async run(a: ProspectArgs, ctx: CoordOpCtx): Promise<ProspectResult> {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('oddsmith:prospect requires ctx.workspaceId');
    const harnessSlug = ctx.harnessSlug ?? 'oddsmith-ops';
    const deps = resolveDeps();
    const bridgeCtx = { workspaceId, harnessSlug };
    const options = parseProspectArgs(a);

    // Cross-tick dedup keys from the papercusp bet-analysis backlog.
    const alreadyQueued = await deps.listAlreadyQueued(bridgeCtx);

    // The engine sweep: live read + select + rank + cap + idle gate. Returns the
    // candidates to enqueue (it does NOT touch papercusp work_items).
    const sweep = await deps.bridge({ options, alreadyQueued, ctx: bridgeCtx });

    if (sweep.gated) {
      ctx.log?.(
        `oddsmith:prospect gated (${sweep.gateReason ?? 'not-idle'}) — ` +
          `swept=${sweep.swept} deduped=${sweep.deduped} enqueued=0`,
      );
      return {
        swept: sweep.swept,
        candidates: sweep.candidates,
        deduped: sweep.deduped,
        enqueued: 0,
        capped: sweep.capped,
        gated: true,
        gateReason: sweep.gateReason,
        byVenue: sweep.byVenue,
        errors: sweep.errors,
        enqueuedKeys: [],
      };
    }

    // Enqueue each survivor into papercusp work_items. A per-item throw is caught
    // so one bad enqueue never aborts the rest (mirrors the engine sweep).
    let errors = sweep.errors;
    const enqueuedKeys: string[] = [];
    for (const cand of sweep.toEnqueue) {
      try {
        await deps.enqueue(cand, bridgeCtx);
        enqueuedKeys.push(candidateKey(cand));
      } catch (e) {
        errors += 1;
        ctx.log?.(`oddsmith:prospect enqueue ${candidateKey(cand)} failed: ${errMsg(e)}`);
      }
    }

    ctx.log?.(
      `oddsmith:prospect swept=${sweep.swept} candidates=${sweep.candidates} ` +
        `deduped=${sweep.deduped} enqueued=${enqueuedKeys.length} capped=${sweep.capped} errors=${errors}`,
    );

    return {
      swept: sweep.swept,
      candidates: sweep.candidates,
      deduped: sweep.deduped,
      enqueued: enqueuedKeys.length,
      capped: sweep.capped,
      gated: false,
      byVenue: sweep.byVenue,
      errors,
      enqueuedKeys,
    };
  },
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

registerCoordOp(oddsmithProspectOp);
