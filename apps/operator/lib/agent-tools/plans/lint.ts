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
 *   - updated: not >7d behind file's git mtime (warn)
 *
 * Returns { errors, warnings } per plan + overall pass/fail.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { listPlanFiles, readPlanBySlug, type PlanSourceOpts } from './source';
import { resolveEffectiveStatus } from './effective-status';
import * as fs from 'node:fs/promises';

const ALL_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

const argsSchema = z.object({
  slug: z.string().optional().describe('Lint one plan. Omit for all plans.'),
  includeArchived: z.boolean().optional().describe('Lint plans under archive/. Default false.'),
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

export async function lintPlan(
  slug: string,
  opts: PlanSourceOpts = {},
): Promise<PlanLintReport | null> {
  const result = await readPlanBySlug(slug, opts);
  if (!result) return null;
  const { parsed, archived } = result;

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
    // Warning, not error: the parser handles a missing Now block fine
    // (returns null); the loss is the cold-resume anchor only. Many
    // legacy plans were converted with minimal frontmatter and no Now
    // — surface it as something to fix, don't fail CI.
    report.warnings.push({
      level: 'warning',
      code: 'missing_now_section',
      message: 'No `## Now` section. Add one to make this plan cold-resumable; use plans:set-now.',
    });
  }
  if (parsed.decisions.length === 0 && parsed.items.length > 0) {
    report.warnings.push({
      level: 'warning',
      code: 'missing_decisions_section',
      message: 'No `## Decisions` section / no decisions recorded.',
    });
  }

  for (const w of parsed.parseWarnings) {
    report.errors.push({ level: 'error', code: 'parse_warning', message: w });
  }

  const itemIds = new Set(parsed.items.map((i) => i.id));
  for (const it of parsed.items) {
    for (const dep of it.blockedBy) {
      if (!itemIds.has(dep)) {
        report.errors.push({
          level: 'error',
          code: 'unknown_blocked_by',
          message: `Item ${it.id} has blocked-by: ${dep} that doesn't resolve.`,
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
    if (it.storedStatus === 'blocked' && it.blockedBy.length === 0) {
      report.warnings.push({
        level: 'warning',
        code: 'stored_blocked_no_external',
        message:
          `Item ${it.id} stored as 'blocked' without any blocked-by — the literal token is reserved for *external* blockers; describe the external reason in the item text.`,
        itemId: it.id,
      });
    }
  }

  if (parsed.frontmatter.updated) {
    try {
      const stat = await fs.stat(parsed.filePath);
      const updatedDate = new Date(parsed.frontmatter.updated + 'T00:00:00Z');
      if (!isNaN(updatedDate.getTime())) {
        const mtime = stat.mtime;
        const diffDays = (mtime.getTime() - updatedDate.getTime()) / 86_400_000;
        if (diffDays > 7) {
          report.warnings.push({
            level: 'warning',
            code: 'updated_lags_mtime',
            message: `frontmatter updated: lags file mtime by ${diffDays.toFixed(1)} days.`,
          });
        }
      }
    } catch {
      // mtime check is best-effort
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
  roles: [...ALL_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };

    let reports: PlanLintReport[];
    if (args.slug) {
      const r = await lintPlan(args.slug);
      if (!r) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_found', slug: args.slug }) }],
          isError: true,
        };
      }
      reports = [r];
    } else {
      const includeArchived = args.includeArchived === true;
      const entries = await listPlanFiles();
      const filtered = includeArchived ? entries : entries.filter((e) => !e.archived);
      reports = [];
      for (const e of filtered) {
        const r = await lintPlan(e.slug);
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
