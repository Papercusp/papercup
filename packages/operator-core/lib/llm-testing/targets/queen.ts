/**
 * `queen` ChatTarget — in-process behavioral SUT for the **hive Queen's
 * spawn prompt**, composed the same way the live spawn composes it: the shared
 * generic method `blueprints/base/prompts/queen.base.md` + the coding decomposition
 * delta `blueprints/coding/prompts/queen.md` (P-007/P-008; see `loadQueenPrompt`).
 *
 * scout-idea-grading-2026-06-12 B-06/B-08 follow-on: the Queen's grading
 * responsibility (D-004 — grade ungraded routed Scout drafts 1–5 while
 * triaging, keyed by routedRef per D-007) is a prompt-level behavior, so the
 * deterministic gates (tools-md-sync, prompt-assembly, the C-2/C-3 suites)
 * cannot observe whether she actually CALLS `scout:grade-idea` during a
 * triage turn. This target reuses the `su` in-process Anthropic tool loop
 * (prompt-from-SOURCE + stubbed executor — see ./su for the full rationale)
 * with the Queen's blueprint prompt and a curated slice of her blueprint
 * tool surface (`blueprints/coding/blueprint.yaml` dependencies.tools).
 *
 * Catalog fidelity notes (mirrors su-catalog's reasoning):
 *   - Names + load-bearing args are real; the slice covers the verbs a triage
 *     turn plausibly reaches for, so grading must be CHOSEN among genuine
 *     alternatives, not forced by an empty menu.
 *   - `scout:grade-idea`'s schema mirrors C-3 + D-007 exactly — ideaId XOR
 *     routedRef, int grade 1..5, optional feedback ≤2000. `gradedBy` is
 *     deliberately ABSENT (derived server-side from the caller role, never an
 *     arg) — Q01 asserts the model does not invent it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SuTarget } from './su';
import { buildCatalog, type SuCatalogEntry } from './su-catalog';

const QUEEN_PROMPT_REL = join(
  'libs', 'papercusp', 'packages', 'harness', 'blueprints', 'coding', 'prompts', 'queen.md',
);

function resolveQueenPromptPath(): string {
  const override = process.env.PAPERCUSP_QUEEN_PROMPT_PATH?.trim();
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // packages/operator-core/lib/llm-testing/targets → repo root (5 up)
    join(here, '..', '..', '..', '..', '..', QUEEN_PROMPT_REL),
    join(process.cwd(), QUEEN_PROMPT_REL),
    join(process.cwd(), '..', '..', QUEEN_PROMPT_REL), // when cwd = apps/operator
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `queen target: could not locate the Queen blueprint prompt (${QUEEN_PROMPT_REL}). ` +
      `Set PAPERCUSP_QUEEN_PROMPT_PATH. Tried:\n  ${candidates.join('\n  ')}`,
  );
}

let _promptCache: string | undefined;

/**
 * Compose the Queen's prompt from SOURCE the SAME way the live spawn does
 * (domain-generic-hive-architecture-2026-06-18 P-007/P-008): the generic
 * orchestration method now lives in the shared base prefix
 * `blueprints/base/prompts/queen.base.md`, and `blueprints/coding/prompts/queen.md`
 * is the thin coding decomposition DELTA. `resolvePromptFiles` composes them as
 * `[base/queen.base.md, hive/queen.md]` joined by `\n\n---\n\n`; this target must
 * mirror that, or the behavioral SUT would run against the delta alone (missing
 * the triage/grading method the scenarios assert). The base prefix is derived as
 * a sibling of the resolved hive main, so it follows the `PAPERCUSP_QUEEN_PROMPT_PATH`
 * override too; an absent prefix (older tree / out-of-blueprints override) falls
 * back to the main alone — byte-identical to the pre-split behavior.
 */
