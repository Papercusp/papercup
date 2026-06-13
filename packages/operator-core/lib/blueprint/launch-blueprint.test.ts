import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  BUILTIN_LAUNCH_BLUEPRINTS,
  resolveLaunchTarget,
  resolveLaunchTargetForEvent,
  launchBlueprintTriggerMap,
  resolveLaunchTriggerEvent,
  resetLaunchBlueprintTriggerMap,
  fireLaunchBlueprint,
  fireLaunchBlueprintForEvent,
  setLaunchBlueprintFire,
  setLaunchBlueprintResolver,
  buildLaunchSpawnRequest,
  type LaunchFireFn,
} from './launch-blueprint';

afterEach(() => {
  setLaunchBlueprintFire(null);
  setLaunchBlueprintResolver(null);
  resetLaunchBlueprintTriggerMap();
});

const opts = { installSlug: 'papercup', workspaceId: 'ws_test' };

describe('launch-blueprint primitive (unify-agent-launches-as-blueprints P0)', () => {
  it('every built-in launch blueprint resolves to its single decider role', async () => {
    const expected: Record<string, string> = {
      deploy: 'release-manager',
      scan: 'scanner',
      implement: 'worker',
      'merge-resolution': 'merge-resolver',
      // release-pipeline-resilience-2026-06-09 P-006: the gate-fixer's decider IS the release-fixer role.
      'release-fix': 'release-fixer',
      audit: 'auditor',
      // local-hive P-071 (2026-06-10): the hive's decider is the QUEEN — the
      // operator specialized for placement (D-001); `operator` remains the
      // deciderAlternative for decision-tree-only wakes (blueprint.yaml).
      hive: 'queen',
      // local-hive P-010/P-011: the bee launch blueprint's decider IS the bee role.
      bee: 'bee',
      // unify-launch-mechanics D-004: the sentinel watcher's decider IS the sentinel role.
      sentinel: 'sentinel',
    };
    for (const id of BUILTIN_LAUNCH_BLUEPRINTS) {
      const target = await resolveLaunchTarget(id, opts);
      expect(target.blueprintId).toBe(id);
      expect(target.role).toBe(expected[id]);
      // The invoke URL carries the resolved role + the workspace.
      expect(target.url).toContain(`role=${encodeURIComponent(expected[id]!)}`);
      expect(target.url).toContain('/api/harness/papercup/invoke');
      expect(target.url).toContain('ws=ws_test');
    }
  });

  it('buildLaunchSpawnRequest opts the implement worker INTO a fleet:tree row (EI-403 round-2)', async () => {
    // The durable path otherwise records no spawned_agents row — round 1's implement
    // workers ran invisibly. The seam must request the row so durableSpawnFireImpl
    // writes it; the itemId rides bodyExtra.improvementDispatch so fleet:tree shows
    // which EI the worker is on.
    const req = await buildLaunchSpawnRequest(
      'implement',
      { ...opts, bodyExtra: { improvementDispatch: { dispatchId: 'd1', itemId: 'EI-9', attempt: 2 } } },
      'implement:EI-9:2',
    );
    expect(req.idempotencyKey).toBe('implement:EI-9:2');
    expect(req.url).toContain('role=worker');
    expect(req.spawnRecord).toBeDefined();
    expect(req.spawnRecord).toMatchObject({
      workspaceId: 'ws_test',
      harnessSlug: 'papercup',
      childRole: 'worker',
      parentRole: 'operator', // parentless system launch
      itemId: 'EI-9',
    });
  });

  it('the event map binds each event-triggered launch blueprint by its trigger key', () => {
    const map = launchBlueprintTriggerMap();
    expect(map['git-sync:conflict']).toBe('merge-resolution');
    expect(map['feature:reaches-auditor-lane']).toBe('audit');
    // Scheduled launches declare no event key — they are not in the event map.
    expect(Object.values(map)).not.toContain('deploy');
    expect(resolveLaunchTriggerEvent('git-sync:conflict')).toBe('merge-resolution');
    // release-pipeline-resilience-2026-06-09 P-007: the gate-red event binds the release-fix clone.
    expect(map['green-checkpoint:red']).toBe('release-fix');
    expect(resolveLaunchTriggerEvent('green-checkpoint:red')).toBe('release-fix');
    expect(resolveLaunchTriggerEvent('nope:nonexistent')).toBeNull();
  });

  it('resolveLaunchTargetForEvent resolves the conflict event to the merge-resolver', async () => {
    const target = await resolveLaunchTargetForEvent('git-sync:conflict', opts);
    expect(target).not.toBeNull();
    expect(target!.blueprintId).toBe('merge-resolution');
    expect(target!.role).toBe('merge-resolver');
    expect(await resolveLaunchTargetForEvent('nope:nonexistent', opts)).toBeNull();
  });

  it('fireLaunchBlueprint resolves the role from the blueprint + dispatches via the fire seam', async () => {
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => {
      fired.push(input);
    });
    const target = await fireLaunchBlueprint('deploy', { ...opts, kickoff: 'go' });
    expect(target.role).toBe('release-manager');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ blueprintId: 'deploy', role: 'release-manager', kickoff: 'go' });
    expect(fired[0]!.url).toContain('role=release-manager');
  });

  it('fireLaunchBlueprintForEvent fires the launch blueprint that declares the event key', async () => {
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => {
      fired.push(input);
    });
    const target = await fireLaunchBlueprintForEvent('git-sync:conflict', {
      ...opts,
      extra: ['--git-sync-conflict', '{}'],
      timeoutMs: 280_000,
    });
    expect(target).not.toBeNull();
    expect(target!.role).toBe('merge-resolver');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ blueprintId: 'merge-resolution', role: 'merge-resolver', timeoutMs: 280_000 });
    expect(fired[0]!.extra).toEqual(['--git-sync-conflict', '{}']);
  });

  // P-007: exercise the SAME launch path for the new gate-red event end-to-end, so
  // the release-fix clone of merge-resolution is proven (not assumed) before
  // green-checkpoint relies on it to auto-dispatch a release-fixer.
  it('fireLaunchBlueprintForEvent fires release-fix for the green-checkpoint:red event', async () => {
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => {
      fired.push(input);
    });
    const target = await fireLaunchBlueprintForEvent('green-checkpoint:red', {
      ...opts,
      extra: ['--green-checkpoint-red', '{}'],
      timeoutMs: 280_000,
    });
    expect(target).not.toBeNull();
    expect(target!.blueprintId).toBe('release-fix');
    expect(target!.role).toBe('release-fixer');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ blueprintId: 'release-fix', role: 'release-fixer', timeoutMs: 280_000 });
    expect(fired[0]!.url).toContain('role=release-fixer');
    expect(fired[0]!.extra).toEqual(['--green-checkpoint-red', '{}']);
  });

  it('fireLaunchBlueprintForEvent returns null (no fire) for an unmapped event', async () => {
    const fired: unknown[] = [];
    setLaunchBlueprintFire((input) => {
      fired.push(input);
    });
    // The miss logs a warn by design — assert it, mocked, rather than letting it
    // trip the fail-on-console harness.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = await fireLaunchBlueprintForEvent('nope:nonexistent', opts);
    expect(target).toBeNull();
    expect(fired).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('the no-nest guard REJECTS a parented kind:hive launch (hive under a parent)', async () => {
    const fired: unknown[] = [];
    setLaunchBlueprintFire((input) => {
      fired.push(input);
    });
    // hive is kind:'hive' — firing it WITH a parent context must throw + never fire.
    await expect(
      fireLaunchBlueprint('hive', { ...opts, parent: { spawnId: 's-parent-1', role: 'bee' } }),
    ).rejects.toThrow(/cannot be nested|hives are peers/i);
    expect(fired).toHaveLength(0);
  });

  it('a ROOT kind:hive launch (no parent) still fires — the hive bootstraps as a root', async () => {
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => {
      fired.push(input);
    });
    // No `parent` → root launch → the guard does not trip; the hive fires normally.
    const target = await fireLaunchBlueprint('hive', { ...opts, kickoff: 'wake' });
    expect(target.role).toBe('queen'); // hive decider since P-071 (2026-06-10)
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ blueprintId: 'hive', role: 'queen' });
  });

  it('a parented kind:harness launch (a bee placed by the Queen) is ALLOWED', async () => {
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => {
      fired.push(input);
    });
    // bee is kind:'harness' — a parent (the Queen) placing it is fine; only hives nest-guard.
    const target = await fireLaunchBlueprint('bee', { ...opts, parent: { spawnId: 's-queen-1', role: 'operator' } });
    expect(target.role).toBe('bee');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ blueprintId: 'bee', role: 'bee' });
  });

  it('honors an overridden blueprint resolver (forked / PG-cache launch blueprint)', async () => {
    setLaunchBlueprintResolver((id) => ({
      id,
      version: '0.1.0',
      workItem: { kind: 'x', idPrefix: 'X' },
      roles: [{ id: 'custom-role', reactive: false }],
      spine: { decider: 'custom-role', maxTurns: 10, default: { to: 'idle' }, edges: { DONE: { to: 'done' } } },
      planner: { kind: 'inline' },
      reactive: [],
      gates: { approvals: [] },
      recursion: { enabled: false, strategy: 'escalate', maxDepth: 1 },
      knobs: { requiresRepo: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));
    const target = await resolveLaunchTarget('deploy', opts);
    expect(target.role).toBe('custom-role');
  });
});
