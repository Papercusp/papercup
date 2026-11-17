/**
 * plans:new — create a new plan from a template.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.2.
 *
 * Slug uniqueness check + frontmatter write happen inside one
 * locks:acquire on the destination path (§4.4). Two concurrent
 * calls with the same slug get one winner; the loser sees the file
 * already exists.
 *
 * The body it writes is the exact bytes a human would type — same
 * template as the worked example in §3.7 of the plan spec.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import * as fs from 'node:fs/promises';
import { withPlanLock } from './with-plan-lock';
import { VERIFICATION_PROFILES } from '@papercusp/plan-parser';
import { resolveNewPlanVerificationProfile, stampNewPlanVerificationProfile } from './plan-verification-profile-stamp';
import { domainFailureMessage } from './plan-activation-gate';
import { listPlanIndexRows, resolvePlanScope } from './source';
import { withWorkspace } from '@papercusp/db-org';
import { validatePropertySchemaDeclaration } from '../../typed-properties-db';
import { NON_TERMINAL_PLAN_STATUSES } from './plan-start-state';
import { summarizeItemParse } from './item-parse-feedback';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { emitPlanAuthored } from '../../harness/usage-emitters';
import { resolveGoalContext, stampPlanGoalProvenance } from '../../modes/goal-context';
import { resolveAgentIdentity } from '../coordination/identity';
import { authoringReuse } from '../../code-intelligence/reuse-authoring';
import { suggestResearchAnchors } from '../../code-intelligence/research-trail';
import { sessionAllowsAmbientContext } from '../../capability-envelope/session-confinement-port';
import { productShapingScaffold, productShapingWriteAdvisory } from './product-shaping';
import { discoveryDeclarationScaffold, planDeclarationsScaffold, planDeclarationsWriteAdvisory } from './plan-declarations';
import { planAuthoringChecklist } from './plan-authoring-checklist';
import {
  parseBarMappings,
  parseRequirementBars,
  type AcceptanceBarSeedProblem,
} from '../../acceptance-bar-seed';

/**
 * A boolean flag that ALSO accepts the exact wire strings `'true'`/`'false'`.
 *
 * EI-302: a long-lived MCP session's `tools/list` schema is manifest-PINNED
 * (tool-manifest.ts freezes the exposed surface so the prompt-prefix cache
 * stays warm), so a session that began before `force` was added to plans:new
 * cannot see `force` in its cached schema. An agent that passes `force` anyway
 * sends the JSON string `"true"` (the value was never typed as a boolean), and
 * a bare `z.boolean()` rejected it → the dispatch layer threw `invalid_args`
 * (define-tool.ts), forcing a hand-call of the raw HTTP MCP projection.
 *
 * Coerce ONLY the two exact strings — never `z.coerce.boolean()`, whose
 * `"false"` → `true` footgun is exactly why `_plans-args.ts` keeps an explicit
 * allowlist instead. Every other value (including a real boolean, or a typo
 * like `"yes"`) passes through to `z.boolean()` unchanged, so a genuine mistake
 * still fails loudly AND the advertised JSON schema stays `type: boolean`
 * (the `tools/list` projection renders the pipe's boolean output).
 */
const stringTolerantBool = z.preprocess(
  (v) => (v === 'true' ? true : v === 'false' ? false : v),
  z.boolean(),
);

