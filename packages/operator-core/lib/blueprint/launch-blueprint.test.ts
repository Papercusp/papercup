import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeComposedResolveExtends } from '@papercusp/blueprint-distribution';
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
  installedAwareLaunchResolver,
  buildLaunchSpawnRequest,
  QUEEN_INVOKE_TIMEOUT_MS,
  type LaunchFireFn,
} from './launch-blueprint';
import { builtinBlueprintPath, loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';

describe('installedAwareLaunchResolver (D-007 / WI-1146)', () => {
  it('resolves a built-in id identically to the default resolver', async () => {
    const bp = await installedAwareLaunchResolver()('coding');
    expect(bp.id).toBe('coding');
  });

  it('loads a blueprint from a resolved (installed-tier) path', async () => {
    // Simulate an installed-tier hit: an injected resolve returns a real blueprint
    // file path for an id the built-in loader would NOT find by id.
    // The id maps to coding's blueprint file; parents (e.g. `base`) fall through to built-in.
    const resolve = (id: string) => (id === 'pretend-installed' ? builtinBlueprintPath('coding') : builtinBlueprintPath(id));
    const bp = await installedAwareLaunchResolver(() => resolve)('pretend-installed');
    expect(bp.id).toBe('coding');
  });

  it('loads an installed-tier child that extends the built-in base blueprint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-launch-blueprint-'));
    try {
      const installedDir = join(dir, 'blueprints');
      const childDir = join(installedDir, 'pretend-installed-program');
      mkdirSync(childDir, { recursive: true });
      writeFileSync(
        join(childDir, 'blueprint.yaml'),
        [
          'id: pretend-installed-program',
          'extends: base',
          'version: 0.1.0',
          'description: Installed program blueprint that inherits the built-in base.',
          'workItem:',
          '  kind: pretend-run',
          '  idPrefix: PR',
          'spine:',
          '  steps:',
          '    - id: tick',
          '      op: pretend:tick',
          '      bind: tick',
          'dependencies:',
          '  tools: []',
          '  plugins: []',
          '',
        ].join('\n'),
      );

      const resolver = installedAwareLaunchResolver(() =>
        makeComposedResolveExtends({ installedDir }),
      );
      const bp = await resolver('pretend-installed-program');

      expect(bp.id).toBe('pretend-installed-program');
      expect(bp.spine).toMatchObject({ steps: [{ id: 'tick', op: 'pretend:tick' }] });
      expect(bp.knobs).toBeDefined(); // inherited from built-in base
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the built-in loader (preserves the throw) for a truly-unknown id', () => {
    expect(() => installedAwareLaunchResolver(() => () => null)('no-such-blueprint-xyz')).toThrow(/no built-in blueprint/);
  });
});

// P-059: the `pot/mug-brief-launch` stub that used to sit here is gone with the
// module. It had already decayed into a no-op before deletion — it mocked
// `computeQueenWakeBrief`, a name the module stopped exporting when queen→mug
// renamed it, so nothing ever imported the mocked symbol and the paired
// `not.toHaveBeenCalled()` assertions were vacuously true.
//
// The property those assertions protected (WI-682: no launch path computes a
// wake brief — the route owns that, not this launcher) now holds STRUCTURALLY:
// there is no brief builder left to call. What remains testable is the
// observable half, `bodyExtra.queenBrief`, which the assertions below keep.

// queen-steering-panel GAP-2: stub the owner-steering + agent-config reads the
// queen own-model resolution does, so the launch path is deterministic (no PG /
// config file) and the resolved spawnModel is assertable. fleet/model-tiers stays
// REAL (the resolution logic is unit-tested in model-tiers.test.ts).
const getOwnerSteering = vi.fn(async (_ws?: string, _slug?: string) => ({
  directive: null,
  eligiblePlans: [] as string[],
  eligibleHives: [] as string[],
  pauseNewWork: false,
  pausedUntil: null as number | null,
  modelTiers: null as unknown,
  tierCeilings: null as unknown,
}));
vi.mock('../owner-steering', () => ({ getOwnerSteering: (...a: unknown[]) => getOwnerSteering(...(a as [string, string])) }));
const readAgentConfig = vi.fn(async () => ({ models: {}, tiers: [] as unknown[], tierCeilings: {} as Record<string, string> }));
vi.mock('../agent-config', () => ({ readAgentConfig: () => readAgentConfig() }));

