/**
 * portfolio-acts.test.ts — the PINS under `portfolio-acts.ts`
 * (goal-mode-drift-guards-2026-08-31 P-002).
 *
 * A verb list is code-describing metadata: a second copy of a truth the tool
 * declarations own. CLAUDE.md's derived-truth ladder says such a copy is taken to
 * the first rung that fits, and a hand-maintained one is the last resort. This
 * list cannot be DERIVED (no property of a tool declaration says "this changes the
 * portfolio" — that is judgement), so it takes rung 2: PIN, a build-time
 * divergence check.
 *
 * ⚠ THE PIN IS NOT HYPOTHETICAL. Its predecessor — the same verb list as PROSE
 * inside the live `goal-mode-e2e` rubric criterion — shipped naming two tools that
 * have never existed (`goals:amend`, `goals:kill`), so it was structurally unable
 * to see amendment or kill activity. The negative control below reproduces that
 * exact defect and is the reason this file exists rather than a comment saying
 * "keep these in sync".
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCellSpec } from '../cell-registry';
import { GOAL_PORTFOLIO_THROUGHPUT_CELL } from '../cell-registrations';
import { GOAL_KICKOFF_GUARDED_TOOLS } from './kickoff-evidence';
import {
  PORTFOLIO_ACT_TOOLS,
  PORTFOLIO_CREATE_TOOLS,
  PORTFOLIO_PLACE_TOOLS,
  PORTFOLIO_STEER_TOOLS,
  isPortfolioAct,
  portfolioActFacet,
} from './portfolio-acts';
import { portfolioAssessmentFor } from './portfolio-throughput';

// lib/goals → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Where tool declarations live. Bounded on purpose: a whole-tree walk costs
 * seconds per run and every verb this module names was found under one of these.
 * A tool declared outside them would fail the live assertion below with a message
 * naming these roots, which is a loud, fixable failure rather than a silent miss.
 */
const TOOL_ROOTS = [
  'packages/agent-mcp/src/tools',
  'packages/agent-mcp/src/resources',
  'packages/operator-core/lib/agent-tools',
];

/**
 * PURE: the tool names a source text DECLARES.
 *
 * Matches the `name: '<server>:<verb>'` property every `defineTool` call carries.
 * Deliberately NOT a search for the bare string: prose, guidance text and
 * `chaining` hints mention dozens of tool names they do not define, and counting
 * those would make the pin pass for a verb nothing implements — which is exactly
 * the `goals:amend` failure, reproduced by a laxer detector.
 */
export function declaredToolNames(source: string): Set<string> {
  const out = new Set<string>();
  const re = /\bname:\s*'([A-Za-z_][A-Za-z0-9_]*:[A-Za-z0-9_.-]+)'/g;
  for (const m of source.matchAll(re)) out.add(m[1]);
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) acc.push(full);
  }
  return acc;
}

/** Every tool name declared anywhere under TOOL_ROOTS. Computed once. */
const DECLARED: Set<string> = (() => {
  const all = new Set<string>();
  for (const root of TOOL_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      for (const name of declaredToolNames(readFileSync(file, 'utf8'))) all.add(name);
    }
  }
  return all;
})();

describe('declaredToolNames — fixture controls (the detector must be able to FAIL)', () => {
  it('finds a real declaration', () => {
    expect(declaredToolNames(`export default defineTool({\n  name: 'goals:update',\n})`)).toContain(
      'goals:update',
    );
  });

  it('does NOT count a tool merely MENTIONED in prose or guidance', () => {
    // The `goals:amend` defect in one line: the rubric criterion "named" the verb
    // in prose, and prose is not a declaration.
    const found = declaredToolNames(`
      guidance: {
        notWhen: 'Changing goal intent/state — use goals:update, which records an amendment.',
        chaining: "goals:amend then goals:kill",
      },
    `);
    expect(found.has('goals:amend')).toBe(false);
    expect(found.has('goals:kill')).toBe(false);
    // ...and not even the REAL verb, when it is only mentioned.
    expect(found.has('goals:update')).toBe(false);
  });

  it('does not match a bare identifier with no colon', () => {
    expect(declaredToolNames(`name: 'handler',`).size).toBe(0);
  });
});

describe('the scan itself is working (guards against a vacuous pass)', () => {
  /**
   * An empty or near-empty DECLARED set would make the containment assertions
   * below fail loudly, which is safe. The dangerous direction is a scan that
   * matched too much, so both directions are controlled here.
   */
  it('found a substantial population of real tools', () => {
    expect(DECLARED.size).toBeGreaterThan(100);
  });

  it('POSITIVE CONTROL: a verb known to exist is found', () => {
    expect(DECLARED.has('goals:update')).toBe(true);
    expect(DECLARED.has('goals:get')).toBe(true);
  });

  /**
   * NEGATIVE CONTROL, and the finding this module was written around.
   *
   * These two names are what the live `goal-mode-e2e` portfolio-activity-floor
   * criterion enumerates. Neither is a tool. If either ever BECOMES one, this
   * test fails and whoever added it is told to reconsider the set above — which
   * is the correct outcome, not a nuisance.
   */
  it('NEGATIVE CONTROL: goals:amend and goals:kill are not tools', () => {
    expect(DECLARED.has('goals:amend')).toBe(false);
    expect(DECLARED.has('goals:kill')).toBe(false);
  });
});