export const argsSchema = z
  .object({
    harness: harnessArg,
    workspaceId: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "EI-1543: explicit opt-in for an UNREGISTERED harness (no harness_registry/projects row in any " +
          "workspace): plans:new otherwise refuses to default its workspace (WI-148), even though " +
          'work_items:create succeeds. Pass the target workspace id (e.g. "default" for a throwaway harness). ' +
          'Omit normally — the workspace resolves from the harness registry.',
      ),
    slug: z
      .string()
      .min(3)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'kebab-case, ends with alphanum')
      .describe(
        'Topic slug in kebab-case. A -YYYY-MM-DD suffix is appended automatically if not already present (plan filename convention, §3.1).',
      ),
    title: hardText(LIMITS.SHORT_TITLE),
    status: z.enum([...NON_TERMINAL_PLAN_STATUSES] as [string, ...string[]]).optional()
      .describe('Initial lifecycle status. Terminal statuses can only be reached through plans:set-plan-status.'),
    ownerEmail: z
      .string()
      .email()
      .optional()
      .describe('Optional plan owner email written to frontmatter.'),
    rationale: z
      .string()
      .optional()
      .describe(
        "Optional — why this plan exists / what prompted its creation. Stored as the rationale of the plan's first revision (D-009). Alias: `goal`.",
      ),
    // tool-contract-repair-2026-09-05 P-006: `goal` is the name callers reach
    // for when stating why a plan exists — hit live by this plan's own author
    // while filing it ("plans:new rejects `goal`, wants `rationale`"). It is a
    // synonym for the same one-line purpose statement this field stores, not a
    // second field: the plan BODY has its own argument (`content`), so `goal`
    // cannot be read as "the plan's contents". `rationale` wins when both are
    // supplied.
    goal: z
      .string()
      .optional()
      .describe('Compatibility alias for `rationale` (the one-line why). The plan BODY is `content`, not this. `rationale` wins when both are supplied.'),
    content: z
      .string()
      .max(200_000)
      .optional()
      .describe(
        'Optional — the FULL plan body (the markdown BELOW the frontmatter: ## Now, ## Background, ## Requirements, ## Design, ## Phase 1 with items, ## Decisions). This is the same canonical field name used by plans:set-content. When provided, plans:new writes valid frontmatter + this content in ONE call, so you do NOT need a follow-up plans:set-content round-trip. Do NOT include your own --- frontmatter block — it is generated from slug/title/status/ownerEmail. ITEM LINES have a STRICT grammar and are the #1 fumble: an item is `- **P-001** `todo` Do the thing` — a `-`/`*` bullet, the id in **bold**, a status token in `backticks` (todo|wip|blocked|needs-human|done|dropped), then the text (optional trailing `blocked-by: P-002`, `importance: high`). A plain `- ` bullet, a `- [ ] ` checkbox, or `1. ` numbered line is NOT an item: plans:new refuses malformed item-looking lines with structured parse feedback before writing. If the body includes `## Requirements`, every `**R-1 — Title.** outcome` must also have a row in `## Design` under the exact `### Bar-to-work map for this plan` heading, using `| bar | implementing plan items | evidence plane |` and `tree`, `deployed`, or `live`. The bar cell is the bare key, for example `| R-1 | P-001 | tree |`; do not include the requirement title in that cell. plans:new validates this post-epoch BAR contract before persistence and reports the exact missing/invalid rows. plans:new returns itemsParsed + the parsed items so you can confirm they registered. If you intend to call plans:start, include substantive ## Requirements, the complete Design BAR map, and canonical P-NNN items; plans:start holds promotion until that spec triad is present. Omit content to get the empty starter template.',
      ),
    propertySchema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "OPTIONAL — typed property DECLARATIONS (P-023): name → { datatype, default?, editable_by: 'owner'|'agent'|'both' }. Each datatype must resolve in datatype_registry; defaults are validated against the datatype's payload_schema. VALUES are written later, only via plans:set-property.",
      ),
    verificationProfile: z
      .enum(VERIFICATION_PROFILES)
      .optional()
      .describe(
        "OPTIONAL — 'coding' | 'general': the default deliverable kind for the plan's items. Omit for the harness default (a code harness ⇒ coding, otherwise general).",
      ),
    force: stringTolerantBool
      .optional()
      .describe(
        'Creation is rejected with `similar_exists` + the overlapping plans when existing slugs/titles share this topic (EI-134 — duplicate plans split project history). Review the candidates; pass force: true with a nonblank rationale only for a NEW effort. The reason is stored in the first plan revision. Accepts the wire strings "true"/"false" too (EI-302).',
      ),
  })
  // EI-8285: without .strict(), an unrecognized top-level key is
  // SILENTLY STRIPPED by zod's default "strip unknown keys" behavior, so a
  // caller who typos `content` for `body` gets `ok:true` with an EMPTY
  // starter-template plan and no indication their body was dropped. .strict()
  // makes an unknown key a loud `invalid_args` validation error instead —
  // same precedent as promote-policy.ts / rubric-template.ts in this package.
  .strict();

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Ensure a slug carries the §3.1 `-YYYY-MM-DD` filename suffix.
 * Appends `today` when the slug doesn't already end with a date, so
 * the plan filename convention holds regardless of what the caller
 * passed. Exported for unit testing.
 */
export function ensureDatedSlug(slug: string, today: string): string {
  return /-\d{4}-\d{2}-\d{2}$/.test(slug) ? slug : `${slug}-${today}`;
}

function buildFrontmatter(args: {
  slug: string;
  title: string;
  status: string;
  owner: string | null;
  date: string;
}): string {
  const ownerLine = args.owner ? `owner: ${args.owner}\n` : '';
  return `---
title: ${args.title}
slug: ${args.slug}
status: ${args.status}
created: ${args.date}
updated: ${args.date}
${ownerLine}---
`;
}

export function buildTemplate(args: {
  slug: string;
  title: string;
  status: string;
  owner: string | null;
  date: string;
  /** When provided, use this as the whole body BELOW the frontmatter instead of
   *  the empty starter template (one-call create-with-content). */
  body?: string;
}): string {
  const fm = buildFrontmatter(args);
  if (args.body != null && args.body.trim().length > 0) {
    // Caller supplied the full body — write frontmatter + body. Strip any
    // leading --- frontmatter the caller mistakenly included (we own it), and
    // guarantee exactly one blank line between frontmatter and body.
    const raw = args.body.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/^\n+/, '');
    return `${fm}\n${raw}\n`;
  }
  return `${fm}
# ${args.title}

## Now

**State:** Draft. Plan body to be filled in.

**Next:** human reviews scope and lists Phase 1 items.

## Background

(Why this plan exists; what problem it addresses.)

${productShapingScaffold()}

${discoveryDeclarationScaffold()}

${planDeclarationsScaffold()}

## Phase 1 — TODO

(Use plans:add-item to populate. Each item is one line:
single id, status token, free text, optional blocked-by.)

## Decisions

(Use plans:add-decision to append. Each decision is a third-level
heading with a date line and a body paragraph.)
`;
}

/**
 * Validate the authoring shape that post-epoch activation audits consume. The
 * BAR writer refuses semantic inference: every Requirements R-N must have an
 * explicit Design map row to one or more P-NNN items. Keeping this preflight
 * beside plans:new turns a later `bar_mapping_missing` refusal into an
 * actionable creation-time error.
 *
 * Bodies without Requirements are intentionally out of this check. The empty
 * starter and legacy/non-BAR authoring paths retain their existing lifecycle.
 */
