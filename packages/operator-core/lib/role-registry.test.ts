import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listRoles, getRole, rolesFiringOn, isValidRoleId, roleConsumes, KERNEL_ROLE_CONSUMES, __clearRoleRegistryCache } from './role-registry';

let harnessRoot: string;
let promptsDir: string;
let papercuspRoot: string;

vi.mock('./harness-paths', () => ({
  harnessPackageDir: () => harnessRoot,
}));
vi.mock('./papercusp-root', () => ({
  papercuspPath: (...segs: string[]) => join(papercuspRoot, ...segs),
}));

beforeEach(async () => {
  __clearRoleRegistryCache();
  harnessRoot = await mkdtemp(join(tmpdir(), 'role-registry-test-'));
  // Phase 5: built-in role manifests live in the base role library, which is where
  // listRoles() scans (join(harnessPackageDir(), 'blueprints', 'base', 'prompts')).
  promptsDir = join(harnessRoot, 'blueprints', 'base', 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  papercuspRoot = await mkdtemp(join(tmpdir(), 'papercusp-root-test-'));
  mkdirSync(join(papercuspRoot, 'global-plugins'), { recursive: true });
});

afterEach(async () => {
  __clearRoleRegistryCache();
  await rm(harnessRoot, { recursive: true, force: true });
  await rm(papercuspRoot, { recursive: true, force: true });
});

function writePlugin(scope: string, name: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const dir = join(papercuspRoot, 'global-plugins', scope, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'papercusp.json'), JSON.stringify(manifest), 'utf8');
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

function enablePluginsForHarness(slug: string, names: string[]) {
  const dir = join(papercuspRoot, 'harnesses', slug);
  mkdirSync(dir, { recursive: true });
  const enabled: Record<string, { version: string }> = {};
  for (const n of names) enabled[n] = { version: '0.1.0' };
  writeFileSync(join(dir, 'enabled-plugins.json'), JSON.stringify({ enabled }), 'utf8');
}

function writeRole(id: string, role: Record<string, unknown>) {
  writeFileSync(join(promptsDir, `${id}.md`), `# ${id}\n\nfake prompt`, 'utf8');
  writeFileSync(join(promptsDir, `${id}.role.json`), JSON.stringify(role), 'utf8');
}

describe('role-registry', () => {
  it('returns empty when no sidecars exist', () => {
    expect(listRoles()).toEqual([]);
  });

  it('discovers a single valid role', () => {
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      whenUseful: 'when infra changes',
      output: { kind: 'features', featureKind: 'infra' },
    });
    const roles = listRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0].id).toBe('infra-reviewer');
    expect(roles[0].output.featureKind).toBe('infra');
  });

  it('discovers multiple roles and sorts by id', () => {
    writeRole('security-reviewer', {
      id: 'security-reviewer',
      whenUseful: 'security changes',
      output: { kind: 'features', featureKind: 'security' },
    });
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      whenUseful: 'infra changes',
      output: { kind: 'features', featureKind: 'infra' },
    });
    const ids = listRoles().map((r) => r.id);
    expect(ids).toEqual(['infra-reviewer', 'security-reviewer']);
  });

  it('skips roles where the sidecar id mismatches the filename', () => {
    writeRole('infra-reviewer', {
      id: 'something-else',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'infra' },
    });
    expect(listRoles()).toEqual([]);
  });

  it('skips roles missing whenUseful', () => {
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      output: { kind: 'features', featureKind: 'infra' },
    });
    expect(listRoles()).toEqual([]);
  });

  it('skips roles missing output.featureKind for kind=features', () => {
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      whenUseful: 'x',
      output: { kind: 'features' },
    });
    expect(listRoles()).toEqual([]);
  });

  it('accepts roles with output.kind=spec (no featureKind required)', () => {
    writeRole('user-research', {
      id: 'user-research',
      whenUseful: 'when SPEC implies questions to answer',
      output: { kind: 'spec', specSection: 'Discovery' },
    });
    const roles = listRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0].output.kind).toBe('spec');
  });

  it('skips roles with unrecognised output kinds', () => {
    writeRole('weird', {
      id: 'weird',
      whenUseful: 'x',
      output: { kind: 'something-else' },
    });
    expect(listRoles()).toEqual([]);
  });

  it('skips roles whose featureKind is not slug-shaped', () => {
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'INFRA STRUCTURE' },
    });
    expect(listRoles()).toEqual([]);
  });

  it('skips a sidecar without a matching prompt file', () => {
    // Don't call writeRole — manually write only the sidecar.
    writeFileSync(join(promptsDir, 'orphan.role.json'), JSON.stringify({
      id: 'orphan',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'orphan' },
    }), 'utf8');
    expect(listRoles()).toEqual([]);
  });

  it('skips a sidecar with malformed JSON', () => {
    writeFileSync(join(promptsDir, 'broken.md'), '# broken', 'utf8');
    writeFileSync(join(promptsDir, 'broken.role.json'), '{not json', 'utf8');
    expect(listRoles()).toEqual([]);
  });

  it('skips invalid role ids', () => {
    writeRole('Bad Role', {
      id: 'Bad Role',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'bad' },
    });
    expect(listRoles()).toEqual([]);
  });

  it('getRole returns the matching manifest or null', () => {
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'infra' },
    });
    expect(getRole('infra-reviewer')?.id).toBe('infra-reviewer');
    expect(getRole('nonexistent')).toBeNull();
  });

  it('rolesFiringOn returns roles whose alwaysFireOn includes the event', () => {
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'infra' },
      alwaysFireOn: ['onProvisioned', 'onTeardown'],
    });
    writeRole('security-reviewer', {
      id: 'security-reviewer',
      whenUseful: 'y',
      output: { kind: 'features', featureKind: 'security' },
      alwaysFireOn: [],
    });
    expect(rolesFiringOn('onProvisioned').map((r) => r.id)).toEqual(['infra-reviewer']);
    expect(rolesFiringOn('onTeardown').map((r) => r.id)).toEqual(['infra-reviewer']);
    expect(rolesFiringOn('onUnknown').map((r) => r.id)).toEqual([]);
  });

  it('isValidRoleId accepts both builtin and plugin-namespaced ids', () => {
    expect(isValidRoleId('infra-reviewer')).toBe(true);
    expect(isValidRoleId('@scope/plugin:my-role')).toBe(true);
    expect(isValidRoleId('plugin:my-role')).toBe(true);
    expect(isValidRoleId('Bad Role')).toBe(false);
    expect(isValidRoleId('../traversal')).toBe(false);
    expect(isValidRoleId(':')).toBe(false);
  });
});

