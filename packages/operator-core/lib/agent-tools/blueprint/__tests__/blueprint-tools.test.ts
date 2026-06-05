/**
 * P-007 — handler-level tests for the agent-authoring blueprint tools
 * (validate / create / extend). All three are pure (no PG, no ctx), so the ctx
 * is a minimal stub.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import validateTool from '../validate';
import createTool from '../create';
import extendTool from '../extend';

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
