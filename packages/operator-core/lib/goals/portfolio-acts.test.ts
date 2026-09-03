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
import type { Sql } from 'postgres';

import type { GoalHolders } from './holder';
import {
  PORTFOLIO_ACT_TOOLS,
  PORTFOLIO_CONDITIONAL_ACTS,
  PORTFOLIO_CREATE_TOOLS,
  PORTFOLIO_PLACE_TOOLS,
  PORTFOLIO_STEER_TOOLS,
  argsCarryConditionalKey,
  argsSatisfyConditionalAct,
  isPortfolioAct,
  portfolioActFacet,
} from './portfolio-acts';
import {
  portfolioActLedgerPredicate,
  portfolioAssessmentFor,
  readGoalPortfolioThroughput,
} from './portfolio-throughput';

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

/**
 * Every tool name declared anywhere under TOOL_ROOTS → the source text that
 * declares it. Computed once. The SOURCE is kept (not just the name) so a
 * conditional act's argument key can be pinned against the tool's real schema
 * rather than against a name somebody remembered.
 */
const DECLARED_SOURCE: Map<string, string> = (() => {
  const all = new Map<string, string>();
  for (const root of TOOL_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      const source = readFileSync(file, 'utf8');
      for (const name of declaredToolNames(source)) all.set(name, source);
    }
  }
  return all;
})();

const DECLARED: Set<string> = new Set(DECLARED_SOURCE.keys());

/**
 * PURE: does a tool's source declare `<key>` as a zod input field?
 *
 * Matches `<key>: z` at a property position — the shape every `defineTool`
 * input schema in this tree uses. Deliberately NOT a bare-word search: a key
 * mentioned only in a `describe(...)` string or a doc comment is not a field the
 * tool accepts, and counting it would let the pin pass for an argument the ledger
 * can never carry.
 */
export function declaresZodField(source: string, key: string): boolean {
  // Comments are prose: a `key: z` quoted in a docblock is not a field.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return new RegExp(`(^|[\\s{,])${key}:\\s*z\\b`, 'm').test(code);
}

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

