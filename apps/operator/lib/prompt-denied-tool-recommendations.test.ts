/**
 * Prompt corpus ↔ deny-list lockstep (EI-19277117902219188).
 *
 * The failure this exists to stop: a tool gets DENY-LISTED in code, and the prompt that
 * recommends it is never updated — so an agent reads an unqualified "use the `X` tool",
 * offers the owner a route built on it, and only discovers at execution time that the tool
 * was removed from its toolset months ago. That is not a style slip; it is a FABRICATED
 * CAPABILITY offered to the owner.
 *
 * Observed 2026-08-01: `apps/operator/prompts/papercusp-su.claude.md` still read
 *   "- **Subagents** — use the `Task` (Agent) tool to fan out parallel or context-isolated work."
 *   "- **Multi-agent orchestration** — use the `Workflow` tool ... for deterministic fan-out"
 * a full month after the owner's 2026-07-02 mandate deny-listed Task/Agent/Workflow for
 * EVERY Claude agent including the human `psu su` collaborator (no-subagent-deny.ts). The
 * corrective rule existed only in the LEGACY `papercusp-su-{engineer,power}.tools.md`
 * playbooks, which are not on the blueprint-persona prompt path — so the agent carrying the
 * defect had no counter-rule anywhere in its context. Nothing checked the two layers agreed.
 *
 * This guard is driven BY `NO_SUBAGENT_TOOLS_DENY`, not by a hardcoded name list, so the
 * NEXT tool added to the deny is covered automatically without anyone remembering to.
 *
 * Detection rule (deliberately narrow — a noisy guard gets disabled, which is worse than no
 * guard): a violation is a deny-listed name appearing as an exact markdown CODE SPAN inside a
 * paragraph that carries no prohibition marker. Code-span matching is what keeps prose
 * ("the agent", "any task with 3+ steps") and sibling tool names (`TaskCreate`, `TaskUpdate`,
 * `TaskList` — different tokens, all legitimate) out of the results. Mentioning a denied tool
 * is fine and often necessary; mentioning it WITHOUT saying it is denied is the bug.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_SUBAGENT_TOOLS_DENY } from '@papercusp/orchestrator/no-subagent-deny';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const PROMPTS = join(HERE, '..', 'prompts');
const BLUEPRINTS = join(REPO, 'libs/papercusp/packages/harness/blueprints');

/** Every tool name currently denied to agents. Extend the SOURCE (no-subagent-deny.ts), not this. */
const DENIED = new Set<string>(NO_SUBAGENT_TOOLS_DENY);

/**
 * Markers that make a paragraph a PROHIBITION rather than a recommendation. Kept generous on
 * purpose: the guard's job is to catch "use the `Task` tool", not to police phrasing.
 */
const PROHIBITION_MARKERS = [
  'denied',
  'deny',
  'do not',
  "don't",
  'never',
  '⛔',
  'disallow',
  'not in your toolset',
  'instead of',
  'not available',
  'forbidden',
  'retired',
  'absent',
];

