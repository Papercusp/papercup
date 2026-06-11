/**
 * plans:lint — validate plan files against the format spec.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.5 + §5.
 *
 * **Legacy files are exempt entirely.** Day-one CI MUST pass against
 * the ~33 legacy plans in docs/plans/. Conversion happens via P-304,
 * one plan at a time.
 *
 * Per-plan checks (when frontmatter present + valid):
 *   - slug matches filename stem
 *   - required sections present (## Now, ## Decisions)
 *   - item IDs unique + well-formed (P-NNN)
 *   - decision IDs unique + well-formed (D-NNN)
 *   - blocked-by refs resolve to known item IDs
 *   - decision refs resolve to known decision IDs
 *   - status tokens in vocabulary
 *   - ASCII-only IDs
 *   - supersession recorded (`superseded-by:` frontmatter / a "superseded by
 *     [[X]]" Now note) but status not `superseded` → warn (EI-154)
 *
 * Returns { errors, warnings } per plan + overall pass/fail.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { listPlanFiles, readPlanBySlug, type PlanSourceOpts } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveEffectiveStatus } from './effective-status';
import { IMPORTANCE_LEVELS } from './parser';
import type { ParsedPlan } from './parser';
import { parsePromotePolicy } from './promote-policy';

const argsSchema = z.object({
  slug: z.string().optional().describe('Lint one plan. Omit for all plans.'),
  includeArchived: z.boolean().optional().describe('Lint plans under archive/. Default false.'),
  harness: harnessArg,
});

export interface LintFinding {
  level: 'error' | 'warning';
  code: string;
  message: string;
  itemId?: string;
  decisionId?: string;
}

export interface PlanLintReport {
  slug: string;
  archived: boolean;
  legacy: boolean;
  exempt: boolean;
  errors: LintFinding[];
  warnings: LintFinding[];
}

/** Count features in harness_features_consolidated whose metadata
 *  records this plan slug as their source. Returns 0 when PG is
 *  unreachable so the lint never breaks on infra blips. */
async function countFeaturesFromPlan(planSlug: string): Promise<number> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    // P-041: scope to the caller's workspace (ALS-populated for tool calls,
    // P-022). getOrgPg bypasses RLS, and post-091 a plan slug is unique only
    // per (workspace_id, slug), so an unscoped count would fold in another
    // workspace's features for a colliding slug.
    const workspaceId = activeWorkspaceId();
    const rows = await sql<Array<{ n: number }>>`
      SELECT COUNT(*)::int AS n
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId}
         AND source_plan_slug = ${planSlug}
    `;
    return rows[0]?.n ?? 0;
  } catch {
    // PG offline / column missing — fail open. The lint surfacing a
    // false negative is strictly better than a false positive
    // (which is the very issue we're fixing).
    return 0;
  }
}

export async function lintPlan(
  slug: string,
  opts: PlanSourceOpts = {},
): Promise<PlanLintReport | null> {
  const result = await readPlanBySlug(slug, opts);
  if (!result) return null;
  const { parsed, archived } = result;
  return lintParsed(parsed, slug, archived);
}

/**
 * Apply the lint rules to an already-parsed plan. Split out of
 * `lintPlan` so `plans:set-content` can lint a *proposed* document
 * body in-memory — before writing it. Pure now (plans are PG-canonical;
 * no filesystem round-trip).
 */
