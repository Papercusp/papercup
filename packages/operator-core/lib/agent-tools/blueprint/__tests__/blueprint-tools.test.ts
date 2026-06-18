/**
 * P-007 — handler-level tests for the agent-authoring blueprint tools
 * (validate / create / extend). All three are pure (no PG, no ctx), so the ctx
 * is a minimal stub.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import validateTool from '../validate';
import createTool from '../create';
import extendTool from '../extend';
import { _resetPapercuspRootForTests } from '../../../papercusp-root';

const CTX = { log() {}, workspaceId: 'ws', role: 'operator' } as never;
const run = async (tool: { handler: (a: never, c: never) => Promise<{ content: { text: string }[] }> }, args: Record<string, unknown>) =>
  JSON.parse((await tool.handler(args as never, CTX)).content[0].text);

const MINIMAL = {
  id: 'mini',
  workItem: { kind: 'feature' },
  spine: { edges: { DONE: { to: 'done' }, NEXT_WORKER: { to: 'role', role: 'worker' } } },
  roles: [{ id: 'director' }, { id: 'worker' }],
};

describe('blueprint:validate', () => {
  it('validates the built-in coding blueprint', async () => {
    const r = await run(validateTool, { id: 'coding' });
    expect(r.ok).toBe(true);
    expect(r.summary.id).toBe('coding');
    expect(r.summary.spineVerbs).toContain('DONE');
    expect(r.summary.spineVerbs).toContain('NEXT_WORKER');
  });

  it('reports a parse error for malformed source', async () => {
    const r = await run(validateTool, { source: 'id: x\nworkItem: {kind: feature}\n' /* no spine */ });
    expect(r.ok).toBe(false);
    expect(r.parseError).toBeTruthy();
  });

  it('validates inline YAML source', async () => {
    const r = await run(validateTool, {
      source: 'id: s\nworkItem: { kind: feature }\nspine: { edges: { DONE: { to: done } } }\n',
    });
    expect(r.ok).toBe(true);
    expect(r.summary.id).toBe('s');
  });
});

describe('blueprint:create', () => {
  it('emits validated canonical YAML for a new blueprint', async () => {
    const r = await run(createTool, { blueprint: MINIMAL });
    expect(r.ok).toBe(true);
    expect(r.yaml).toContain('id: mini');
    // round-trips back to the same object shape
    expect(parseYaml(r.yaml).id).toBe('mini');
  });

  it('returns parseError for an unresolvable blueprint', async () => {
    const r = await run(createTool, { blueprint: { id: 'x', extends: 'no-such-parent', workItem: { kind: 'f' }, spine: { edges: { DONE: { to: 'done' } } } } });
    expect(r.ok).toBe(false);
    expect(r.parseError).toContain('extends');
  });
});

describe('blueprint:extend', () => {
  it('authors a child extending coding (knob override)', async () => {
    const r = await run(extendTool, { id: 'my-coding', parent: 'coding', overrides: { knobs: { maxCostUsd: 5 } } });
    expect(r.ok).toBe(true);
    const child = parseYaml(r.yaml);
    expect(child.id).toBe('my-coding');
    expect(child.extends).toBe('coding');
    expect(child.knobs.maxCostUsd).toBe(5);
  });

  it('fails on an unknown parent', async () => {
    const r = await run(extendTool, { id: 'c', parent: 'nope', overrides: {} });
    expect(r.ok).toBe(false);
    expect(r.parseError).toBeTruthy();
  });
});

