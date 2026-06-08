/**
 * router.ts — Scout loop routing (hive-creative-ideation-2026-06-08, P-007 / D-007).
 *
 * The Scout loop's hand-off: it takes the debate+recombine SURVIVORS (P-006
 * {@link Proposal}s) and routes each into exactly one of the Hive's three
 * EXISTING rails — "route into the existing rails; extend pillar 2, don't fork
 * the loop" (D-007):
 *
 *   • broad-scope    → a `plans:new` DRAFT plan      (owner/Queen-visible design surface)
 *   • testable-small → the gym quality-diversity rail (seedDistantNiches, P-012 / D-008)
 *   • concrete       → `improvements:capture`          (the self-improvement idea queue)
 *
 * It is the convergence seam of Phase 1: it CONSUMES su-d1170's P-006 `Proposal`
 * (which already carries a `routeHint` the recombine step computed with full idea
 * context — the router validates + dispatches it, and MAY override) and PRODUCES
 * the `{ ideaId, lens, rail, routedRef }` rows P-013 (`outcome-feedback`) reads
 * back to weight winning lenses (D-009). A recombined proposal fuses several
 * ideas, so provenance is expanded PER source idea — every contributing lens
 * gets attribution credit ({@link decisionsToProvenance}).
 *
 * Per the verification lane's invariant #5 (su-b6c3f) the module splits into:
 *   - a PURE decision spine ({@link classifyProposal} / {@link decideRoutes}) —
 *     zero IO, the part the tests pin hard; and
 *   - the side-effecting dispatch behind an INJECTED {@link RouterPorts} port
 *     (the gym:judge / corpus-digest-deps pattern), so {@link routeProposals}
 *     unit-tests with fakes — no PG, no LLM, no tool calls, no real writes.
 *
 * Provenance is NOT persisted here: the router emits typed decisions;
 * {@link decisionsToProvenance} adapts them to P-013's {@link RoutedIdeaProvenance}
 * ledger contract, which su-80be9 persists at the cycle/scheduler boundary
 * (`recordRoutedIdea` → `harness_shared.scout_routed_ideas`). Production port
 * wiring lives in `router-deps.ts`.
 */

import type { CreativeLens, Proposal } from './types';
import type { RoutedIdeaProvenance, RoutedRail } from './outcome-feedback';
import type { ScoutIdeaView, SeedDistantResult } from './gym-bridge';

/* ────────────────────────────────────────────────────────────────────────
 * The routing decision (pure)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * One routing decision (per proposal). `rail` + `reason` are decided purely;
 * `routedRef` is filled once {@link routeProposals} dispatches it (and stays
 * undefined when a dispatch fails — see `error`). `sourceIdeaIds` is carried so
 * P-013 can attribute the outcome to every lens that recombined into the proposal.
 */
export interface RoutingDecision {
  /** The proposal id (Proposal.id). */
  proposalId: string;
  /** The ideas that recombined into this proposal — P-013 attributes the outcome to each. */
  sourceIdeaIds: string[];
  /** The rail it routed to. */
  rail: RoutedRail;
  /** One line: why this rail (b6c3f invariant #5 — route + reason). */
  reason: string;
  /** False when the router overrode the proposal's `routeHint` (or there was none). */
  followedHint: boolean;
  /** One-line title (from the proposal framing), for the report drill-down. */
  title?: string;
  /** The change-feed ref of the created artifact: plan:<slug> | gym:<proposalId> | wi:<id>. */
  routedRef?: string;
  /** Dispatch error — defensive: one failed sink never aborts the batch. */
  error?: string;
}

export interface ClassifyOptions {
  /** Rail used when a proposal has no `routeHint`. Default 'improvement' (smallest footprint). */
  defaultRail?: RoutedRail;
  /**
   * Optional override hook: given a proposal, return a rail to FORCE (the router
   * overriding the recombine hint with richer signal — e.g. the cycle resolves
   * the source ideas' scope / moonshot bucket). Return undefined to defer to the
   * proposal's own `routeHint`. This is the "the router may override" seam.
   */
  override?: (p: Proposal) => RoutedRail | undefined;
}

/**
 * Decide the rail for ONE proposal (D-007). Pure + deterministic. The creative
 * judgment already happened upstream (critics P-005, debate/recombine P-006),
 * and recombine emits a `routeHint`; routing is the deterministic, dispatchable
 * decision over it, in priority order:
 *
 *   1. an explicit {@link ClassifyOptions.override} (the router overruling the
 *      hint with richer signal) — wins if it returns a rail;
 *   2. the proposal's own `routeHint` (recombine's recommendation);
 *   3. the {@link ClassifyOptions.defaultRail} (default 'improvement' — the
 *      smallest-footprint, reversible rail) when a proposal carries no hint.
 */