export function validateAcceptanceBarAuthoring(planContent: string): AcceptanceBarSeedProblem[] {
  if (!/^##\s+Requirements\s*$/im.test(planContent)) return [];

  // EI-28712348345595435: BOTH halves of the contract are checked on every call. This
  // used to return as soon as the requirement records failed to parse, so the map was
  // only looked at on the NEXT attempt — one refusal for "no R-N records", then a second
  // for "## Design has no Bar-to-work map", each costing a full re-send of the plan body.
  const requirements = parseRequirementBars(planContent);
  const mappings = parseBarMappings(
    planContent,
    requirements.ok
      ? new Set(requirements.bars.map((bar) => bar.barKey))
      : authoredRequirementKeys(planContent),
  );
  return [
    ...(requirements.ok ? [] : requirements.problems),
    ...(mappings.ok ? [] : mappings.problems),
  ];
}

/**
 * The R-N keys as AUTHORED under `## Requirements`, well-formed or not. Only used to
 * keep the map check honest when the records themselves failed to parse: a malformed
 * `**R-2 ...` record is already reported once, and must not be reported a second time
 * as "the map names R-2, which has no Requirements record" or hide "R-2 has no map row".
 */
function authoredRequirementKeys(planContent: string): Set<string> {
  const lines = planContent.split('\n');
  const start = lines.findIndex((line) => /^##\s+Requirements\s*$/i.test(line));
  const keys = new Set<string>();
  if (start < 0) return keys;
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    const key = /^\*\*(R-\d+)\b/.exec(line)?.[1];
    if (key) keys.add(key);
  }
  return keys;
}

/** Which pre-persistence check a problem came from. */
export type NewPlanCheck = 'item-grammar' | 'acceptance-bar' | 'property-schema' | 'similar-plans' | 'override-reason';

/** One problem found before a plan is written. `plans:new` reports ALL of them in one refusal. */
export interface NewPlanProblem {
  check: NewPlanCheck;
  code: string;
  detail: string;
}

const SIMILAR_PLANS_HINT =
  'Existing plans overlap this topic. Continue one of them (plans:get → set-now/add-item). ' +
  'Before reaching for force: true, note search:semantic does NOT cover plans (only escalations/brainstorm/turns/decisions) — ' +
  'this refusal is the only plan-aware dedup check that ran. force: true bypasses it with no other check behind it, so only ' +
  'pass it after reading the candidates above and confirming this is genuinely a new effort, not after a semantic/grep search came up clean.';

/** The map's parent section, heading and columns: one copy for the refusal block and the skeleton below. */
const BAR_MAP_SECTION = '## Design';
const BAR_MAP_HEADING = '### Bar-to-work map for this plan';
const BAR_MAP_COLUMNS = ['bar', 'implementing plan items', 'evidence plane'] as const;

/**
 * The smallest plan body that passes the whole acceptance-bar contract, returned with an
 * acceptance-bar refusal.
 *
 * WHY. Three independent reports (EI-24791664511417016, EI-25792549631608914,
 * EI-28712348345595435) describe the same author: told the rules one at a time, and still
 * opening an older plan to see where the pieces sit. Listing every problem in one refusal
 * fixes the first half. This fixes the second, by showing the three placements those
 * refusals were about: a record is a standalone paragraph (not a bullet) under
 * `## Requirements`, the map sits under `## Design` (not after the last record), and each
 * item is one bullet.
 *
 * It is an illustration, never a body to submit: the titles are placeholders. A test feeds
 * it to `validateAcceptanceBarAuthoring` and to plans:new itself, so it cannot drift from
 * the validator it illustrates.
 */
export const ACCEPTANCE_BAR_SKELETON = [
  '## Requirements',
  '',
  '**R-1 — Short title.** One sentence stating the outcome that must be true.',
  '',
  BAR_MAP_SECTION,
  '',
  BAR_MAP_HEADING,
  '',
  `| ${BAR_MAP_COLUMNS.join(' | ')} |`,
  '|---|---|---|',
  '| R-1 | P-001 | tree |',
  '',
  '## Phase 1',
  '',
  '- **P-001** `todo` the work that makes R-1 true',
  '',
].join('\n');

const ACCEPTANCE_BAR_HINT =
  'Add one map row for every **R-N — Title.** record, using only the bare R-N key in the bar cell (for example, | R-1 | P-001 | tree |); do not infer the mapping.';

/** What each failing check contributes to the refusal. Absent key = that check passed (or did not run). */
export interface NewPlanRefusalInput {
  slug: string;
  problems: NewPlanProblem[];
  parseSummary: Record<string, unknown>;
  acceptanceBarProblems: AcceptanceBarSeedProblem[];
  propertySchemaIssues?: unknown;
  similarPlans?: {
    similar: unknown[];
    semanticallyCleared: Array<{ slug: string; similarity: number }>;
    cosineConfirm: Record<string, unknown>;
  };
}

const PRIMARY_MESSAGE: Record<NewPlanCheck, (input: NewPlanRefusalInput) => string | null> = {
  'item-grammar': () =>
    'plans:new refused to create the plan because one or more item-looking lines do not match the canonical P-NNN item grammar.',
  'acceptance-bar': (input) =>
    'plans:new refused to create the plan because its Requirements would not satisfy the post-epoch acceptance BAR contract. ' +
    `${input.acceptanceBarProblems[0]?.detail ?? 'See acceptanceBar.problems'}.`,
  'property-schema': () => 'plans:new refused to create the plan because its property declarations are invalid.',
  'override-reason': () => 'An explicit similarity override requires a nonblank rationale, stored with the first plan revision.',
  // A lone similar-plans refusal keeps its established shape, which carries a hint and no message.
  'similar-plans': () => null,
};

/**
 * Build the ONE refusal for everything the pre-persistence pass found (EI-28712348345595435).
 *
 * `error` / `reason` stay those of the FIRST failing check, in the order the checks have
 * always run, so every existing matcher (`similar_exists`, `invalid_plan_content` +
 * `reason`, `bad_property_schema`) keeps working. What is new is that nothing is held
 * back for the next attempt: `problems` lists every problem from every check, each
 * failing check's detail block is present, and the authoring checklist rides along.
 *
 * Key order is deliberate. The result door clips a long payload from the END, so the
 * problems come first and the echo of parsed items — the least useful part of a
 * refusal — comes last.
 */
export function buildNewPlanRefusal(input: NewPlanRefusalInput): Record<string, unknown> {
  const { problems } = input;
  const primary = problems[0]!.check;
  const failed = new Set(problems.map((problem) => problem.check));
  const invalidContent = primary === 'item-grammar' || primary === 'acceptance-bar';
  const primaryMessage = PRIMARY_MESSAGE[primary](input);
  const message =
    problems.length > 1
      ? `plans:new found ${problems.length} problems in one pass and did not create the plan. ` +
        '`problems` lists every one: fix them all before retrying.' +
        (primaryMessage ? ` First: ${primaryMessage}` : '')
      : primaryMessage;
  const similarBlock = input.similarPlans
    ? {
        similar: input.similarPlans.similar,
        ...(input.similarPlans.semanticallyCleared.length > 0
          ? { semanticallyCleared: input.similarPlans.semanticallyCleared }
          : {}),
        cosineConfirm: input.similarPlans.cosineConfirm,
        hint: SIMILAR_PLANS_HINT,
      }
    : null;
  return {
    error: primary === 'similar-plans' ? 'similar_exists' : primary === 'override-reason' ? 'override_reason_required' : primary === 'property-schema' ? 'bad_property_schema' : 'invalid_plan_content',
    ...(primary === 'item-grammar' ? { reason: 'unparsed_item_lines' } : {}),
    ...(primary === 'acceptance-bar' ? { reason: 'acceptance_bar_authoring' } : {}),
    slug: input.slug,
    ...(message ? { message } : {}),
    problemCount: problems.length,
    problems,
    ...(failed.has('item-grammar') ? { parseFeedback: input.parseSummary } : {}),
    ...(failed.has('acceptance-bar')
      ? {
          acceptanceBar: {
            problems: input.acceptanceBarProblems,
            requiredMapHeading: BAR_MAP_HEADING,
            requiredMapSection: BAR_MAP_SECTION,
            requiredColumns: [...BAR_MAP_COLUMNS],
            allowedEvidencePlanes: ['tree', 'deployed', 'live'],
            hint: ACCEPTANCE_BAR_HINT,
            skeleton: ACCEPTANCE_BAR_SKELETON,
          },
        }
      : {}),
    ...(failed.has('property-schema') ? { issues: input.propertySchemaIssues } : {}),
    // The similar-plans block sits at the top level only when it is the primary refusal —
    // its `hint` would otherwise collide with the item-grammar hint spread in below.
    ...(similarBlock ? (primary === 'similar-plans' ? similarBlock : { similarPlans: similarBlock }) : {}),
    authoringChecklist: planAuthoringChecklist(),
    ...(invalidContent ? input.parseSummary : {}),
  };
}

/** Explicit result payload so `withPlanLock`'s `T` is fixed by the type
 *  argument, not inferred from a union-returning mutator. */
type NewPlanValue = { ok: true; slug: string } | { ok: false; code: 'slug_exists' };

/** Stopwords + boilerplate that would over-match between any two plans. */
const DEDUP_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'over', 'under',
  'plan', 'plans', 'fix', 'fixes', 'new', 'add', 'update', 'phase',
  // Generic planning verbs/nouns are not topic identity. Keep these out even
  // when a small corpus makes document-frequency suppression unavailable.
  'keep', 'keeps', 'keeping', 'restore', 'restores', 'restored', 'restoring',
  'boundary', 'boundaries',
]);

