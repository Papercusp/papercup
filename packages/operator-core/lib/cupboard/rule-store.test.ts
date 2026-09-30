import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRulePackage, readRuleDir, resolveLocalRule, RULE_CONDITION_MAX_DEPTH } from './rule-store';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'rule-store-'));
  roots.push(root);
  return root;
}
const manifest = {
  schemaVersion: 1, id: 'notify-on-handoff', title: 'Notify',
  description: 'Notify the wearer when work arrives.', version: '1.0.0',
  delivery: 'async',
  on: 'coord:handoff', when: { 'result.ok': true },
  fire: 'class:notice.send@1.0.0#send', args: { message: 'work arrived' },
  onlyOnSuccess: true,
};
function put(dir: string, value: unknown = manifest, listing: unknown = { kind: 'rule', version: '1.0.0' }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'rule.json'), JSON.stringify(value));
  writeFileSync(join(dir, 'listing.json'), JSON.stringify(listing));
}

describe('local standalone rule packages', () => {
  it('reads the existing standalone rule fields without registering or granting anything', () => {
    const dir = scratch();
    put(dir);
    expect(readRuleDir(dir, 'publisher-notify')).toEqual({
      ...manifest, schemaVersion: undefined, ref: 'publisher-notify', dir, layer: 'user',
    });
  });

  it('uses the existing user-over-bundled resolution and accepts both manifest id and directory ref', () => {
    const root = scratch();
    vi.stubEnv('PAPERCUSP_HOME', join(root, 'home'));
    vi.stubEnv('PAPERCUSP_RULES_DIR', join(root, 'bundled'));
    put(join(root, 'bundled', 'notify'), { ...manifest, description: 'Bundled' });
    const userDir = join(root, 'home', 'rules', 'installed', 'notify');
    put(userDir, { ...manifest, description: 'User-installed' });
    expect(resolveLocalRule('notify')).toMatchObject({ dir: userDir, description: 'User-installed' });
    expect(resolveLocalRule(manifest.id)).toMatchObject({ dir: userDir, version: '1.0.0' });
    expect(resolveLocalRule('missing')).toBeNull();
  });

  it.each([
    { fire: 'coord:send' },
    { capability: 'operator:admin' },
    { principalId: 'system:event-reaction' },
    { onlyOnSuccess: 'yes' },
    { schemaVersion: 2 },
    { version: '' },
    { delivery: undefined },
    { delivery: 'sync' },
    { sink: 'turn-start' },
  ])('refuses malformed or authority-bearing rule data: %j', (override) => {
    const dir = scratch();
    put(dir, { ...manifest, ...override });
    expect(readRuleDir(dir, 'notify')).toBeNull();
  });

  it('refuses version disagreement, wrong listing kind and corrupt manifests', () => {
    const dir = scratch();
    put(dir, manifest, { kind: 'rule', version: '2.0.0' });
    expect(readRuleDir(dir, 'notify')).toBeNull();
    put(dir, manifest, { kind: 'recipe', version: '1.0.0' });
    expect(readRuleDir(dir, 'notify')).toBeNull();
    put(dir);
    writeFileSync(join(dir, 'rule.json'), 'not JSON');
    expect(readRuleDir(dir, 'notify')).toBeNull();
  });
});

// P-011 / D-023: a sync rule runs inline at one hook sink with exactly one of a
// read-only context capability or a deny-only guard.
const meta = {
  schemaVersion: 1, id: 'sync-rule', title: 'Sync', description: 'A sync hook rule.', version: '1.0.0',
};
const context = { ref: 'memory.recall@1', verb: 'recall', tokenBudget: 400, priority: 10, overBudget: 'truncate' };
const guard = { deny: { 'args.command': { matches: 'rm -rf' } }, reason: 'no recursive deletes' };

describe('sync rule packages', () => {
  it('reads a context rule at turn-start and a guard rule at pre-tool', () => {
    const contextDir = scratch();
    const contextRule = { ...meta, delivery: 'sync', sink: 'turn-start', context };
    put(contextDir, contextRule);
    expect(readRuleDir(contextDir, 'ctx')).toEqual({
      ...contextRule, schemaVersion: undefined, ref: 'ctx', dir: contextDir, layer: 'user',
    });

    const guardRule = { ...meta, delivery: 'sync', sink: 'pre-tool', tools: ['capability:bash', 'fs:*'], guard };
    expect(parseRulePackage(guardRule)).toMatchObject({ ok: true, rule: { sink: 'pre-tool', guard } });
  });

  it.each([
    ['a guard off pre-tool', { sink: 'stop', guard }, 'guard'],
    ['a context hook at pre-tool', { sink: 'pre-tool', context }, 'context'],
    ['both context and guard', { sink: 'post-tool', context, guard }, 'exactly one'],
    ['neither context nor guard', { sink: 'turn-start' }, 'exactly one'],
    ['a tools filter at a non-tool sink', { sink: 'stop', tools: ['coord:send'], context }, 'tools'],
    ['an async fire on a sync rule', { sink: 'turn-start', context, fire: 'class:notice.send@1.0.0#send' }, 'fire'],
    ['an unknown sink', { sink: 'mid-thought', context }, 'sink'],
    ['a context ref without a major', { sink: 'turn-start', context: { ...context, ref: 'memory.recall' } }, 'class@major'],
    ['an allow-granting guard', { sink: 'pre-tool', guard: { allow: { tool: 'x' } } }, 'guard'],
    ['a malformed tool filter', { sink: 'pre-tool', tools: ['fs:*:read'], guard }, 'tools'],
  ])('refuses %s and names the problem', (_label, fields, named) => {
    const parsed = parseRulePackage({ ...meta, delivery: 'sync', ...fields });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(named);
  });

  it('bounds a guard condition before it is ever evaluated', () => {
    let deep: Record<string, unknown> = { 'args.path': '/etc' };
    for (let i = 0; i <= RULE_CONDITION_MAX_DEPTH; i += 1) deep = { all: [deep] };
    const parsed = parseRulePackage({ ...meta, delivery: 'sync', sink: 'pre-tool', guard: { deny: deep } });
    expect(parsed.ok).toBe(false);

    const wide = { any: Array.from({ length: 400 }, (_, i) => ({ [`args.f${i}`]: i })) };
    expect(parseRulePackage({ ...meta, delivery: 'sync', sink: 'pre-tool', guard: { deny: wide } }).ok).toBe(false);
  });
});