export function classifyProposal(
  p: Proposal,
  opts: ClassifyOptions = {},
): { rail: RoutedRail; reason: string; followedHint: boolean } {
  const forced = opts.override?.(p);
  if (forced) {
    return {
      rail: forced,
      reason:
        forced === p.routeHint
          ? `router confirmed routeHint → ${forced}`
          : `router override → ${forced}${p.routeHint ? ` (recombine hinted ${p.routeHint})` : ''}`,
      followedHint: forced === p.routeHint,
    };
  }
  if (p.routeHint) {
    return { rail: p.routeHint, reason: `followed recombine routeHint → ${p.routeHint}`, followedHint: true };
  }
  const def = opts.defaultRail ?? 'improvement';
  return { rail: def, reason: `no routeHint → default ${def} (smallest-footprint, reversible rail)`, followedHint: false };
}

/**
 * Decide rails for a batch — the pure planning step (no IO, no `routedRef`).
 * Order-preserving so a caller can zip decisions back to proposals by index.
 */
export function decideRoutes(
  proposals: readonly Proposal[],
  opts: ClassifyOptions = {},
): RoutingDecision[] {
  return proposals.map((p) => {
    const { rail, reason, followedHint } = classifyProposal(p, opts);
    const title = proposalTitle(p);
    return {
      proposalId: p.id,
      sourceIdeaIds: [...(p.sourceIdeaIds ?? [])],
      rail,
      reason,
      followedHint,
      ...(title ? { title } : {}),
    };
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * The injected dispatch ports
 * ──────────────────────────────────────────────────────────────────────── */

export interface PlanDraftRequest {
  proposal: Proposal;
  /** A valid kebab-case slug stem ({@link deriveSlugStem}); the port may refine it. */
  slugStem: string;
}

/** broad → plans:new. Returns the created (or pre-existing) draft plan's slug. */
export type PlansNewPort = (req: PlanDraftRequest) => Promise<{ slug: string }>;

/** testable → gym. Seeds the QD archive's distant niches in one batch (P-012). */
export type GymDispatchPort = (ideas: ScoutIdeaView[]) => Promise<SeedDistantResult>;

export interface CaptureRequest {
  proposal: Proposal;
}

/** concrete → improvements:capture. Returns the issue id + whether it was newly created. */
export type CapturePort = (req: CaptureRequest) => Promise<{ id: string; created: boolean }>;

/**
 * The injected effect port. Every rail's side-effect goes through here so
 * {@link routeProposals} is testable with fakes (invariant #5: assert routing
 * without real writes). Production wiring: `router-deps.ts`.
 */
export interface RouterPorts {
  plansNew: PlansNewPort;
  gymDispatch: GymDispatchPort;
  capture: CapturePort;
}

/* ────────────────────────────────────────────────────────────────────────
 * Adapters
 * ──────────────────────────────────────────────────────────────────────── */

/** First non-empty line of the framing, capped — the proposal's human title. */
export function proposalTitle(p: Proposal): string {
  const framing = (p.framing ?? '').trim();
  const firstLine = framing.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return firstLine.slice(0, 200);
}

/**
 * Map a gym-routed proposal onto the gym-bridge's {@link ScoutIdeaView}. The
 * view `id` is the PROPOSAL id, so the niche the bridge seeds carries the same
 * candidateId the gym's change-feed entry will — which is what makes the
 * `gym:<proposalId>` provenance ref join in P-013. The real `Proposal` carries
 * no behaviour-space tags, so the descriptor falls back to gym-bridge's
 * graceful defaults; the cycle may inject a richer mapper via
 * {@link RouteOptions.gymView} once it resolves the source ideas' scope/risk.
 */
export function proposalToGymView(p: Proposal): ScoutIdeaView {
  const title = proposalTitle(p);
  return {
    id: p.id,
    rationale: title,
    text: [p.framing, p.mechanism].map((s) => (s ?? '').trim()).filter(Boolean).join(' — '),
  };
}

/**
 * Derive a valid `plans:new` slug stem from the proposal framing — lowercased,
 * non-alnum collapsed to single hyphens, trimmed, capped, and `scout-`-prefixed
 * (so Scout drafts are identifiable + the slug always satisfies plans:new's
 * `^[a-z0-9][a-z0-9-]*[a-z0-9]$`, min-3 rule). plans:new appends the date.
 */
export function deriveSlugStem(framing: string): string {
  const core = (framing ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return core.length > 0 ? `scout-${core}` : 'scout-idea';
}

/* ────────────────────────────────────────────────────────────────────────
 * Dispatch
 * ──────────────────────────────────────────────────────────────────────── */

export interface RouteResult {
  /** One decision per input proposal, in input order, `routedRef` filled where dispatched. */
  decisions: RoutingDecision[];
  /** Count routed to each rail (counted even if the dispatch then failed). */
  byRail: Record<RoutedRail, number>;
  /** The gym seed result (coverage gain), present when ≥1 proposal routed to the gym. */
  gymSeed?: SeedDistantResult;
  /** proposalIds whose dispatch threw (their decision carries the `error`). */
  failed: string[];
}

export interface RouteOptions extends ClassifyOptions {
  /** Custom proposal→gym-view mapper (default {@link proposalToGymView}). */
  gymView?: (p: Proposal) => ScoutIdeaView;
}

/**
 * Route a batch of proposals through the injected ports (P-007). Classifies
 * purely, then dispatches: the gym rail in ONE batch (`seedDistantNiches` is
 * batch-shaped); plan + improvement per-proposal. Defensive — a sink that throws
 * fails only that decision (recorded in `error` + `failed`), never the whole
 * batch (the ideators.ts "one failed ideator never kills the batch" discipline).
 */
export async function routeProposals(
  proposals: readonly Proposal[],
  ports: RouterPorts,
  opts: RouteOptions = {},
): Promise<RouteResult> {
  const decisions = decideRoutes(proposals, opts);
  const byProposal = new Map(proposals.map((p) => [p.id, p]));
  const gymView = opts.gymView ?? proposalToGymView;

  // ── gym rail (batched) ──────────────────────────────────────────────────
  const gymDecisions = decisions.filter((d) => d.rail === 'gym');
  let gymSeed: SeedDistantResult | undefined;
  if (gymDecisions.length > 0) {
    const views = gymDecisions.map((d) => gymView(byProposal.get(d.proposalId)!));
    try {
      gymSeed = await ports.gymDispatch(views);
      for (const d of gymDecisions) d.routedRef = `gym:${d.proposalId}`;
    } catch (e) {
      const msg = errMsg(e);
      for (const d of gymDecisions) d.error = msg;
    }
  }

  // ── plan + improvement rails (per-proposal) ───────────────────────────────
  for (const d of decisions) {
    if (d.rail === 'gym') continue; // handled above
    const p = byProposal.get(d.proposalId)!;
    try {
      if (d.rail === 'plan') {
        const { slug } = await ports.plansNew({ proposal: p, slugStem: deriveSlugStem(p.framing) });
        d.routedRef = `plan:${slug}`;
      } else {
        const { id } = await ports.capture({ proposal: p });
        d.routedRef = `wi:${id}`;
      }
    } catch (e) {
      d.error = errMsg(e);
    }
  }

  const byRail: Record<RoutedRail, number> = { plan: 0, gym: 0, improvement: 0 };
  for (const d of decisions) byRail[d.rail] += 1;
  const failed = decisions.filter((d) => d.error).map((d) => d.proposalId);

  return { decisions, byRail, ...(gymSeed ? { gymSeed } : {}), failed };
}

/* ────────────────────────────────────────────────────────────────────────
 * Provenance adapter (→ P-013)
 * ──────────────────────────────────────────────────────────────────────── */

/** Resolve a source idea's creative lens (P-004 Idea.lens) for attribution. */
export type LensResolver = (ideaId: string) => CreativeLens | undefined;

export interface ProvenanceContext {
  /** The Scout cycle this routing belongs to (P-013 grouping). */
  cycleId?: string;
  /** ISO timestamp the routing ran (injected for determinism). */
  routedAt?: string;
}

/**
 * Expand the dispatched decisions into P-013's {@link RoutedIdeaProvenance}
 * ledger rows — ONE per source idea, so every lens that recombined into a routed
 * proposal earns attribution for the outcome (D-009). su-80be9's scheduler calls
 * this after `runScoutCycle` then `recordRoutedIdea(...)`. A decision with no
 * `routedRef` (never dispatched) or a source idea whose lens can't be resolved is
 * skipped — there is nothing to attribute.
 */
export function decisionsToProvenance(
  decisions: readonly RoutingDecision[],
  lensOf: LensResolver,
  ctx: ProvenanceContext = {},
): RoutedIdeaProvenance[] {
  const out: RoutedIdeaProvenance[] = [];
  for (const d of decisions) {
    if (!d.routedRef) continue;
    for (const ideaId of d.sourceIdeaIds) {
      const lens = lensOf(ideaId);
      if (!lens) continue;
      out.push({
        ideaId,
        lens,
        rail: d.rail,
        routedRef: d.routedRef,
        ...(ctx.cycleId ? { cycleId: ctx.cycleId } : {}),
        ...(d.title ? { title: d.title } : {}),
        ...(ctx.routedAt ? { routedAt: ctx.routedAt } : {}),
      });
    }
  }
  return out;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