/** Meaningful topic tokens from a slug + title (date suffix dropped). */
export function dedupTokens(slug: string, title: string): string[] {
  const text = `${slug.replace(/-\d{4}-\d{2}-\d{2}$/, '')} ${title}`.toLowerCase();
  return [
    ...new Set(
      text
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !DEDUP_STOPWORDS.has(t)),
    ),
  ];
}

export interface SimilarPlan {
  slug: string;
  title: string | null;
  status: string | null;
  archived: boolean;
  /** Topic tokens shared with the proposed plan. */
  sharedTokens: string[];
}

/**
 * A token is "corpus-generic" only on a LARGE index. On a small corpus,
 * document-frequency is noise, so DF suppression is skipped entirely (nothing is
 * generic) and the matcher behaves exactly like the pre-P-003 absolute-count
 * version.
 *
 * WHY (cross-platform-hardening-and-agent-ergonomics-2026-07-05 P-003): the old
 * matcher flagged `similar_exists` on any two shared tokens, so a plan like
 * `cross-platform-hardening-and-agent-ergonomics` false-matched unrelated plans
 * that merely also contain the project-ubiquitous words `agent`/`platform` — the
 * false positive that forced a spurious `force: true`. Suppressing corpus-generic
 * tokens (self-tuning, no stopword maintenance) fixes the class without regressing
 * EI-134 dup detection: a GENUINE duplicate always shares a *distinctive* topic
 * word (by definition not ubiquitous), so it still flags.
 *
 * ─── WHY THE CUT IS CORPUS-RELATIVE, NOT AN ABSOLUTE DF FRACTION (EI-20316169827703913) ───
 * It used to be an absolute constant, `GENERIC_DF_FRACTION = 0.25` — a token had
 * to appear in more than a QUARTER of all plans. Measured 2026-09-05 over the
 * live corpus in this function's own units (slug+title tokenized by `dedupTokens`
 * over `harness_shared.harness_plans`, the same scope `listPlanIndexRows` reads:
 * workspace-scoped, `template_slug IS NULL`, n=1,726), that constant was INERT:
 *
 *   - the MOST common non-stopword token in the entire corpus is `acceptance`
 *     at 318/1,726 = 0.184 — below the 0.25 cut;
 *   - so `isGeneric` returned false for EVERY token, the `distinctive` filter
 *     rejected nothing, and P-003's suppression did nothing at all;
 *   - the tokens the filed report actually collided on sit far below it:
 *     `gate` 0.042, `green` 0.021, `integration` 0.011, `red` 0.008.
 *
 * That is why a refusal on generic gate vocabulary was still reachable AFTER
 * P-003 shipped. Replacing 0.25 with another hand-picked fraction reproduces the
 * same fragility on a timer — the corpus keeps growing and diversifying, so any
 * absolute DF cut drifts upward out of reach. The cut is instead taken from the
 * corpus's OWN head: a token is generic when it appears in at least
 * GENERIC_DF_RELATIVE of the MOST common token's document count.
 *
 * That is scale-free, and it is structurally non-vacuous: because the cut is a
 * fraction (<1) of the observed maximum, the corpus's most common token ALWAYS
 * clears it, so this mechanism can never silently go inert the way the constant
 * did. `new-dedup.test.ts` asserts that invariant directly.
 *
 * VALIDATED on the live corpus: 0.2 puts the cut at 63.6 docs and selects 21 of
 * the 2,055 shareable (df>=2) tokens — `acceptance, agent, papercusp, 2026,
 * fleet, work, sidestage, audit, release, desktop, hive, live, test, loop, gate,
 * shared, per, owner, one, system, make`. That is recognizably platform
 * vocabulary and no distinctive topic word, and it touches ~1% of the
 * vocabulary, so EI-134 duplicate detection is preserved: a genuine duplicate
 * shares a distinctive topic word by definition. Override via
 * PAPERCUSP_PLAN_GENERIC_DF_RELATIVE.
 */
