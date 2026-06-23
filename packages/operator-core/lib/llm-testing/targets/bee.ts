/**
 * `bee` ChatTarget — in-process behavioral SUT for the **hive bee's spawn prompt**
 * (hybrid-bee-scheduler-work-stealing-2026-06-22, P-003 verification).
 *
 * Composed the SAME way the live spawn composes a bee role: the shared base bee persona
 * `blueprints/base/prompts/bee.base.md` (the universal generic-worker prompt — there is no
 * coding-specific `prompts/bee.md` delta layered onto it for the scheduling behavior we test;
 * the base file carries the get_next mandate). The deterministic gates (tools-md-sync,
 * blueprint-prompt-dark-tools, prompt-assembly) prove the WIRING — the bee prompt names
 * `scheduler:get_next` AND the bee blueprint declares it — but they cannot observe whether the
 * prompt actually PRODUCES pull-via-scheduler behavior on a "claim your next item" turn. This
 * target does, reusing the `su` in-process Anthropic tool loop (prompt-from-SOURCE + stubbed
 * executor — see ./su) with the bee persona and a curated slice of the bee blueprint tool
 * surface (`blueprints/bee/blueprint.yaml` dependencies.tools).
 *
 * Catalog fidelity (mirrors su-catalog / queen.ts):
 *   - Names + load-bearing args are real; the slice includes BOTH the scheduler pull path
 *     (`scheduler:get_next`) AND the legacy self-scan alternative (`work_items:list` +
 *     `work_items:claim`) so pulling via the scheduler is CHOSEN among genuine alternatives,
 *     not forced by an empty menu — the B01 scenario asserts the bee does NOT self-freelance.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SuTarget } from './su';
import { buildCatalog, type SuCatalogEntry } from './su-catalog';

const BEE_PROMPT_REL = join(
  'libs', 'papercusp', 'packages', 'harness', 'blueprints', 'base', 'prompts', 'bee.base.md',
);

function resolveBeePromptPath(): string {
  const override = process.env.PAPERCUSP_BEE_PROMPT_PATH?.trim();
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // packages/operator-core/lib/llm-testing/targets → repo root (5 up)
    join(here, '..', '..', '..', '..', '..', BEE_PROMPT_REL),
    join(process.cwd(), BEE_PROMPT_REL),
    join(process.cwd(), '..', '..', BEE_PROMPT_REL), // when cwd = apps/operator
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `bee target: could not locate the bee blueprint prompt (${BEE_PROMPT_REL}). ` +
      `Set PAPERCUSP_BEE_PROMPT_PATH. Tried:\n  ${candidates.join('\n  ')}`,
  );
}

let _promptCache: string | undefined;

/** Compose the bee's prompt from SOURCE the same way the live spawn does: the base bee persona
 *  framed as the agent's operating prompt. */
export function loadBeePrompt(): string {
  if (_promptCache !== undefined) return _promptCache;
  const body = readFileSync(resolveBeePromptPath(), 'utf8').trim();
  _promptCache =
    'You are a bee (a generic implementation worker) in a Papercusp Hive, placed by the Queen. ' +
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
 * Curated bee catalog — a faithful slice of blueprints/bee/blueprint.yaml dependencies.tools,
 * sized for cheap matrix runs. Includes the scheduler pull path AND the legacy self-scan/claim
 * verbs so "pull via the scheduler" is a genuine choice the model makes over self-prioritizing.
 */
export const BEE_CATALOG: ReadonlyArray<SuCatalogEntry> = [
  {
    name: 'scheduler:get_next',
    description:
      "Pull your NEXT work item through the scheduler — atomically leases the single top-ranked item satisfying BOTH the global hard floors (ready/lease/admission/dedup) AND your current per-bee claim SPEC (the Queen-authored scoped filter + rank), FOR UPDATE SKIP LOCKED. This is how a bee claims its next item: scheduling is the Queen's judgment expressed as your spec; PICKUP is yours. Records specId@revision for provenance.",
    input: obj({
      held_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Paths you already hold open (the affinity rank-term input). Optional.',
      },
    }),
  },
  {
    name: 'work_items:get',
    description: 'Read one work item in full (body, state, claims, comments).',
    input: obj({ id: { type: 'string' } }, ['id']),
  },
  {
    name: 'work_items:list',
    description:
      'List/scan the work-item backlog for a harness (state/kind filters). The RAW frontier — NOT the way a bee picks its next item (that is scheduler:get_next); use this only to read your already-claimed lane, never to self-prioritize the global queue.',
    input: obj({
      harness: { type: 'string' },
      state: { type: 'string', description: 'Filter: todo | wip | blocked | done | passed …' },
    }),
  },
  {
    name: 'work_items:claim',
    description:
      'Claim a SPECIFIC work item by id (maintains your already-claimed list). NOT the next-item picker — the scheduler (scheduler:get_next) leases your next item under your spec; this is for an item you already decided to take.',
    input: obj({ id: { type: 'string' } }, ['id']),
  },
  {
    name: 'work_items:complete',
    description: 'Mark a work item complete (you finished it).',
    input: obj({ id: { type: 'string' } }, ['id']),
  },
  {
    name: 'work_items:set_state',
    description: "Set a work item's state (e.g. blocked, with a reason) — the structured deferral the reconciler reads.",
    input: obj({ id: { type: 'string' }, state: { type: 'string' }, reason: { type: 'string' } }, ['id', 'state']),
  },
  {
    name: 'work_items:checkpoint',
    description: 'Write a compact carry-note on a work item (your continuity across spawns).',
    input: obj({ id: { type: 'string' }, checkpoint: { type: 'string' } }, ['id', 'checkpoint']),
  },
  {
    name: 'coord:declare-intent',
    description: 'Declare what you are working on so peers + the Queen see it (intent + current files; items: [P-NNN] claims your plan lane).',
    input: obj({ intent: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } }, ['intent']),
  },
  {
    name: 'coord:send',
    description: 'Send a coordination message to a peer or the Queen (wake:true to re-invoke a sleeper).',
    input: obj({ to: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } }, ['to', 'summary']),
  },
  {
    name: 'coord:await-inbox',
    description: 'Register a standing wake-watch on your inbox before ending a turn idle (your only wake surface).',
    input: obj({}),
  },
  {
    name: 'docs:search',
    description: 'Search the docs (agent-insights / system) for a runbook or convention.',
    input: obj({ query: { type: 'string' } }, ['query']),
  },
  {
    name: 'memory:search',
    description: 'Search persistent + hive-shared memories by semantic similarity.',
    input: obj({ query: { type: 'string' } }, ['query']),
  },
];

export const BEE_BEHAVIORS = ['pull-via-scheduler', 'no-self-freelance'];

/** The `bee` target — the su in-process loop with the bee's base prompt + catalog. */
export function makeBeeTarget(): SuTarget {
  return new SuTarget({
    id: 'bee',
    behaviors: BEE_BEHAVIORS,
    catalog: buildCatalog(BEE_CATALOG),
    loadSystemPrompt: loadBeePrompt,
  });
}