// ─── installed-tier resolution (official-blueprints-cupboard-publish D-005 / P-006) ───
// blueprint:extend / blueprint:validate resolve parents through the composed
// installed (~/.papercusp/blueprints) → built-in tiers, not built-in only.
describe('installed (non-built-in) parents', () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(join(tmpdir(), 'bp-tools-home-'));
    const dir = join(home, 'blueprints', 'installed-parent');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'blueprint.yaml'),
      [
        'id: installed-parent',
        'version: 0.9.0',
        'description: a Cupboard-installed parent',
        'workItem: { kind: feature }',
        'spine: { edges: { DONE: { to: done } } }',
        'knobs: { requiresRepo: false }',
      ].join('\n'),
      'utf8',
    );
    process.env.PAPERCUSP_HOME = home;
    _resetPapercuspRootForTests();
  });

  afterEach(async () => {
    delete process.env.PAPERCUSP_HOME;
    _resetPapercuspRootForTests();
    await fs.rm(home, { recursive: true, force: true });
  });

  it('blueprint:validate resolves an installed blueprint by id', async () => {
    const r = await run(validateTool, { id: 'installed-parent' });
    expect(r.ok).toBe(true);
    expect(r.summary.id).toBe('installed-parent');
    expect(r.summary.requiresRepo).toBe(false);
  });

  it('blueprint:extend extends an installed (non-built-in) parent', async () => {
    const r = await run(extendTool, { id: 'my-child', parent: 'installed-parent', overrides: { knobs: { x: 1 } } });
    expect(r.ok).toBe(true);
    const child = parseYaml(r.yaml);
    expect(child.extends).toBe('installed-parent');
  });

  it('built-ins still resolve when the installed tier lacks the id (bundle floor, D-004)', async () => {
    const r = await run(validateTool, { id: 'coding' });
    expect(r.ok).toBe(true);
    expect(r.summary.id).toBe('coding');
  });
});

// ─── G1: extend.ts merge semantics — the engine deep-merges OBJECTS but REPLACES
// arrays/scalars. extend.ts spreads overrides at the child's TOP level and lets
// resolveExtends do the DEEP merge during resolution, so both shapes resolve
// correctly. These pin that contract: an array override REPLACES the parent's
// array; an object override (spine.edges) DEEP-MERGES with it. Re-validating the
// returned YAML via {source} resolves it through the real engine.
describe('blueprint:extend — merge semantics (deep-merge objects, replace arrays)', () => {
  it('an array override (roles) REPLACES the parent array — resolved has ONLY the override', async () => {
    const r = await run(extendTool, { id: 'c', parent: 'coding', overrides: { roles: [{ id: 'solo' }] } });
    expect(r.ok).toBe(true);
    // The returned child YAML carries the override verbatim (one role) …
    const child = parseYaml(r.yaml);
    expect(child.roles).toEqual([{ id: 'solo' }]);
    // … and re-resolving it through the engine confirms the parent's many roles
    // were REPLACED, not appended: exactly the one override role survives.
    const resolved = await run(validateTool, { source: r.yaml });
    expect(resolved.summary.roles).toEqual(['solo']);
    // Fault-injection guard: this assertion is NON-VACUOUS only because the array
    // was replaced. coding declares >1 role; if extend.ts had deep-merged the
    // array (concat) the resolved set would contain the parent roles too.
    expect(resolved.summary.roles).not.toContain('worker');
    expect(resolved.summary.roles.length).toBe(1);
  });

  it('an object override (spine.edges) DEEP-MERGES — resolved retains parent edges AND adds the new one', async () => {
    const r = await run(extendTool, {
      id: 'c2',
      parent: 'coding',
      overrides: { spine: { edges: { CUSTOM: { to: 'role', role: 'worker' } } } },
    });
    expect(r.ok).toBe(true);
    const child = parseYaml(r.yaml);
    // The child override only mentions CUSTOM …
    expect(Object.keys(child.spine.edges)).toEqual(['CUSTOM']);
    // … but the resolved spine RETAINS the parent's edges (DONE, NEXT_WORKER) AND
    // gains CUSTOM — the object deep-merge, not an array/scalar replace.
    const resolved = await run(validateTool, { source: r.yaml });
    expect(resolved.summary.spineVerbs).toContain('DONE');
    expect(resolved.summary.spineVerbs).toContain('NEXT_WORKER');
    expect(resolved.summary.spineVerbs).toContain('CUSTOM');
  });
});

