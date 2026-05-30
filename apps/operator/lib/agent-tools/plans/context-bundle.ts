/**
 * buildPlanContextBundle — the invariant launch seed for a plan agent.
 *
 * plan-agent-launch-2026-05-21, Phase 2 (P-009 / D-002).
 *
 * `plans:launch` (P-012) seeds a launched plan agent with this bundle
 * as its `systemPromptText`. The bundle is INVARIANT — there is no
 * context-depth choice (D-002). It has three parts:
 *
 *   1. a framing preamble — what the agent is, and what to do;
 *   2. the plan doc verbatim — the settled spec (`## Now`, items,
 *      decisions, prose);
 *   3. the per-revision rationale digest — the *why* behind each past
 *      change, the reasoning the plan doc itself does not carry.
 *
 * Raw conversation transcripts are NEVER inlined (D-002 / D-005): they
 * are retrievable on demand and scoped (P-008). The rationale digest
 * is the bounded, always-seeded distillation — one short entry per
 * revision that recorded a `rationale`.
 */

import { hashPlanContent } from './content-hash';
import { readPlanBySlug, type PlanSourceOpts } from './source';
import { listPlanRevisions } from './revisions';
import type { PlanStatus } from './parser';

const SECTION_RULE =
  '═══════════════════════════════════════════════════════════════';

/**
 * The framing preamble — what a launched plan agent is and does.
 * Static: every launch gets the same instruction (D-002 — the seed is
 * invariant, no context-depth knob).
 */
const LAUNCH_PREAMBLE = `# Plan agent — launched to advance a plan

You are an autonomous agent launched from a Papercusp plan. Your job
is to move that plan forward.

Read the plan below in full, starting with its \`## Now\` block — it
states where the plan stands and what the next action is. Then pick
up the next actionable item and work it.

The plan doc is the settled spec. The revision history that follows
it is the *reasoning* — why each past change was made, the arguments
and constraints that shaped decisions but were never written as plan
lines. Treat it as binding context: it is there so you do not
re-litigate questions the plan has already settled.

When you change the plan, record your reasoning — pass a \`rationale\`
to the \`plans:*\` write verb you use. That rationale becomes the
always-loaded context for the next agent launched on this plan.`;

/** One revision's rationale, as fed to the digest. */
export interface PlanBundleRationale {
  /** 1-based per-plan revision number. */
  seq: number;
  /** Revision creation time, epoch ms. */
  createdAt: number;
  /** Who made the revision. */
  authorKind: 'agent' | 'human';
  /** The recorded "why" — non-empty (the assembler is fed only
   *  revisions that have a rationale). */
  rationale: string;
}

/** Flat input to the pure assembler — everything the seed text needs,
 *  in a shape trivial to construct in a test. */
export interface PlanBundleInput {
  title: string;
  slug: string;
  status: PlanStatus | null;
  /** The plan doc verbatim — the parser `raw` field. */
  planMarkdown: string;
  /** Revision rationales newest-first; only revisions that recorded
   *  one (rationale-less revisions are omitted, not shown as blanks). */
  rationales: PlanBundleRationale[];
}

/** The assembled bundle plus the launch metadata `plans:launch` needs. */
export interface PlanContextBundle {
  /** The assembled seed text — preamble + plan doc + rationale digest.
   *  Goes straight into the plan-agent runner's `systemPromptText`. */
  text: string;
  slug: string;
  /** Frontmatter title, or the slug when untitled. */
  title: string;
  /** Lifecycle status — P-012 warns before launching a `superseded` plan. */
  status: PlanStatus | null;
  /** True when the plan lives in `docs/plans/archive/`. */
  archived: boolean;
  /** `hashPlanContent` of the plan doc — byte-identical to `plans:get`'s
   *  `contentHash`; P-012 stamps it on the `plan_runs` row as
   *  `plan_content_hash` (P-023's version badge compares against it). */
  contentHash: string;
  /** Number of revisions whose rationale entered the digest. */
  rationaleCount: number;
}

/** Render one revision as a digest entry — a `· rev N` header line and
 *  the rationale indented beneath it (continuation lines indented too,
 *  so a multi-line rationale stays visually grouped). */
function formatRationaleEntry(r: PlanBundleRationale): string {
  const date = new Date(r.createdAt).toISOString().slice(0, 10);
  const body = r.rationale
    .trim()
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
  return `· rev ${r.seq} — ${date} — ${r.authorKind}\n${body}`;
}

/**
 * Assemble the seed text. Pure — no IO — so the assembly is unit
 * testable without the FS or the embedded PG; `buildPlanContextBundle`
 * does the reads and calls this.
 */
export function assemblePlanContextBundleText(input: PlanBundleInput): string {
  const headerLines = [
    `THE PLAN — ${input.title}`,
    `slug: ${input.slug}   ·   status: ${input.status ?? 'draft'}`,
  ];
  if (input.status === 'superseded') {
    headerLines.push(
      '⚠ This plan is superseded — confirm it is still the right plan ' +
        'to work before making changes.',
    );
  }

  const digest =
    input.rationales.length > 0
      ? input.rationales.map(formatRationaleEntry).join('\n\n')
      : 'No revision rationales have been recorded for this plan yet.';

  return [
    LAUNCH_PREAMBLE,
    '',
    SECTION_RULE,
    headerLines.join('\n'),
    SECTION_RULE,
    '',
    input.planMarkdown.trimEnd(),
    '',
    SECTION_RULE,
    'REVISION HISTORY — the reasoning behind the plan above',
    SECTION_RULE,
    '',
    'Newest first. Each entry is one recorded change and why it was made.',
    '',
    digest,
    '',
  ].join('\n');
}

/**
 * Build the launch context bundle for a plan. Reads the plan doc from
 * the filesystem (canonical) and the rationale chain from
 * `plan_revisions`, then assembles the invariant seed.
 *
 * Returns `null` when the slug does not resolve to a plan — the caller
 * (`plans:launch`) surfaces "plan not found".
 *
 * The revision read is best-effort: the plan doc is the substance of
 * the bundle, so a `plan_revisions` outage must not block a launch —
 * the digest is simply empty when the revision DB is unreachable.
 */
export async function buildPlanContextBundle(
  slug: string,
  opts: PlanSourceOpts & { harnessSlug?: string } = {},
): Promise<PlanContextBundle | null> {
  const read = await readPlanBySlug(slug, opts);
  if (!read) return null;
  const { parsed, archived } = read;

  let rationales: PlanBundleRationale[] = [];
  try {
    const revisions = await listPlanRevisions(
      slug,
      opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {},
    );
    rationales = revisions
      .filter((r) => typeof r.rationale === 'string' && r.rationale.trim().length > 0)
      .map((r) => ({
        seq: r.seq,
        createdAt: r.createdAt,
        authorKind: r.authorKind,
        rationale: (r.rationale as string).trim(),
      }));
  } catch (err) {
    // Best-effort (D-014 spirit): a revision-DB outage must not block a
    // launch. Proceed with an empty digest; the plan doc still seeds.
    console.warn(
      `[plan-context-bundle] revision history unavailable for ${slug}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const title = parsed.frontmatter.title ?? slug;
  const status = parsed.frontmatter.status ?? null;
  const text = assemblePlanContextBundleText({
    title,
    slug,
    status,
    planMarkdown: parsed.raw,
    rationales,
  });

  return {
    text,
    slug,
    title,
    status,
    archived,
    contentHash: hashPlanContent(parsed.raw),
    rationaleCount: rationales.length,
  };
}
