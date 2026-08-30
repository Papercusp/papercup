/**
 * improvements:triage — Queen-turn triage (P-020 from self-learning-central-2026-06-06).
 *
 * The Queen reads the digest and triages each idea:
 * - type-routes (product→place, process→gate)
 * - attaches triage decision + reason
 * - updates idea lifecycle state
 *
 * This is a working tool (not just read-only) — the Queen calls it to record her
 * triage decisions per idea.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { readImprovementItems, countImprovementItems } from '../../harness/improvements/read-items';
import { buildDigest } from '../../harness/improvements/digest';
import { readOwnerFullAutonomyGrant } from '../../harness/improvements/full-autonomy-grant';
import { applyHumanQueueRanking, humanQueueRankerSpec, type RankedHumanQueueItem } from '../../queue-ranker/human-queue';
import { triageIdea, summarizeTriages, type IdeaType, type TriageDecision } from '../../harness/improvements/triage';
import { applyTriageDecision } from '../../harness/improvements/triage-core';

/**
 * How many open ideas one triage invocation reads.
 *
 * This is a WINDOW, not the corpus. It was previously an unnamed `100` inline in the
 * read, which is how `retriage-all` came to describe itself as a pass over "EVERY open
 * idea" while only ever reaching the first {@link TRIAGE_WINDOW} rows. Every mode now
 * stamps a `coverage` block derived from this constant plus the real `COUNT(*)`, so the
 * bound travels with the result instead of living only here.
 */
const TRIAGE_WINDOW = 100;