// ─── G2: validate.ts returns issues instead of throwing on a semantically-broken
// (but schema-valid) blueprint. An unreachable/non-terminating spine is a hard
// ERROR; an undeclared dispatch target is a non-blocking WARNING. Both paths must
// return cleanly (no thrown exception, no parseError).
describe('blueprint:validate — semantic errors are returned, not thrown', () => {
  it('a non-terminating spine (no terminal edge, non-terminal default) → ok:false with errors, no throw', async () => {
    const src = [
      'id: g2',
      'workItem: { kind: feature }',
      'roles: [{ id: director }, { id: worker }]',
      'spine:',
      '  decider: director',
      '  edges: { NEXT_WORKER: { to: role, role: worker } }',
      '  default: { to: role, role: worker }',
    ].join('\n');
    const r = await run(validateTool, { source: src });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.map((e: { code: string }) => e.code)).toContain('no-terminal');
    // Returned, not thrown: no parseError, and a summary is still produced.
    expect(r.parseError).toBeUndefined();
    expect(r.summary.id).toBe('g2');
  });

  it('an unreachable (declared-but-unused) role → ok:true with an unused-role WARNING', async () => {
    const src = [
      'id: g2b',
      'workItem: { kind: feature }',
      'roles: [{ id: director }, { id: worker }, { id: orphan }]',
      'spine:',
      '  decider: director',
      '  edges: { DONE: { to: done }, NEXT_WORKER: { to: role, role: worker } }',
    ].join('\n');
    const r = await run(validateTool, { source: src });
    // Reachability is a warning, not a hard error — the blueprint still runs.
    expect(r.ok).toBe(true);
    expect(r.parseError).toBeUndefined();
    expect(r.warnings.map((w: { code: string }) => w.code)).toContain('unused-role');
    expect(r.warnings.some((w: { message: string }) => w.message.includes('orphan'))).toBe(true);
  });

  it('a dispatch target with no matching role (ghost) → ok:true, a dispatch-undeclared-role WARNING (not thrown)', async () => {
    const src = [
      'id: g2c',
      'workItem: { kind: feature }',
      'roles: [{ id: director }, { id: worker }]',
      'spine:',
      '  decider: director',
      '  edges: { DONE: { to: done }, NEXT_WORKER: { to: role, role: ghost } }',
    ].join('\n');
    const r = await run(validateTool, { source: src });
    expect(r.ok).toBe(true);
    expect(r.parseError).toBeUndefined();
    expect(r.warnings.map((w: { code: string }) => w.code)).toContain('dispatch-undeclared-role');
  });
});

// ─── G3: program-mode spine — the summary surfaces spineSteps (and leaves
// spineVerbs empty), the mirror of the decider/edges path. One valid program,
// one with a gate branch that can never resolve (no fallback → a hard error).
describe('blueprint:validate — program-mode spine summary', () => {
  it('a valid steps+gate program → summary.spineSteps populated, summary.spineVerbs empty', async () => {
    const src = [
      'id: g3',
      'workItem: { kind: decision }',
      'roles: [{ id: voter }]',
      'spine:',
      '  decider: voter',
      '  steps:',
      // P-001: the authoring path now enforces op-liveness against the live coord-op
      // registry, so a valid program must name REAL registered ops (these fixtures
      // previously used placeholder `spawn-roles`/`collect-votes` that nothing caught).
      '    - { id: s1, op: orchestrator:spawn-roles }',
      '    - { id: s2, op: coord:collect }',
      '  gate:',
      '    - { op: resolve, else: true }',
    ].join('\n');
    const r = await run(validateTool, { source: src });
    expect(r.ok).toBe(true);
    expect(r.summary.spineSteps).toEqual(['s1', 's2']);
    expect(r.summary.spineVerbs).toEqual([]);
  });

  it('a gate with no fallback branch → ok:false (gate-no-fallback error), no throw', async () => {
    const src = [
      'id: g3b',
      'workItem: { kind: decision }',
      'roles: [{ id: voter }]',
      'spine:',
      '  decider: voter',
      '  steps:',
      '    - { id: s1, op: orchestrator:spawn-roles }',
      '  gate:',
      "    - { op: resolve, when: { '==': [{ var: tally.winner }, yes] } }",
    ].join('\n');
    const r = await run(validateTool, { source: src });
    expect(r.ok).toBe(false);
    expect(r.parseError).toBeUndefined();
    expect(r.errors.map((e: { code: string }) => e.code)).toContain('gate-no-fallback');
  });
});
