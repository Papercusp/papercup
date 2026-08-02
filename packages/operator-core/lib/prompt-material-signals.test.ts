/**
 * The MATERIAL-signal detector behind stale-prompt-render-in-live-sessions-2026-08-02 P-004.
 *
 * The thing under test is a DETECTOR whose entire value is being quiet, so the tests are
 * arranged around the two ways it can be worthless: firing on a change that does not matter
 * (chatter → muted → useless), and failing to fire on one that does (blind → theatre). Both
 * directions get an explicit discrimination case, because this detector's real corpus produced
 * ZERO route-family hits across 5,352 renders — a number that is either "nothing was retired"
 * or "the family cannot see", and only a proof that it CAN see separates them.
 */
import { describe, it, expect } from 'vitest';
import {
  detectMaterialRenderDrift,
  driftFingerprint,
  extractMaterialSignals,
  extractRouteMechanisms,
  findDeniedToolRecommendations,
} from './prompt-material-signals';

const DENIED = new Set(['Task', 'Agent', 'Workflow']);

describe('findDeniedToolRecommendations', () => {
  it('fires on the historical bug (and not on its benign lookalike)', () => {
    const historicalBug = [
      '- **Subagents** — use the `Task` (Agent) tool to fan out parallel or',
      '  context-isolated work.',
      '- **Multi-agent orchestration** — use the `Workflow` tool (when present',
      '  in your build) for deterministic fan-out / pipelines.',
    ].join('\n');
    expect(findDeniedToolRecommendations(historicalBug, DENIED)).toEqual(['Task', 'Workflow']);

    // The false-positive trap: the to-do panel tools are NOT the subagent launcher.
    const benign = [
      "- **Task tracking** — use Claude Code's native to-do / task-panel tool",
      '  (`TodoWrite`, or `TaskCreate` / `TaskUpdate` / `TaskList` depending on',
      '  your build) for any task with 3+ steps.',
    ].join('\n');
    expect(findDeniedToolRecommendations(benign, DENIED)).toEqual([]);
  });

  it('a denied tool NAMED as denied is correct usage, not a violation', () => {
    const prohibited =
      '⛔ **DENIED BY DEFAULT.** Do NOT reach for `Task` / `Agent` / `Workflow` — use a fleet.';
    expect(findDeniedToolRecommendations(prohibited, DENIED)).toEqual([]);
  });

  it('matches whole code spans only, so prose mentions never fire', () => {
    expect(findDeniedToolRecommendations('Finish the task, then the workflow.', DENIED)).toEqual([]);
    expect(findDeniedToolRecommendations('Use `TaskCreate` to file it.', DENIED)).toEqual([]);
  });
});

describe('extractRouteMechanisms', () => {
  it('reads mechanisms out of BOTH route-menu spellings', () => {
    const numbered = '1. **(0) I implement it myself** — drive it directly: `plans:launch` then `work_items:claim_next`.';
    const lettered = '  - **D. Spawn a new VISIBLE desktop fleet** — `fleet:launch-on-plan { name, plan, count }`.';
    expect(extractRouteMechanisms(numbered)).toEqual(['plans:launch', 'work_items:claim_next']);
    expect(extractRouteMechanisms(lettered)).toEqual(['fleet:launch-on-plan']);
  });

  it('strips the inline args suffix — the miss that made the whole family blind', () => {
    // Measured against the real corpus: writing the call shape inline is the NORM
    // for route mechanisms, so an anchored match on the raw span extracted NOTHING
    // from routes (3) and (4) — the two most load-bearing rules in the menu.
    const line = '5. **(4) Create a new HEADLESS fleet** — `fleet:launch-on-plan { name, plan, count, headless: true }`.';
    expect(extractRouteMechanisms(line)).toEqual(['fleet:launch-on-plan']);
  });

  it('reads the papercusp-way routing gate, and ONLY that table', () => {
    const md = [
      '| when the ask sounds like | the papercusp way |',
      '|---|---|',
      '| "do X daily" | `plans:set-schedule` THEN `plans:arm-schedule` |',
      '| "watch for Y" | `watch:create` — the unified subscription primitive |',
      '',
      'Some other table entirely:',
      '',
      '| you want | use | not |',
      '|---|---|---|',
      '| a line RANGE of one file | `capability:read` | `sed:noop` |',
    ].join('\n');
    expect(extractRouteMechanisms(md)).toEqual([
      'plans:arm-schedule',
      'plans:set-schedule',
      'watch:create',
    ]);
  });

  it('ignores verbs outside route rules — a render splices hundreds of them', () => {
    const md = [
      'Prose naming `coord:orient` and `work_items:list` in passing.',
      '',
      '- A bullet that is not a route mentioning `dev:pg_query`.',
    ].join('\n');
    expect(extractRouteMechanisms(md)).toEqual([]);
  });

  it('rejects non-verb code spans', () => {
    const line = '1. **(1) Hand to the Mug** — see `staging`, `--files`, `A.B`, and `work_items:create`.';
    expect(extractRouteMechanisms(line)).toEqual(['work_items:create']);
  });
});

