/**
 * run-sandbox.test.ts — the RunSandbox open/scope/dispose + isolation tests (P-002).
 * FULLY STUBBED: a fake SandboxHiveOps + a fake run-tool. NO real hive boot, NO MCP call.
 */
import { describe, expect, it } from 'vitest';
import { openRunSandbox } from './run-sandbox';
import type { OpenRunSandboxDeps } from './capability-tools';
import type { RunTool, RunToolResult, SandboxHiveOps } from './types';

/** Records every hive-ops call so the test can assert the boot/teardown ordering + scope. */
function fakeHiveOps(): SandboxHiveOps & { calls: Array<{ op: string; input: unknown }> } {
  const calls: Array<{ op: string; input: unknown }> = [];
  return {
    calls,
    async createHive(input) {
      calls.push({ op: 'createHive', input });
    },
    async registerMember(input) {
      calls.push({ op: 'registerMember', input });
    },
    async seedFeature(input) {
      calls.push({ op: 'seedFeature', input });
    },
    async dropMember(input) {
      calls.push({ op: 'dropMember', input });
    },
    async dissolveHive(input) {
      calls.push({ op: 'dissolveHive', input });
    },
  };
}

/** A no-op run-tool (the sandbox carries it; the sandbox tests don't call it). */
const noopRunTool: RunTool = async (): Promise<RunToolResult> => ({ ok: true, payload: {} });

function deps(hiveOps: SandboxHiveOps): OpenRunSandboxDeps {
  return { workspaceId: 'ws-test', hiveOps, runTool: noopRunTool };
}

describe('openRunSandbox', () => {
  it('boots an ephemeral hive + member + bootstrap feature, scoped to one hive_slug', async () => {
    const hiveOps = fakeHiveOps();
    const sandbox = await openRunSandbox(deps(hiveOps), {
      suite: 'swe-bench-pro',
      arm: '+memory',
      runId: 'run-1',
      hiveSlug: 'sbx-hive',
    });

    expect(sandbox.hiveSlug).toBe('sbx-hive');
    expect(sandbox.memberSlug).toBe('sbx-hive-m');
    expect(sandbox.workspaceId).toBe('ws-test');
    expect(sandbox.id).toEqual({ suite: 'swe-bench-pro', arm: '+memory', runId: 'run-1' });

    // Boot ordering: createHive → registerMember → seedFeature, all on the same hive/member.
    expect(hiveOps.calls.map((c) => c.op)).toEqual(['createHive', 'registerMember', 'seedFeature']);
    expect(hiveOps.calls[0].input).toMatchObject({ slug: 'sbx-hive', workspaceId: 'ws-test' });
    expect(hiveOps.calls[1].input).toMatchObject({
      member: 'sbx-hive-m',
      hiveHome: 'sbx-hive',
      workspaceId: 'ws-test',
    });
    expect(hiveOps.calls[2].input).toMatchObject({ member: 'sbx-hive-m', workspaceId: 'ws-test' });
  });

  it('generates a unique hive slug per sandbox when none is supplied', async () => {
    const a = await openRunSandbox(deps(fakeHiveOps()), { suite: 's', arm: 'ours', runId: 'r' });
    const b = await openRunSandbox(deps(fakeHiveOps()), { suite: 's', arm: 'ours', runId: 'r' });
    expect(a.hiveSlug).not.toBe(b.hiveSlug);
    expect(a.hiveSlug).toMatch(/^xbench-cap-s-ours-/);
  });

  it('dispose() tears the hive down (dropMember → dissolveHive) and is idempotent', async () => {
    const hiveOps = fakeHiveOps();
    const sandbox = await openRunSandbox(deps(hiveOps), {
      suite: 's',
      arm: 'a',
      runId: 'r',
      hiveSlug: 'sbx-dispose',
    });
    hiveOps.calls.length = 0; // ignore boot calls; focus on teardown.

    await sandbox.dispose();
    expect(hiveOps.calls.map((c) => c.op)).toEqual(['dropMember', 'dissolveHive']);
    expect(hiveOps.calls[0].input).toMatchObject({ member: 'sbx-dispose-m', workspaceId: 'ws-test' });
    expect(hiveOps.calls[1].input).toMatchObject({ hiveHome: 'sbx-dispose', workspaceId: 'ws-test' });

    // Idempotent: a second dispose does not double-tear-down.
    await sandbox.dispose();
    expect(hiveOps.calls.filter((c) => c.op === 'dissolveHive')).toHaveLength(1);
  });

  it('dissolves the hive (no leak) when a boot step AFTER createHive throws', async () => {
    const hiveOps = fakeHiveOps();
    hiveOps.registerMember = async () => {
      throw new Error('register failed');
    };
    await expect(
      openRunSandbox(deps(hiveOps), { suite: 's', arm: 'a', runId: 'r', hiveSlug: 'sbx-fail' }),
    ).rejects.toThrow('register failed');
    // createHive ran, then teardown dissolved it — no leaked hive.
    expect(hiveOps.calls.map((c) => c.op)).toEqual(['createHive', 'dropMember', 'dissolveHive']);
  });

  it('two sandboxes isolate distinct hive_slug + memberSlug namespaces', async () => {
    const a = await openRunSandbox(deps(fakeHiveOps()), { suite: 's', arm: 'A', runId: 'r', hiveSlug: 'hive-A' });
    const b = await openRunSandbox(deps(fakeHiveOps()), { suite: 's', arm: 'B', runId: 'r', hiveSlug: 'hive-B' });
    expect(a.hiveSlug).not.toBe(b.hiveSlug);
    expect(a.memberSlug).not.toBe(b.memberSlug);
  });
});
