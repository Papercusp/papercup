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