describe('detectMaterialRenderDrift', () => {
  const source = [
    '| when the ask sounds like | the papercusp way |',
    '|---|---|',
    '| spawn a fleet | `fleet:launch-on-plan` |',
  ].join('\n');

  it('names a mechanism the render carries and no current source does', () => {
    const render = [
      '| when the ask sounds like | the papercusp way |',
      '|---|---|',
      '| spawn a fleet | `fleet:launch-on-plan` |',
      '| spawn a fleet the old way | `fleet:retired-verb` |',
    ].join('\n');
    const d = detectMaterialRenderDrift({ renderText: render, sourceTexts: [source], denied: DENIED });
    expect(d.retiredRouteMechanisms).toEqual(['fleet:retired-verb']);
    expect(d.material).toBe(true);
  });

  it('is SILENT on a mechanism the sources ADDED — that direction is layer variance', () => {
    // A session launched at a trimmed persona tier legitimately never carried a
    // layer, so "missing from render" cannot be told apart from "genuinely stale"
    // and would fire constantly on perfectly current sessions.
    const render = '| when the ask sounds like | the papercusp way |\n|---|---|\n| x | `fleet:launch-on-plan` |';
    const richer = `${source}\n| brand new row | \`templates:new-app\` |`;
    const d = detectMaterialRenderDrift({ renderText: render, sourceTexts: [richer], denied: DENIED });
    expect(d.retiredRouteMechanisms).toEqual([]);
    expect(d.material).toBe(false);
  });

  it('is SILENT on wording, formatting and reordering changes', () => {
    const reworded = [
      '| when the ask sounds like | the papercusp way |',
      '|---|---|',
      '| you want a fleet spun up (any phrasing at all) | `fleet:launch-on-plan { name, plan, count }` — now with extra prose |',
    ].join('\n');
    expect(
      detectMaterialRenderDrift({ renderText: reworded, sourceTexts: [source], denied: DENIED }).material,
    ).toBe(false);
  });

  it('reports a denied recommendation with NO reference document at all', () => {
    // Family 1 is reference-free on purpose: the deny list is live code, so a
    // recommendation of a denied tool is wrong however old the render is.
    const d = detectMaterialRenderDrift({
      renderText: 'use the `Task` (Agent) tool to fan out parallel work',
      sourceTexts: [],
      denied: DENIED,
    });
    expect(d.deniedRecommendations).toEqual(['Task']);
    expect(d.material).toBe(true);
  });

  it('FAILS CLOSED on an empty source union rather than calling everything retired', () => {
    const render = '1. **(0) do it** — `plans:launch`';
    const d = detectMaterialRenderDrift({ renderText: render, sourceTexts: [], denied: DENIED });
    expect(d.retiredRouteMechanisms).toEqual([]);
  });

  it('FAILS CLOSED when the caller could not establish the sources', () => {
    const render = '1. **(0) do it** — `plans:launch`';
    const d = detectMaterialRenderDrift({
      renderText: render,
      sourceTexts: ['| when the ask sounds like | the papercusp way |\n|---|---|\n| x | `other:verb` |'],
      denied: DENIED,
      includeRouteFamily: false,
    });
    expect(d.retiredRouteMechanisms).toEqual([]);
    expect(d.material).toBe(false);
  });
});

describe('driftFingerprint', () => {
  it('separates two distinct drifts on one session, and is stable for one drift', () => {
    const a = detectMaterialRenderDrift({
      renderText: 'use the `Task` tool to fan out',
      sourceTexts: [],
      denied: DENIED,
    });
    const b = detectMaterialRenderDrift({
      renderText: 'use the `Workflow` tool to fan out',
      sourceTexts: [],
      denied: DENIED,
    });
    expect(driftFingerprint(a)).not.toEqual(driftFingerprint(b));
    expect(driftFingerprint(a)).toEqual(driftFingerprint({ ...a }));
  });
});

describe('extractMaterialSignals', () => {
  it('returns both families from one pass', () => {
    const md = [
      'use the `Task` (Agent) tool to fan out',
      '',
      '1. **(3) fleet** — `fleet:launch-on-plan { count }`',
    ].join('\n');
    expect(extractMaterialSignals(md, DENIED)).toEqual({
      deniedRecommendations: ['Task'],
      routeMechanisms: ['fleet:launch-on-plan'],
    });
  });
});