/** Deny-listed names mentioned as a code span in a paragraph with no prohibition marker. */
export function findDeniedToolRecommendations(md: string): string[] {
  const found = new Set<string>();
  for (const para of md.split(/\n\s*\n/)) {
    const spans = [...para.matchAll(/`([^`\n]{1,40})`/g)].map((m) => m[1]);
    const hits = spans.filter((s) => DENIED.has(s));
    if (hits.length === 0) continue;
    const low = para.toLowerCase();
    if (PROHIBITION_MARKERS.some((p) => low.includes(p))) continue;
    for (const h of hits) found.add(h);
  }
  return [...found].sort();
}

function markdownFilesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.md'))
    .map((p) => join(root, p));
}

describe('prompt corpus never recommends a deny-listed tool (EI-19277117902219188)', () => {
  it('the detector actually fires on the historical bug (and not on its benign lookalike)', () => {
    // If this ever goes silent, the sweep below is worthless — it would pass by blindness.
    const historicalBug = [
      '- **Subagents** — use the `Task` (Agent) tool to fan out parallel or',
      '  context-isolated work.',
      '- **Multi-agent orchestration** — use the `Workflow` tool (when present',
      '  in your build) for deterministic fan-out / pipelines.',
    ].join('\n');
    expect(findDeniedToolRecommendations(historicalBug)).toEqual(['Task', 'Workflow']);

    // The false-positive trap: the to-do panel tools are NOT the subagent launcher.
    const benignTaskPanel = [
      "- **Task tracking** — use Claude Code's native to-do / task-panel tool",
      '  (`TodoWrite`, or `TaskCreate` / `TaskUpdate` / `TaskList` depending on',
      '  your build) for any task with 3+ steps; keep it accurate for a successor.',
    ].join('\n');
    expect(findDeniedToolRecommendations(benignTaskPanel)).toEqual([]);

    // A denied tool NAMED as denied is correct and must stay allowed.
    const properlyProhibited =
      '⛔ **DENIED BY DEFAULT.** Do NOT reach for `Task` / `Agent` / `Workflow` — use a fleet.';
    expect(findDeniedToolRecommendations(properlyProhibited)).toEqual([]);
  });

  const corpus = [...markdownFilesUnder(PROMPTS), ...markdownFilesUnder(BLUEPRINTS)];

  it('sweeps a non-empty corpus (a path regression must not silently pass)', () => {
    expect(corpus.length).toBeGreaterThan(20);
  });

  it('no prompt source recommends a tool that is denied to agents', () => {
    const violations = corpus
      .map((file) => ({ file, hits: findDeniedToolRecommendations(readFileSync(file, 'utf8')) }))
      .filter((v) => v.hits.length > 0)
      .map((v) => `${relative(REPO, v.file)} → ${v.hits.join(', ')}`);

    expect(
      violations,
      [
        'A prompt source recommends a tool that is DENY-LISTED to agents',
        '(NO_SUBAGENT_TOOLS_DENY, libs/papercusp/packages/orchestrator/src/no-subagent-deny.ts).',
        'An agent reading this will offer the owner a route it cannot execute.',
        'Fix the PROMPT (say the tool is denied and route fan-out to `fleet:launch-on-plan`),',
        'or, if the tool is genuinely allowed again, remove it from the deny list first.',
      ].join(' '),
    ).toEqual([]);
  });
});

/**
 * The negative sweep above is satisfiable by deleting the guidance entirely, which would
 * leave an agent with no idea how to fan out. These pin the REPLACEMENT rule in place.
 */
describe('su persona sources carry the fleet-first fan-out rule', () => {
  const SU_PERSONA_FILES: Array<[label: string, path: string]> = [
    ['claude client overlay', join(PROMPTS, 'papercusp-su.claude.md')],
    ['pot instance override', join(PROMPTS, 'pot-instances/papercup-pot.su.md')],
    ['legacy engineer playbook', join(PROMPTS, 'papercusp-su-engineer.tools.md')],
    ['legacy power playbook', join(PROMPTS, 'papercusp-su-power.tools.md')],
    ['base domain-neutral persona', join(BLUEPRINTS, 'base/prompts/su.md')],
  ];

  for (const [label, path] of SU_PERSONA_FILES) {
    it(`${label} routes client-native fan-out to a fleet`, () => {
      expect(existsSync(path), `${path} missing — persona layout changed`).toBe(true);
      const md = readFileSync(path, 'utf8');
      expect(md.toLowerCase(), 'names client-native subagent fan-out').toMatch(/subagent/);
      expect(md.toLowerCase(), 'routes fan-out to a fleet').toMatch(/fleet/);
    });
  }

  // The three layers that compose the LIVE blueprint-persona system prompt must state the
  // deny outright — this is the layer the 2026-08-01 miss actually travelled through.
  const BLUEPRINT_PATH_LAYERS: Array<[string, string]> = [
    ['claude client overlay', join(PROMPTS, 'papercusp-su.claude.md')],
    ['pot instance override', join(PROMPTS, 'pot-instances/papercup-pot.su.md')],
    ['base domain-neutral persona', join(BLUEPRINTS, 'base/prompts/su.md')],
  ];

  for (const [label, path] of BLUEPRINT_PATH_LAYERS) {
    it(`${label} states that subagent fan-out is denied by default`, () => {
      const low = readFileSync(path, 'utf8').toLowerCase();
      expect(low, 'states the deny').toMatch(/deny|denied/);
    });
  }

  it('the base persona requires verifying a route is executable before offering it', () => {
    const low = readFileSync(join(BLUEPRINTS, 'base/prompts/su.md'), 'utf8').toLowerCase();
    expect(low, 'never offer an unverified route').toMatch(
      /never offer a route you have not confirmed/,
    );
  });
});