export function loadQueenPrompt(): string {
  if (_promptCache !== undefined) return _promptCache;
  const mainPath = resolveQueenPromptPath();
  const main = readFileSync(mainPath, 'utf8');
  // …/blueprints/coding/prompts/queen.md → …/blueprints → base/prompts/queen.base.md
  const blueprintsDir = dirname(dirname(dirname(mainPath)));
  const basePrefixPath = join(blueprintsDir, 'base', 'prompts', 'queen.base.md');
  const body = existsSync(basePrefixPath)
    ? `${readFileSync(basePrefixPath, 'utf8').trim()}\n\n---\n\n${main.trim()}`
    : main;
  _promptCache =
    'You are the Queen of a Papercusp Hive (a spawned placement/triage agent turn). ' +
    'The following is your operating prompt — follow it exactly.\n\n' +
    body;
  return _promptCache;
}

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});

/**
 * Curated Queen catalog — a faithful slice of blueprints/coding/blueprint.yaml
 * dependencies.tools, sized for cheap matrix runs (su-catalog's bounded-cost
 * reasoning). The triage-relevant spread plus believable neighbors.
 */
export const QUEEN_CATALOG: ReadonlyArray<SuCatalogEntry> = [
  {
    name: 'scout:grade-idea',
    description:
      "Grade a routed Scout idea 1–5 with optional feedback (≤2000 chars). Grades steer Scout's learning: fractional win credit in the lens weights + the critique primed into next cycles' ideator prompts. Key by ideaId or routedRef — exactly one.",
    input: obj(
      {
        ideaId: { type: 'string', description: "The routed idea's ledger id. Pass this OR routedRef, not both." },
        routedRef: {
          type: 'string',
          description:
            "Alternate key: the routed artifact's change-feed ref — 'plan:<slug>' | 'wi:<id>' | 'gym:<id>' — for callers that hold the artifact but not the scout ideaId.",
        },
        grade: { type: 'integer', minimum: 1, maximum: 5, description: '1–5: 5 = clear win, 3 = neutral, 1 = clear loss.' },
        feedback: { type: 'string', maxLength: 2000, description: "Free-text critique shown to next cycles' ideators." },
      },
      ['grade'],
    ),
  },
  {
    name: 'work_items:list',
    description: 'List work items for a harness (state/kind filters) — the ranked backlog read.',
    input: obj({
      harness: { type: 'string' },
      state: { type: 'string', description: 'Filter: todo | wip | blocked | done | passed …' },
      kind: { type: 'string', description: 'Filter: feature | bug | change | task | chunk.' },
    }),
  },
  {
    name: 'work_items:get',
    description: 'Read one work item in full (body, state, claims, comments).',
    input: obj({ id: { type: 'string' } }, ['id']),
  },
  {
    name: 'work_items:set_priority',
    description: "Set a work item's priority/rank in the queue.",
    input: obj({ id: { type: 'string' }, priority: { type: 'integer' } }, ['id', 'priority']),
  },
  {
    name: 'improvements:triage',
    description:
      "Queen-turn triage: record a routing decision per scored idea. mode 'summary' shows the breakdown; 'triage-all' lists deterministic route proposals (human queue in rank order, each with its rank breakdown); 'triage-one' PERSISTS the Queen's decision for one idea — place (backlog/implementation) | gate (human review) | gym (A/B-verify a process/prompt change) | reject (close with the decided reason).",
    input: obj({
      mode: { type: 'string', description: "summary | triage-all | triage-one | retriage-all." },
      ideaId: { type: 'string', description: 'For triage-one, the idea to decide (e.g. EI-352).' },
      decision: { type: 'string', description: "For triage-one: place | gate | gym | reject." },
      reason: { type: 'string', description: 'Required with decision — recorded on the idea lifecycle.' },
    }),
  },
  {
    name: 'improvements:digest',
    description:
      'The scored improvement digest. humanQueue arrives RANKED by the one queue ranker (P-040): each item carries rank { score, features: [{ feature, value, weight, contribution, reasons }] } across blocking-impact / deferral-interest / owner-preference / calibration.',
    input: obj({ harness: { type: 'string' } }),
  },
  {
    name: 'calibration:summary',
    description:
      'Per-persona per-domain calibration from recorded bets: Brier score, base rate, sample size, and the shrunk trust weight (0.5 = unknown, →1 proven-sharp, →0 proven-noisy) — plus the open-bet rollup. Read-only.',
    input: obj({
      domain: { type: 'string', description: "Filter: 'fix-survival' | 'plan-ship' | 'flake-recurrence'." },
      predictor: { type: 'string', description: 'Filter to one persona (ownerId).' },
    }),
  },
  {
    name: 'plans:get',
    description: 'Fetch one plan by slug: frontmatter, ## Now, items, decisions.',
    input: obj({ slug: { type: 'string' }, harness: { type: 'string' } }, ['slug']),
  },
  {
    name: 'curation:change-feed',
    description: "The Hive's change feed — completions, proposals, reverts since a timestamp.",
    input: obj({ since_ts: { type: 'string' } }),
  },
  {
    name: 'fleet:assignments',
    description: "Who's on what: per-agent presence + plan-item and work-item claims.",
    input: obj({ harness: { type: 'string' } }),
  },
  {
    name: 'bee:spawn',
    description: 'Spawn a bee on a work item with a situational brief (placement decision).',
    input: obj({ work_item: { type: 'string' }, brief: { type: 'string' } }, ['work_item']),
  },
  {
    name: 'scheduler:set_claim_spec',
    description:
      "Steer a bee's claim path by authoring (or re-steering) its per-bee claim SPEC — a versioned, declarative scoped VIEW (filter) + ORDERING (rank) over the live work-item DAG that the scheduler compiles into the bee's scheduler:get_next pulls. This is how the Queen decentralizes PICKUP while centralizing JUDGMENT: you decide WHICH items are eligible + in what order (the spec); the bee decides WHEN to take the next one (the pull). Re-steer a running bee by bumping the spec REVISION, not by re-dispatching each item.",
    input: obj(
      {
        beeId: { type: 'string', description: "The bee to steer (its spawn/agent id)." },
        spec: {
          type: 'object',
          description:
            "The claim spec: { view: { filter }, rank: { mode, terms } } over the primitive vocabulary (item fields priority/tags/kind/paths/plan/plan_item/age, predicates =/!=/</in/contains/glob with all/any/not, rank terms incl. affinity). The spec NARROWS + REORDERS within the global floors — it can never widen past a floor.",
        },
      },
      ['beeId', 'spec'],
    ),
  },
  {
    name: 'scheduler:running',
    description:
      "The live-execution view: each running bee run — the bee, its current item, its spec specId@revision, progress, lease/heartbeat, idle/blocked reason. Read it to see whether bees are pulling under the specs you authored.",
    input: obj({ harness: { type: 'string' } }),
  },
  {
    name: 'coord:send',
    description: 'Send a coordination message to agents (inject; wake:true to re-invoke a sleeper).',
    input: obj({
      to: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
      wake: { type: 'boolean' },
    }, ['to', 'summary']),
  },
  {
    name: 'coord:inbox',
    description: 'Read your coordination inbox (messages, handoffs, escalations addressed to you).',
    input: obj({ limit: { type: 'integer' } }),
  },
  {
    name: 'harness:escalation',
    description: 'Read open escalations for a harness (the needs-human surface).',
    input: obj({ harness: { type: 'string' } }),
  },
  {
    name: 'hive:declare-wake',
    description: 'Declare your next wake (time or event) before ending the turn.',
    input: obj({ in_sec: { type: 'integer' }, on_event: { type: 'string' }, note: { type: 'string' } }),
  },
  {
    name: 'memory:search',
    description: 'Search persistent memories by semantic similarity.',
    input: obj({ query: { type: 'string' } }, ['query']),
  },
];

export const QUEEN_BEHAVIORS = ['grade-routed-scout-ideas', 'triage-routed-drafts', 'triage-ranked-queue'];

/** The `queen` target — the su in-process loop with the Queen's prompt + catalog. */
export function makeQueenTarget(): SuTarget {
  return new SuTarget({
    id: 'queen',
    behaviors: QUEEN_BEHAVIORS,
    catalog: buildCatalog(QUEEN_CATALOG),
    loadSystemPrompt: loadQueenPrompt,
  });
}
