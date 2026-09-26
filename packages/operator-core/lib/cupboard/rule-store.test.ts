import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readRuleDir, resolveLocalRule } from './rule-store';

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