// WI-269 (durable-spawn workspace-pin): resolveLaunchTarget must resolve a `*`
// workspace to a concrete one and never bake `ws=*` into the /invoke URL (a persisted
// durable replay would 400 unknown_workspace → zombie). Stub the harness→workspace
// resolver + the registry checks that resolution path uses. importActual keeps every
// other export real (the helper dynamic-imports both modules).
const resolveWorkspaceForHarnessSlug = vi.fn(async (_slug: string): Promise<string | null> => 'ws_resolved');
vi.mock('../harness-core', async (orig) => ({
  ...(await (orig as () => Promise<typeof import('../harness-core')>)()),
  resolveWorkspaceForHarnessSlug: (...a: unknown[]) => resolveWorkspaceForHarnessSlug(...(a as [string])),
}));
const stubActiveWorkspaceId = vi.fn((): string => 'ws_test');
const stubIsKnownWorkspace = vi.fn((id: string) => id === 'ws_resolved' || id === 'ws_test');
vi.mock('../workspace-registry', async (orig) => ({
  ...(await (orig as () => Promise<typeof import('../workspace-registry')>)()),
  activeWorkspaceId: () => stubActiveWorkspaceId(),
  isKnownWorkspace: (id: string) => stubIsKnownWorkspace(id),
}));

afterEach(() => {
  setLaunchBlueprintFire(null);
  setLaunchBlueprintResolver(null);
  resetLaunchBlueprintTriggerMap();
  getOwnerSteering.mockClear();
  readAgentConfig.mockClear();
  resolveWorkspaceForHarnessSlug.mockClear();
  resolveWorkspaceForHarnessSlug.mockResolvedValue('ws_resolved');
  stubActiveWorkspaceId.mockClear();
  stubActiveWorkspaceId.mockReturnValue('ws_test');
  stubIsKnownWorkspace.mockClear();
  vi.unstubAllEnvs();
});

const opts = { installSlug: 'papercup', workspaceId: 'ws_test' };

// Most tests in this file exercise launch mechanics (model routing, body shaping,
// lineage), not the retired Queen/cup blueprints themselves. Make that distinction
// explicit: these are test-only revived fixtures; the dedicated retirement test
// below restores the default resolver and proves the real built-ins are blocked.
function useLiveLaunchFixtures(): void {
  setLaunchBlueprintResolver((id) => {
    const resolved = loadBuiltinBlueprint(id).blueprint;
    if (id === 'coding' || id === 'cup') return { ...resolved, retired: null };
    return resolved;
  });
}

