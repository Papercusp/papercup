/**
 * plans:audit — record a code-truth audit of a plan
 * (plan-completion-audit-and-acceptance-verdict-2026-08-13 P-002).
 *
 * The implementer traces every plan item to the code that implements it and CITES it,
 * before authoring the acceptance rubric (plan D-004). Citations of kind `code`/`test`
 * are resolved against the real tree HERE, at write time, so a fabricated path fails
 * immediately rather than at ship time — and a stored audit is therefore always
 * self-consistent. The completion gate re-resolves them again later, because the tree
 * moves between audit and ship.
 *
 * WHY VALIDATION IS COLLECTED, NOT SHORT-CIRCUITED: an audit of a 20-item plan is one
 * expensive pass of agent attention. Failing on the first bad citation would send the
 * agent round the loop once per problem. Every problem is collected and returned
 * together, so one fix-up pass clears them all.
 *
 * NOT BULK: the house contract is bulk-by-default, but an audit is inherently one
 * plan's worth of work and its payload is large. Auditing two plans in one call has no
 * real caller, so the single-plan shape is the honest one.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { execFileSync } from 'node:child_process';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveAgentIdentity } from '../coordination/identity';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import {
  AUDIT_VERDICTS,
  CITATION_KINDS,
  citationBlobSha,
  getEffectiveItemAudits,
  getPlanItemStatuses,
  isVerifyingCitation,
  prepareAuditPassEntries,
  recordPlanAudit,
  repoCitationContextForHarness,
  resolveCitation,
  summarizeCoverage,
  type AuditCitation,
  type AuditItemEntry,
} from '../../plan-audits';

const citationSchema = z.object({
  kind: z.enum(CITATION_KINDS).describe(
    "`code`/`test` RESOLVE against the tree (path required, must name a real file) and are the ONLY kinds that count as verification. `doc` records where a non-source deliverable lives: give `path` if it is a tree file (resolved like any other path) or `ref` + `reason` if it is a PG-canonical doc — either way it never supports `implemented`. `none` is the escape hatch and REQUIRES `reason`. The unverified counts come back in the result and go in front of the independent grader, because a self-audit cannot police its own use of them.",
  ),
  path: z.string().min(1).optional().describe('Repo-relative path. No leading `/` or `~`, no `..` segments — a citation that needs one is not evidence.'),
  line: z.number().int().positive().optional().describe('Optional line number, validated against the file\'s ACTUAL length — a hallucinated line is refused.'),
  symbol: z.string().min(1).optional().describe('Optional symbol that must literally appear in the cited file.'),
  ref: z.string().min(1).optional().describe('Doc id — for a `doc` citation naming a PG-canonical doc rather than a tree file. Requires `reason` too.'),
  reason: z.string().min(1).optional().describe('REQUIRED for kind `none`, and for a `doc` cited by `ref` alone: why this item has no code-resolvable artifact.'),
});

const itemSchema = z.object({
  itemId: z.string().regex(/^P-\d{3,}$/).describe('The plan item this entry audits.'),
  verdict: z.enum(AUDIT_VERDICTS).describe(
    'implemented (you READ the code that implements it — REQUIRES a resolving `code`/`test` citation; a `doc` citation cannot support this verdict) | not-code (a decision/doc/investigation — REQUIRES `note`, and is counted, because it exempts the item from code verification) | partial | missing | dropped (intentionally departed from — REQUIRES `note`). Per plan D-002 no verdict refuses a ship on its own; they RECORD. The ship-blocking question is the item\'s own status.',
  ),
  citations: z.array(citationSchema).max(20).optional(),
  note: z.string().min(1).max(2000).optional().describe('Free note. REQUIRED when verdict is `dropped` — the intentional-departure reason (D-002): going against the plan is fine, going against it silently is not. Also REQUIRED when verdict is `not-code`: what the deliverable actually is, and why no code implements it.'),
});

const findingSchema = z.object({
  summary: z.string().min(1).max(1000),
  severity: z.string().min(1).max(40).optional(),
  disposition: z.enum(['fixed', 'filed']).describe('`fixed` — you fixed it in this pass. `filed` — it is out of scope and REQUIRES `ref`, the work-item it now lives on.'),
  ref: z.string().min(1).optional(),
});

const argsSchema = z.object({
  slug: z.string().min(1).describe('The plan being audited.'),
  harness: harnessArg,
  items: z.array(itemSchema).min(1).max(200).describe('One entry per plan item you audited.'),
  findings: z.array(findingSchema).max(50).optional().describe('Out-of-scope discoveries. A finding NEVER blocks the ship — that is what keeps "fix any bugs" from making a plan un-closeable — but a `filed` one must carry its work-item ref so nothing is silently swallowed.'),
  summary: z.string().max(4000).optional(),
  auditedSha: z.string().min(7).max(64).optional().describe('The commit audited against. Resolved from the local tree when omitted.'),
});

interface Problem {
  itemId?: string;
  code: string;
  detail: string;
}

/** Best-effort local HEAD. An audit whose sha cannot be resolved is still a real
 *  audit, so this never throws — the column is nullable for exactly this case. */