const GENERIC_MIN_CORPUS = 25;
const GENERIC_DF_RELATIVE =
  Number(process.env.PAPERCUSP_PLAN_GENERIC_DF_RELATIVE ?? '') || 0.2;
/**
 * Below this many documents for the corpus's most common token, the head is too
 * flat for a relative cut to mean anything, so suppression stays OFF and the
 * pre-P-003 behavior stands. Guards the degenerate direction (under-blocking,
 * which is the EI-134 harm) rather than the over-blocking one, which `force:true`
 * can already escape.
 */
const GENERIC_MIN_MAX_DF = 10;

/**
 * Search-first dedup for plans:new (audit P-049 / EI-134) — like
 * improvements:capture, surface overlapping existing plans BEFORE a
 * duplicate splits the project history. Pure scoring over the index
 * rows' slug+title (no content).
 *
 * A candidate matches when it shares ≥2 TOPIC TOKENS (or the single token, for
 * one-token proposals) AND at least one shared token is DISTINCTIVE — i.e. not
 * corpus-generic (P-003). Matching is on tokenized SETS, not raw substrings, so
 * `cross` no longer matches `across` (the substring false-match class). Top 5 by
 * overlap, ties to non-archived.
 */
export function findSimilarPlans(
  tokens: string[],
  rows: Array<{ planSlug: string; title: string | null; status: string | null; archived: boolean }>,
): SimilarPlan[] {
  if (tokens.length === 0) return [];

  // Tokenize every row ONCE (reusing the same stopword/date/short-token filter),
  // then compute per-token document frequency across the corpus.
  const rowTokenSets = rows.map((r) => new Set(dedupTokens(r.planSlug, r.title ?? '')));
  const df = new Map<string, number>();
  for (const set of rowTokenSets) {
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  }
  // Corpus-RELATIVE genericness cut (see GENERIC_DF_RELATIVE): scale-free, so it
  // cannot drift out of reach as the corpus grows the way the old absolute
  // fraction did. `maxDf` is taken over tokens appearing in >=2 plans — a token
  // in exactly one plan carries no genericness signal.
  let maxDf = 0;
  for (const n of df.values()) if (n >= 2 && n > maxDf) maxDf = n;
  const suppressionActive = rows.length >= GENERIC_MIN_CORPUS && maxDf >= GENERIC_MIN_MAX_DF;
  // Floor at 2: a token in a single plan is never "corpus-generic", whatever the
  // relative cut works out to.
  const genericCut = Math.max(2, maxDf * GENERIC_DF_RELATIVE);
  const isGeneric = (t: string): boolean =>
    suppressionActive && (df.get(t) ?? 0) >= genericCut;

  const threshold = Math.min(2, tokens.length);
  const scored: Array<SimilarPlan & { n: number; d: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    const rowSet = rowTokenSets[i]!;
    // Token-SET intersection (not substring): `cross` ∉ "across".
    const shared = tokens.filter((t) => rowSet.has(t));
    if (shared.length < threshold) continue;
    // Require ≥1 distinctive (non-corpus-generic) shared token. On a small corpus
    // isGeneric is always false, so this is a no-op and old behavior is preserved.
    const distinctive = shared.filter((t) => !isGeneric(t));
    if (distinctive.length === 0) continue;
    const r = rows[i]!;
    scored.push({
      slug: r.planSlug,
      title: r.title,
      status: r.status,
      archived: r.archived,
      sharedTokens: shared,
      n: shared.length,
      d: distinctive.length,
    });
  }
  // Rank: most distinctive overlap first, then most total overlap, then live plans.
  scored.sort((a, b) => b.d - a.d || b.n - a.n || Number(a.archived) - Number(b.archived));
  return scored.slice(0, 5).map(({ n: _n, d: _d, ...rest }) => rest);
}