describe('launch-blueprint primitive (unify-agent-launches-as-blueprints P0)', () => {
  beforeEach(() => {
    useLiveLaunchFixtures();
  });

  it('rejects the retired coding/cup launch blueprints before building an invoke target', async () => {
    setLaunchBlueprintResolver(null);

    await expect(resolveLaunchTarget('coding', opts)).rejects.toThrow(
      /blueprint "coding" is RETIRED/i,
    );
    await expect(resolveLaunchTarget('cup', opts)).rejects.toThrow(
      /blueprint "cup" is RETIRED/i,
    );
  });

  it('every built-in launch blueprint resolves to its single decider role', async () => {
    const expected: Record<string, string> = {
      deploy: 'release-manager',
      scan: 'scanner',
      implement: 'worker',
      'merge-resolution': 'merge-resolver',
      // docs-corpus WS2 P-008: the doc-freshness consumer's decider IS the doc-steward role.
      'doc-steward': 'doc-steward',
      // release-pipeline-resilience-2026-06-09 P-006: the gate-fixer's decider IS the release-fixer role.
      'release-fix': 'release-fixer',
      // git-sync-content-guard-2026-06-13 P-006: the content-guard fixer's decider IS the content-fixer role.
      'content-fix': 'content-fixer',
      audit: 'auditor',
      // local-hive P-071 (2026-06-10): the hive's decider is the QUEEN — the
      // operator specialized for placement (D-001); `operator` remains the
      // deciderAlternative for decision-tree-only wakes (blueprint.yaml).
      coding: 'mug',
      // local-hive P-010/P-011: the cup launch blueprint's decider IS the cup role.
      cup: 'cup',
      // unify-launch-mechanics D-004: the papercup watcher's decider IS the papercup role.
      papercup: 'papercup',
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

  // WI-269: a system / cross-workspace routine (e.g. improvement-implement) builds a
  // launch with ctx.workspaceId='*'. The /invoke URL is persisted in the durable-spawn
  // DBOS input, so `ws=*` would 400 unknown_workspace on a post-restart replay → zombie.
  it('WI-269: resolves a `*` workspace to the harness workspace — never persists ws=*', async () => {
    const target = await resolveLaunchTarget('coding', { installSlug: 'somehive', workspaceId: '*' });
    expect(resolveWorkspaceForHarnessSlug).toHaveBeenCalledWith('somehive');
    expect(target.url).toContain('ws=ws_resolved');
    expect(target.url).not.toContain('ws=*');
    expect(target.url).not.toContain('ws=%2A');
  });

  it('WI-269: a concrete workspace passes through unchanged (no resolver call)', async () => {
    const target = await resolveLaunchTarget('coding', { installSlug: 'papercup', workspaceId: 'ws_test' });
    expect(target.url).toContain('ws=ws_test');
    expect(resolveWorkspaceForHarnessSlug).not.toHaveBeenCalled();
  });

  it('WI-269: fails loud when `*` is unresolvable (no harness ws + host pin is `*`) — beats a silent replay zombie', async () => {
    resolveWorkspaceForHarnessSlug.mockResolvedValueOnce(null);
    // Persistent (not Once): the installed-aware default resolver (D-007/WI-1146) reads
    // activeWorkspaceId() via papercuspRoot() during blueprint resolution, so the
    // workspace-resolution step needs the stub to still return '*' on its own call.
    // In prod activeWorkspaceId() is stable, so both reads see the same value.
    stubActiveWorkspaceId.mockReturnValue('*');
    await expect(
      resolveLaunchTarget('coding', { installSlug: 'nope', workspaceId: '*' }),
    ).rejects.toThrow(/WI-269/);
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

  it('buildLaunchSpawnRequest stamps a bounded timeout on Queen durable requests by default', async () => {
    const req = await buildLaunchSpawnRequest('coding', { ...opts, kickoff: 'wake' }, 'launch:queen');
    expect(req.url).toContain('role=mug');
    expect(req.body.timeoutMs).toBe(QUEEN_INVOKE_TIMEOUT_MS);
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
    // git-sync-content-guard-2026-06-13 P-006: the content-error event binds the content-fix clone.
    expect(map['git-sync:content-error']).toBe('content-fix');
    expect(resolveLaunchTriggerEvent('git-sync:content-error')).toBe('content-fix');
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

  it('GAP-2: an owner tier override raises the QUEEN\'s OWN model (bodyExtra.spawnModel) at launch', async () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // 2026-09-02 owner directive (role-models.ts ROLE_MODEL_DEFAULTS) moved mug's committed
    // default to `opus:xhigh` — her home tier (roleHomeTier, matched by family) is therefore now
    // `deep`, not the pre-directive `standard`. Owner raises that tier's spec to `opus:max` (a
    // stronger EFFORT within the same opus family) in the 👑-tab → session override, so the
    // override is a real escalation above her already-opus committed floor.
    getOwnerSteering.mockResolvedValueOnce({
      directive: null, eligiblePlans: [], eligibleHives: [], pauseNewWork: false, pausedUntil: null,
      modelTiers: [{ name: 'deep', spec: 'opus:max' }], tierCeilings: null,
    });
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => { fired.push(input); });
    const target = await fireLaunchBlueprint('coding', { ...opts, kickoff: 'go' });
    expect(target.role).toBe('mug');
    expect(fired).toHaveLength(1);
    // Her OWN model is now tier-driven — resolved from the owner's menu, raised past her
    // committed opus:xhigh floor to opus:max.
    expect((fired[0]!.bodyExtra as { spawnModel?: string }).spawnModel).toBe('opus:max');
  });

  it('GAP-2: owner steering also raises non-Queen launch roles such as doc-steward', async () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    getOwnerSteering.mockResolvedValueOnce({
      directive: null,
      eligiblePlans: [],
      eligibleHives: [],
      pauseNewWork: false,
      pausedUntil: null,
      modelTiers: [
        { name: 'standard', spec: 'chatgpt:5.5', backend: 'codex' },
      ],
      tierCeilings: { 'doc-steward': 'standard' },
    });
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => { fired.push(input); });
    const target = await fireLaunchBlueprint('doc-steward', { ...opts, kickoff: 'doc drift' });
    expect(target.role).toBe('doc-steward');
    expect(fired).toHaveLength(1);
    expect((fired[0]!.bodyExtra as { spawnModel?: string }).spawnModel).toBe('chatgpt:5.5');
  });

  it('GAP-2: an un-steered Hive leaves the queen on her committed default (no spawnModel pin) — the [1m] window rides the exec boundary (applyRoleModel), not a pin', async () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    // default getOwnerSteering mock = un-steered; readAgentConfig = empty menu.
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => { fired.push(input); });
    await fireLaunchBlueprint('coding', { ...opts, kickoff: 'go' });
    expect(fired).toHaveLength(1);
    expect((fired[0]!.bodyExtra as { spawnModel?: string } | undefined)?.spawnModel).toBeUndefined();
  });

  it('GAP-2: a caller-set spawnModel (e.g. the bench pin) WINS over the tier resolution', async () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    getOwnerSteering.mockResolvedValueOnce({
      directive: null, eligiblePlans: [], eligibleHives: [], pauseNewWork: false, pausedUntil: null,
      modelTiers: [{ name: 'standard', spec: 'opus:xhigh' }], tierCeilings: null,
    });
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => { fired.push(input); });
    await fireLaunchBlueprint('coding', { ...opts, kickoff: 'go', bodyExtra: { spawnModel: 'opus:max' } });
    expect((fired[0]!.bodyExtra as { spawnModel?: string }).spawnModel).toBe('opus:max'); // not overridden
  });

  // P-002 (role-model-one-answer-2026-09-03): an EXPLICIT per-role `models[role]` is THE
  // ANSWER — the tier menu's family/floor/ceiling math gets no vote over it. Before this,
  // `models[role]` was never read on the launch path, so a correctly-set per-role model was
  // silently inert; that cost nine dead release-fixers on 2026-09-03, each spawned onto a
  // usage-walled codex account while `models['release-fixer']='claude-opus-5:xhigh'` sat
  // ignored. The falsifiable half is the tier menu below: it is deliberately set to a
  // CROSS-PROVIDER gpt spec, which is exactly what used to win.
  it('P-002: an explicit per-role models[role] WINS over the tier menu', async () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const cfgWithRoleModel = {
      models: { mug: 'claude-opus-5:xhigh' },
      tiers: [{ name: 'deep', spec: 'gpt-5.6-sol:xhigh', backend: 'codex' }],
      tierCeilings: {},
    } as unknown as Awaited<ReturnType<typeof readAgentConfig>>;
    // ⚠ EXACTLY ONE queued value. Model and backend now resolve in ONE block through
    // resolveRoleLaunch (P-001), so a fire reads config exactly once; queueing a
    // second would leave a spare that `mockClear` does NOT drain, silently steering
    // the NEXT test's config. That leak is what made this whole describe go red when
    // the two blocks were unified — the tests were pinning the read COUNT, not the
    // behaviour.
    readAgentConfig.mockResolvedValueOnce(cfgWithRoleModel);
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => { fired.push(input); });
    const target = await fireLaunchBlueprint('coding', { ...opts, kickoff: 'go' });
    expect(target.role).toBe('mug');
    expect((fired[0]!.bodyExtra as { spawnModel?: string }).spawnModel).toBe('claude-opus-5:xhigh');
    // P-003: the backend rides with that model — one read answers both halves.
    expect((fired[0]!.bodyExtra as { spawnBackend?: string }).spawnBackend).toBe('claude-code');
    expect(readAgentConfig).toHaveBeenCalledTimes(1);
  });

  it('P-002: a caller-set spawnModel still WINS over an explicit per-role models[role]', async () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    const cfgWithRoleModel = {
      models: { mug: 'claude-opus-5:xhigh' },
      tiers: [] as unknown[],
      tierCeilings: {},
    } as unknown as Awaited<ReturnType<typeof readAgentConfig>>;
    // EXACTLY ONE queued value: one unified resolution block = one config read per
    // fire, whether or not the caller pinned a field. Queueing two would leak the
    // spare `mockResolvedValueOnce` into the NEXT test (mockClear does not drain the
    // once-queue), which is precisely how this pair first failed.
    readAgentConfig.mockResolvedValueOnce(cfgWithRoleModel);
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => { fired.push(input); });
    await fireLaunchBlueprint('coding', { ...opts, kickoff: 'go', bodyExtra: { spawnModel: 'opus:max' } });
    expect((fired[0]!.bodyExtra as { spawnModel?: string }).spawnModel).toBe('opus:max');
    expect(readAgentConfig).toHaveBeenCalledTimes(1);
  });

  it('P-002: with NO per-role models[role], the tier menu still resolves (no regression)', async () => {
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    getOwnerSteering.mockResolvedValueOnce({
      directive: null, eligiblePlans: [], eligibleHives: [], pauseNewWork: false, pausedUntil: null,
      modelTiers: [{ name: 'deep', spec: 'opus:max' }], tierCeilings: null,
    });
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => { fired.push(input); });
    await fireLaunchBlueprint('coding', { ...opts, kickoff: 'go' });
    expect((fired[0]!.bodyExtra as { spawnModel?: string }).spawnModel).toBe('opus:max');
  });

  // WI-2142846: fireLaunchBlueprint's role-BACKEND resolution, added because the
  // release-fixer's per-role `roleBackends['release-fixer']` override was silently
  // invisible to the actual dispatch (it was honoured only by green-checkpoint.ts's
  // PREFLIGHT capacity check, which does its own separate live readAgentConfig()).
  //
  // Since P-001 this shares ONE resolution with the model (fleet/role-launch.ts), and
  // P-003 narrowed the rule: `roleBackends[role]` is the FALLBACK for when no per-role
  // model carries a backend of its own. Every role in this describe has no committed
  // default model, so `roleBackends` is what answers — which is why these cases read
  // the same as before the unification.
  describe('WI-2142846: role-backend resolution (bodyExtra.spawnBackend)', () => {
    it('resolves the configured roleBackends override for the firing role at launch', async () => {
      // ONE queued value — model and backend resolve together in one read (P-001).
      // release-fixer carries no committed default model, so nothing rides a backend
      // in with it and `roleBackends` is the answer, exactly as P-003 specifies.
      const cfgWithBackend = {
        models: {}, tiers: [], tierCeilings: {},
        roleBackends: { 'release-fixer': 'claude-code' },
      } as unknown as Awaited<ReturnType<typeof readAgentConfig>>;
      readAgentConfig.mockResolvedValueOnce(cfgWithBackend);
      const fired: Array<Parameters<LaunchFireFn>[0]> = [];
      setLaunchBlueprintFire((input) => { fired.push(input); });
      const target = await fireLaunchBlueprint('release-fix', { ...opts, kickoff: 'gate red' });
      expect(target.role).toBe('release-fixer');
      expect(fired).toHaveLength(1);
      expect((fired[0]!.bodyExtra as { spawnBackend?: string }).spawnBackend).toBe('claude-code');
    });

    it('leaves spawnBackend unset when the role has no configured override (falls through to the route\'s own resolution)', async () => {
      // default readAgentConfig mock carries no roleBackends at all.
      const fired: Array<Parameters<LaunchFireFn>[0]> = [];
      setLaunchBlueprintFire((input) => { fired.push(input); });
      await fireLaunchBlueprint('release-fix', { ...opts, kickoff: 'gate red' });
      expect((fired[0]!.bodyExtra as { spawnBackend?: string } | undefined)?.spawnBackend).toBeUndefined();
    });

    it('a caller-set spawnBackend WINS over the configured roleBackends override', async () => {
      readAgentConfig.mockResolvedValueOnce({
        models: {}, tiers: [], tierCeilings: {},
        roleBackends: { 'release-fixer': 'claude-code' },
      } as unknown as Awaited<ReturnType<typeof readAgentConfig>>);
      const fired: Array<Parameters<LaunchFireFn>[0]> = [];
      setLaunchBlueprintFire((input) => { fired.push(input); });
      await fireLaunchBlueprint('release-fix', { ...opts, kickoff: 'gate red', bodyExtra: { spawnBackend: 'omp' } });
      expect((fired[0]!.bodyExtra as { spawnBackend?: string }).spawnBackend).toBe('omp'); // not overridden
    });

    it('fails soft (no throw, no spawnBackend) when the config read rejects', async () => {
      // ONE read, so ONE rejection exercises the unified block's catch.
      readAgentConfig.mockRejectedValueOnce(new Error('pg unreachable'));
      const fired: Array<Parameters<LaunchFireFn>[0]> = [];
      setLaunchBlueprintFire((input) => { fired.push(input); });
      const target = await fireLaunchBlueprint('release-fix', { ...opts, kickoff: 'gate red' });
      expect(target.role).toBe('release-fixer');
      expect((fired[0]!.bodyExtra as { spawnBackend?: string } | undefined)?.spawnBackend).toBeUndefined();
    });

    it('does not resolve a backend for an unrelated role even when SOME roleBackends entries exist', async () => {
      const cfgWithOtherRole = {
        models: {}, tiers: [], tierCeilings: {},
        roleBackends: { 'doc-steward': 'codex' }, // release-fixer has no entry
      } as unknown as Awaited<ReturnType<typeof readAgentConfig>>;
      readAgentConfig.mockResolvedValueOnce(cfgWithOtherRole);
      const fired: Array<Parameters<LaunchFireFn>[0]> = [];
      setLaunchBlueprintFire((input) => { fired.push(input); });
      await fireLaunchBlueprint('release-fix', { ...opts, kickoff: 'gate red' });
      expect((fired[0]!.bodyExtra as { spawnBackend?: string } | undefined)?.spawnBackend).toBeUndefined();
    });
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
      fireLaunchBlueprint('coding', { ...opts, parent: { spawnId: 's-parent-1', role: 'cup' } }),
    ).rejects.toThrow(/cannot be nested|hives are peers/i);
    expect(fired).toHaveLength(0);
  });

  it('a ROOT kind:hive launch (no parent) still fires — the hive bootstraps as a root', async () => {
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => {
      fired.push(input);
    });
    // No `parent` → root launch → the guard does not trip; the hive fires normally.
    const target = await fireLaunchBlueprint('coding', { ...opts, kickoff: 'wake' });
    expect(target.role).toBe('mug'); // hive decider since P-071 (2026-06-10)
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ blueprintId: 'coding', role: 'mug' });
    expect(fired[0].timeoutMs).toBe(QUEEN_INVOKE_TIMEOUT_MS);
    // WI-682: the wake brief was computed at the /invoke ROUTE (spawn.ts), NOT
    // by this launcher — EI-995's durable seam bypassed a launcher-side compute,
    // so the launcher must not own it. P-059 retired the builder outright, so
    // "no launch path computes here" is now structural; what stays assertable is
    // that the launcher emits no queenBrief of its own.
    expect(fired[0].bodyExtra?.queenBrief).toBeUndefined();
  });

  it('a caller-supplied bodyExtra.queenBrief rides the fire body untouched (the route respects it)', async () => {
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => {
      fired.push(input);
    });
    await fireLaunchBlueprint('coding', { ...opts, kickoff: 'wake', bodyExtra: { queenBrief: 'PRECOMPUTED' } });
    expect(fired[0].bodyExtra?.queenBrief).toBe('PRECOMPUTED');
  });

  it('a parented kind:harness launch (a bee placed by the Queen) is ALLOWED', async () => {
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => {
      fired.push(input);
    });
    // bee is kind:'harness' — a parent (the Queen) placing it is fine; only hives nest-guard.
    const target = await fireLaunchBlueprint('cup', { ...opts, parent: { spawnId: 's-queen-1', role: 'operator' } });
    expect(target.role).toBe('cup');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ blueprintId: 'cup', role: 'cup' });
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