describe('plugin-contributed roles', () => {
  it('discovers a role from an enabled scoped plugin', () => {
    writePlugin('@scope', 'cf', {
      name: '@scope/cf',
      roles: [{
        id: 'reviewer',
        promptPath: 'roles/reviewer.md',
        whenUseful: 'when CF stuff',
        output: { kind: 'features', featureKind: 'infra' },
        alwaysFireOn: ['onProvisioned'],
      }],
    }, { 'roles/reviewer.md': '# reviewer prompt' });
    enablePluginsForHarness('test-harness', ['@scope/cf']);

    const roles = listRoles('test-harness');
    expect(roles).toHaveLength(1);
    expect(roles[0].id).toBe('@scope/cf:reviewer');
    expect(roles[0].source.kind).toBe('plugin');
    if (roles[0].source.kind === 'plugin') {
      expect(roles[0].source.plugin).toBe('@scope/cf');
      expect(roles[0].source.promptPath).toBe('roles/reviewer.md');
    }
    expect(roles[0].alwaysFireOn).toEqual(['onProvisioned']);
  });

  it('does NOT include plugin roles when the plugin is not enabled', () => {
    writePlugin('@scope', 'cf', {
      name: '@scope/cf',
      roles: [{
        id: 'reviewer',
        promptPath: 'roles/reviewer.md',
        whenUseful: 'x',
        output: { kind: 'features', featureKind: 'infra' },
      }],
    }, { 'roles/reviewer.md': '# x' });
    enablePluginsForHarness('test-harness', []); // no plugins enabled

    expect(listRoles('test-harness')).toEqual([]);
  });

  it('skips plugin role with missing prompt file', () => {
    writePlugin('@scope', 'cf', {
      name: '@scope/cf',
      roles: [{
        id: 'reviewer',
        promptPath: 'roles/missing.md',
        whenUseful: 'x',
        output: { kind: 'features', featureKind: 'infra' },
      }],
    });
    // Note: not writing the prompt file
    enablePluginsForHarness('test-harness', ['@scope/cf']);

    expect(listRoles('test-harness')).toEqual([]);
  });

  it('skips plugin role with traversal in promptPath', () => {
    writePlugin('@scope', 'cf', {
      name: '@scope/cf',
      roles: [{
        id: 'evil',
        promptPath: '../../../../etc/passwd',
        whenUseful: 'x',
        output: { kind: 'features', featureKind: 'infra' },
      }],
    });
    enablePluginsForHarness('test-harness', ['@scope/cf']);

    expect(listRoles('test-harness')).toEqual([]);
  });

  it('merges builtin and plugin roles, sorted by id', () => {
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'infra' },
    });
    writePlugin('@scope', 'cf', {
      name: '@scope/cf',
      roles: [{
        id: 'reviewer',
        promptPath: 'roles/reviewer.md',
        whenUseful: 'y',
        output: { kind: 'features', featureKind: 'infra' },
      }],
    }, { 'roles/reviewer.md': '# y' });
    enablePluginsForHarness('test-harness', ['@scope/cf']);

    const roles = listRoles('test-harness');
    expect(roles.map((r) => r.id)).toEqual(['@scope/cf:reviewer', 'infra-reviewer']);
    expect(roles[0].source.kind).toBe('plugin');
    expect(roles[1].source.kind).toBe('builtin');
  });

  it('rolesFiringOn includes plugin-contributed roles', () => {
    writePlugin('@scope', 'cf', {
      name: '@scope/cf',
      roles: [{
        id: 'verifier',
        promptPath: 'roles/v.md',
        whenUseful: 'x',
        output: { kind: 'features', featureKind: 'infra' },
        alwaysFireOn: ['onProvisioned'],
      }],
    }, { 'roles/v.md': '# v' });
    enablePluginsForHarness('test-harness', ['@scope/cf']);

    const matches = rolesFiringOn('onProvisioned', 'test-harness');
    expect(matches.map((r) => r.id)).toEqual(['@scope/cf:verifier']);
  });

  it('listRoles() without harness slug returns ONLY builtin roles', () => {
    writeRole('infra-reviewer', {
      id: 'infra-reviewer',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'infra' },
    });
    writePlugin('@scope', 'cf', {
      name: '@scope/cf',
      roles: [{
        id: 'reviewer',
        promptPath: 'roles/reviewer.md',
        whenUseful: 'y',
        output: { kind: 'features', featureKind: 'infra' },
      }],
    }, { 'roles/reviewer.md': '# y' });
    enablePluginsForHarness('test-harness', ['@scope/cf']);

    const roles = listRoles();
    expect(roles.map((r) => r.id)).toEqual(['infra-reviewer']);
  });

  it('handles symlinked plugin directories', async () => {
    // Create a real plugin elsewhere, symlink it into global-plugins
    const realDir = await mkdtemp(join(tmpdir(), 'real-plugin-'));
    mkdirSync(join(realDir, 'roles'), { recursive: true });
    writeFileSync(join(realDir, 'papercusp.json'), JSON.stringify({
      name: '@scope/real',
      roles: [{
        id: 'reviewer',
        promptPath: 'roles/reviewer.md',
        whenUseful: 'real',
        output: { kind: 'features', featureKind: 'infra' },
      }],
    }), 'utf8');
    writeFileSync(join(realDir, 'roles', 'reviewer.md'), '# real', 'utf8');

    const linkParent = join(papercuspRoot, 'global-plugins', '@scope');
    mkdirSync(linkParent, { recursive: true });
    require('node:fs').symlinkSync(realDir, join(linkParent, 'real'));
    enablePluginsForHarness('test-harness', ['@scope/real']);

    try {
      const roles = listRoles('test-harness');
      expect(roles).toHaveLength(1);
      expect(roles[0].id).toBe('@scope/real:reviewer');
    } finally {
      await rm(realDir, { recursive: true, force: true });
    }
  });
});