function resolveHeadSha(repoRoot: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim() || null;
  } catch {
    return null;
  }
}

export default defineTool({
  name: 'plans:audit',
  description:
    "Record a CODE-TRUTH audit of a plan. Audit ONLY the items whose requirements or evidence changed: every unlisted item with a prior audit is carried forward mechanically with its ORIGINAL per-item sha/time, so it cannot be falsely re-stamped by a pass that did not inspect it. Submitted `code`/`test` citations resolve against the real tree and store the current blob sha. THE CODE IS THE ONLY SOURCE OF TRUTH — never a doc, work-item, or memory of writing it.",
  guidance: {
    when: "You have finished implementing a plan and are heading for `shipped`. Compare every item to the ACTUAL CODE — not the plan text, not the work-item records, not your memory of writing it — then file what you found. Gaps inside the plan's scope get fixed or the item gets dropped with a reason; bugs outside it go in `findings` with a filed work-item ref.",
    returns:
      'Returns { ok, auditSeq, itemsAuditedThisPass, itemsCarriedForward, coverage, uncoveredItems }. Unlisted items with a prior entry carry forward automatically; uncoveredItems therefore names only items with NO audit history. Every submitted code/test citation records a blobSha, and each submitted item records auditedSha/auditedAt/itemTextHash. `coverage.verifiedRatio` is computed over the full effective item set.',
    notWhen:
      "Mid-implementation — the audit is post-implementation by design and a mid-flight one just goes stale. Grading a plan against its acceptance rubric — that is scorecards:emit. Recording a decision — plans:add-decision.",
    chaining:
      'plans:audit → rubrics:propose { kind:"acceptance" } → (a NON-implementer) scorecards:emit → plans:set-plan-status { status:"shipped" }.',
    seeAlso: [
      'plans:set-status (drop an item you intentionally departed from, with a reason)',
      'plans:set-plan-status (the completion gate that reads this audit)',
    ],
  },
  capability: 'plans:write',
  skipWorkspaceTx: true,
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);

    // The plan's real items. An empty read is ambiguous between "no such plan" and "the
    // index read failed", and BOTH must refuse: validating against an empty list would
    // accept every itemId, which is the opposite of this tool's job.
    const planItems = await getPlanItemStatuses(args.slug);
    if (planItems.length === 0) {
      return { data: {
        ok: false as const,
        slug: args.slug,
        error: 'plan_items_unreadable',
        message:
          `No items could be read for plan '${args.slug}'. Either the plan does not exist, or it has no ` +
          `parsed items (item lines must be \`- **P-001** \\\`todo\\\` text\`). An audit cannot be validated ` +
          `against an unknown item set, so this is refused rather than recorded.`,
      } };
    }
    const known = new Set(planItems.map((i) => i.itemId));

    const citationContext = await repoCitationContextForHarness(harnessSlug);
    if (!citationContext) {
      return { data: {
        ok: false as const,
        slug: args.slug,
        error: 'harness_repo_unresolved',
        message:
          `The canonical source root for harness '${harnessSlug ?? '(none)'}' could not be resolved. ` +
          `No audit was recorded; register/fix the harness path rather than validating citations ` +
          `against a different checkout.`,
      } };
    }
    const deps = citationContext.deps;
    const problems: Problem[] = [];
    const entries: AuditItemEntry[] = [];
    const seenItems = new Set<string>();
    let citationsChecked = 0;

    for (const it of args.items) {
      if (seenItems.has(it.itemId)) {
        problems.push({
          itemId: it.itemId,
          code: 'duplicate_item',
          detail: `'${it.itemId}' appears more than once in this audit pass`,
        });
        continue;
      }
      seenItems.add(it.itemId);
      if (!known.has(it.itemId)) {
        problems.push({
          itemId: it.itemId,
          code: 'unknown_item',
          detail: `'${it.itemId}' is not an item of plan '${args.slug}'`,
        });
        continue;
      }

      const citations = (it.citations ?? []) as AuditCitation[];

      if (it.verdict === 'implemented' && citations.length === 0) {
        problems.push({
          itemId: it.itemId,
          code: 'uncited_verdict',
          detail: `verdict 'implemented' needs at least one citation — that claim is the whole point of the audit`,
        });
      } else if (it.verdict === 'implemented' && !citations.some(isVerifyingCitation)) {
        // D-008. Requiring "at least one citation" was not enough: `doc` satisfied it, so
        // `implemented` — whose documented meaning is "traced to as-built code the auditor
        // READ" — could be claimed on a document asserting completion. Only code/test are
        // evidence; a doc says where a non-source deliverable lives, never that code exists.
        problems.push({
          itemId: it.itemId,
          code: 'implemented_without_code',
          detail:
            `verdict 'implemented' requires at least one \`code\` or \`test\` citation resolving against the ` +
            `tree — a \`doc\` citation cannot support it. Read the CODE and cite the file that implements ` +
            `'${it.itemId}'; do not rely on a doc, a work-item, or your memory of writing it. If the item's ` +
            `deliverable genuinely is not source, the verdict is 'not-code' (with \`note\`), not 'implemented'.`,
        });
      }
      if (it.verdict === 'not-code' && !it.note) {
        // The widest escape hatch in the design — wider than `none`, and unmetered until
        // D-008. A reason is the minimum bar, and summarizeCoverage now counts these.
        problems.push({
          itemId: it.itemId,
          code: 'not_code_without_reason',
          detail:
            `verdict 'not-code' requires \`note\` saying what the deliverable IS and why no code implements ` +
            `it. This verdict exempts an item from code verification, so it is recorded and counted, never ` +
            `assumed (D-008).`,
        });
      }
      if (it.verdict === 'dropped' && !it.note) {
        problems.push({
          itemId: it.itemId,
          code: 'drop_without_reason',
          detail: `verdict 'dropped' requires \`note\` — departing from the plan is fine, departing silently is not (D-002)`,
        });
      }

      const storedCitations: AuditCitation[] = [];
      for (const c of citations) {
        citationsChecked += 1;
        const res = resolveCitation(c, deps);
        if (!res.ok) {
          problems.push({
            itemId: it.itemId,
            code: `citation_${res.reason}`,
            detail: res.detail ?? `${c.kind} citation did not resolve (${res.reason})`,
          });
          storedCitations.push(c);
          continue;
        }
        if (isVerifyingCitation(c)) {
          const blobSha = citationBlobSha(c, deps);
          if (!blobSha) {
            problems.push({
              itemId: it.itemId,
              code: 'citation_blob_unreadable',
              detail: `${c.kind} citation '${c.path ?? ''}' resolved but its bytes could not be fingerprinted`,
            });
            storedCitations.push(c);
            continue;
          }
          storedCitations.push({ ...c, blobSha });
        } else {
          storedCitations.push(c);
        }
      }

      entries.push({
        itemId: it.itemId,
        verdict: it.verdict,
        citations: storedCitations,
        ...(it.note ? { note: it.note } : {}),
      });
    }

    for (const f of args.findings ?? []) {
      if (f.disposition === 'filed' && !f.ref) {
        problems.push({
          code: 'finding_undisposed',
          detail: `finding "${f.summary.slice(0, 60)}" is marked 'filed' but carries no work-item ref — file it, then cite it`,
        });
      }
    }

    if (problems.length > 0) {
      return { data: {
        ok: false as const,
        slug: args.slug,
        error: 'audit_invalid',
        problems,
        message:
          `${problems.length} problem(s) — nothing was recorded. Every problem is listed above so one fix-up ` +
          `pass clears them all. A citation that will not resolve is usually a real finding about the work, ` +
          `not a typo: if the file you expected is not there, the item may not actually be implemented.`,
      } };
    }

    const auditedSha = args.auditedSha ?? resolveHeadSha(citationContext.repoRoot);
    const auditedAt = new Date().toISOString();
    const previous = await getEffectiveItemAudits(args.slug);
    const effectiveEntries = prepareAuditPassEntries({
      planItems,
      submitted: entries,
      previous,
      auditedSha,
      auditedAt,
    });
    const submittedIds = new Set(entries.map((entry) => entry.itemId));
    const carriedItemIds = effectiveEntries
      .filter((entry) => !submittedIds.has(entry.itemId))
      .map((entry) => entry.itemId);

    const audit = await recordPlanAudit({
      planSlug: args.slug,
      harnessSlug: harnessSlug ?? '',
      // Cast at the call, exactly as the sibling set-plan-status.ts does. Passing `ctx`
      // raw makes TS infer the handler's ctx parameter as ResolveIdentityCtx, which no
      // defineTool overload supplies — the whole call then fails overload resolution with
      // a TS2769 that points at `handler` and says nothing about identity.
      createdBy: resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId,
      auditedSha,
      items: effectiveEntries,
      findings: args.findings ?? [],
      summary: args.summary ?? null,
    });

    const coverage = summarizeCoverage(effectiveEntries);
    const audited = new Set(effectiveEntries.map((e) => e.itemId));
    // Items with no current OR historical audit entry. Unlisted prior entries were
    // carried by the verb with their original provenance, so callers never have to
    // copy them forward and accidentally re-stamp them at this pass's sha (D-006).
    const uncoveredItems = planItems
      .filter((i) => !audited.has(i.itemId) && i.status !== 'dropped')
      .map((i) => i.itemId);

    await emitPlanEventForCaller(ctx as Parameters<typeof emitPlanEventForCaller>[0], {
      planSlug: args.slug,
      event: 'plan_audited',
      detail: `audit #${audit.auditSeq}`,
      after: `${coverage.auditedItems} item(s), ${citationsChecked} citation(s) resolved`,
    });

    return { data: {
      ok: true as const,
      slug: args.slug,
      auditSeq: audit.auditSeq,
      auditedSha: audit.auditedSha,
      auditedAt,
      citationsChecked,
      itemsAuditedThisPass: entries.length,
      itemsCarriedForward: carriedItemIds.length,
      carriedItemIds,
      coverage,
      uncoveredItems,
      ...(uncoveredItems.length > 0
        ? {
            note:
              `${uncoveredItems.length} non-dropped item(s) have no audit entry. Audit ONLY those listed ` +
              `items (or drop them with a reason); every other unlisted item already carried forward with ` +
              `its original provenance.`,
          }
        : {}),
    } };
  },
});