describe('PORTFOLIO_ACT_TOOLS', () => {
  it('names only tools that actually exist', () => {
    const phantom = PORTFOLIO_ACT_TOOLS.filter((t) => !DECLARED.has(t));
    expect(
      phantom,
      `these portfolio-act verbs match no \`name: '<verb>'\` declaration under ${TOOL_ROOTS.join(
        ', ',
      )}. A verb that no tool declares can never appear in tool_invocations.tool_name, so counting it is a silent under-count — the exact defect that shipped as goals:amend / goals:kill.`,
    ).toEqual([]);
  });

  it('is the union of its three facets, deduplicated and sorted', () => {
    const union = [
      ...new Set([...PORTFOLIO_CREATE_TOOLS, ...PORTFOLIO_PLACE_TOOLS, ...PORTFOLIO_STEER_TOOLS]),
    ].sort();
    expect([...PORTFOLIO_ACT_TOOLS]).toEqual(union);
  });

  it('has DISJOINT facets — every act belongs to exactly one', () => {
    const seen = new Map<string, string[]>();
    const add = (tools: readonly string[], facet: string) => {
      for (const t of tools) seen.set(t, [...(seen.get(t) ?? []), facet]);
    };
    add(PORTFOLIO_CREATE_TOOLS, 'create');
    add(PORTFOLIO_PLACE_TOOLS, 'place');
    add(PORTFOLIO_STEER_TOOLS, 'steer');
    const overlapping = [...seen.entries()].filter(([, facets]) => facets.length > 1);
    expect(overlapping).toEqual([]);
  });

  it('classifies every act into a facet, and non-acts into none', () => {
    for (const tool of PORTFOLIO_ACT_TOOLS) {
      expect(isPortfolioAct(tool)).toBe(true);
      expect(portfolioActFacet(tool)).not.toBeNull();
    }
    expect(isPortfolioAct(null)).toBe(false);
    expect(isPortfolioAct(undefined)).toBe(false);
    expect(portfolioActFacet('goals:list')).toBeNull();
  });

  /**
   * Rule 1 of the membership contract. The condition being detected is a steward
   * that READS and REPORTS forever, so a set containing a read would be blind by
   * construction — it would score the very behaviour it exists to catch as work.
   */
  it('contains NO read verbs', () => {
    const reads = [
      'goals:list',
      'goals:get',
      'goals:pots',
      'plans:get',
      'plans:items',
      'plans:list',
      'coord:orient',
      'coord:presence',
      'coord:glance',
      'sessions:search',
      'search:semantic',
      'search:fulltext',
      'dev:pg_query',
      'capability:read',
      'work_items:get',
      'work_items:list',
      'state:read',
      'issues:list',
    ];
    expect(reads.filter((r) => isPortfolioAct(r))).toEqual([]);
  });

  /**
   * ── THE CONTAINMENT INVARIANT ────────────────────────────────────────────────
   *
   * A door so consequential that a GOAL HOLDER MAY NOT CROSS IT until its kickoff
   * reads and owner report are done is, by definition, an act of placing portfolio
   * work. That is not a coincidence between two lists — it is the same judgement
   * expressed for two purposes, so the gated set must be a subset of the measured
   * set.
   *
   * This is the drift direction that actually hurts: a verb MISSING from
   * PORTFOLIO_ACT_TOOLS makes a BUSY steward read as IDLE. Adding a new guarded
   * door without adding it here now fails this test instead of silently degrading
   * the detector months later.
   */
  it('contains every GOAL_KICKOFF_GUARDED_TOOLS door', () => {
    const missing = GOAL_KICKOFF_GUARDED_TOOLS.filter((t) => !isPortfolioAct(t));
    expect(
      missing,
      'these doors are gated before a goal holder may place work, but are not counted as placing it. A kickoff-guarded door IS a portfolio act; add each to the matching facet in portfolio-acts.ts.',
    ).toEqual([]);
  });
});

describe('the cell and the resolver agree on one closed vocabulary', () => {
  it('registers cleanly against the D-038 contract', () => {
    expect(validateCellSpec(GOAL_PORTFOLIO_THROUGHPUT_CELL)).toEqual([]);
  });

  /**
   * `readCell` DOWNGRADES an undeclared code to `unavailable` rather than passing
   * it through. So a resolver emitting a code the registration does not declare
   * fails SILENTLY: every read of a perfectly healthy resolver reports "no
   * semantics", which reads as the cell being broken. Both directions are pinned.
   */
  it('every code the resolver can emit is declared on the cell', () => {
    const emitted = new Set(
      (['idle', 'not-held', 'not-measured', 'placing', 'within-grace'] as const).map(
        portfolioAssessmentFor,
      ),
    );
    const declared = new Set(Object.keys(GOAL_PORTFOLIO_THROUGHPUT_CELL.assessment?.codes ?? {}));
    expect([...emitted].sort()).toEqual([...declared].sort());
  });

  it('maps each verdict reason to a DISTINCT code — no two reasons collapse', () => {
    const reasons = ['idle', 'not-held', 'not-measured', 'placing', 'within-grace'] as const;
    const codes = reasons.map(portfolioAssessmentFor);
    expect(new Set(codes).size).toBe(reasons.length);
  });
});