describe('declaresZodField — fixture controls', () => {
  it('finds a real zod input field, at any indentation and as a first property', () => {
    expect(declaresZodField(`const schema = z.object({\n  goal: z\n    .string()\n});`, 'goal')).toBe(
      true,
    );
    expect(declaresZodField(`z.object({goal: z.string()})`, 'goal')).toBe(true);
    expect(declaresZodField(`z.object({ id: z.string(), goal: z.string() })`, 'goal')).toBe(true);
  });

  it('does NOT count a key that is only mentioned in prose, a describe string, or as a suffix', () => {
    expect(declaresZodField(`.describe('goal id to adopt this work-item into')`, 'goal')).toBe(false);
    expect(declaresZodField(`// pass goal: z to adopt`, 'goal')).toBe(false);
    expect(declaresZodField(`/**\n * goal: z.string() is what the caller passes\n */\nid: z.string()`, 'goal')).toBe(false);
    expect(declaresZodField(`subgoal: z.string()`, 'goal')).toBe(false);
    expect(declaresZodField(`goalId: z.string()`, 'goal')).toBe(false);
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

describe('PORTFOLIO_CONDITIONAL_ACTS — the name says nothing, the arguments decide', () => {
  /**
   * The motivating entry (WI-2140701): goal placement of EXISTING backlog goes
   * through `work_items:update { goal }`, and a steward whose whole contribution
   * was adopting items into its goal graded as measurably idle because the set
   * above had no verb for it. Pinned as a positive control so the list can never
   * silently lose it.
   */
  it('names goal placement via work_items:update { goal } as a PLACE act', () => {
    expect(PORTFOLIO_CONDITIONAL_ACTS).toContainEqual({
      tool: 'work_items:update',
      argKey: 'goal',
      batchKey: 'items',
      facet: 'place',
    });
  });

  /**
   * The second polarity's positive control (WI-2142888). `improvements:capture`
   * is what `provenance-stamp.ts` calls "the door a goal steward files most of
   * its findings through", and a non-observation capture mints a real work-item —
   * CREATE by this module's own definition. It was in NEITHER set, so a steward
   * whose real output was captures scored `actsInWindow: 0` and, because
   * idleness scores FAIL rather than `unknown` (WI-1740139), failed a graded
   * rubric criterion for work it actually did.
   */
  it('names a non-observation improvements:capture as a CREATE act, by NOT-VALUE', () => {
    expect(PORTFOLIO_CONDITIONAL_ACTS).toContainEqual({
      tool: 'improvements:capture',
      argKey: 'lane',
      batchKey: null,
      facet: 'create',
      notValue: 'observation',
    });
  });

  /**
   * The polarity is the whole point of the entry above, so pin the choice rather
   * than just the values: `absent: true` would have been the simpler field, and
   * it is WRONG here because the tool's schema defaults `lane` to `'improvement'`
   * and every call site in capture.ts tests `!== 'observation'`, never presence.
   * An explicit `lane: 'improvement'` is a real filing; this asserts it counts.
   */
  it('credits an EXPLICIT non-observation lane, not merely an absent one', () => {
    expect(isPortfolioAct('improvements:capture', { title: 't', lane: 'improvement' })).toBe(true);
    expect(isPortfolioAct('improvements:capture', { title: 't' })).toBe(true);
    expect(isPortfolioAct('improvements:capture', { title: 't', lane: 'observation' })).toBe(false);
  });

  it('names only tools that actually exist', () => {
    const phantom = PORTFOLIO_CONDITIONAL_ACTS.map((a) => a.tool).filter((t) => !DECLARED.has(t));
    expect(phantom).toEqual([]);
  });

  /**
   * `notValue` inverts the predicate; the batch leg is EXISTENTIAL ("any element
   * carries the key"). Negating an existential silently gives the wrong
   * quantifier — a batch would score as an act whenever ANY element was not an
   * observation — so the combination is refused rather than guessed at. No case
   * needs it today; this is what stops one being added without the design work.
   */
  it('never combines notValue with a batch form — the quantifier would be wrong', () => {
    const both = PORTFOLIO_CONDITIONAL_ACTS.filter((a) => a.notValue != null && a.batchKey != null);
    expect(both).toEqual([]);
  });

  /**
   * The argument-level analogue of the phantom-verb pin. A key the tool's input
   * schema does not declare can never reach `tool_invocations.args_json`, so the
   * SQL leg would match nothing and the TS leg would only ever see it in a test —
   * the `goals:amend` defect one level down.
   */
  it('names only argument keys the tool really declares in its zod input schema', () => {
    for (const act of PORTFOLIO_CONDITIONAL_ACTS) {
      const source = DECLARED_SOURCE.get(act.tool);
      expect(source, `${act.tool} has no declaring source under ${TOOL_ROOTS.join(', ')}`).toBeDefined();
      expect(
        declaresZodField(source!, act.argKey),
        `${act.tool} does not declare \`${act.argKey}: z…\` — a key the schema refuses never reaches args_json`,
      ).toBe(true);
      if (act.batchKey != null) {
        expect(
          declaresZodField(source!, act.batchKey),
          `${act.tool} does not declare a \`${act.batchKey}: z…\` batch form`,
        ).toBe(true);
      }
    }
  });

  /**
   * The false-BUSY guard. A conditional tool in the unconditional set would count
   * every retitle as placement — the direction that lets a reading-and-reporting
   * steward pass — so the two sets must be disjoint.
   */
  it('is DISJOINT from PORTFOLIO_ACT_TOOLS — a conditional tool never counts by name', () => {
    const leaked = PORTFOLIO_CONDITIONAL_ACTS.map((a) => a.tool).filter((t) =>
      PORTFOLIO_ACT_TOOLS.includes(t),
    );
    expect(leaked).toEqual([]);
    for (const act of PORTFOLIO_CONDITIONAL_ACTS) {
      expect(isPortfolioAct(act.tool)).toBe(false);
      expect(portfolioActFacet(act.tool)).toBeNull();
    }
  });

  it('argsCarryConditionalKey: presence at the top level or in any batch element, never truthiness', () => {
    const act = { argKey: 'goal', batchKey: 'items' };
    expect(argsCarryConditionalKey({ id: 'WI-1', goal: 'work-on-everything-070565' }, act)).toBe(true);
    // A clear is a release, and releasing changes who is on the work.
    expect(argsCarryConditionalKey({ id: 'WI-1', goal: null }, act)).toBe(true);
    expect(argsCarryConditionalKey({ items: [{ id: 'WI-1', title: 't' }, { id: 'WI-2', goal: 'g' }] }, act)).toBe(
      true,
    );
    expect(argsCarryConditionalKey({ id: 'WI-1', title: 'retitled' }, act)).toBe(false);
    expect(argsCarryConditionalKey({ items: [{ id: 'WI-1', severity: 'major' }] }, act)).toBe(false);
    // Malformed shapes are non-acts, not errors.
    expect(argsCarryConditionalKey({ items: 'WI-1' }, act)).toBe(false);
    expect(argsCarryConditionalKey({ items: [null, 'x', 3] }, act)).toBe(false);
    expect(argsCarryConditionalKey(null, act)).toBe(false);
    expect(argsCarryConditionalKey(undefined, act)).toBe(false);
    expect(argsCarryConditionalKey('goal', act)).toBe(false);
    expect(argsCarryConditionalKey(['goal'], act)).toBe(false);
    // A tool with no batch form ignores an `items` array entirely.
    expect(argsCarryConditionalKey({ items: [{ goal: 'g' }] }, { argKey: 'goal', batchKey: null })).toBe(
      false,
    );
  });

  it('argsSatisfyConditionalAct: dispatches on polarity, and PRESENCE is unchanged', () => {
    const presence = { argKey: 'goal', batchKey: 'items' };
    expect(argsSatisfyConditionalAct({ id: 'WI-1', goal: null }, presence)).toBe(true);
    expect(argsSatisfyConditionalAct({ id: 'WI-1', title: 'retitled' }, presence)).toBe(false);

    const notValue = { argKey: 'lane', batchKey: null, notValue: 'observation' };
    // Absent ⇒ act (the default filing), the value ⇒ non-act, another value ⇒ act.
    expect(argsSatisfyConditionalAct({ title: 't' }, notValue)).toBe(true);
    expect(argsSatisfyConditionalAct({ title: 't', lane: 'observation' }, notValue)).toBe(false);
    expect(argsSatisfyConditionalAct({ title: 't', lane: 'improvement' }, notValue)).toBe(true);
    // An explicit null/undefined lane is not the documented opt-out value.
    expect(argsSatisfyConditionalAct({ title: 't', lane: null }, notValue)).toBe(true);
    // A non-string value is a mismatch, therefore an act — an unexpected shape
    // is not the opt-out.
    expect(argsSatisfyConditionalAct({ title: 't', lane: ['observation'] }, notValue)).toBe(true);

    /**
     * ⚠ THE CONSERVATIVE FLOOR, and under `notValue` it is load-bearing rather
     * than a formality. "No `lane` key" is the ACT condition, so a missing or
     * opaque args payload is indistinguishable from a real filing — without this
     * guard a caller holding only a tool name would score a false BUSY on every
     * capture, which is the direction that lets a reading-and-reporting steward
     * pass. The name alone never counts, in EITHER polarity.
     */
    expect(argsSatisfyConditionalAct(undefined, notValue)).toBe(false);
    expect(argsSatisfyConditionalAct(null, notValue)).toBe(false);
    expect(argsSatisfyConditionalAct('observation', notValue)).toBe(false);
    expect(argsSatisfyConditionalAct([{ lane: 'improvement' }], notValue)).toBe(false);
  });

  it('portfolioActFacet resolves a notValue act to CREATE, and the opt-out to null', () => {
    expect(portfolioActFacet('improvements:capture', { title: 't' })).toBe('create');
    expect(portfolioActFacet('improvements:capture', { title: 't', lane: 'observation' })).toBeNull();
  });

  it('isPortfolioAct / portfolioActFacet resolve a conditional act from its arguments', () => {
    expect(isPortfolioAct('work_items:update', { id: 'WI-1', goal: 'g' })).toBe(true);
    expect(portfolioActFacet('work_items:update', { id: 'WI-1', goal: 'g' })).toBe('place');
    expect(isPortfolioAct('work_items:update', { items: [{ id: 'WI-1', goal: null }] })).toBe(true);
    expect(portfolioActFacet('work_items:update', { items: [{ id: 'WI-1', goal: null }] })).toBe('place');
    // The same tool, retitling: a measured non-act.
    expect(isPortfolioAct('work_items:update', { id: 'WI-1', title: 'x' })).toBe(false);
    expect(portfolioActFacet('work_items:update', { id: 'WI-1', title: 'x' })).toBeNull();
    // Arguments never PROMOTE a non-act name.
    expect(isPortfolioAct('work_items:get', { id: 'WI-1', goal: 'g' })).toBe(false);
    // ...and never DEMOTE an unconditional act.
    expect(isPortfolioAct('goals:start', { anything: 1 })).toBe(true);
    expect(portfolioActFacet('goals:start', { anything: 1 })).toBe('place');
  });
});

/**
 * A recording tag with postgres.js's composition semantics: a nested fragment
 * splices its text and parameters in place, so the rendered query is what the
 * driver would send. `then` makes the top-level query awaitable, which is how
 * `readGoalPortfolioThroughput` consumes it.
 */
interface RenderedQuery {
  text: string;
  params: unknown[];
}
const FRAGMENT = Symbol('fragment');
interface Fragment {
  [FRAGMENT]: true;
  strings: TemplateStringsArray;
  values: unknown[];
}
function isFragment(v: unknown): v is Fragment {
  return typeof v === 'object' && v !== null && FRAGMENT in v;
}
function render(frag: Fragment, out: RenderedQuery): void {
  frag.strings.forEach((s, i) => {
    out.text += s;
    if (i >= frag.values.length) return;
    const v = frag.values[i];
    if (isFragment(v)) render(v, out);
    else {
      out.params.push(v);
      out.text += `$${out.params.length}`;
    }
  });
}
function recordingSql(onQuery: (q: RenderedQuery) => unknown[]): { sql: Sql; queries: RenderedQuery[] } {
  const queries: RenderedQuery[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const frag: Fragment & { then: (res: (rows: unknown[]) => void, rej: (e: unknown) => void) => void } = {
      [FRAGMENT]: true,
      strings,
      values,
      then(resolve, reject) {
        try {
          const q: RenderedQuery = { text: '', params: [] };
          render(frag, q);
          queries.push(q);
          resolve(onQuery(q));
        } catch (e) {
          reject(e);
        }
      },
    };
    return frag;
  };
  return { sql: tag as unknown as Sql, queries };
}

const HELD_HOLDERS = {
  goalId: 'goal-1',
  workspaceId: 'ws',
  holders: [{ ownerId: 'su-holder', setAtMs: 1_000 }],
  liveness: 'held',
} as unknown as GoalHolders;

describe('portfolioActLedgerPredicate — the SQL leg is derived from the same constants', () => {
  it('renders both legs: by name over PORTFOLIO_ACT_TOOLS, by args for every conditional act', () => {
    const { sql } = recordingSql(() => []);
    const q: RenderedQuery = { text: '', params: [] };
    render(portfolioActLedgerPredicate(sql) as unknown as Fragment, q);

    expect(q.text).toContain('ti.tool_name = ANY(');
    expect(q.params).toContainEqual([...PORTFOLIO_ACT_TOOLS]);

    for (const act of PORTFOLIO_CONDITIONAL_ACTS) {
      expect(q.params).toContain(act.tool);
      expect(q.params).toContain(act.argKey);
      if (act.batchKey != null) expect(q.params).toContain(act.batchKey);
      if (act.notValue != null) expect(q.params).toContain(act.notValue);
    }
    // jsonb key-EXISTENCE, so a deliberate null (a release) still matches.
    expect(q.text).toMatch(/ti\.args_json \? \$\d+::text/);
    // The batch leg guards the array type before unnesting it.
    expect(q.text).toMatch(/jsonb_typeof\(ti\.args_json -> \$\d+::text\) = 'array'/);
    expect(q.text).toMatch(/jsonb_array_elements\(ti\.args_json -> \$\d+::text\) el/);
    expect(q.text).toMatch(/WHERE el \? \$\d+::text/);

    /**
     * The notValue leg, pinned in both its halves because each fails silently in
     * the false-IDLE direction if dropped:
     *  • IS DISTINCT FROM — `->` yields SQL NULL for an absent key, and a bare
     *    `<>` would make that whole leg NULL, scoring the DEFAULT filing (the
     *    common case) as a non-act.
     *  • jsonb_typeof(args_json) = 'object' — the SQL half of the conservative
     *    floor; without it a NULL or scalar args_json has no key, so
     *    `-> key IS DISTINCT FROM value` is TRUE and every argument-less row
     *    scores as an act.
     */
    if (PORTFOLIO_CONDITIONAL_ACTS.some((a) => a.notValue != null)) {
      expect(q.text).toMatch(
        /\(ti\.args_json -> \$\d+::text\) IS DISTINCT FROM to_jsonb\(\$\d+::text\)/,
      );
      expect(q.text).toMatch(/jsonb_typeof\(ti\.args_json\) = 'object'/);
    }
    // The legs are OR-ed: a name match OR an args match — never AND.
    const byArgsLegs = PORTFOLIO_CONDITIONAL_ACTS.length;
    expect((q.text.match(/ OR /g) ?? []).length).toBeGreaterThanOrEqual(byArgsLegs);
  });

  it('readGoalPortfolioThroughput scans the ledger through it and reads the last act args for the facet', async () => {
    const { sql, queries } = recordingSql(() => [
      {
        acts_in_window: '2',
        last_act_ms: '90000',
        last_act_tool: 'work_items:update',
        last_act_args: { id: 'WI-1', goal: 'goal-1' },
      },
    ]);
    const read = await readGoalPortfolioThroughput(sql, {
      workspaceId: 'ws',
      goalId: 'goal-1',
      nowMs: 100_000,
      holders: HELD_HOLDERS,
    });

    expect(queries).toHaveLength(1);
    const q = queries[0]!;
    expect(q.text).toContain('FROM harness_shared.tool_invocations ti');
    expect(q.text).toContain("ti.status = 'ok'");
    expect(q.text).toContain('AS last_act_args');
    expect(q.params).toContainEqual([...PORTFOLIO_ACT_TOOLS]);
    expect(q.params).toContain('work_items:update');
    expect(q.params).toContain('goal');
    expect(q.params).toContain('items');

    expect(read.actsInWindow).toBe(2);
    expect(read.lastActTool).toBe('work_items:update');
    // By name alone this would be null; the args resolve it.
    expect(read.lastActFacet).toBe('place');
    expect(read.reason).toBe('placing');
  });

  it('a last act whose args do NOT carry the key stays a facet-less row (the SQL should never return one)', async () => {
    const { sql } = recordingSql(() => [
      {
        acts_in_window: '1',
        last_act_ms: '90000',
        last_act_tool: 'work_items:update',
        last_act_args: { id: 'WI-1', title: 'retitled' },
      },
    ]);
    const read = await readGoalPortfolioThroughput(sql, {
      workspaceId: 'ws',
      goalId: 'goal-1',
      nowMs: 100_000,
      holders: HELD_HOLDERS,
    });
    expect(read.lastActFacet).toBeNull();
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