/**
 * BENCH-SCOPED, FAIL-CLOSED OPUS PIN — the Queen half (P-033 Fix 2). A Queen wake for a
 * BENCH hive (the bench flag set + an `xbq…` install slug) is fired with
 * bodyExtra.spawnModel = the bench model, threaded to the /invoke route → her child's
 * PAPERCUSP_SPAWN_MODEL. Scoped: a non-bench hive Queen (or no flag) is never pinned, so
 * every other hive keeps its sonnet floor and no GLOBAL AGENT_MODELS opus is needed.
 */
describe('launch-blueprint — bench-scoped Queen opus pin (P-033 Fix 2)', () => {
  const KEY = 'PAPERCUSP_XBENCH_CUP_DIRECTIVE';
  const LEGACY_KEY = 'PAPERCUSP_XBENCH_BEE_DIRECTIVE';
  const MODEL = 'PAPERCUSP_XBENCH_MODEL';
  let savedKey: string | undefined;
  let savedLegacyKey: string | undefined;
  let savedModel: string | undefined;
  beforeEach(() => {
    useLiveLaunchFixtures();
    savedKey = process.env[KEY];
    savedLegacyKey = process.env[LEGACY_KEY];
    savedModel = process.env[MODEL];
    // Hermetic guard (EI-1459): the "does NOT pin" cases assert the Queen gets NO
    // model override, but the queen own-model path (launch-blueprint.ts ~490) reads
    // `process.env.AGENT_MODELS` via model-tiers. A sibling test file that sets
    // AGENT_MODELS (e.g. queen→opus:high) without cleanup leaks into this worker and
    // fires a spurious pin → flaky cross-file red that only reproduces in the full
    // suite (passes 21/21 in isolation). Clear it per-case, matching the same idiom
    // the queen-own-model tests above already use; the file-level afterEach
    // `vi.unstubAllEnvs()` restores it.
    vi.stubEnv('AGENT_MODELS', undefined as unknown as string);
    delete process.env[LEGACY_KEY];
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env[KEY]; else process.env[KEY] = savedKey;
    if (savedLegacyKey === undefined) delete process.env[LEGACY_KEY]; else process.env[LEGACY_KEY] = savedLegacyKey;
    if (savedModel === undefined) delete process.env[MODEL]; else process.env[MODEL] = savedModel;
  });

  it('pins a bench-hive Queen wake to opus via bodyExtra.spawnModel (flag set + xbq slug)', async () => {
    process.env[KEY] = 'bench directive';
    delete process.env[MODEL];
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => { fired.push(input); });
    await fireLaunchBlueprint('coding', { installSlug: 'xbqabc123', workspaceId: 'ws_test', kickoff: 'survey' });
    expect(fired).toHaveLength(1);
    expect(fired[0]!.role).toBe('mug');
    expect((fired[0]!.bodyExtra as Record<string, unknown>)?.spawnModel).toBe('opus:xhigh');
  });

  it('honors the PAPERCUSP_XBENCH_MODEL knob for the Queen pin', async () => {
    process.env[KEY] = 'bench directive';
    process.env[MODEL] = 'opus:high';
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => { fired.push(input); });
    await fireLaunchBlueprint('coding', { installSlug: 'xbqdef456', workspaceId: 'ws_test', kickoff: 'survey' });
    expect((fired[0]!.bodyExtra as Record<string, unknown>)?.spawnModel).toBe('opus:high');
  });

  it('does NOT pin a NON-bench hive Queen (xbq slug but no bench flag → normal floor)', async () => {
    delete process.env[KEY];
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => { fired.push(input); });
    await fireLaunchBlueprint('coding', { installSlug: 'xbqghi789', workspaceId: 'ws_test', kickoff: 'survey' });
    expect((fired[0]!.bodyExtra as Record<string, unknown> | undefined)?.spawnModel).toBeUndefined();
  });

  it('does NOT pin a Queen whose slug is not a bench home (flag set but slug not xbq…)', async () => {
    process.env[KEY] = 'bench directive';
    const fired: Array<Parameters<LaunchFireFn>[0]> = [];
    setLaunchBlueprintFire((input) => { fired.push(input); });
    await fireLaunchBlueprint('coding', { installSlug: 'papercup', workspaceId: 'ws_test', kickoff: 'survey' });
    expect((fired[0]!.bodyExtra as Record<string, unknown> | undefined)?.spawnModel).toBeUndefined();
  });
});