export default defineTool({
  name: 'improvements:triage',
  profile: 'engineer',
  description:
    'Mug-turn triage: route each scored idea by the D-005 taxonomy (product→place; code-bug→the policy tier\'s lane; infra-environment→owner-escalation; process-prompt→gate/gym; needs-design→plans:new). The risk-tier policy is the one safety verdict — triage adds only routing (D-003). Persists the decision on the idea lifecycle. (P-010) Per-Hive scope filtering.',
  guidance: {
    when:
      'To triage captured ideas: read the digest summary, walk the human queue in RANK order (the P-040 ranker — triage-all carries each item\'s rank breakdown), classify by the D-005 taxonomy, decide (place/gate/gym/reject), and record the Mug\'s judgment. (P-010) Pass harnessSlug for one Hive. mode=retriage-all re-routes the open-idea WINDOW after a taxonomy/policy change — every mode returns `coverage`; retriage-all adds `complete`, and complete:false means ideas beyond the window KEPT their old routing.',
    notWhen: 'You want to READ ideas — use improvements:digest. You want to CAPTURE — use improvements:capture. You want implementation status — use improvements:resolve.',
    chaining: "improvements:triage → work_items:create/update for placed ideas, or coord:escalate for human-gate ideas. A rank breakdown showing a 'calibration' contribution → calibration:summary { predictor } to weigh the bettor's claim before deciding.",
    seeAlso: [
      'improvements:digest (READ the ideas without recording a judgment)',
      'improvements:capture (FILE a new idea)',
      'work_items:create (place a triaged idea as tracked work)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  // Triage uses the issue helpers' own short-lived DB calls and never reads
  // ctx.tx. In particular, triage-one must not hold the ambient workspace
  // transaction while a queue-wide ranking pass is running under load.
  skipWorkspaceTx: true,
  // Queue-wide summary/retriage scans can legitimately sit behind the shared
  // issue/ranking reads for longer than the generic 60s tool budget. The
  // historical false-timeout reached 187s before the handler returned
  // successfully; leave enough headroom for that bounded batch.
  timeoutSec: 300,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    mode: z
      .enum(['summary', 'triage-all', 'triage-one', 'retriage-all'])
      .optional()
      .describe(
        'Summary: show triage breakdown without applying decisions. Triage-all: classify all open ideas. Triage-one: triage a single idea by id. Retriage-all: re-run the deterministic route over EVERY open idea (already-triaged included — triaged→triaged is valid) and PERSIST it; the backlog migration pass for a taxonomy change (consume-edges P-021).',
      ),
    ideaId: z.string().optional().describe('For triage-one mode, the idea to triage'),
    decision: z
      .enum(['place', 'gate', 'gym', 'reject'])
      .optional()
      .describe('For triage-one, the Mug\'s decision'),
    reason: z.string().optional().describe('Reason for the decision (required if decision is set)'),
    harnessSlug: z.string().min(1).max(80).optional().describe('(P-010) restrict to a specific Pot\'s ideas (default: all)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);

    // Triage-one only needs the requested item's lifecycle write. The full
    // digest/ranking prelude below is for queue views, not this targeted
    // operation. Running it here made a single Blender/Mug triage call scan
    // and rank 100 ideas before touching one item; under load that could
    // outlive the 60s dispatcher deadline and return the misleading
    // "handler returned but signal had aborted" timeout (EI-21826830445006528).
    if (args.mode === 'triage-one') {
      if (!args.ideaId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'triage-one mode requires ideaId',
              }),
            },
          ],
        };
      }

      if (!args.decision || !args.reason) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'triage-one mode requires decision + reason',
              }),
            },
          ],
        };
      }

      // Persist the Queen's decision durably (learning-system-audit P-010):
      // writes payload.ideaLifecycle (state machine validated), records
      // payload.decidedReason + CLOSES the issue on reject (queue-as-memory —
      // the next same-signature capture recalls "already decided: <reason>").
      const result = await applyTriageDecision({
        id: args.ideaId,
        decision: args.decision as TriageDecision,
        reason: args.reason,
        by: 'Queen',
      });
      if (!result.ok) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ ok: false, error: result.error }) },
          ],
        };
      }

      // Generate guidance based on decision type (P-040: gym re-trigger)
      let note = '';
      if (args.decision === 'place') {
        note = 'Decision persisted. Use work_items:create to assign and track the implementation.';
      } else if (args.decision === 'gate') {
        note = 'Decision persisted. Escalate for human review before proceeding.';
      } else if (args.decision === 'gym') {
        note = 'Decision persisted. Gym A/B dispatch for verification (P-040). Next: call cup:spawn or harness:create to instantiate the gym with the target prompt variant for evaluation.';
      } else if (args.decision === 'reject') {
        note = 'Decision persisted: issue CLOSED with decidedReason — the recall matcher surfaces it on the next same-signature capture.';
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'triage-one',
              ideaId: args.ideaId,
              decision: args.decision,
              reason: args.reason,
              lifecycle: result.lifecycle,
              closed: result.closed ?? false,
              note,
            }),
          },
        ],
      };
    }

    // Read all open ideas (P-010: filter by harnessSlug if provided), human
    // lane ranked by the ONE queue ranker (frontier P-040/P-045, D-005) — the
    // Queen's triage walk follows the same order the digest, the tab, and the
    // owner inbox show, with each item carrying its rank.features breakdown.
    const readOpts = { state: 'open' as const, limit: TRIAGE_WINDOW, harnessSlug: args.harnessSlug };
    // D2 (EI-18790490225750395), propagated here from `improvements:digest`: the TRUE
    // corpus total — a real COUNT(*), never bounded by `limit`. Without it `buildDigest`
    // falls back to `total = candidates.length`, so this tool reported its own 100-row
    // WINDOW as the backlog size AND set `windowed:false`, which reads as a positive
    // assertion that nothing was truncated. Best-effort exactly as in digest.ts: a count
    // failure degrades to `undefined` (prior behaviour) rather than sinking the triage.
    const [items, corpusTotal] = await Promise.all([
      readImprovementItems(readOpts),
      countImprovementItems(readOpts).catch(() => undefined),
    ]);
    // The OWNER FULL-AUTONOMY grant (Phase 2): the Queen's recorded triage must match the
    // live dispatch — when ON, protected-surface kind=bugs route to the auto-implement lane.
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const ownerFullAutonomy = await readOwnerFullAutonomyGrant(ws);
    const digest = await applyHumanQueueRanking(
      buildDigest(items, { nowMs: Date.now(), ownerFullAutonomy, corpusTotal }),
      { candidates: items },
    );
    // The window/corpus framing every mode below stamps onto its result, so a count
    // computed over a capped fetch can never be read as a corpus-wide verdict.
    const coverage = {
      window: TRIAGE_WINDOW,
      examined: items.length,
      corpusTotal: corpusTotal ?? null,
      windowed: digest.windowed,
    };

    // Summary mode: just show the breakdown
    if (!args.mode || args.mode === 'summary') {
      const summary = summarizeTriages([...digest.humanQueue, ...digest.autoEligible]);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'summary',
              digest: {
                total: digest.total,
                open: digest.open,
                byKind: digest.byKind,
                autoEligible: digest.autoEligible.length,
                humanQueue: digest.humanQueue.length,
              },
              // The breakdown below is computed over `coverage.examined` rows, NOT the
              // corpus: `triageSummary.total` is a floor. Read `coverage` before quoting
              // any of these counts as a backlog-wide figure.
              coverage,
              triageSummary: summary,
              // The one ranker's registry as data (P-040/D-005) — name/weight/
              // description per feature, the inspectable half of rank.features.
              ranker: humanQueueRankerSpec(),
            }),
          },
        ],
      };
    }

    // Triage-all: classify all open ideas and show decisions. The human queue
    // leads in RANK ORDER (P-040/P-045) with each item's breakdown attached, so
    // the Queen walks the same order every other surface shows.
    if (args.mode === 'triage-all') {
      const decide = (item: (typeof digest.autoEligible)[number]) => {
        const triage = triageIdea(item);
        return {
          id: item.id,
          title: item.title,
          kind: item.kind,
          ideaType: item.ideaType,
          score: item.score,
          decision: triage.decision,
          reason: triage.reason,
          target: triage.target,
        };
      };
      const rankedQueue: RankedHumanQueueItem[] = digest.humanQueue;
      const decisions = [
        ...rankedQueue.map((item) => ({
          ...decide(item),
          rankScore: item.rank.score,
          rankFeatures: item.rank.features
            .filter((f) => f.contribution !== 0)
            .map((f) => `${f.feature}: ${f.contribution.toFixed(2)}`),
        })),
        ...digest.autoEligible.map(decide),
      ];

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'triage-all',
              coverage,
              decisions,
              note:
                'Mug, review the decisions above. Use triage-one to record each decision you choose to apply. ' +
                'PREVIEW ONLY — this mode persists nothing. `decisions` covers the first ' +
                `${coverage.examined} open idea(s)` +
                (coverage.windowed ? ` of ${coverage.corpusTotal ?? 'an unknown number of'} in the corpus.` : '.'),
            }),
          },
        ],
      };
    }

    // Retriage-all (consume-edges P-021): one deterministic pass over the open-idea
    // WINDOW — already-triaged included (triaged→triaged is a valid transition) — so a
    // taxonomy change re-routes standing items rather than only new ones.
    // Decisions are persisted (by='improvement-retriage'); the Queen/owner can
    // still re-take any of them via triage-one.
    //
    // ⚠ This reaches the first TRIAGE_WINDOW open ideas, NOT the whole corpus. This
    // comment used to claim "EVERY open idea", which is the dangerous reading: after a
    // taxonomy change an operator sees `scanned: 100 / applied: 100`, concludes the
    // standing backlog was re-routed, and never learns the remainder kept its stale
    // routing — a silent partial that looks exactly like success. The result now carries
    // `coverage` + `complete` so the bound is impossible to miss. Widening the WRITE to
    // the full corpus is deliberately NOT done here: that turns a reporting fix into a
    // bulk mutation of every open idea and needs its own decision.
    if (args.mode === 'retriage-all') {
      const all = [...digest.humanQueue, ...digest.autoEligible];
      const byDecision: Record<TriageDecision, number> = { place: 0, gate: 0, gym: 0, reject: 0 };
      const byType: Record<IdeaType, number> = {
        'product': 0,
        'code-bug': 0,
        'infra-environment': 0,
        'process-prompt': 0,
        'needs-design': 0,
      };
      const failures: Array<{ id: string; error: string }> = [];
      let applied = 0;
      for (const item of all) {
        const triage = triageIdea(item);
        const res = await applyTriageDecision({
          id: item.id,
          decision: triage.decision,
          reason: triage.reason,
          by: 'improvement-retriage',
          comment: false, // batch pass — the lifecycle carries the decision, no thread spam
        });
        if (res.ok) {
          applied += 1;
          byDecision[triage.decision] += 1;
          if (item.ideaType) byType[item.ideaType] += 1;
        } else {
          failures.push({ id: item.id, error: res.error ?? 'unknown' });
        }
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'retriage-all',
              scanned: all.length,
              applied,
              // `scanned`/`applied` count the WINDOW, never the corpus. `complete` is the
              // one field that answers "did this re-route the standing backlog?" — false
              // means ideas outside the window kept their previous routing.
              coverage,
              complete: !coverage.windowed,
              remaining: coverage.corpusTotal === null ? null : Math.max(0, coverage.corpusTotal - all.length),
              byDecision,
              byType,
              failures: failures.slice(0, 10),
              failureCount: failures.length,
            }),
          },
        ],
      };
    }

    // Triage-one: record the Queen's decision for a single idea
    if (args.mode === 'triage-one') {
      if (!args.ideaId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'triage-one mode requires ideaId',
              }),
            },
          ],
        };
      }

      if (!args.decision || !args.reason) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'triage-one mode requires decision + reason',
              }),
            },
          ],
        };
      }

      // Persist the Queen's decision durably (learning-system-audit P-010):
      // writes payload.ideaLifecycle (state machine validated), records
      // payload.decidedReason + CLOSES the issue on reject (queue-as-memory —
      // the next same-signature capture recalls "already decided: <reason>").
      const result = await applyTriageDecision({
        id: args.ideaId,
        decision: args.decision as TriageDecision,
        reason: args.reason,
        by: 'Queen',
      });
      if (!result.ok) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ ok: false, error: result.error }) },
          ],
        };
      }

      // Generate guidance based on decision type (P-040: gym re-trigger)
      let note = '';
      if (args.decision === 'place') {
        note = 'Decision persisted. Use work_items:create to assign and track the implementation.';
      } else if (args.decision === 'gate') {
        note = 'Decision persisted. Escalate for human review before proceeding.';
      } else if (args.decision === 'gym') {
        note = 'Decision persisted. Gym A/B dispatch for verification (P-040). Next: call cup:spawn or harness:create to instantiate the gym with the target prompt variant for evaluation.';
      } else if (args.decision === 'reject') {
        note = 'Decision persisted: issue CLOSED with decidedReason — the recall matcher surfaces it on the next same-signature capture.';
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: 'triage-one',
              ideaId: args.ideaId,
              decision: args.decision,
              reason: args.reason,
              lifecycle: result.lifecycle,
              closed: result.closed ?? false,
              note,
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error: 'Unknown mode',
          }),
        },
      ],
    };
  },
});