describe('roleConsumes', () => {
  it('feature-consuming kernel roles require a feature', () => {
    expect(roleConsumes('worker').feature).toBe('required');
    expect(roleConsumes('validator').feature).toBe('required');
    expect(roleConsumes('debugger').feature).toBe('required');
    expect(roleConsumes('architect').feature).toBe('required');
  });

  it('scoper works at plan scope; curator/operator/oracle need nothing', () => {
    expect(roleConsumes('scoper')).toEqual({ feature: 'none', plan: 'optional' });
    expect(roleConsumes('curator')).toEqual({ feature: 'none', plan: 'none' });
    expect(roleConsumes('operator')).toEqual({ feature: 'none', plan: 'none' });
    expect(roleConsumes('oracle')).toEqual({ feature: 'none', plan: 'none' });
  });

  it('documenter/reviewer take a feature optionally', () => {
    expect(roleConsumes('documenter').feature).toBe('optional');
    expect(roleConsumes('reviewer').feature).toBe('optional');
  });

  it('an unknown role falls back to none/none', () => {
    expect(roleConsumes('nonexistent-role')).toEqual({ feature: 'none', plan: 'none' });
  });

  it('the kernel map covers the roles psu offers', () => {
    for (const id of ['worker', 'validator', 'debugger', 'architect', 'documenter', 'reviewer', 'scoper', 'curator']) {
      expect(KERNEL_ROLE_CONSUMES[id]).toBeDefined();
    }
  });

  it('a cross-cutting manifest consumes overrides the kernel default', async () => {
    // security-reviewer-style cross-cutting role with an explicit consumes block.
    writeFileSync(join(promptsDir, 'feat-checker.role.json'), JSON.stringify({
      id: 'feat-checker',
      whenUseful: 'checks a feature',
      output: { kind: 'features', featureKind: 'feat-checker' },
      consumes: { feature: 'required', plan: 'none' },
    }), 'utf8');
    writeFileSync(join(promptsDir, 'feat-checker.md'), '# checker', 'utf8');
    __clearRoleRegistryCache();
    expect(roleConsumes('feat-checker').feature).toBe('required');
  });
});