export default defineTool({
  name: 'plans:new',
  description:
    "Create a plan with a unique slug. suggestedAnchors come from this caller's trail; pass chosen links to plans:add-item anchors to store them.",
  guidance: {
    when: 'Starting a plan: plans:new { slug, title, content }. Shape brief/scenarios before requirements/tasks; plans:audit phase:shaping returns ownerWalkthrough for approval. Finalize incorporated Discovery findings before implementation review. Requirements need R-N plus requirement JSON (METHOD/check/layers) and Design "### Bar-to-work map for this plan". Fill reuse/libraries declarations (scaffolded; or notApplicable).',
    notWhen:
      'Existing plan: plans:set-content / set-now / add-decision / add-item.',
    chaining:
      'Brief → scoped discovery → incorporate findings and reuse + libraries → R-N JSON + bar-to-work map + items → plans:audit phase:discovery → implementation review → activation/spec quality → plans:start. Code-intelligence suggestions are leads, not completed investigation; pass chosen code links as anchors.',
    seeAlso: [
      'plans:add-item (populate the plan with work items)',
      'plans:set-frontmatter (fill/adjust the templated frontmatter)',
      'plans:start (begin the plan once it is filled in)',
    ],
  },
  capability: 'plans:write',
  // Idempotent-completion (backend-reliability-100pct-2026-07-03 W6/P-007; EI-11507): a plans:new
  // whose wall-clock beat the 55s transport deadline still COMMITTED the plan — the slug write runs
  // inside withPlanLock, synchronously before the handler returns. Surfacing the TRUTHFUL success
  // instead of a spurious `timeout` stops the forced verify-read; and a genuine retry is safe — the
  // plan lock's slug uniqueness makes a re-create a no-op (slug_exists), never a duplicate plan.
  // Same opt-in already shipped for plans:set-status. Inert except in the dispatch abort-race branch.
  idempotent: true,
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const date = todayISO();
    const status = args.status ?? 'draft';
    // §3.1: plan filenames carry a -YYYY-MM-DD suffix; ensureDatedSlug
    // appends today's date when the caller didn't already include one.
    const slug = ensureDatedSlug(args.slug, date);
    const body = args.content;
    const renderedBody = buildTemplate({
      slug,
      title: args.title,
      status,
      owner: args.ownerEmail ?? null,
      date,
      ...(body != null ? { body } : {}),
    });
    const parseSummary = summarizeItemParse(renderedBody, {
      bodyProvided: body != null && body.trim().length > 0,
      hintOnZeroItems: true,
    });

    // EI-28712348345595435 — ONE PASS, EVERY PROBLEM. Each check below used to return
    // its own refusal as soon as it failed, so an author met them one at a time and
    // re-sent the whole plan body for each (measured: four calls to create one small
    // draft). Every check now runs, each failure is collected here, and a single
    // refusal after the last check reports all of them. Nothing is written until
    // `problems` is empty, exactly as before.
    const problems: NewPlanProblem[] = [];

    // Parse admission. A body that contains item-looking lines but fails the strict
    // P-NNN grammar would otherwise create a plan that looks successful while
    // promoting zero items later. The refusal carries the same structured feedback
    // the body writers use, so callers can repair the exact lines without a
    // follow-up read.
    const unparsedItemLines = parseSummary.unparsedItemLines ?? 0;
    if (unparsedItemLines > 0) {
      problems.push({
        check: 'item-grammar',
        code: 'unparsed_item_lines',
        detail: `${unparsedItemLines} item-looking line(s) do not match the canonical P-NNN item grammar`,
      });
    }

    // Post-epoch plans seed acceptance BARs from Requirements plus the
    // explicit Design map during activation. Refuse an authored Requirements
    // section before persistence when that source is incomplete; otherwise the
    // creator gets a successful plans:new followed much later by an opaque
    // plans:audit `bar_mapping_missing` failure. No semantic mapping is
    // invented here — the caller must name every R-N → P-NNN edge.
    const acceptanceBarProblems = body != null && body.trim().length > 0
      ? validateAcceptanceBarAuthoring(renderedBody)
      : [];
    for (const problem of acceptanceBarProblems) {
      problems.push({ check: 'acceptance-bar', code: problem.code, detail: problem.detail });
    }

    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx);
    let creatorOwnerId: string | undefined;
    try {
      creatorOwnerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      // Some legacy in-process plan callers carry the already-resolved ownerId
      // directly rather than the transport identity fields. Preserve that
      // attributable identity so it gets the same authority fence.
      creatorOwnerId = (ctx as { ownerId?: string }).ownerId;
    }

    // ── P-023: typed property DECLARATIONS — validated BEFORE the plan is
    // created (datatype refs must resolve in datatype_registry; defaults must
    // satisfy their datatype's payload_schema), so a bad declaration refuses
    // cleanly instead of half-creating a plan that then cannot be stamped.
    let propertySchemaDoc: Record<string, unknown> | null = null;
    let propertySchemaIssues: unknown;
    if (args.propertySchema) {
      const declScope = await resolvePlanScope({
        ...(harnessSlug ? { harnessSlug } : {}),
        ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      });
      const propCheck = await withWorkspace(declScope.workspaceId, (tx) =>
        validatePropertySchemaDeclaration(tx as never, declScope.workspaceId, args.propertySchema),
      );
      if (!propCheck.ok) {
        propertySchemaIssues = propCheck.issues;
        problems.push({
          check: 'property-schema',
          code: 'bad_property_schema',
          detail: 'one or more property declarations are invalid; see `issues`',
        });
      } else {
        propertySchemaDoc = args.propertySchema;
      }
    }

    // Reuse the first revision's rationale instead of introducing a separate
    // override store. An explicit empty rationale wins over its legacy alias.
    if (args.force === true && !(args.rationale ?? args.goal ?? '').trim()) {
      problems.push({ check: 'override-reason', code: 'override_reason_required',
        detail: 'Pass a nonblank rationale explaining why this is a separate effort; it is stored in the first plan revision.' });
    }

    // Search-first dedup (audit P-049 / EI-134): surface overlapping plans
    // before creating. Index-only read (slug/title columns — no blobs);
    // archived plans count as candidates (a superseded plan on the same
    // topic is exactly the "this exists, continue it instead" signal).
    // Best-effort: an index-read failure never blocks creation.
    // P-010: token candidates cleared by cosine confirmation are surfaced on
    // the success payload so the creator sees what was cleared (and can still
    // continue one of them if the semantic verdict was wrong).
    let semanticallyCleared: Array<{ slug: string; similarity: number }> = [];
    // WI-2145556: how the cosine confirmation was cut, or that it could not run.
    // Reported on the refusal so an agent staring at `similar_exists` can tell a
    // CONFIRMED overlap from one the classifier never got to judge — the state
    // the inert 0.6 constant left every refusal in, indistinguishably.
    let cosineConfirm: Record<string, unknown> = { basis: 'not-run' };
    let similarPlans: NewPlanRefusalInput['similarPlans'];
    if (args.force !== true) {
      try {
        const rows = await listPlanIndexRows({
          ...(harnessSlug ? { harnessSlug } : {}),
          includeArchived: true,
          // Dedup matches on slug/title only (findSimilarPlans' row type is literally
          // {planSlug,title,status,archived}), so skip the items detoast entirely — it is
          // ~2/3 of this query's cost (P-006).
          includeItems: false,
        });
        let similar: Array<SimilarPlan & { similarity?: number }> = findSimilarPlans(
          dedupTokens(slug, args.title),
          rows,
        );
        // WI-10004345: an exact-slug row in this harness is not a "similar" plan, it is
        // this slug already taken. Let the lock-enforced create answer `slug_exists`,
        // the code create-or-reuse callers match, instead of a `similar_exists` that
        // lists the plan itself.
        if (harnessSlug && rows.some((row) => row.planSlug === slug)) similar = [];
        // P-010 (shared-embedding-sidecar-and-enrichment-2026-07-10): cosine
        // CONFIRMATION of the token verdict. The token matcher sees slug+title
        // tokens only, so topically-adjacent but distinct efforts false-flag
        // (it flagged this very plan's creation). A flagged candidate whose
        // migration-553 vector is semantically distant from the proposed
        // title+body is cleared; no verdict (embedder down, no stored vector,
        // vitest) keeps the token refusal unchanged — fail-open both ways.
        if (similar.length > 0) {
          try {
            const { confirmSimilarPlans } = await import('./semantic-dedup');
            const res = await confirmSimilarPlans(
              { title: args.title, body },
              similar,
              harnessSlug ? { harnessSlug } : {},
            );
            if (res.verdict) {
              similar = res.kept;
              if (res.dropped.length > 0) {
                semanticallyCleared = res.dropped.map((d) => ({ slug: d.slug, similarity: d.similarity }));
              }
              cosineConfirm = res.calibration
                ? { ...res.calibration, clearedCount: res.dropped.length }
                : { basis: 'unknown' };
            } else {
              // No cosine verdict: the token refusal below is UNCONFIRMED. Say so —
              // the corpus could not be calibrated against (too few or degenerate
              // background vectors), the embedder was down, or the candidates have
              // no stored vector. Fails safe (over-blocking), but the agent needs to
              // know the semantic check did not actually clear anything.
              cosineConfirm = {
                basis: 'unavailable',
                note: 'the cosine confirmation could not run, so these candidates are token-matches that were never semantically judged',
                ...(res.coverage?.verdict ? { corpusCoverage: res.coverage.verdict } : {}),
              };
            }
          } catch {
            /* fail-open: the token verdict stands */
          }
        }
        if (similar.length > 0) {
          similarPlans = { similar, semanticallyCleared, cosineConfirm };
          problems.push({
            check: 'similar-plans',
            code: 'similar_exists',
            detail:
              `${similar.length} existing plan(s) overlap this topic: ${similar.map((plan) => plan.slug).join(', ')}. ` +
              'Continue one of them, or pass force: true once you have confirmed this is a new effort.',
          });
        }
      } catch {
        /* dedup is advisory — never block creation on an index hiccup */
      }
    }

    // The single refusal for everything found above. Nothing has been written.
    if (problems.length > 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              buildNewPlanRefusal({
                slug,
                problems,
                parseSummary: parseSummary as unknown as Record<string, unknown>,
                acceptanceBarProblems,
                ...(propertySchemaIssues !== undefined ? { propertySchemaIssues } : {}),
                ...(similarPlans ? { similarPlans } : {}),
              }),
            ),
          },
        ],
        isError: true,
      };
    }

    // Authority is checked before withPlanLock can write the plan. This is
    // intentionally separate from the later best-effort provenance UPDATE:
    // discovering an expired holder after creation is already too late.
    if (creatorOwnerId) {
      const authorityScope = await resolvePlanScope({
        ...(harnessSlug ? { harnessSlug } : {}),
        ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
      });
      await resolveGoalContext(authorityScope.workspaceId, creatorOwnerId);
    }

    // plan-verification-profiles-2026-10-17 P-002 (R-4/R-5): resolve the profile before the lock
    // (the harness default reads the registry), then stamp it inside the creating transaction.
    const verificationStamp = await resolveNewPlanVerificationProfile({
      declared: args.verificationProfile,
      harnessSlug,
      workspaceId:
        args.verificationProfile || !harnessSlug
          ? ''
          : (
              await resolvePlanScope({
                harnessSlug,
                ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
              })
            ).workspaceId,
    });

    const rev = planRevisionCapture(
      ctx as PlanRevisionCtx,
      slug,
      // `goal` is a compatibility alias for `rationale`; an explicit
      // `rationale` wins (tool-contract-repair-2026-09-05 P-006).
      args.rationale ?? args.goal,
      harnessSlug ? { harnessSlug } : {},
    );
    const result = await withPlanLock<NewPlanValue>(
      ctx as never,
      {
        slug,
        intent: `plans:new ${slug}`,
        ...(harnessSlug ? { harnessSlug } : {}),
        ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
        afterWrite: rev.afterWrite,
        inTransaction: async (tx, _body, scope, written) => {
          if (written.ok) await stampNewPlanVerificationProfile(tx, scope, slug, verificationStamp);
        },
      },
      async (current): Promise<{ newBody: string | null; value: NewPlanValue }> => {
        if (current !== null) {
          // Slug collision — leave existing untouched, signal via value.
          return { newBody: null, value: { ok: false, code: 'slug_exists' } };
        }
        return { newBody: renderedBody, value: { ok: true, slug } };
      },
    );

    if (result.kind === 'busy') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'busy',
              busy: result.busy.map((b) => ({
                path: b.path,
                owner_label: b.owner_label,
                intent: b.intent,
                expires_ts: b.expires_ts,
              })),
            }),
          },
        ],
        isError: true,
      };
    }

    const value = result.value;
    if (!value.ok) {
      const message = domainFailureMessage(value);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: value.code, slug, ...(message ? { message } : {}) }),
          },
        ],
        isError: true,
      };
    }

    await emitPlanEventForCaller(ctx, {
      planSlug: value.slug,
      event: 'created',
      after: args.title,
      detail: args.title,
    });
    // P-070 usage ledger (best-effort): authoring a plan is contributor activity
    // on a managed harness. Operator-level plans (harness:'all') have no harness
    // slug and the ledger is per-harness, so skip those.
    if (harnessSlug) void emitPlanAuthored(harnessSlug, value.slug);

    // Migration 791: link this plan to the goal its creator is working, if any.
    // Without it a goal-mode agent's own plan is invisible on the goal page until
    // some work item stamped with that goal happens to name it — which on a fresh
    // goal is never, so the page reads as "the agent has done nothing".
    // Best-effort and un-awaited for the same reason emitPlanAuthored is: the plan
    // is already written, and provenance metadata must not fail a created plan.
    // `result.scope` is the RESOLVED pair withPlanLock actually wrote the row with
    // (resolvePlanScope collapses a member harness to its pot home). Using the
    // caller's own harnessSlug here would miss on exactly the pot-scoped plans a
    // goal creates, and miss SILENTLY — the UPDATE would match zero rows.
    // ── P-023: stamp the validated property declarations onto the row.
    // AWAITED (unlike the best-effort provenance decorations below): the
    // caller was promised a plan carrying these declarations, so a failed
    // stamp must surface rather than silently producing a schema-less plan.
    // Uses `result.scope` — the RESOLVED pair the row was actually written
    // with — for the same reason stampPlanGoalProvenance does.
    if (propertySchemaDoc) {
      await withWorkspace(result.scope.workspaceId, (tx) => tx`
        UPDATE harness_shared.harness_plans
           SET property_schema = ${JSON.stringify(propertySchemaDoc)}::text::jsonb,
               updated_at = now()
         WHERE workspace_id = ${result.scope.workspaceId}
           AND harness_slug = ${result.scope.harnessSlug}
           AND plan_slug = ${value.slug}
      `);
    }

    // A goal-local plan also gets its origin row in Blender's routed-idea ledger
    // (goal-brief-to-claimed-plan-work P-009), so its outcome feeds back like a
    // Blender-origin plan's. recordGoalLocalPlanOrigin re-reads the stamped goal_id
    // and writes nothing when another row already owns the plan's attribution.
    void stampPlanGoalProvenance({
      workspaceId: result.scope.workspaceId,
      harnessSlug: result.scope.harnessSlug,
      planSlug: value.slug,
      ownerId: creatorOwnerId,
    })
      .then(async (goalId) => {
        if (!goalId || !creatorOwnerId) return;
        const { recordGoalLocalPlanOrigin } = await import('../../scout/goal-feedback');
        await recordGoalLocalPlanOrigin({
          workspaceId: result.scope.workspaceId,
          harnessSlug: result.scope.harnessSlug,
          planSlug: value.slug,
          goalId,
          ownerId: creatorOwnerId,
        });
      })
      .catch(() => {});

    const shapingAdvisory = body != null && body.trim().length > 0 ? productShapingWriteAdvisory(body) : null;
    const declarationsAdvisory = body != null && body.trim().length > 0 ? planDeclarationsWriteAdvisory(body) : null;
    // The plan is ALREADY written here, so nothing below may throw. This used to resolve the
    // transport identity a second time with no fallback: a caller without one (the legacy
    // in-process callers `creatorOwnerId` above exists for) got an exception for a plan that
    // had been created, and its retry then met `slug_exists`. Advice is optional; reuse the
    // owner resolved above and skip the advice when there is none.
    const adviceOwner = creatorOwnerId;
    const allowAdvice = adviceOwner
      ? await sessionAllowsAmbientContext({ ownerId: adviceOwner, workspaceId: result.scope.workspaceId })
      : false;
    const reuseAdvice = allowAdvice ? await authoringReuse(ctx, { workspaceId: result.scope.workspaceId,
      harness: result.scope.harnessSlug, plan: value.slug, text: body ?? args.title }) : undefined;
    const suggestedAnchors = allowAdvice && adviceOwner ? await suggestResearchAnchors(result.scope.workspaceId,
      adviceOwner, harnessSlug ?? result.scope.harnessSlug) : undefined;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            slug: value.slug,
            filePath: result.filePath,
            revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
            verificationProfile: verificationStamp,
            suggestedAnchors,
            ...(semanticallyCleared.length > 0 ? { semanticallyCleared } : {}),
            ...parseSummary,
            // R-9: a supplied body without product shaping still lands; the
            // response carries the advisory preview + scaffold. The default
            // template already embeds the scaffold, so it never triggers this.
            ...(shapingAdvisory ? { productShaping: shapingAdvisory } : {}),
            // plan-reuse-and-library-declarations R-1: same rule for the two
            // declaration sections (the default template embeds both scaffolds).
            ...(declarationsAdvisory ? { planDeclarations: declarationsAdvisory } : {}),
            ...(reuseAdvice ? { reuseAdvice } : {}),
          }),
        },
      ],
    };
  },
});

// Re-export for test convenience; unused otherwise.
export { fs };