export async function lintParsed(
  parsed: ParsedPlan,
  slug: string,
  archived: boolean,
): Promise<PlanLintReport> {
  const report: PlanLintReport = {
    slug,
    archived,
    legacy: parsed.isLegacy,
    exempt: parsed.isLegacy,
    errors: [],
    warnings: [],
  };

  if (parsed.isLegacy) return report;

  const fmSlug = parsed.frontmatter.slug;
  if (fmSlug && fmSlug !== parsed.slug) {
    report.errors.push({
      level: 'error',
      code: 'slug_mismatch',
      message: `Frontmatter slug "${fmSlug}" doesn't match filename stem "${parsed.slug}".`,
    });
  }

  if (!parsed.now) {
    // §4.5: `## Now` is required — it is the cold-resume anchor, the
    // single most-read field of a plan. Every plan was backfilled with
    // a Now block, so a non-legacy plan missing one is malformed: hard
    // error, not a warning. (Legacy plans returned early above.)
    report.errors.push({
      level: 'error',
      code: 'missing_now_section',
      message: 'No `## Now` section — every plan needs one (the cold-resume anchor); add it with plans:set-now.',
    });
  }
  if (parsed.decisions.length === 0 && parsed.items.length > 0) {
    report.warnings.push({
      level: 'warning',
      code: 'missing_decisions_section',
      message: 'No `## Decisions` section / no decisions recorded.',
    });
  }

  // EI-154: a plan that RECORDS its own supersession — via the `superseded-by:`
  // frontmatter field OR a "superseded by [[X]]" note in its `## Now` block — but
  // whose STATUS is not `superseded` is a trap. The next agent reads it as a live
  // `ready`/`active` plan and may build the design that was already rejected. This
  // is the fleet-federation-reanchor case (2026-06-09): its NULL=fleet-domain
  // federation design sat `ready` for days after `shared-hive-federation` shipped
  // the opposite (Hive-pubkey) approach, and an assigned agent nearly built the
  // rejected design before a code-grounded read caught the supersession. Flipping
  // the status makes the supersession machine-visible (it drops out of
  // plans:items actionable/needs-human) instead of buried in prose.
  //
  // WARNING, never error: supersession state is transiently inconsistent mid-edit
  // (you record it in prose, then flip the status), and plan lints advise rather
  // than gate (CLAUDE.md). The prose signal requires a `[[wikilink]]` after
  // "superseded by" so a passing narrative mention can't false-positive; the
  // frontmatter signal is exact. Tightly scoped to the `## Now` state (the
  // self-referential cold-resume anchor), so it never fires on a decision that
  // merely discusses some *other* plan's supersession.
  const status = parsed.frontmatter.status;
  if (status && status !== 'superseded') {
    // Strip markdown emphasis (`**bold**` / `_italic_` / `` `code` ``) so the
    // natural Now phrasing "**SUPERSEDED** by [[X]]" still matches `superseded by`.
    const nowState = (parsed.now?.state ?? '').replace(/[*_`]/g, '');
    const fmSupersededBy =
      typeof parsed.frontmatter.supersededBy === 'string'
        ? parsed.frontmatter.supersededBy.trim()
        : '';
    const proseLink = /\bsuperseded\s+by\b[^[\n]*\[\[([^\]]+)\]\]/i.exec(nowState)?.[1]?.trim();
    if (fmSupersededBy || proseLink) {
      const by = fmSupersededBy || proseLink || 'another plan';
      const where = fmSupersededBy ? 'its `superseded-by:` frontmatter' : 'its `## Now` block';
      report.warnings.push({
        level: 'warning',
        code: 'superseded_status_mismatch',
        message:
          `This plan records that it is superseded by ${by} (in ${where}) but its status is '${status}'. ` +
          `Flip it with plans:set-plan-status status=superseded — a stale '${status}' plan whose design was ` +
          `superseded misleads the next agent into building the rejected approach (the fleet-federation-reanchor trap).`,
      });
    }
  }

  for (const w of parsed.parseWarnings) {
    report.errors.push({ level: 'error', code: 'parse_warning', message: w });
  }

  const itemIds = new Set(parsed.items.map((i) => i.id));
  const itemById = new Map(parsed.items.map((i) => [i.id, i]));

  // EI-251: checkbox-style item lines (`- [ ] P-NNN — text`) are NOT the
  // canonical item syntax (`- **P-NNN** \`status\` text`) and parse as ZERO
  // items — plans:set-status returns item_not_found, plans:items can't see
  // them, and claims never auto-release. This bit all 15 agents of the
  // 2026-06-10 closeout dispatch on the audit plan (81 invisible items,
  // lint silently green). Surface every checkbox-form id the parser did
  // not register. WARNING, not error: lint advises rather than gates, and
  // the regex is line-anchored so a prose mention can't fire it, but a
  // quoted example block legitimately could.
  const checkboxItemRe = /^[ \t]*-\s*\[(?: |x|X)\]\s*\*{0,2}([A-Z]-\d{3,})\b/gm;
  const ghostIds: string[] = [];
  for (const m of parsed.raw.matchAll(checkboxItemRe)) {
    const id = m[1];
    if (id && !itemIds.has(id)) ghostIds.push(id);
  }
  if (ghostIds.length > 0) {
    const sample = ghostIds.slice(0, 5).join(', ');
    const suffix = ghostIds.length > 5 ? `, … +${ghostIds.length - 5} more` : '';
    report.warnings.push({
      level: 'warning',
      code: 'checkbox_item_syntax',
      message:
        `${ghostIds.length} checkbox-style item line(s) (${sample}${suffix}) are INVISIBLE to the plan parser — ` +
        'plans:set-status fails item_not_found on them and they never appear in plans:items. ' +
        'Rewrite as the canonical form `- **P-NNN** `status` text` (spec/plan-format).',
    });
  }
  for (const it of parsed.items) {
    for (const dep of it.blockedBy) {
      const depItem = itemById.get(dep);
      if (!depItem) {
        report.errors.push({
          level: 'error',
          code: 'unknown_blocked_by',
          message: `Item ${it.id} has blocked-by: ${dep} that doesn't resolve.`,
          itemId: it.id,
        });
        continue;
      }
      // §3.4 / D-005: a `dropped` blocker never completes, so the
      // resolver treats the dependent as unblocked. Surface it so the
      // dependency gets re-evaluated rather than silently un-gating.
      if (depItem.storedStatus === 'dropped') {
        report.warnings.push({
          level: 'warning',
          code: 'blocker_dropped',
          message: `Item ${it.id} is blocked-by ${dep}, which is dropped — ${dep} will never complete, so ${it.id} is treated as unblocked; re-evaluate the dependency.`,
          itemId: it.id,
        });
      }
    }
    const decisionIds = new Set(parsed.decisions.map((d) => d.id));
    for (const dref of it.decisionRefs) {
      if (!decisionIds.has(dref)) {
        report.warnings.push({
          level: 'warning',
          code: 'unknown_decision_ref',
          message: `Item ${it.id} references unknown decision ${dref}.`,
          itemId: it.id,
        });
      }
    }
    if (!/^[A-Z]-\d{3,}$/.test(it.id)) {
      report.errors.push({
        level: 'error',
        code: 'malformed_item_id',
        message: `Item id ${it.id} is not in P-NNN form.`,
        itemId: it.id,
      });
    }
    // An `importance:` value the parser didn't recognise was degraded to
    // `normal` (silently — a parseWarning would become an error above).
    // Surface it here as a soft WARNING so a typo'd level is visible
    // without failing CI. Mirrors the parser's `[a-z]+` token boundary.
    const impRaw = /\bimportance\s*:\s*([a-z]+)/i.exec(it.rawLine);
    if (impRaw && !(IMPORTANCE_LEVELS as readonly string[]).includes((impRaw[1] ?? '').toLowerCase())) {
      report.warnings.push({
        level: 'warning',
        code: 'unknown_importance',
        message: `Item ${it.id} has importance: ${impRaw[1]} which isn't one of ${IMPORTANCE_LEVELS.join('/')} — treated as normal.`,
        itemId: it.id,
      });
    }
  }

  const resolved = resolveEffectiveStatus(parsed);
  for (const m of resolved.missingRefs) {
    report.errors.push({
      level: 'error',
      code: 'missing_blocker',
      message: `Item ${m.itemId} blocked-by ${m.ref}, which doesn't exist.`,
      itemId: m.itemId,
    });
  }
  for (const cid of resolved.cycleMembers) {
    report.errors.push({
      level: 'error',
      code: 'cycle',
      message: `Item ${cid} is part of a blocked-by cycle.`,
      itemId: cid,
    });
  }

  for (const it of parsed.items) {
    // §3.4: the stored `blocked` token is reserved for *external*
    // blockers (upstream PR, vendor). Internal dependencies use
    // blocked-by and are computed — so a stored `blocked` that also
    // carries blocked-by is a contradiction; the token should be `todo`.
    if (it.storedStatus === 'blocked' && it.blockedBy.length > 0) {
      report.warnings.push({
        level: 'warning',
        code: 'stored_blocked_with_blocked_by',
        message:
          `Item ${it.id} is stored as 'blocked' and also has blocked-by — 'blocked' is for external blockers only; internal deps are computed from blocked-by, so the stored token should be 'todo'.`,
        itemId: it.id,
      });
    }
    // §3.3: every item lives under a `## Phase` heading.
    if (it.phase === null) {
      report.warnings.push({
        level: 'warning',
        code: 'unphased_item',
        message: `Item ${it.id} is not under a '## Phase' heading — §3.3 expects every item to live in a phase section.`,
        itemId: it.id,
      });
    }
  }

  // P-004 / D-005: if this plan ACTUALLY promoted features (i.e.
  // harness_features_consolidated has rows with
  // metadata.source_plan === <this slug>), the plan body should have
  // a ## Promoted block recording them.
  //
  // The trigger is semantic, not syntactic. The earlier version
  // regex-scanned the plan body for F-NNN-shaped strings, which
  // false-positived on any plan that mentioned a feature id in
  // *prose* — even purely as documentation ("here's how F-FIX-024
  // works"). Querying PG for features that claim this slug as their
  // source asks the right question: did this plan actually mint
  // features?
  //
  // Severity is date-gated against the migration ship date. Plans
  // CREATED before then won't have the block until backfilled — emit
  // a WARNING. Plans created AFTER should always have it — emit an
  // ERROR. Backfill state takes precedence: a plan with the block
  // already silences the check regardless of created-date.
  const PROMOTED_BLOCK_ENFORCEMENT_DATE = '2026-05-24';
  const hasPromotedBlock = /^## Promoted\b/m.test(parsed.raw);
  if (!hasPromotedBlock) {
    const planSlug = parsed.frontmatter.slug ?? parsed.slug;
    const promotedCount = await countFeaturesFromPlan(planSlug);
    if (promotedCount > 0) {
      const createdStr = parsed.frontmatter.created;
      const isPostMigration =
        typeof createdStr === 'string' && createdStr >= PROMOTED_BLOCK_ENFORCEMENT_DATE;
      const finding: LintFinding = {
        level: isPostMigration ? 'error' : 'warning',
        code: 'missing_promoted_block',
        message: isPostMigration
          ? `Plan promoted ${promotedCount} feature(s) (metadata.source_plan == ${planSlug}) but the body has no \`## Promoted\` block — run plans:promote apply=true to regenerate it.`
          : `Plan promoted ${promotedCount} feature(s) (metadata.source_plan == ${planSlug}) but the body has no \`## Promoted\` block — run plans:promote apply=true (or the backfill script) to generate it.`,
      };
      if (isPostMigration) {
        report.errors.push(finding);
      } else {
        report.warnings.push(finding);
      }
    }
  }

  // (The former `updated_lags_mtime` warning compared frontmatter `updated:`
  // against the plan FILE's git mtime. Plans are PG-canonical now — there is no
  // file, and the row's `updated_at` is auto-bumped on every write, so there's
  // no faithful equivalent. Dropped with plans-pg-canonical-migration-2026-06-03.)

  // P-002 (promote-spawn-child-harness, D-001): a `## Promote` wave that declares
  // `spawn_child` creates a NEW child harness rather than promoting into the
  // current one — a heavier act only justified at a repo/worktree boundary or for
  // work needing its own lifecycle. That boundary is never mechanically
  // detectable, so this is a WARNING (never an error): prompt the author to
  // confirm the justification. A sharper warning fires when neither `repo` nor
  // `template` is given (the child's target tree is ambiguous). Only spawn_child
  // findings are surfaced here — a malformed/absent `## Promote` block yields a
  // null policy and is left alone (it's not this check's remit).
  const promote = parsePromotePolicy(parsed.raw);
  if (promote.policy) {
    for (const w of promote.policy.waves) {
      const child = w.spawn_child;
      if (!child) continue;
      report.warnings.push({
        level: 'warning',
        code: 'spawn_child_wave',
        message:
          `Wave "${w.id}" declares spawn_child "${child.slug}", which creates a NEW child harness. ` +
          `Per D-001, spawn_child is only justified for cross-repo / own-worktree work or work needing its own ` +
          `lifecycle — same-repo sub-work should stay as features in the current harness. Confirm the boundary justification.`,
      });
      if (!child.repo && !child.template) {
        report.warnings.push({
          level: 'warning',
          code: 'spawn_child_ambiguous_target',
          message:
            `Wave "${w.id}" spawn_child "${child.slug}" gives neither repo nor template — the child's target tree is ` +
            `ambiguous. Set spawn_child.template (a spawnable template) or spawn_child.repo (a git URL).`,
        });
      }
    }
  }

  return report;
}

export default defineTool({
  name: 'plans:lint',
  description:
    "Validate plan files. Legacy plans are exempt. Returns errors + warnings per plan. CI should fail on any error; warnings are informational.",
  guidance: {
    when: 'You\'re editing a plan and want to verify it parses cleanly, or you\'re running the doc-tree health check.',
    notWhen:
      'You just want to read plans — use plans:list/get.',
    chaining: 'plans:lint → plans:get { slug } for the failing plan to see context.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);

    let reports: PlanLintReport[];
    if (args.slug) {
      const r = await lintPlan(args.slug, opts);
      if (!r) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_found', slug: args.slug }) }],
          isError: true,
        };
      }
      reports = [r];
    } else {
      const includeArchived = args.includeArchived === true;
      const entries = await listPlanFiles(opts);
      const filtered = includeArchived ? entries : entries.filter((e) => !e.archived);
      reports = [];
      for (const e of filtered) {
        const r = await lintPlan(e.slug, opts);
        if (r) reports.push(r);
      }
    }

    const totalErrors = reports.reduce((n, r) => n + r.errors.length, 0);
    const totalWarnings = reports.reduce((n, r) => n + r.warnings.length, 0);
    const exempt = reports.filter((r) => r.exempt).length;

    ctxAny.metadata?.({
      planCount: reports.length,
      errors: totalErrors,
      warnings: totalWarnings,
      exempt,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: totalErrors === 0,
            totalErrors,
            totalWarnings,
            exempt,
            reports,
          }),
        },
      ],
    };
  },
});
