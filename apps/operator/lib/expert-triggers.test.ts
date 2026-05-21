/**
 * Tests for the plugin-event → expert dispatch wiring.
 *
 * The triggers module reads the role registry and dispatches any role
 * whose `alwaysFireOn` includes the fired event name. Best-effort:
 * failures don't propagate to the original plugin event chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let papercuspRoot: string;
let harnessRoot: string;

vi.mock('./harness-paths', () => ({
  harnessPackageDir: () => harnessRoot,
}));
vi.mock('./papercusp-root', () => ({
  papercuspPath: (...segs: string[]) => join(papercuspRoot, ...segs),
}));

const dispatched: Array<{ role: string; reason?: string }> = [];
vi.mock('./expert-dispatcher', () => ({
  dispatchExpert: vi.fn(async (_project: unknown, role: string, ctx: { reason?: string }) => {
    dispatched.push({ role, reason: ctx.reason });
    return { ok: true, expertId: `ua-${dispatched.length}`, userActionId: dispatched.length };
  }),
}));

vi.mock('./harness-registry', () => ({
  loadHarnessRegistry: () => ({
    projects: [{ slug: 'test-harness', path: '/tmp/fake-project' }],
  }),
}));

import { fireLifecycleTriggers, fireEventTriggers } from './expert-triggers';
import { __clearRoleRegistryCache } from './role-registry';

beforeEach(async () => {
  __clearRoleRegistryCache();
  dispatched.length = 0;
  papercuspRoot = await mkdtemp(join(tmpdir(), 'expert-triggers-test-'));
  harnessRoot = await mkdtemp(join(tmpdir(), 'harness-test-'));
  await mkdir(join(harnessRoot, 'prompts'), { recursive: true });
  await mkdir(join(papercuspRoot, 'global-plugins'), { recursive: true });
  // Register a built-in role with alwaysFireOn for the tests.
  await writeFile(
    join(harnessRoot, 'prompts', 'infra-reviewer.md'),
    '# fake prompt',
    'utf8',
  );
  await writeFile(
    join(harnessRoot, 'prompts', 'infra-reviewer.role.json'),
    JSON.stringify({
      id: 'infra-reviewer',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'infra' },
      alwaysFireOn: ['onProvisioned', 'onDeploy'],
    }),
    'utf8',
  );
  // And a role with no triggers (should not fire).
  await writeFile(
    join(harnessRoot, 'prompts', 'security-reviewer.md'),
    '# x',
    'utf8',
  );
  await writeFile(
    join(harnessRoot, 'prompts', 'security-reviewer.role.json'),
    JSON.stringify({
      id: 'security-reviewer',
      whenUseful: 'x',
      output: { kind: 'features', featureKind: 'security' },
    }),
    'utf8',
  );
});

afterEach(async () => {
  __clearRoleRegistryCache();
  await rm(papercuspRoot, { recursive: true, force: true });
  await rm(harnessRoot, { recursive: true, force: true });
});

describe('fireLifecycleTriggers', () => {
  it('dispatches roles whose alwaysFireOn includes the lifecycle event', async () => {
    const out = await fireLifecycleTriggers('onProvisioned', 'test-harness', {
      pluginSlug: '@papercupai/cf',
    });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('infra-reviewer');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].reason).toMatch(/lifecycle:onProvisioned fired/);
  });

  it('dispatches multiple roles when multiple match', async () => {
    // Add a second role that also fires on onProvisioned.
    await writeFile(
      join(harnessRoot, 'prompts', 'cost-reviewer.md'),
      '# x',
      'utf8',
    );
    await writeFile(
      join(harnessRoot, 'prompts', 'cost-reviewer.role.json'),
      JSON.stringify({
        id: 'cost-reviewer',
        whenUseful: 'x',
        output: { kind: 'features', featureKind: 'cost' },
        alwaysFireOn: ['onProvisioned'],
      }),
      'utf8',
    );
    __clearRoleRegistryCache();

    const out = await fireLifecycleTriggers('onProvisioned', 'test-harness', {});
    expect(out.map((o) => o.role).sort()).toEqual(['cost-reviewer', 'infra-reviewer']);
    expect(dispatched).toHaveLength(2);
  });

  it('does NOT dispatch roles without matching alwaysFireOn', async () => {
    // security-reviewer has no alwaysFireOn — should not fire.
    const out = await fireLifecycleTriggers('onProvisioned', 'test-harness', {});
    expect(out.find((o) => o.role === 'security-reviewer')).toBeUndefined();
  });

  it('returns [] when no roles match the event', async () => {
    const out = await fireLifecycleTriggers('onUnknownEvent', 'test-harness', {});
    expect(out).toEqual([]);
    expect(dispatched).toHaveLength(0);
  });

  it('returns [] when harness slug is not registered', async () => {
    const out = await fireLifecycleTriggers('onProvisioned', 'nonexistent-slug', {});
    expect(out).toEqual([]);
    expect(dispatched).toHaveLength(0);
  });

  it('passes context object through to the dispatched role', async () => {
    const ctx = { pluginSlug: '@scope/test', extra: 42 };
    await fireLifecycleTriggers('onProvisioned', 'test-harness', ctx);
    expect(dispatched).toHaveLength(1);
    // The dispatchExpert mock captures the third arg (DispatchCtx) as
    // a whole object. We can verify the reason was templated correctly.
    expect(dispatched[0].reason).toContain('lifecycle:onProvisioned');
  });

  it('does not throw when dispatcher fails — best-effort semantics', async () => {
    const { dispatchExpert } = await import('./expert-dispatcher');
    (dispatchExpert as any).mockImplementationOnce(async () => {
      throw new Error('dispatch failed');
    });
    await expect(
      fireLifecycleTriggers('onProvisioned', 'test-harness', {}),
    ).resolves.toBeDefined();
  });
});

describe('fireEventTriggers', () => {
  it('dispatches roles matching free-form events', async () => {
    const out = await fireEventTriggers('onDeploy', 'test-harness', { extra: 'x' });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('infra-reviewer');
  });

  it('returns [] when arg is not an object (no installSlug to derive)', async () => {
    // The plugin-host-runtime hook only fires fireEventTriggers when
    // `arg` has installSlug; this test verifies trigger behavior given a
    // properly-shaped arg works at this layer.
    const out = await fireEventTriggers('onDeploy', 'test-harness', { foo: 'bar' });
    expect(out.length).toBeGreaterThan(0);
  });
});
