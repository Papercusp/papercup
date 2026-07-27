import { describe, it, expect, vi } from 'vitest';

/**
 * P-003: `gitPipelinePosition`'s serving probe really shells out to
 * systemctl+ps by default (D-001 — a null-by-default dep would be shipping the
 * feature dark). That makes every call site in this file machine-dependent:
 * un-mocked, these unit tests read THIS box's live papercup-dev-api uptime and
 * would answer differently on CI, or on a host where the unit does not exist.
 * Pin it to a deterministic process: started 60s ago, which every fixture below
 * treats as "after the code landed" unless it deliberately says otherwise.
 */
vi.mock('./agent-tools/dev/systemd-service-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-tools/dev/systemd-service-probe')>();
  return {
    ...actual,
    probeServiceStart: async () => ({ ok: true, mainPid: 4242, secondsSinceStart: 60, activeState: 'active' }),
  };
});
import {
  gitPipelinePosition,
  summarizePosition,
  classifyRuntimeOwner,
  classifyRuntimeOwners,
  computeStages,
  evaluateServing,
  evaluateChangeInCandidate,
  evaluateSweepExposure,
  parsePorcelainPaths,
  deriveBlocker,
  type GitRunner,
  type PipelinePosition,
  type ChangeInCandidate,
  type ServingTruth,
  type StageName,
  type StageState,
  type SweepExposure,
} from './git-pipeline-position';
import type { DevDeployState } from './dev-deploy-state';
import type { GitPipelineSnapshot } from './git-pipeline-stats';

/** A git-sync leg-state with nothing wrong with it — the baseline for fixtures. */
const HEALTHY_GIT_SYNC = {
  status: 'synced',
  lastSyncedAtMs: Date.now(),
  syncAgeMs: 0,
  consecutiveErrorTicks: 0,
  pushedRepos: ['papercusp'],
  mergedRepos: [],
  conflicts: [],
  errors: [],
};

/** P-003: a serving process that started AFTER the code it runs — i.e. actually live. */
const HEALTHY_SERVING: ServingTruth = {
  host: 'operator-release',
  unit: 'papercup-dev-api.service',
  pid: 4242,
  startedAtMs: 2_000,
  codeAsOfMs: 1_000,
  codeAsOfSource: 'deploy',
  startedSinceCodeChange: true,
  behindMin: null,
  restartLever: 'PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute',
  unknownReason: null,
};

/**
 * P-004: the "nothing to report" containment verdict. Every fixture below defaults to
 * it so no existing case accidentally depends on gate-candidate containment — a case
 * that means to exercise it says so explicitly.
 */
const NO_CANDIDATE: ChangeInCandidate = {
  judgingSha: null,
  judgingContainsPath: null,
  nextCandidateSha: null,
  nextContainsPath: null,
  missingReason: null,
  detail: null,
};

/** P-006: a clean tree — nothing for the next git-sync tick to sweep. */
const NO_SWEEP: SweepExposure = {
  exposed: false,
  dirtyPathCount: null,
  dirtyPathSample: [],
  nextSweepInMs: null,
  detail: null,
};

/** A fake `git` runner keyed by arg shape + a per-ref containment map. */
function fakeGit(opts: {
  submodules?: string[];
  dirty?: boolean;
  /** P-006: raw porcelain for the TREE-WIDE status (the sweep's blast radius). */
  dirtyTree?: string;
  pathCommit?: string | null;
  subject?: string;
  /** ref → set of shas that ref's history contains (ancestor-or-equal). */
  contains?: Record<string, string[]>;
  /** EI-18694888339365359: the AUTHORITATIVE remote tip `git ls-remote origin
   *  refs/heads/staging` would report — deliberately independent of `contains`
   *  so a test can simulate a stale LOCAL origin/staging ref (contains says
   *  not-present) disagreeing with the true remote tip. */
  remoteStagingTip?: string;
  /**
   * D-038 axis 2: refs whose `rev-list --count` FAILS (GitRunner yields null).
   * Deliberately distinct from `contains` merely omitting the ref — that is an
   * honest "not contained", this is "could not measure". Conflating the two is
   * exactly the defect `positionsUnknown` exists to surface.
   */
  failRefs?: string[];
  /**
   * EI-18715870370005934: models the SUBMODULE BOUNDARY faithfully — the
   * superproject stores a gitlink (mode 160000), never submodule file content.
   * So inside the submodule repo a superproject sha does NOT resolve (rev-parse
   * fails) and `git show <superSha>:<submodulePath>` yields nothing, while
   * `git ls-tree <superSha> <submodulePath>` in the ROOT reports the pin.
   */
  submodulePin?: { superSha: string; pinnedSha: string; path: string };
}): GitRunner {
  const root = '/repo';
  return async (_repo, args) => {
    if (args[0] === 'config' && args.includes('.gitmodules')) {
      const subs = opts.submodules ?? [];
      return subs.length ? subs.map((p, i) => `submodule.s${i}.path ${p}`).join('\n') : null;
    }
    // P-006: the path-filtered status (`status --porcelain -- <path>`) and the
    // TREE-WIDE one are different questions — the second is the sweep's blast radius.
    // A fixture that answers both with the same string cannot exercise the multi-file
    // case at all, which is the only case P-006 exists for.
    if (args[0] === 'status') {
      if (!opts.dirty) return '';
      return args.includes('--') ? 'M somefile' : (opts.dirtyTree ?? 'M somefile');
    }
    // The gitlink read that IS the ground truth across the boundary.
    if (args[0] === 'ls-tree') {
      const pin = opts.submodulePin;
      if (pin && _repo === root && args[1] === pin.superSha && args[2] === pin.path) {
        return `160000 commit ${pin.pinnedSha}\t${pin.path}`;
      }
      return null;
    }
    // The naive cross-boundary content probe: empty, because the superproject
    // commit holds a gitlink, not the file. `realGit` turns git's non-zero exit
    // into null, so null is the faithful stand-in for "grep -c => 0".
    if (args[0] === 'show') return null;
    if (args[0] === 'rev-parse') {
      const want = args[args.length - 1].replace('^{commit}', '');
      // A SUPERPROJECT sha does not exist in the submodule's object store.
      if (opts.submodulePin && _repo !== root && want === opts.submodulePin.superSha) return null;
      return want;
    }
    if (args[0] === 'log' && args.includes('--pretty=%H')) return opts.pathCommit ?? null;
    if (args[0] === 'log' && args.includes('--pretty=%s')) return opts.subject ?? 'subj';
    if (args[0] === 'rev-list' && args[1] === '--count') {
      const [ref, sha] = args[2].split('..');
      if (opts.failRefs?.includes(ref)) return null; // the READ failed — not "not contained"
      const set = new Set(opts.contains?.[ref] ?? []);
      return set.has(sha) ? '0' : '3';
    }
    if (args[0] === 'ls-remote' && args[1] === 'origin' && args[2] === 'refs/heads/staging') {
      return opts.remoteStagingTip ? `${opts.remoteStagingTip}\trefs/heads/staging` : null;
    }
    return null;
  };
}

const deploy = (over: Partial<DevDeployState> = {}): DevDeployState =>
  ({
    integrationRoot: '/repo',
    deployed: { sha: 'deployedsha0' } as DevDeployState['deployed'],
    // P-003: the deploy landed an hour ago, while the mocked serving process
    // started 60s ago — so the default fixture is a process that HAS loaded the
    // deployed code. A case that wants the stale reading overrides this.
    deployedAtMs: Date.now() - 60 * 60_000,
    ...over,
  } as DevDeployState);

/** Default snapshot-level deploy state (distinct from the `deploy()` fixture above,
 *  which is the `loadDeploy` dep — this is `GitPipelineSnapshot.deploy`, the source
 *  for verdictProvenance's ready/greenPinAtStagingHead/deployedBehindGreenPin). */
const snapDeploy = (over: Partial<DevDeployState> = {}): DevDeployState =>
  ({
    integrationRoot: '/repo',
    greenPin: { sha: 'readysha0', shortSha: 'readysha', committedAtMs: 1000, subject: 'ready' } as DevDeployState['greenPin'],
    deployed: { sha: 'deployedsha0' } as DevDeployState['deployed'],
    greenPinAtStagingHead: true,
    deployedBehindGreenPin: 0,
    ...over,
  } as DevDeployState);

const snap = (
  gate: Partial<GitPipelineSnapshot['gate']> = {},
  lastStatus = 'synced',
  deployOver: Partial<DevDeployState> = {},
): GitPipelineSnapshot =>
  ({
    gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null, ...gate },
    gitSync: { lastStatus },
    deploy: snapDeploy(deployOver),
  } as GitPipelineSnapshot);

describe('gitPipelinePosition (P-002)', () => {
  it('a fully-promoted+deployed superproject path reads committed→staging→main→deployed (live)', async () => {
    const git = fakeGit({
      pathCommit: 'abc1234567',
      subject: 'my fix',
      contains: {
        HEAD: ['abc1234567'],
        'origin/staging': ['abc1234567'],
        'origin/main': ['abc1234567'],
        deployedsha0: ['abc1234567'],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.positions).toEqual({ committedLocal: true, onStaging: true, inMain: true, deployed: true });
    expect(res.submodule).toBeNull();
    // P-003 changed this deliberately: the summary no longer prints a bare
    // "(live)" off `positions.deployed`, because that git fact cannot establish
    // that the serving PROCESS has loaded the code. It may claim live only with
    // the process evidence attached — which this fixture supplies (deploy 1h ago,
    // serving process started 60s ago).
    expect(res.summary).toContain('live — the serving process started after this code landed');
    expect(res.serving.startedSinceCodeChange).toBe(true);
  });

  /**
   * D-038 axis 2 + D-039's hoist — and the defect P-006 found in THIS cell while
   * trying to register it as the contract's exemplar.
   *
   * `refContains` returned `contained === '0'` over a GitRunner that yields `null`
   * on any failure, so `null === '0'` made a FAILED read indistinguishable from an
   * honest "this ref does not contain the commit". An agent reads `inMain: false`
   * and waits for a stage it may already have passed — a verdict manufactured from
   * an absence, in the pipeline's headline leg.
   */
  it('a FAILED ref read is hoisted as unknown, never reported as a confident "not reached"', async () => {
    const git = fakeGit({
      pathCommit: 'abc1234567',
      contains: { HEAD: ['abc1234567'], 'origin/staging': ['abc1234567'], deployedsha0: [] },
      failRefs: ['origin/main'], // could not measure — NOT "honestly not contained"
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    // The boolean still degrades to false, so every existing consumer is unchanged…
    expect(res.positions.inMain).toBe(false);
    // …but it is now SAYABLE that this particular false was not a measurement.
    expect(res.positionsUnknown).toContain('inMain');
    // And a leg that genuinely read "not contained" must NOT be swept in with it.
    // A hoist that cries wolf is one agents learn to ignore, which would leave us
    // worse off than the bare boolean it replaced.
    expect(res.positionsUnknown).not.toContain('deployed');
    expect(res.positions.deployed).toBe(false);
    expect(res.positions.onStaging).toBe(true);
  });

  // EI-18694888339365359: the local origin/staging remote-tracking ref lagged
  // one commit behind (git-sync had not yet fetched this push) — refContains
  // against it said "not present", which would otherwise emit a false BLOCKING
  // "not-on-origin-staging" release:trace constraint and park an agent on
  // git-sync:await for a push event that already fired.
  it('EI-18694888339365359: a STALE local origin/staging ref is corrected via ls-remote when the target IS the exact remote tip', async () => {
    const git = fakeGit({
      pathCommit: 'newtip1234',
      contains: {
        HEAD: ['newtip1234'],
        'origin/staging': [], // stale local ref: does NOT (yet) contain the target
        'origin/main': [],
        deployedsha0: [],
      },
      remoteStagingTip: 'newtip1234', // but the true remote tip IS the target
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/w.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.positions.onStaging).toBe(true);
    expect(res.notes.some((n) => n.includes('ls-remote'))).toBe(true);
  });

  it('EI-18694888339365359: a GENUINELY unpushed commit still reads onStaging false (ls-remote tip does not match, no false positive)', async () => {
    const git = fakeGit({
      pathCommit: 'notpushed12',
      contains: {
        HEAD: ['notpushed12'],
        'origin/staging': [],
        'origin/main': [],
        deployedsha0: [],
      },
      remoteStagingTip: 'someothersha', // remote is at a different commit entirely
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/v.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.positions.onStaging).toBe(false);
  });

  it('a change stuck at staging behind a STALLED gate reads main ✗ + surfaces the stall', async () => {
    const git = fakeGit({
      pathCommit: 'def7654321',
      contains: {
        HEAD: ['def7654321'],
        'origin/staging': ['def7654321'],
        'origin/main': [], // not promoted
        deployedsha0: [],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/y.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap({ stalled: true, consecutiveReds: 3 }) },
    );
    expect(res.positions.onStaging).toBe(true);
    expect(res.positions.inMain).toBe(false);
    expect(res.positions.deployed).toBe(false);
    expect(res.summary).toContain('main ✗');
    expect(res.summary).toContain('STALLED');
  });

  it('WI-282: a change stuck behind a WEDGED (non-firing, 0-red) gate surfaces the wedge, not a false all-clear', async () => {
    const git = fakeGit({
      pathCommit: 'fed7654321',
      contains: {
        HEAD: ['fed7654321'],
        'origin/staging': ['fed7654321'],
        'origin/main': [], // not promoted — main is frozen
        deployedsha0: [],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/z.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        // The failure mode: the checkpoint never RAN, so 0 reds + stalled:false — yet
        // it is wedged. fireStale must surface it even though the reds-based signal is clear.
        loadSnapshot: async () =>
          snap({
            stalled: false,
            consecutiveReds: 0,
            fireStale: true,
            fireStaleReason: 'the routine has not FIRED in ~3h (active, cron hourly)',
          }),
      },
    );
    expect(res.positions.inMain).toBe(false);
    expect(res.summary).toContain('main ✗');
    expect(res.summary).toContain('WEDGED');
    // The reds-based STALLED label must NOT be what shows (it would mislead — 0 reds).
    expect(res.summary).not.toContain('STALLED');
  });

  it('EI-18719549079738452: 0 reds + not-fast-forwarded reads as a held gate, not a silent all-clear', async () => {
    // The torn-candidate incident this guards: green-checkpoint's retriage recognizes
    // a stale red and works to auto-refire, but while that plays out the LAST
    // *recorded* verdict can show 0 consecutive reds / stalled:false / fireStale:false
    // — every existing branch above falls through to '' — while `main` genuinely sits
    // behind the latest green pin (mainFastForwarded:false). The summary must say so
    // instead of reading as fully healthy.
    const git = fakeGit({
      pathCommit: 'torn1234567',
      contains: {
        HEAD: ['torn1234567'],
        'origin/staging': ['torn1234567'],
        'origin/main': [], // not promoted — main hasn't fast-forwarded
        deployedsha0: [],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/w.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () =>
          snap({ stalled: false, consecutiveReds: 0, fireStale: false, fireStaleReason: null }, 'synced', {
            greenPinAtStagingHead: false,
          }),
      },
    );
    expect(res.positions.inMain).toBe(false);
    expect(res.verdictProvenance.mainFastForwarded).toBe(false);
    expect(res.gate.consecutiveReds).toBe(0);
    expect(res.gate.stalled).toBe(false);
    expect(res.summary).toContain('main ✗');
    expect(res.summary).toContain('0 reds');
    expect(res.summary).toContain('NOT fast-forwarded');
    // Must not be confused with the reds-based / wedge-based labels (this is neither).
    expect(res.summary).not.toContain('STALLED');
    expect(res.summary).not.toContain('WEDGED');
  });

  it('a submodule path is detected, annotated, and resolved against the submodule (not staging)', async () => {
    const git = fakeGit({
      submodules: ['libs/papercusp'],
      pathCommit: 'sub1234567',
      contains: { HEAD: ['sub1234567'], 'origin/HEAD': ['sub1234567'] },
    });
    const res = await gitPipelinePosition(
      { path: 'libs/papercusp/packages/harness/x.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.submodule).toBe('libs/papercusp');
    expect(res.positions.committedLocal).toBe(true);
    expect(res.positions.onStaging).toBe(true); // origin/HEAD
    expect(res.positions.inMain).toBe(false); // not tracked for submodule paths
    expect(res.summary).toContain('submodule libs/papercusp');
    expect(res.notes.join(' ')).toMatch(/submodule/i);
  });

  /**
   * EI-18715870370005934 — the SUBMODULE-BOUNDARY false negative.
   *
   * The bug is not that a check is hard; it is that the wrong check returns a
   * confident, safe-sounding EMPTY. `git show <superSha>:<submodulePath>` and
   * `git status --porcelain <submodulePath>` both yield nothing across the
   * boundary, which reads as "my change is absent" / "the tree is clean" instead
   * of "you asked the superproject about content it does not store". A near-miss
   * on that reading nearly aborted a good ~30min decisive gate run.
   *
   * The whole point of the guard is that the naive form and the resolver must
   * DISAGREE — so these assert the disagreement directly.
   */
  describe('superproject sha + submodule path (EI-18715870370005934)', () => {
    const SUPER = 'super8b339f8780aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const PINNED = '151cfdb3357a4ae03d34e8a32b89b8355656c356';
    const pinGit = () =>
      fakeGit({
        submodules: ['papercusp-desktop'],
        submodulePin: { superSha: SUPER, pinnedSha: PINNED, path: 'papercusp-desktop' },
        contains: { HEAD: [PINNED], 'origin/HEAD': [PINNED] },
      });

    it('resolves the gitlink instead of reporting the sha as absent', async () => {
      const res = await gitPipelinePosition(
        { path: 'papercusp-desktop/bin/lib/scenarios/b3-revocation.sh', sha: SUPER },
        { git: pinGit(), loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );

      // THE REGRESSION: before the fix this was null + "did not resolve" — a bare
      // absence, from the tool agents are pointed at for "is my edit live".
      expect(res.targetSha).toBe(PINNED);
      expect(res.submodulePin).toEqual({ superprojectSha: SUPER, submoduleSha: PINNED });
      expect(res.notes.join(' ')).not.toMatch(/did not resolve/);
      expect(res.positions.committedLocal).toBe(true);
    });

    it('never substitutes one sha for another silently — the summary names both', async () => {
      const res = await gitPipelinePosition(
        { path: 'papercusp-desktop/bin/vm-federation.sh', sha: SUPER },
        { git: pinGit(), loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.summary).toContain(SUPER.slice(0, 9));
      expect(res.summary).toContain(PINNED.slice(0, 9));
      expect(res.summary).toMatch(/PINS/);
      // The note must redirect the reader off the hand-rolled form.
      expect(res.notes.join(' ')).toMatch(/git -C papercusp-desktop show/);
    });

    it('the naive cross-boundary probe DISAGREES with the resolver (the whole point)', async () => {
      const git = pinGit();
      // Naive: what an agent hand-composes. Empty — indistinguishable from absent.
      const naiveShow = await git('/repo', ['show', `${SUPER}:papercusp-desktop/bin/vm-federation.sh`]);
      const naiveStatus = await git('/repo', ['ls-tree', SUPER, 'papercusp-desktop/bin/vm-federation.sh']);
      expect(naiveShow).toBeNull();
      expect(naiveStatus).toBeNull(); // a FILE path, not the submodule root — no gitlink

      // The PRE-FIX code path, asserted explicitly so this stays a real guard: the
      // only thing the old implementation did was rev-parse the sha INSIDE the
      // submodule, and that returns null for a superproject sha. So without the
      // gitlink resolution `targetSha` is necessarily null — i.e. reverting the fix
      // makes the expectations below fail, rather than passing for another reason.
      expect(await git('/repo/papercusp-desktop', ['rev-parse', '--verify', `${SUPER}^{commit}`])).toBeNull();

      // Resolver: the same question, asked correctly.
      const res = await gitPipelinePosition(
        { path: 'papercusp-desktop/bin/vm-federation.sh', sha: SUPER },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.targetSha).toBe(PINNED);
      expect(res.targetSha).not.toBe(naiveShow);
    });

    it('a sha that genuinely does not resolve still reports absent (no false pin)', async () => {
      const res = await gitPipelinePosition(
        { path: 'papercusp-desktop/bin/vm-federation.sh', sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
        { git: pinGit(), loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      // rev-parse succeeds for any non-superproject sha in the fake, so the guard
      // that matters here is that NO pin was fabricated for an unrelated sha.
      expect(res.submodulePin).toBeNull();
    });

    it('a superproject sha with a NON-submodule path is untouched by the resolver', async () => {
      const res = await gitPipelinePosition(
        { path: 'packages/operator-core/lib/x.ts', sha: SUPER },
        { git: pinGit(), loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.submodule).toBeNull();
      expect(res.submodulePin).toBeNull();
      expect(res.targetSha).toBe(SUPER);
    });
  });

  it('a newly-created uncommitted file reports no commit + the dirty flag', async () => {
    const git = fakeGit({ pathCommit: null, dirty: true });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/new.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.targetSha).toBeNull();
    expect(res.dirtyUncommitted).toBe(true);
    expect(res.summary).toContain('no commit found');
  });

  // EI-7846: verdict-provenance — the last green sha/age, main-FF status, and
  // whether the live deploy actually came from the gate-green pin.
  it('EI-7846: deployedSha === ready.sha reports deployOrigin gate-green (the normal auto-deploy path)', async () => {
    const git = fakeGit({
      pathCommit: 'abc1234567',
      contains: { HEAD: ['abc1234567'], 'origin/staging': ['abc1234567'], 'origin/main': ['abc1234567'] },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      {
        git,
        loadDeploy: async () => deploy({ deployed: { sha: 'readysha0' } as DevDeployState['deployed'] }),
        loadSnapshot: async () => snap({}, 'synced', { greenPinAtStagingHead: true, deployedBehindGreenPin: 0 }),
      },
    );
    expect(res.verdictProvenance.lastGreenSha).toBe('readysha0');
    expect(res.verdictProvenance.lastGreenShortSha).toBe('readysha');
    expect(res.verdictProvenance.lastGreenAgeMs).toBeGreaterThanOrEqual(0);
    expect(res.verdictProvenance.mainFastForwarded).toBe(true);
    expect(res.verdictProvenance.deployedBehindGreenPin).toBe(0);
    expect(res.verdictProvenance.deployOrigin).toBe('gate-green');
  });

  it('EI-7846: a deployed sha that IS an ancestor of ready reports stale-behind-gate (safe lag)', async () => {
    const git = fakeGit({
      pathCommit: 'abc1234567',
      contains: {
        HEAD: ['abc1234567'],
        'origin/staging': ['abc1234567'],
        'origin/main': ['abc1234567'],
        readysha0: ['deployedsha0'], // ready's history contains the deployed sha
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      {
        git,
        loadDeploy: async () => deploy(), // deployed.sha = 'deployedsha0' (fixture default)
        loadSnapshot: async () => snap({}, 'synced', { greenPinAtStagingHead: true, deployedBehindGreenPin: 2 }),
      },
    );
    expect(res.verdictProvenance.deployOrigin).toBe('stale-behind-gate');
    expect(res.verdictProvenance.deployedBehindGreenPin).toBe(2);
  });

  it('EI-7846: a deployed sha NOT reachable from ready reports ahead-of-gate (force-deployed past the gate)', async () => {
    const git = fakeGit({
      pathCommit: 'abc1234567',
      contains: {
        HEAD: ['abc1234567'],
        'origin/staging': ['abc1234567'],
        'origin/main': ['abc1234567'],
        // readysha0's history does NOT contain deployedsha0 — force-deployed ahead.
        readysha0: [],
      },
    });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap({}, 'synced', { greenPinAtStagingHead: false }),
      },
    );
    expect(res.verdictProvenance.deployOrigin).toBe('ahead-of-gate');
    expect(res.verdictProvenance.mainFastForwarded).toBe(false);
  });

  it('EI-7846: no ready pin (fresh workspace, never green yet) reports unknown provenance, not a throw', async () => {
    const git = fakeGit({ pathCommit: 'abc1234567', contains: { HEAD: ['abc1234567'] } });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap({}, 'synced', { greenPin: null }),
      },
    );
    expect(res.verdictProvenance.lastGreenSha).toBeNull();
    expect(res.verdictProvenance.lastGreenAgeMs).toBeNull();
    expect(res.verdictProvenance.deployOrigin).toBe('unknown');
  });

  it('summarizePosition is pure over the resolved facts', () => {
    const base: Omit<PipelinePosition, 'summary'> = {
      input: { path: 'a.ts', sha: null },
      repoRoot: '/repo',
      submodule: null,
      submodulePin: null,
      targetSha: 'aaaaaaa',
      targetShortSha: 'aaaaaaa',
      targetSubject: 'subj',
      dirtyUncommitted: false,
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
      positionsUnknown: [],
      deployedSha: 'deployedsha0',
      gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
      verdictProvenance: {
        lastGreenSha: 'readysha0',
        lastGreenShortSha: 'readysha',
        lastGreenAgeMs: 1000,
        mainFastForwarded: true,
        deployedBehindGreenPin: 0,
        deployOrigin: 'stale-behind-gate',
      },
      gitSyncLastStatus: 'synced',
      gitSync: HEALTHY_GIT_SYNC,
      runtime: classifyRuntimeOwner('a.ts'),
      runtimes: classifyRuntimeOwners('a.ts'),
      serving: HEALTHY_SERVING,
      changeInCandidate: NO_CANDIDATE,
      sweepExposure: NO_SWEEP,
      notes: [],
      stages: [],
      blockedOn: null,
      nextAction: null,
    };
    expect(summarizePosition(base)).toContain('deployed ✗');
    expect(summarizePosition(base)).not.toContain('(live)');
  });
});

/* ------------------------------------------------------------------------- *
 * EI-10895 — the RUNTIME-OWNER map.
 *
 * The bug being fixed: this tool reported `deployed ✗` + "sleep on the deploy:
 * deploy:await" for code that the release pipeline DOES NOT CARRY. The gateway,
 * bg-host and embed-sidecar all execute tsx straight from the staging tree, so a
 * deploy is a no-op for them and a RESTART is the only activation. An agent that
 * follows the old advice waits forever for an event that lands and changes
 * nothing (this cost an hour on WI-4541, a gateway admission fix).
 * ------------------------------------------------------------------------- */
describe('runtime-owner map (EI-10895)', () => {
  const gatewayPath = 'packages/operator-core/lib/inference-gateway/gateway-priority-tiers.ts';

  it.each([
    [gatewayPath, 'gateway', 'gateway'],
    ['apps/operator/bin/embed-sidecar.ts', 'embed-sidecar', 'embed-sidecar'],
    ['packages/operator-core/lib/dbos/routines-tick.ts', 'bg-host', 'bg-host'],
  ])('%s → runs in %s, and a DEPLOY is not its activation path', (p, host, restartTarget) => {
    const own = classifyRuntimeOwner(p)!;
    expect(own.host).toBe(host);
    expect(own.releasePipelineApplies).toBe(false);
    expect(own.restartTarget).toBe(restartTarget);
    expect(own.activation).toMatch(/dev:restart/);
  });

  /* ---------------------------------------------------------------------- *
   * EI-11120: `system:<action>` routine handlers (git-sync, scout-cycle,
   * blueprint-run, ...) and the routinesTick dispatch machinery itself only
   * execute when PAPERCUSP_BACKGROUND_WORKERS=1 (bg-host) — :3070/:3170 boot
   * request-only and never run this code. Before this fix these paths fell
   * through to the generic `packages/operator-core/lib` shared-caveat case,
   * which only ever HINTED "restart one of those hosts" instead of naming the
   * one true host — a landed+gated+deployed routine fix could look live and
   * silently not be (WI-4475's scout timeout-hierarchy fix).
   * ---------------------------------------------------------------------- */
  it.each([
    'packages/operator-core/lib/harness/routines/register-system-actions.ts',
    'packages/operator-core/lib/harness/routines/system-actions.ts',
    'packages/operator-core/lib/harness/routines/routine-host.ts',
    'packages/operator-core/lib/harness/routines/improvement-actions.ts',
    'packages/operator-core/lib/blueprint/blueprint-run-action.ts',
    'packages/operator-core/lib/scout/scout-cycle-action.ts',
    'packages/operator-core/lib/scout/cycle.ts',
    'packages/operator-core/lib/harness/git-sync/git-sync-action.ts',
    'packages/operator-core/lib/harness/git-sync/run-git-sync.ts',
    'packages/operator-core/lib/harness/git-sync/git-sync-eligibility.ts',
  ])('EI-11120: %s → runs in bg-host only (routinesTick, BACKGROUND_WORKERS=1) — a deploy never carries it', (p) => {
    const own = classifyRuntimeOwner(p)!;
    expect(own.host).toBe('bg-host');
    expect(own.releasePipelineApplies).toBe(false);
    expect(own.restartTarget).toBe('bg-host');
    expect(own.activation).toMatch(/dev:restart.*bg-host/s);
  });

  it('EI-11120: a *-action.ts TEST file under harness/routines/ is NOT misclassified (only the handler itself is bg-host-exclusive)', () => {
    // improvement-actions.test.ts ends in `.test.ts`, not `-action.ts` — must not match.
    const own = classifyRuntimeOwner('packages/operator-core/lib/harness/routines/improvement-actions.test.ts')!;
    expect(own.host).toBe('operator-release');
    expect(own.releasePipelineApplies).toBe(true);
  });

  it('EI-11120: other lib/blueprint/ files (used interactively by the operator API — catalog/authoring) stay release-pipeline-carried', () => {
    const own = classifyRuntimeOwner('packages/operator-core/lib/blueprint/installed-blueprints.ts')!;
    expect(own.host).toBe('operator-release');
    expect(own.releasePipelineApplies).toBe(true);
  });

  it.each([
    ['packages/operator-core/lib/inference-gateway/gateway-sidecar-spawn.ts'],
    ['packages/operator-core/lib/fleet/spawner-sidecar-spawn.ts'],
    ['packages/operator-core/lib/sync/hyperbee/substrate-sidecar-spawn.ts'],
  ])(
    'WI-4996: %s is the BG-HOST supervisor that spawns its sidecar — NOT the sidecar itself, despite living under a sidecar-named directory',
    (p) => {
      const own = classifyRuntimeOwner(p)!;
      expect(own.host).toBe('bg-host');
      expect(own.releasePipelineApplies).toBe(false);
      expect(own.restartTarget).toBe('bg-host');
      // The activation text must not steer an agent toward restarting the
      // (wrong, more disruptive) sidecar it supervises.
      expect(own.activation).toMatch(/dev:restart.*bg-host/s);
      expect(own.activation).not.toMatch(/target: "gateway"/);
    },
  );

  it('WI-4996: a non-spawn file under inference-gateway/ still classifies as the gateway host (no over-correction)', () => {
    const own = classifyRuntimeOwner(gatewayPath)!;
    expect(own.host).toBe('gateway');
    expect(own.restartTarget).toBe('gateway');
  });

  it('the Tauri shell is carried by NEITHER a deploy nor a dev:restart — it is compiled', () => {
    const own = classifyRuntimeOwner('papercusp-desktop/src-tauri/src/main.rs')!;
    expect(own.host).toBe('tauri-desktop');
    expect(own.releasePipelineApplies).toBe(false);
    expect(own.restartTarget).toBeNull();
  });

  it('ordinary operator code still reads as release-pipeline-carried (no false positives)', () => {
    for (const p of ['apps/operator/app/page.tsx', 'packages/operator-core/lib/agent-tools/dev/why.ts']) {
      const own = classifyRuntimeOwner(p)!;
      expect(own.host).toBe('operator-release');
      expect(own.releasePipelineApplies).toBe(true);
    }
  });

  it('a sha-only probe cannot be classified (returns null, keeping the default reading)', () => {
    expect(classifyRuntimeOwner(null)).toBeNull();
    expect(classifyRuntimeOwner(undefined)).toBeNull();
  });

  it('WI-4541 repro — a gateway path summary leads with the RESTART, never "deployed ✗"', async () => {
    const git = fakeGit({
      pathCommit: 'gate123456',
      subject: 'work-conserving tier admission',
      // Fully committed + on staging, but NOT in main and NOT deployed — the exact
      // state that made the old tool say "not live yet, sleep on the deploy".
      contains: { HEAD: ['gate123456'], 'origin/staging': ['gate123456'] },
    });
    const res = await gitPipelinePosition(
      { path: gatewayPath },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );

    expect(res.positions.deployed).toBe(false); // the raw fact is unchanged…
    expect(res.runtime?.host).toBe('gateway'); // …but it is no longer the HEADLINE.
    expect(res.runtime?.releasePipelineApplies).toBe(false);

    // FALSIFICATION: on the old code this summary was
    //   "… committed ✓ · staging ✓ · main ✗ · deployed ✗."
    // and the tool attached { awaitable: deploy:await }. Both were wrong.
    expect(res.summary).toContain('dev:restart');
    expect(res.summary).toContain('gateway');
    expect(res.summary).not.toContain('deployed ✗');
    expect(res.summary).not.toContain('main ✗');
  });

  it('an uncommitted gateway edit is ALREADY what the host will load — the summary says so', async () => {
    const git = fakeGit({ dirty: true, pathCommit: 'gate123456', contains: { HEAD: ['gate123456'] } });
    const res = await gitPipelinePosition(
      { path: gatewayPath },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.dirtyUncommitted).toBe(true);
    expect(res.summary).toMatch(/uncommitted edit is what it loads on restart/i);
  });

  it('shared operator-core/libs code carries the staging-host caveat (a deploy may not be your lever)', async () => {
    const git = fakeGit({ pathCommit: 'aaa1111111', contains: { HEAD: ['aaa1111111'] } });
    const res = await gitPipelinePosition(
      { path: 'libs/papercusp-shared/src/resilience/priority-admission.ts' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    // Still release-carried (the operator loads it too) — so we do NOT reclassify…
    expect(res.runtime?.releasePipelineApplies).toBe(true);
    // …but the agent is told the gateway/bg-host also run it from THIS tree.
    expect(res.notes.some((n) => /gateway|bg-host/.test(n) && /dev:restart/.test(n))).toBe(true);
  });

  it('an app path gets NO staging-host caveat (it is operator-only — keep the note honest)', async () => {
    const git = fakeGit({ pathCommit: 'bbb2222222', contains: { HEAD: ['bbb2222222'] } });
    const res = await gitPipelinePosition(
      { path: 'apps/operator/app/x.tsx' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.notes.some((n) => /dev:restart/.test(n))).toBe(false);
  });

  /* ------------------------------------------------------------------------- *
   * WI-5440 — a path with TWO real consumers on DIFFERENT activation routes.
   * `success-metrics.ts` is read by both the scout ideation cycle (bg-host,
   * routinesTick) AND buildProgramSuccessReport (the `blender:success-metrics`
   * MCP tool, served by the release-checkout operator). Collapsing to one
   * routed a live activation decision the wrong way during the 0.0.11-alpha
   * release watch — this must never again answer with a single owner.
   * ------------------------------------------------------------------------- */
  describe('multi-consumer paths (WI-5440)', () => {
    const successMetricsPath = 'packages/operator-core/lib/scout/success-metrics.ts';

    it('classifyRuntimeOwners returns BOTH consumers, in order', () => {
      const owners = classifyRuntimeOwners(successMetricsPath)!;
      expect(owners).toHaveLength(2);
      expect(owners[0].host).toBe('bg-host');
      expect(owners[0].releasePipelineApplies).toBe(false);
      expect(owners[1].host).toBe('operator-release');
      expect(owners[1].releasePipelineApplies).toBe(true);
    });

    it('the legacy singular classifyRuntimeOwner still returns ONE answer (back-compat), never throws', () => {
      const own = classifyRuntimeOwner(successMetricsPath)!;
      expect(own.host).toBe('bg-host');
    });

    it('a sibling scout/ file with only one real consumer still classifies single-owner (no over-correction)', () => {
      const owners = classifyRuntimeOwners('packages/operator-core/lib/scout/cycle.ts')!;
      expect(owners).toHaveLength(1);
      expect(owners[0].host).toBe('bg-host');
    });

    it('gitPipelinePosition surfaces `runtimes` (plural) and flags the split in notes + summary', async () => {
      const git = fakeGit({ pathCommit: 'sm0000001', contains: { HEAD: ['sm0000001'] } });
      const res = await gitPipelinePosition(
        { path: successMetricsPath },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.runtimes).toHaveLength(2);
      expect(res.runtimes?.map((r) => r.host)).toEqual(['bg-host', 'operator-release']);
      // back-compat single `runtime` is still the first owner, never dropped
      expect(res.runtime?.host).toBe('bg-host');
      expect(res.notes.some((n) => /distinct consumers/.test(n))).toBe(true);
      expect(res.summary).toContain('MULTIPLE CONSUMERS');
      expect(res.summary).toContain('bg-host');
      expect(res.summary).toContain('operator-release');
    });
  });
});

/**
 * git-pipeline-agent-state-2026-07-26 P-001 — the stage table.
 *
 * These assert the BEHAVIOURS that caused real filed incidents, not the shape of
 * the object. Each case names the incident it encodes so a future edit that
 * flattens health back into a boolean fails with the reason attached.
 */
describe('computeStages: position x health', () => {
  type StageInput = Parameters<typeof computeStages>[0];

  const input = (over: Partial<StageInput> = {}): StageInput => ({
    dirtyUncommitted: false,
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
    verdictProvenance: {
      lastGreenSha: 'g',
      lastGreenShortSha: 'g',
      lastGreenAgeMs: 1,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'synced',
    gitSync: HEALTHY_GIT_SYNC,
    serving: HEALTHY_SERVING,
    changeInCandidate: NO_CANDIDATE,
    sweepExposure: NO_SWEEP,
    runtime: classifyRuntimeOwner('packages/operator-core/lib/x.ts'),
    ...over,
  });

  const stage = (stages: StageState[], name: StageName): StageState => {
    const s = stages.find((x) => x.name === name);
    if (!s) throw new Error(`no stage ${name}`);
    return s;
  };

  it('EI-18752644493166307: an UNCOMMITTED edit is not "committed" even when the path is committed', () => {
    // The exact misread that fired the gate twice against candidates lacking the fix:
    // positions.committedLocal means "this PATH exists at a commit", which reads as
    // "my change is committed". The stage table must answer about the CHANGE.
    const s = computeStages(input({ dirtyUncommitted: true }));
    expect(stage(s, 'committed').position).toBe('pending');
    expect(stage(s, 'committed').health).toBe('stalled');
    // and it must say WHY, naming the gate's committed-candidate semantics
    expect(stage(s, 'committed').detail).toMatch(/COMMITTED candidate/);
    expect(stage(s, 'committed').detail).toMatch(/git-sync:run/);
  });

  it('a clean committed path reads past/advancing with no noise', () => {
    const s = computeStages(input());
    expect(stage(s, 'committed')).toMatchObject({ position: 'past', health: 'advancing', detail: null });
  });

  const unpushed = { committedLocal: true, onStaging: false, inMain: false, deployed: false };

  it('EI-18753105351266788: "synced" with NOTHING pushed says so explicitly', () => {
    // The trap: status 'synced' is reachable with pushedRepos empty, and the old
    // surface forwarded only that word. The caller must be told the tick pushed
    // nothing rather than left to infer "reached origin" from "synced".
    const s = computeStages(input({ positions: unpushed, gitSync: { ...HEALTHY_GIT_SYNC, pushedRepos: [] } }));
    expect(stage(s, 'pushed').position).toBe('pending');
    expect(stage(s, 'pushed').detail).toMatch(/does NOT mean pushed/);
    expect(stage(s, 'pushed').detail).toMatch(/pushed NOTHING/);
  });

  it('EI-18750935999066024: a FAULTING push leg is `broken`, not "not yet"', () => {
    // The 2h52m / 19-stranded-commit freeze. Commits kept landing locally, so every
    // position boolean looked plausible; only the leg's own health distinguishes
    // "waiting will fix this" from "waiting is futile".
    const s = computeStages(
      input({
        positions: unpushed,
        gitSync: { ...HEALTHY_GIT_SYNC, consecutiveErrorTicks: 4, errors: ['push failed: permission denied'] },
      }),
    );
    expect(stage(s, 'pushed').health).toBe('broken');
    expect(stage(s, 'pushed').detail).toMatch(/FAULTING/);
    expect(stage(s, 'pushed').detail).toMatch(/waiting will not clear this/i);
  });

  it('a git-sync tick far past its interval is `stalled`, with the age named', () => {
    const s = computeStages(
      input({ positions: unpushed, gitSync: { ...HEALTHY_GIT_SYNC, syncAgeMs: 172 * 60_000 } }),
    );
    expect(stage(s, 'pushed').health).toBe('stalled');
    expect(stage(s, 'pushed').detail).toMatch(/172 min ago/);
    expect(stage(s, 'pushed').detail).toMatch(/not simply "not yet"/);
  });

  it('merge conflicts block origin and name the resolver, not a retry', () => {
    const s = computeStages(
      input({ positions: unpushed, gitSync: { ...HEALTHY_GIT_SYNC, conflicts: ['apps/operator/x.tsx'] } }),
    );
    expect(stage(s, 'pushed').health).toBe('broken');
    expect(stage(s, 'pushed').detail).toMatch(/merge-resolver/);
  });

  it('a healthy pushed change is past/advancing with no noise', () => {
    const s = computeStages(input());
    expect(stage(s, 'pushed')).toMatchObject({ position: 'past', health: 'advancing', detail: null });
  });

  it('EI-11120: stages off the release route are `na`, never "pending" — waiting would never end', () => {
    // A bg-host path is not carried by staging->main->:3070 at all. Reporting those
    // stages as pending told an agent to wait for something that could not happen.
    const bg = classifyRuntimeOwner('packages/operator-core/lib/harness/git-sync/git-sync-action.ts');
    expect(bg?.releasePipelineApplies).toBe(false);
    const s = computeStages(input({ runtime: bg }));
    for (const name of ['gate', 'main', 'deployed'] as StageName[]) {
      expect(stage(s, name).position).toBe('na');
      expect(stage(s, name).health).toBe('disabled');
      expect(stage(s, name).detail).toMatch(/dev:restart/);
    }
  });

  it('WI-282: a non-firing gate is `broken` and says waiting will not help', () => {
    const s = computeStages(
      input({ gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: true, fireStaleReason: 'paused' } }),
    );
    expect(stage(s, 'gate').health).toBe('broken');
    expect(stage(s, 'gate').detail).toMatch(/Waiting will not help/i);
    expect(stage(s, 'gate').detail).toMatch(/paused/);
  });

  it('a red gate is `stalled` and framed as yours to fix, not a queue to wait in', () => {
    const s = computeStages(
      input({ gate: { stalled: true, consecutiveReds: 3, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null } }),
    );
    expect(stage(s, 'gate').health).toBe('stalled');
    expect(stage(s, 'gate').detail).toMatch(/RED \(3 consecutive\)/);
  });

  it('EI-7846: a force-deployed sha is `broken` — "deployed" must not imply "tested"', () => {
    const s = computeStages(
      input({
        verdictProvenance: {
          lastGreenSha: 'g',
          lastGreenShortSha: 'g',
          lastGreenAgeMs: 1,
          mainFastForwarded: true,
          deployedBehindGreenPin: 0,
          deployOrigin: 'ahead-of-gate',
        },
      }),
    );
    expect(stage(s, 'deployed').health).toBe('broken');
    expect(stage(s, 'deployed').detail).toMatch(/does not mean "tested"/);
  });

  it('the 4x-filed class: `serving` is NEVER advancing from git state alone', () => {
    // EI-18740960754854672 + 3 duplicates: `deployed ✓` was read as "live" while the
    // process served older code. Git state can never justify claiming a process is
    // serving something. P-003 supplies that truth from a process probe — and this
    // asserts the OTHER half of the same rule: when the probe cannot answer, the
    // stage degrades to `unknown`, never back to `advancing`. Every stage around it
    // is fully green here, so only a git-derived inference could turn this green.
    const noProcessEvidence = evaluateServing({
      runtime: classifyRuntimeOwner('packages/operator-core/lib/x.ts'),
      process: null,
      codeAsOfMs: Date.now(),
      codeAsOfSource: 'deploy',
    });
    const s = computeStages(input({ serving: noProcessEvidence }));
    expect(stage(s, 'deployed').position).toBe('past');
    expect(stage(s, 'serving').health).toBe('unknown');
    expect(stage(s, 'serving').position).toBe('pending');
    expect(stage(s, 'serving').detail).toMatch(/not the same as "live"/);
  });

  it('is pure: no git calls, and stages are ordered source->live', () => {
    const names = computeStages(input()).map((s) => s.name);
    expect(names).toEqual(['committed', 'pushed', 'gate', 'main', 'deployed', 'serving']);
  });
});

/**
 * git-pipeline-agent-state-2026-07-26 P-003 — serving-process truth.
 *
 * The class these encode was filed FOUR times independently
 * (EI-18740960754854672, EI-18741985436324043, EI-18741004371760803,
 * EI-18746827803289687): `deployed` is a git fact, and reading it as "live" is
 * wrong whenever the serving process booted before the code landed. Four
 * rediscoveries of one fact is a missing state surface, so these assert the
 * SURFACE never claims liveness without process evidence.
 */
describe('evaluateServing: process truth, never a git inference', () => {
  const releaseRuntime = classifyRuntimeOwner('packages/operator-core/lib/x.ts')!;
  const bgHostRuntime = classifyRuntimeOwner('packages/operator-core/lib/scout/cycle.ts')!;

  it('a process that started BEFORE the deploy is NOT serving the deployed code', () => {
    const sv = evaluateServing({
      runtime: releaseRuntime,
      process: { pid: 99, startedAtMs: 1_000_000 },
      codeAsOfMs: 1_000_000 + 45 * 60_000, // deploy landed 45m AFTER boot
      codeAsOfSource: 'deploy',
    });
    expect(sv.startedSinceCodeChange).toBe(false);
    expect(sv.behindMin).toBe(45);
    // and it must name the lever, not merely report the gap
    expect(sv.restartLever).toContain('deploy-cli.ts --execute');
  });

  it('a process that started AFTER the deploy has genuinely loaded it', () => {
    const sv = evaluateServing({
      runtime: releaseRuntime,
      process: { pid: 99, startedAtMs: 2_000_000 },
      codeAsOfMs: 1_000_000,
      codeAsOfSource: 'deploy',
    });
    expect(sv.startedSinceCodeChange).toBe(true);
    expect(sv.behindMin).toBeNull();
  });

  it('probes the SERVING unit, not the restart target (an operator-release path is served by :3070, not :3170)', () => {
    // restartTarget for a release path is `staging` — the host you bounce to
    // EXERCISE an edit. Probing that process would answer about the wrong one.
    expect(releaseRuntime.restartTarget).toBe('staging');
    const sv = evaluateServing({
      runtime: releaseRuntime,
      process: { pid: 1, startedAtMs: 2 },
      codeAsOfMs: 1,
      codeAsOfSource: 'deploy',
    });
    expect(sv.unit).toBe('papercup-dev-api.service');
  });

  it('an UNREADABLE process start is UNKNOWN, never "live" (fail-soft in the honest direction)', () => {
    const sv = evaluateServing({
      runtime: releaseRuntime,
      process: null,
      codeAsOfMs: 1_000,
      codeAsOfSource: 'deploy',
    });
    expect(sv.startedSinceCodeChange).toBeNull();
    // The probe RAN and came back empty — retry-or-escalate, NOT a final answer.
    expect(sv.unknownReason?.code).toBe('resolver-failed');
    expect(sv.unknownReason?.detail).toMatch(/UNKNOWN, which is not the same as "live"/);
  });

  it('a sha-only probe (no path) cannot identify a serving process and says so', () => {
    const sv = evaluateServing({ runtime: null, process: null, codeAsOfMs: null, codeAsOfSource: null });
    expect(sv.startedSinceCodeChange).toBeNull();
    expect(sv.host).toBeNull();
    // Nothing failed here — there is no serving question to ask, so this is
    // FINAL. A caller that retries a `not-applicable` is burning calls forever.
    expect(sv.unknownReason?.code).toBe('not-applicable');
    expect(sv.unknownReason?.detail).toMatch(/sha-only probe/);
  });

  /**
   * The case that earns the enum its keep (D-038 axis 2 corollary). All three
   * unknowns above render as prose a human reads the same way — "we don't know"
   * — but they demand THREE different responses, and only the code says which:
   *   - sha-only probe        → not-applicable   → stop asking; there is no lever
   *   - unreadable start time → resolver-failed  → retry, or escalate the probe
   *   - start time but no code-as-of → insufficient-data → supply the missing
   *     operand; retrying the identical call cannot help, because the half that
   *     failed is not the half being retried.
   * Before this change all three were `string | null` and a caller could only
   * have told them apart by matching on prose, which nobody does.
   */
  it('a HALF-read comparison is insufficient-data, not resolver-failed — the probe succeeded', () => {
    const sv = evaluateServing({
      runtime: releaseRuntime,
      process: { pid: 4242, startedAtMs: 5_000 },
      codeAsOfMs: null,
      codeAsOfSource: null,
    });
    expect(sv.startedSinceCodeChange).toBeNull();
    expect(sv.unknownReason?.code).toBe('insufficient-data');
    expect(sv.unknownReason?.code).not.toBe('resolver-failed');
    expect(sv.unknownReason?.detail).toMatch(/cannot be compared/);
  });

  it('a working-tree host compares against FILE MTIME, because it imports the tree — not the deploy', () => {
    // bg-host tsx-loads the working tree, so an uncommitted edit IS its code; the
    // deploy is irrelevant to it (EI-11120). Same comparison service-health's
    // evaluateBgHostCodeDrift makes, generalised from hot-paths to one file.
    const sv = evaluateServing({
      runtime: bgHostRuntime,
      process: { pid: 7, startedAtMs: 1_000_000 },
      codeAsOfMs: 1_000_000 + 10 * 60_000,
      codeAsOfSource: 'file-mtime',
    });
    expect(sv.unit).toBe('papercup-bg-host.service');
    expect(sv.startedSinceCodeChange).toBe(false);
    expect(sv.restartLever).toContain('bg-host');
  });
});

describe('the serving STAGE and summary never claim "live" off a git fact', () => {
  type StageInput = Parameters<typeof computeStages>[0];
  const stage = (stages: StageState[], name: StageName): StageState => {
    const s = stages.find((x) => x.name === name);
    if (!s) throw new Error(`no stage ${name}`);
    return s;
  };
  const base = (serving: ServingTruth, over: Partial<StageInput> = {}): StageInput => ({
    dirtyUncommitted: false,
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
    verdictProvenance: {
      lastGreenSha: 'g',
      lastGreenShortSha: 'g',
      lastGreenAgeMs: 1,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'synced',
    gitSync: HEALTHY_GIT_SYNC,
    changeInCandidate: NO_CANDIDATE,
    sweepExposure: NO_SWEEP,
    runtime: classifyRuntimeOwner('packages/operator-core/lib/x.ts'),
    ...over,
    serving,
  });

  const STALE: ServingTruth = {
    ...HEALTHY_SERVING,
    startedAtMs: 1_000,
    codeAsOfMs: 100_000,
    startedSinceCodeChange: false,
    behindMin: 30,
  };

  it('THE 4x-FILED BUG: deployed ✓ + a process older than the deploy is NOT past the serving stage', () => {
    const s = computeStages(base(STALE));
    // deployed is genuinely past — the git fact is true...
    expect(stage(s, 'deployed').position).toBe('past');
    // ...and that is exactly why serving must be the one to say "no".
    expect(stage(s, 'serving').position).toBe('pending');
    expect(stage(s, 'serving').health).toBe('stalled');
    expect(stage(s, 'serving').detail).toMatch(/does NOT mean "running"/);
    // waiting is futile here; the detail must name the restart, not suggest patience
    expect(stage(s, 'serving').detail).toMatch(/Waiting cannot fix this/);
  });

  it('deployed ✓ + a process younger than the deploy IS past the serving stage', () => {
    const s = computeStages(base(HEALTHY_SERVING));
    expect(stage(s, 'serving').position).toBe('past');
    expect(stage(s, 'serving').health).toBe('advancing');
  });

  it('not deployed yet ⇒ serving is pending even when the process is current (the deploy stage owns that wait)', () => {
    const s = computeStages(
      base(HEALTHY_SERVING, { positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false } }),
    );
    expect(stage(s, 'serving').position).toBe('pending');
    expect(stage(s, 'serving').health).toBe('advancing');
    expect(stage(s, 'serving').detail).toBeNull();
  });

  it('an UNKNOWN serving verdict is health=unknown with its reason — not silently "advancing"', () => {
    const unknown: ServingTruth = {
      ...HEALTHY_SERVING,
      startedAtMs: null,
      pid: null,
      startedSinceCodeChange: null,
      unknownReason: { code: 'resolver-failed', detail: 'could not read the unit' },
    };
    const s = computeStages(base(unknown));
    expect(stage(s, 'serving').health).toBe('unknown');
    expect(stage(s, 'serving').position).toBe('pending');
    expect(stage(s, 'serving').detail).toBe('could not read the unit');
  });

  it('summarizePosition drops the bare "(live)" and qualifies it with process evidence', () => {
    const mk = (serving: ServingTruth): Omit<PipelinePosition, 'summary'> => ({
      input: { path: 'a.ts', sha: null },
      repoRoot: '/repo',
      submodule: null,
      submodulePin: null,
      targetSha: 'aaaaaaa',
      targetShortSha: 'aaaaaaa',
      targetSubject: 'subj',
      dirtyUncommitted: false,
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
      positionsUnknown: [],
      deployedSha: 'deployedsha0',
      gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
      verdictProvenance: {
        lastGreenSha: 'readysha0',
        lastGreenShortSha: 'readysha',
        lastGreenAgeMs: 1000,
        mainFastForwarded: true,
        deployedBehindGreenPin: 0,
        deployOrigin: 'gate-green',
      },
      gitSyncLastStatus: 'synced',
      gitSync: HEALTHY_GIT_SYNC,
      runtime: classifyRuntimeOwner('a.ts'),
      runtimes: classifyRuntimeOwners('a.ts'),
      serving,
      changeInCandidate: NO_CANDIDATE,
      sweepExposure: NO_SWEEP,
      notes: [],
      stages: [],
      blockedOn: null,
      nextAction: null,
    });

    // stale process: the summary must actively CONTRADICT the deployed tick
    const stale = summarizePosition(mk(STALE));
    expect(stale).toMatch(/NOT LIVE/);
    expect(stale).not.toMatch(/\(live\)/);

    // confirmed: "live" is allowed, but only with the reason attached
    const live = summarizePosition(mk(HEALTHY_SERVING));
    expect(live).toContain('live — the serving process started after this code landed');

    // unknown: neither "live" nor a false alarm
    const unknown = summarizePosition(mk({ ...HEALTHY_SERVING, startedSinceCodeChange: null }));
    expect(unknown).toMatch(/UNKNOWN — not confirmed live/);
    expect(unknown).not.toMatch(/NOT LIVE/);
  });
});

/* ------------------------------------------------------------------------- *
 * P-004 — "is the commit the gate is judging even MY code?"
 *
 * EI-18752644493166307: two gate runs judged candidates that did not contain the
 * caller's fix. The wasted runs were the cheap part. The expensive part is that a
 * candidate WITHOUT your fix reds on the PRE-FIX failure with the PRE-FIX count,
 * which reads as "your fix did not work" instead of "your fix was not present" —
 * and sends you off to re-debug code that was already correct.
 *
 * So these cases assert the READING, not the field: every path that can produce that
 * misread must be closed by text that names it.
 * ------------------------------------------------------------------------- */
describe('changeInCandidate (P-004)', () => {
  const contained = (over: Partial<ChangeInCandidate> = {}): ChangeInCandidate => ({
    ...NO_CANDIDATE,
    ...over,
  });

  describe('evaluateChangeInCandidate', () => {
    it('a sha-only probe reports nothing rather than inventing a verdict', () => {
      const r = evaluateChangeInCandidate({
        relPath: null,
        candidates: { judgingSha: 'aaa', nextCandidateSha: 'bbb' },
        judging: null,
        next: null,
      });
      expect(r).toEqual(NO_CANDIDATE);
    });

    it('THE misread: an in-flight run without your file says a RED is not your fix failing', () => {
      const r = evaluateChangeInCandidate({
        relPath: 'a.ts',
        candidates: { judgingSha: 'cand1234567890', nextCandidateSha: 'cand1234567890' },
        judging: { path: 'a.ts', inCandidate: false, reason: 'uncommitted', unknownReason: null },
        next: null,
      });
      expect(r.judgingContainsPath).toBe(false);
      expect(r.missingReason).toBe('uncommitted');
      // The whole point: pre-empt "my fix didn't work".
      expect(r.detail).toMatch(/NOT evidence your change failed/);
      // …and name the lever that actually applies to THIS reason.
      expect(r.detail).toMatch(/git-sync:run/);
    });

    it('a quiet-cut miss routes to the quiet-window lever, NOT to "commit it"', () => {
      // Naming this 'uncommitted' would send the caller to git-sync:run — which cannot
      // help, because the change is already committed. Wrong lever = another wasted run.
      const r = evaluateChangeInCandidate({
        relPath: 'a.ts',
        candidates: { judgingSha: null, nextCandidateSha: 'cand1234567890' },
        judging: null,
        next: { path: 'a.ts', inCandidate: false, reason: 'newer-commit', unknownReason: null },
      });
      expect(r.nextContainsPath).toBe(false);
      expect(r.detail).toMatch(/quiet-cut/);
      expect(r.detail).not.toMatch(/git-sync:run/);
    });

    it('the IN-FLIGHT run outranks the hypothetical next candidate — its verdict is the one landing', () => {
      const r = evaluateChangeInCandidate({
        relPath: 'a.ts',
        candidates: { judgingSha: 'inflight123456', nextCandidateSha: 'nextcand123456' },
        judging: { path: 'a.ts', inCandidate: false, reason: 'newer-commit', unknownReason: null },
        next: { path: 'a.ts', inCandidate: true, reason: null, unknownReason: null },
      });
      expect(r.detail).toMatch(/IN FLIGHT/);
      expect(r.detail).toMatch(/inflight1234/);
    });

    it('a confirmed-contained candidate says the verdict IS about your change', () => {
      const r = evaluateChangeInCandidate({
        relPath: 'a.ts',
        candidates: { judgingSha: 'inflight123456', nextCandidateSha: null },
        judging: { path: 'a.ts', inCandidate: true, reason: null, unknownReason: null },
        next: null,
      });
      expect(r.detail).toMatch(/real verdict on your change/);
    });

    it('an UNKNOWN containment claims nothing in either direction', () => {
      const r = evaluateChangeInCandidate({
        relPath: 'a.ts',
        candidates: { judgingSha: 'inflight123456', nextCandidateSha: null },
        judging: {
          path: 'a.ts',
          inCandidate: null,
          reason: null,
          unknownReason: { code: 'resolver-failed', detail: 'unreadable' },
        },
        next: null,
      });
      expect(r.judgingContainsPath).toBeNull();
      expect(r.detail).toBeNull();
    });
  });

  describe('the gate stage leads with containment', () => {
    type StageInput = Parameters<typeof computeStages>[0];
    const gateStage = (over: Partial<StageInput>) => {
      const stages = computeStages({
        dirtyUncommitted: false,
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
        verdictProvenance: {
          lastGreenSha: 'g',
          lastGreenShortSha: 'g',
          lastGreenAgeMs: 1,
          mainFastForwarded: true,
          deployedBehindGreenPin: 0,
          deployOrigin: 'gate-green',
        },
        gitSyncLastStatus: 'synced',
        gitSync: HEALTHY_GIT_SYNC,
        serving: HEALTHY_SERVING,
        changeInCandidate: NO_CANDIDATE,
        sweepExposure: NO_SWEEP,
        runtime: classifyRuntimeOwner('packages/operator-core/lib/x.ts'),
        ...over,
      });
      const s = stages.find((x) => x.name === 'gate');
      if (!s) throw new Error('no gate stage');
      return s;
    };

    it('a RED gate + a candidate lacking your file must not read as one signal', () => {
      // These are the two readings the incident conflated. A bare "gate is RED (3
      // consecutive)" next to a candidate that cannot contain the fix is exactly what
      // sends someone back to re-debug correct code — so containment leads, and the red
      // is explicitly demoted to "not about you yet".
      const s = gateStage({
        gate: { stalled: true, consecutiveReds: 3, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
        changeInCandidate: contained({
          judgingSha: 'cand1234567890',
          judgingContainsPath: false,
          missingReason: 'uncommitted',
          detail: 'candidate does not contain it',
        }),
      });
      expect(s.health).toBe('stalled');
      expect(s.detail).toMatch(/candidate does not contain it/);
      expect(s.detail).toMatch(/do NOT read that red as your change failing/);
    });

    it('leaves the normal red-gate message alone when containment is not in question', () => {
      const s = gateStage({
        gate: { stalled: true, consecutiveReds: 3, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
      });
      expect(s.detail).toMatch(/Gate is RED \(3 consecutive\)/);
    });

    it('containment also outranks a WEDGED gate — a verdict that cannot mention you is worse news', () => {
      const s = gateStage({
        gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: true, fireStaleReason: 'no tick' },
        changeInCandidate: contained({
          nextCandidateSha: 'cand1234567890',
          nextContainsPath: false,
          missingReason: 'newer-commit',
          detail: 'a fire now would judge older code',
        }),
      });
      expect(s.detail).toMatch(/a fire now would judge older code/);
    });
  });

  describe('summarizePosition', () => {
    const base = (over: Partial<Omit<PipelinePosition, 'summary'>> = {}): Omit<PipelinePosition, 'summary'> => ({
      input: { path: 'a.ts', sha: null },
      repoRoot: '/repo',
      submodule: null,
      submodulePin: null,
      targetSha: 'aaaaaaa',
      targetShortSha: 'aaaaaaa',
      targetSubject: 'subj',
      dirtyUncommitted: false,
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      positionsUnknown: [],
      deployedSha: 'deployedsha0',
      gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
      verdictProvenance: {
        lastGreenSha: 'readysha0',
        lastGreenShortSha: 'readysha',
        lastGreenAgeMs: 1000,
        mainFastForwarded: true,
        deployedBehindGreenPin: 0,
        deployOrigin: 'gate-green',
      },
      gitSyncLastStatus: 'synced',
      gitSync: HEALTHY_GIT_SYNC,
      runtime: classifyRuntimeOwner('a.ts'),
      runtimes: classifyRuntimeOwners('a.ts'),
      serving: HEALTHY_SERVING,
      changeInCandidate: NO_CANDIDATE,
      sweepExposure: NO_SWEEP,
      notes: [],
      stages: [],
      blockedOn: null,
      nextAction: null,
      ...over,
    });

    it('appends the containment warning LAST — where a reader stops', () => {
      const s = summarizePosition(
        base({
          changeInCandidate: contained({
            judgingSha: 'cand1234567890',
            judgingContainsPath: false,
            detail: 'the judged candidate lacks this file',
          }),
        }),
      );
      expect(s).toMatch(/the judged candidate lacks this file$/);
    });

    it('stays silent when containment is unknown — no verdict is better than a wrong one', () => {
      expect(summarizePosition(base())).not.toMatch(/⚠ The gate run/);
    });

    /**
     * The EI names this line specifically. For a working-tree tsx host the reassurance
     * "even an uncommitted edit is what it loads on restart" is TRUE — of the RESTART
     * consumer. The green-checkpoint is a second consumer of the same file and judges a
     * COMMITTED candidate, for which the same edit is invisible. The filer read the true
     * half as blanket permission and fired the gate dirty.
     */
    it('qualifies the working-tree reassurance for the GATE consumer when the path is dirty', () => {
      const bgPath = 'packages/operator-core/lib/inference-gateway/admission.ts';
      const rt = classifyRuntimeOwner(bgPath);
      expect(rt?.releasePipelineApplies).toBe(false);

      const dirty = summarizePosition(
        base({
          input: { path: bgPath, sha: null },
          dirtyUncommitted: true,
          runtime: rt,
          runtimes: classifyRuntimeOwners(bgPath),
        }),
      );
      expect(dirty).toMatch(/even an uncommitted edit is what it loads on restart/);
      expect(dirty).toMatch(/GREEN GATE is a different consumer/);
      expect(dirty).toMatch(/INVISIBLE to it/);

      // …and it must NOT fire when there is nothing uncommitted to be blind to.
      const clean = summarizePosition(
        base({ input: { path: bgPath, sha: null }, runtime: rt, runtimes: classifyRuntimeOwners(bgPath) }),
      );
      expect(clean).not.toMatch(/GREEN GATE is a different consumer/);
    });
  });

  describe('gitPipelinePosition wiring', () => {
    it('reports containment against BOTH candidates and notes the miss', async () => {
      const git: GitRunner = async (_repo, args) => {
        if (args[0] === 'config') return null;
        if (args[0] === 'status') return 'M a.ts';
        if (args[0] === 'log' && args.includes('--pretty=%H')) return 'abc1234567';
        if (args[0] === 'log' && args.includes('--pretty=%s')) return 'subj';
        if (args[0] === 'rev-list') return '0';
        // The candidate COMMIT must resolve before any path verdict is computed — an
        // unresolvable sha is UNKNOWN, not a blanket "absent".
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2].endsWith('^{commit}')) return 'c'.repeat(40);
        // The candidate carries an OLD blob; the working tree has a new one. (Both must be
        // real hex — the reader rejects non-sha output rather than trusting it.)
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'judging1:a.ts') return '0'.repeat(40);
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD:a.ts') return '0'.repeat(40);
        if (args[0] === 'hash-object') return 'f'.repeat(40);
        return null;
      };
      const res = await gitPipelinePosition(
        { path: 'a.ts' },
        {
          git,
          loadDeploy: async () => deploy(),
          loadSnapshot: async () => snap(),
          resolveGateCandidates: async () => ({ judgingSha: 'judging1', nextCandidateSha: 'judging1' }),
        },
      );
      expect(res.changeInCandidate.judgingSha).toBe('judging1');
      expect(res.changeInCandidate.judgingContainsPath).toBe(false);
      expect(res.changeInCandidate.missingReason).toBe('uncommitted');
      expect(res.notes.join(' ')).toMatch(/CANDIDATE DOES NOT CONTAIN THIS FILE/);
    });

    it('does NOT claim containment across a submodule boundary — the gate judges the PIN', async () => {
      // The superproject stores a gitlink, not submodule content, so a blob comparison
      // there compares nothing. Reporting `true` would be the same absence-reads-as-
      // evidence trap EI-18715870370005934 already cost a false "abort the run".
      const git = fakeGit({
        submodules: ['libs/generic/thing'],
        pathCommit: 'abc1234567',
        contains: { HEAD: ['abc1234567'] },
      });
      const res = await gitPipelinePosition(
        { path: 'libs/generic/thing/src/x.ts' },
        { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
      );
      expect(res.changeInCandidate.judgingContainsPath).toBeNull();
      expect(res.changeInCandidate.nextContainsPath).toBeNull();
      expect(res.changeInCandidate.detail).toMatch(/gitlink/);
    });

    it('a failing candidate resolver degrades to UNKNOWN, never to a false all-clear', async () => {
      const git = fakeGit({ pathCommit: 'abc1234567', contains: { HEAD: ['abc1234567'] } });
      const res = await gitPipelinePosition(
        { path: 'a.ts' },
        {
          git,
          loadDeploy: async () => deploy(),
          loadSnapshot: async () => snap(),
          resolveGateCandidates: async () => ({ judgingSha: null, nextCandidateSha: null }),
        },
      );
      expect(res.changeInCandidate.judgingContainsPath).toBeNull();
      expect(res.changeInCandidate.nextContainsPath).toBeNull();
      expect(res.summary).not.toMatch(/⚠ The gate run/);
    });
  });
});

/* ------------------------------------------------------------------------- *
 * P-005 — blockedOn + nextAction.
 *
 * `stages[]` gives six position×health readings. This answers the question the caller
 * actually arrived with: "is my change live, and if not what is the ONE thing blocking
 * it" — the task that cost 11 tool calls and 4 hand-diffs on 2026-07-26 and STILL went
 * wrong twice, because deciding which of six stages owned the next move was left to the
 * reader.
 *
 * The invariant these protect: THREE distinct states. Collapsing "waiting is correct"
 * into "here is a lever" manufactures busywork (and, on the push/deploy legs, an
 * unnecessary forced run); collapsing it into "nothing is pending" claims the change is
 * live when it is not.
 * ------------------------------------------------------------------------- */
describe('deriveBlocker (P-005)', () => {
  const st = (name: StageName, position: 'past' | 'pending' | 'na', lever: string | null = null): StageState => ({
    name,
    position,
    health: 'advancing',
    detail: null,
    lever,
  });

  it('nothing pending ⇒ null/null — the change is live', () => {
    expect(deriveBlocker([st('committed', 'past'), st('serving', 'past')])).toEqual({
      blockedOn: null,
      nextAction: null,
      actionOwner: null,
    });
  });

  /**
   * Caught by a LIVE run, not a fixture. A change sitting at a healthy `pushed` leg
   * (git-sync pushes within ~10 min — genuinely "wait") with the gate RED at 5 consecutive
   * reds behind it reported nextAction: null, i.e. "nothing to do", while a red gate held
   * main for the entire fleet. That is a FALSE ALL-CLEAR on the one thing the caller most
   * owns: "the reds are yours to fix, not a queue to wait in."
   */
  it('a self-advancing early stage must NOT mask an actionable stage behind it', () => {
    const r = deriveBlocker([
      st('committed', 'past'),
      st('pushed', 'pending', null), // healthy, between ticks — waiting is correct HERE
      st('gate', 'pending', 'fix the reds, then release:checkpoint-run'),
    ]);
    // Where the change SITS is still reported honestly…
    expect(r.blockedOn).toBe('pushed');
    // …but the actionable thing is surfaced, and attributed to the stage that owns it.
    expect(r.nextAction).toMatch(/fix the reds/);
    expect(r.actionOwner).toBe('gate');
  });

  it('an EARLIER stage with a lever still wins — you cannot green a gate for uncommitted work', () => {
    const r = deriveBlocker([
      st('committed', 'pending', 'git-sync:run'),
      st('gate', 'pending', 'fix the reds'),
    ]);
    expect(r.blockedOn).toBe('committed');
    expect(r.nextAction).toBe('git-sync:run');
    expect(r.actionOwner).toBe('committed');
  });

  it('picks the FIRST pending stage — a later stage cannot advance until an earlier one has', () => {
    const r = deriveBlocker([
      st('committed', 'past'),
      st('pushed', 'pending', 'git-sync:run'),
      st('gate', 'pending', 'release:checkpoint-run'),
    ]);
    expect(r.blockedOn).toBe('pushed');
    expect(r.nextAction).toBe('git-sync:run');
  });

  it('SKIPS `na` stages — they are not on this change\'s route, so they cannot block it', () => {
    // The bg-host/gateway case: gate/main/deployed are `na`, and reporting one of them as
    // the blocker would send the caller to wait for a deploy that can never carry the code.
    const r = deriveBlocker([
      st('committed', 'past'),
      st('pushed', 'past'),
      st('gate', 'na'),
      st('main', 'na'),
      st('deployed', 'na'),
      st('serving', 'pending', 'dev:restart { target: "bg-host" }'),
    ]);
    expect(r.blockedOn).toBe('serving');
    expect(r.nextAction).toBe('dev:restart { target: "bg-host" }');
  });

  it('a pending stage with NO lever anywhere reports the block with a null action — waiting IS the answer', () => {
    const r = deriveBlocker([st('committed', 'past'), st('pushed', 'pending', null), st('gate', 'pending', null)]);
    expect(r.blockedOn).toBe('pushed');
    // Distinct from "nothing is pending" (blockedOn null) and from "do this" (action set).
    expect(r.nextAction).toBeNull();
    expect(r.actionOwner).toBeNull();
  });
});

describe('stage levers (P-005)', () => {
  type StageInput = Parameters<typeof computeStages>[0];
  const lever = (name: StageName, over: Partial<StageInput>): string | null => {
    const stages = computeStages({
      dirtyUncommitted: false,
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
      gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
      verdictProvenance: {
        lastGreenSha: 'g',
        lastGreenShortSha: 'g',
        lastGreenAgeMs: 1,
        mainFastForwarded: true,
        deployedBehindGreenPin: 0,
        deployOrigin: 'gate-green',
      },
      gitSyncLastStatus: 'synced',
      gitSync: HEALTHY_GIT_SYNC,
      serving: HEALTHY_SERVING,
      changeInCandidate: NO_CANDIDATE,
      sweepExposure: NO_SWEEP,
      runtime: classifyRuntimeOwner('packages/operator-core/lib/x.ts'),
      ...over,
    });
    const s = stages.find((x) => x.name === name);
    if (!s) throw new Error(`no stage ${name}`);
    return s.lever;
  };

  it('uncommitted work routes to git-sync:run', () => {
    expect(lever('committed', { dirtyUncommitted: true })).toMatch(/git-sync:run/);
  });

  /**
   * The push leg between ticks is the case a lever would actively HARM: git-sync pushes
   * within ~10 min on its own, so offering a forced run invites needless work. A FAULTED
   * leg never self-clears, so it must not read the same way.
   */
  it('a healthy push leg between ticks offers NO lever; a faulted one does', () => {
    const healthy = lever('pushed', {
      positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
    });
    expect(healthy).toBeNull();

    const faulted = lever('pushed', {
      positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
      gitSync: { ...HEALTHY_GIT_SYNC, consecutiveErrorTicks: 3, errors: ['boom'] },
    });
    expect(faulted).toMatch(/git-sync:run/);

    const conflicted = lever('pushed', {
      positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
      gitSync: { ...HEALTHY_GIT_SYNC, conflicts: ['libs/x'] },
    });
    expect(conflicted).toMatch(/merge-resolver/);
  });

  it('containment OUTRANKS a red gate — judging a candidate without your change buys nothing', () => {
    const l = lever('gate', {
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      gate: { stalled: true, consecutiveReds: 3, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
      changeInCandidate: { ...NO_CANDIDATE, judgingContainsPath: false, missingReason: 'uncommitted' },
    });
    expect(l).toMatch(/git-sync:run/);
    expect(l).not.toMatch(/fix the reds/);
  });

  it('a red gate with the change present routes to fixing the reds, not waiting', () => {
    const l = lever('gate', {
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      gate: { stalled: true, consecutiveReds: 3, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
    });
    expect(l).toMatch(/fix the reds/);
  });

  /**
   * Found by DOGFOODING this surface on a live stale red: the gate read 5 consecutive
   * reds, but a run was already in flight judging a candidate that carried the fix, so
   * a verdict clearing it was on its way.
   *
   * Telling the caller to fire release:checkpoint-run there is actively wrong: the gate
   * is a singleton, so a second fire is REFUSED — and the natural escalation from a
   * refusal is `replaceStale`, which is precisely the EI-11667 replace-storm that killed
   * every verdict for 2h on 2026-07-13. When a verdict covering your change is already
   * coming, waiting IS the lever.
   */
  it('an IN-FLIGHT run that carries the change ⇒ no lever, even with the gate red', () => {
    const l = lever('gate', {
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      gate: { stalled: true, consecutiveReds: 5, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
      changeInCandidate: { ...NO_CANDIDATE, judgingSha: 'inflight123456', judgingContainsPath: true },
    });
    expect(l).toBeNull();
  });

  it('…but an in-flight run that does NOT carry the change still routes to the containment lever', () => {
    const l = lever('gate', {
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      gate: { stalled: true, consecutiveReds: 5, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
      changeInCandidate: {
        ...NO_CANDIDATE,
        judgingSha: 'inflight123456',
        judgingContainsPath: false,
        missingReason: 'newer-commit',
      },
    });
    expect(l).toMatch(/quiet-cut/);
  });

  it('`main` never offers a lever — it advances only as a consequence of the gate', () => {
    expect(
      lever('main', {
        positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
        verdictProvenance: {
          lastGreenSha: 'g',
          lastGreenShortSha: 'g',
          lastGreenAgeMs: 1,
          mainFastForwarded: false,
          deployedBehindGreenPin: 0,
          deployOrigin: 'gate-green',
        },
      }),
    ).toBeNull();
  });

  it('the force-deploy lever appears ONLY once the change is in main', () => {
    // Offering it earlier would ship a sha that does not carry the change — which looks
    // like progress and is not.
    const notInMain = lever('deployed', {
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
    });
    expect(notInMain).toBeNull();

    const inMain = lever('deployed', {
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
    });
    expect(inMain).toMatch(/deploy-cli\.ts --execute/);
  });

  /**
   * EI-11120's shape: restarting a host whose source has NOT yet received the code
   * restarts it onto the SAME old bytes, which reads as "I did the thing and nothing
   * changed".
   */
  it('the restart lever appears ONLY once the code reached the host', () => {
    const STALE = { ...HEALTHY_SERVING, startedSinceCodeChange: false, behindMin: 30, restartLever: 'RESTART_ME' };
    const notDeployed = lever('serving', {
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: false },
      serving: STALE,
    });
    expect(notDeployed).toBeNull();

    const deployed = lever('serving', {
      positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
      serving: STALE,
    });
    expect(deployed).toBe('RESTART_ME');
  });
});

describe('P-005 ACCEPTANCE TEST — one call answers "is it live, and if not what is blocking it"', () => {
  const run = (over: {
    dirty?: boolean;
    contains?: Record<string, string[]>;
    servingStale?: boolean;
    deployedAtMs?: number;
  }) =>
    gitPipelinePosition(
      { path: 'apps/operator/app/x.ts' },
      {
        git: fakeGit({ pathCommit: 'abc1234567', subject: 'my fix', dirty: over.dirty, contains: over.contains ?? {} }),
        loadDeploy: async () => deploy(over.deployedAtMs ? { deployedAtMs: over.deployedAtMs } : {}),
        loadSnapshot: async () => snap(),
        resolveGateCandidates: async () => ({ judgingSha: null, nextCandidateSha: null }),
      },
    );

  it('uncommitted ⇒ blocked at COMMITTED, and the summary LEADS with the lever', async () => {
    const res = await run({ dirty: true, contains: { HEAD: ['abc1234567'] } });
    expect(res.blockedOn).toBe('committed');
    expect(res.nextAction).toMatch(/git-sync:run/);
    // Leading, not buried: this is the whole deliverable — the answer is the first thing read.
    expect(res.summary).toMatch(/^BLOCKED AT COMMITTED → /);
  });

  it('committed but not pushed ⇒ blocked at PUSHED, and says plainly there is nothing to do', async () => {
    const res = await run({ contains: { HEAD: ['abc1234567'] } });
    expect(res.blockedOn).toBe('pushed');
    expect(res.nextAction).toBeNull();
    expect(res.summary).toMatch(/^WAITING AT PUSHED \(nothing to do/);
  });

  it('pushed but not in main ⇒ blocked at GATE', async () => {
    const res = await run({ contains: { HEAD: ['abc1234567'], 'origin/staging': ['abc1234567'] } });
    expect(res.blockedOn).toBe('gate');
  });

  it('in main but not deployed ⇒ blocked at DEPLOYED, with the force-deploy lever', async () => {
    const res = await run({
      contains: { HEAD: ['abc1234567'], 'origin/staging': ['abc1234567'], 'origin/main': ['abc1234567'] },
    });
    expect(res.blockedOn).toBe('deployed');
    expect(res.nextAction).toMatch(/deploy-cli\.ts --execute/);
  });

  it('deployed but the process predates the code ⇒ blocked at SERVING, with the restart lever', async () => {
    // The 4x-filed class: every git tick is ✓ and the change is still NOT running.
    const res = await run({
      contains: {
        HEAD: ['abc1234567'],
        'origin/staging': ['abc1234567'],
        'origin/main': ['abc1234567'],
        deployedsha0: ['abc1234567'],
      },
      deployedAtMs: Date.now(), // deploy NOW; the mocked process started 60s ago ⇒ stale
    });
    expect(res.blockedOn).toBe('serving');
    expect(res.nextAction).toMatch(/deploy-cli\.ts --execute/);
    expect(res.summary).toMatch(/^BLOCKED AT SERVING → /);
  });

  it('fully live ⇒ null/null, and the summary carries no blocked/waiting lead at all', async () => {
    const res = await run({
      contains: {
        HEAD: ['abc1234567'],
        'origin/staging': ['abc1234567'],
        'origin/main': ['abc1234567'],
        deployedsha0: ['abc1234567'],
      },
    });
    expect(res.blockedOn).toBeNull();
    expect(res.nextAction).toBeNull();
    expect(res.summary).not.toMatch(/BLOCKED AT|WAITING AT/);
  });
});

/* ------------------------------------------------------------------------- *
 * P-006 — SWEEP EXPOSURE.
 *
 * The defect (EI-18735166063643844): an agent cannot commit atomically here, so a
 * multi-file change is GUARANTEED to expose a partial intermediate as a commit, and
 * the green-checkpoint can cut its candidate inside that window. Measured cost: 29
 * failures against a 14:09 candidate for work whose dependent fix landed at 14:36 —
 * all green at tip, and a peer spent a wake triaging them.
 *
 * What is pinned here is a DISTINCTION, not a warning: one dirty file cannot be cut
 * into a partial set, so warning there would be a false alarm that trains readers to
 * skim past the real one.
 * ------------------------------------------------------------------------- */
describe('sweep exposure (P-006)', () => {
  const NOW = 1_000_000_000_000;

  const stageInput = (sweep: SweepExposure): Parameters<typeof computeStages>[0] => ({
    dirtyUncommitted: true,
    positions: { committedLocal: true, onStaging: false, inMain: false, deployed: false },
    gate: { stalled: false, consecutiveReds: 0, lastGreenAtMs: 1, fireStale: false, fireStaleReason: null },
    verdictProvenance: {
      lastGreenSha: 'g',
      lastGreenShortSha: 'g',
      lastGreenAgeMs: 1,
      mainFastForwarded: true,
      deployedBehindGreenPin: 0,
      deployOrigin: 'gate-green',
    },
    gitSyncLastStatus: 'synced',
    gitSync: HEALTHY_GIT_SYNC,
    serving: HEALTHY_SERVING,
    changeInCandidate: NO_CANDIDATE,
    runtime: classifyRuntimeOwner('packages/operator-core/lib/x.ts'),
    sweepExposure: sweep,
  });

  it('a clean path is not exposed at all — and says nothing', () => {
    const s = evaluateSweepExposure({
      dirtyUncommitted: false,
      dirtyPaths: null,
      nextSweepAtMs: NOW + 60_000,
      nowMs: NOW,
    });
    expect(s.exposed).toBe(false);
    expect(s.detail).toBeNull();
    expect(s.dirtyPathCount).toBeNull();
  });

  it('ONE dirty path: exposed, but explicitly NOT a partial-set risk', () => {
    const s = evaluateSweepExposure({
      dirtyUncommitted: true,
      dirtyPaths: ['packages/operator-core/lib/x.ts'],
      nextSweepAtMs: NOW + 5 * 60_000,
      nowMs: NOW,
    });
    expect(s.exposed).toBe(true);
    expect(s.dirtyPathCount).toBe(1);
    expect(s.detail).toMatch(/cannot cut a partial set/);
    // The multi-file alarm must NOT fire here.
    expect(s.detail).not.toMatch(/SWEEP-EXPOSED/);
    expect(s.detail).toMatch(/~5 min/);
  });

  it('SEVERAL dirty paths: names the blast radius, the window, and that you cannot make it atomic', () => {
    const s = evaluateSweepExposure({
      dirtyUncommitted: true,
      dirtyPaths: ['a.ts', 'b.ts', 'c.ts'],
      nextSweepAtMs: NOW + 3 * 60_000,
      nowMs: NOW,
    });
    expect(s.exposed).toBe(true);
    expect(s.dirtyPathCount).toBe(3);
    expect(s.detail).toMatch(/SWEEP-EXPOSED/);
    expect(s.detail).toMatch(/all 3 dirty path/);
    expect(s.detail).toMatch(/a\.ts, b\.ts, c\.ts/);
    expect(s.detail).toMatch(/~3 min/);
    // The honest half: there is no lever that makes it atomic.
    expect(s.detail).toMatch(/cannot make this atomic/);
    // ...and the reason it matters: the gate can judge the intermediate.
    expect(s.detail).toMatch(/judge the intermediate/);
  });

  it('a large dirty set is sampled, not dumped — and the remainder is counted', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
    const s = evaluateSweepExposure({ dirtyUncommitted: true, dirtyPaths: paths, nextSweepAtMs: null, nowMs: NOW });
    expect(s.dirtyPathCount).toBe(20);
    expect(s.dirtyPathSample).toHaveLength(6);
    expect(s.detail).toMatch(/\+14 more/);
  });

  it('an OVERDUE tick clamps to zero — never a negative or a past-tense window', () => {
    const s = evaluateSweepExposure({
      dirtyUncommitted: true,
      dirtyPaths: ['a.ts', 'b.ts'],
      nextSweepAtMs: NOW - 10 * 60_000, // the scheduler is late
      nowMs: NOW,
    });
    expect(s.nextSweepInMs).toBe(0);
    expect(s.detail).toMatch(/within the next MINUTE/);
    // No negative window can render ("in ~-10 min"). Scoped to the rendered duration —
    // the detail legitimately carries a hyphenated issue id.
    expect(s.detail).not.toMatch(/~-\d+ min/);
  });

  it('carry note (2): an UNDEFINED next-fire renders as unknown, never "NaN min"', () => {
    // `nextFireAtMs` is parsed out of free-form routine state, so `undefined` reaches
    // here as easily as `null` — and `=== null` lets it straight through into the
    // arithmetic. This is the trap P-003 hit; pin it rather than re-learn it.
    const s = evaluateSweepExposure({
      dirtyUncommitted: true,
      dirtyPaths: ['a.ts', 'b.ts'],
      nextSweepAtMs: undefined as unknown as number | null,
      nowMs: NOW,
    });
    expect(s.nextSweepInMs).toBeNull();
    expect(s.detail).not.toMatch(/NaN/);
    expect(s.detail).toMatch(/at its next tick/);
  });

  it('parsePorcelainPaths takes the NEW path of a rename, and unquotes', () => {
    const out = [
      ' M packages/operator-core/lib/x.ts',
      '?? new-file.ts',
      'R  old/name.ts -> new/name.ts',
      ' M "path with space.ts"',
      'MM staged-and-modified.ts',
    ].join('\n');
    expect(parsePorcelainPaths(out)).toEqual([
      'packages/operator-core/lib/x.ts',
      'new-file.ts',
      'new/name.ts',
      'path with space.ts',
      'staged-and-modified.ts',
    ]);
  });

  it('REGRESSION (live probe): realGit TRIMS, so the first record loses its leading space', () => {
    // Found by dogfooding on the real repo, not by any fixture — fixtures never go
    // through realGit, which returns `stdout.trim()`. Every ` M path` record keeps its
    // leading space except the FIRST, whose space the trim ate. A column-slicing parser
    // therefore returned `ackages/operator-core/...` — a plausible path that is not the
    // file, corrupting the sample silently rather than failing.
    const trimmedFirstLine = ['M packages/operator-core/lib/a.ts', ' M packages/operator-core/lib/b.ts', ' M papercusp-desktop'].join(
      '\n',
    );
    expect(parsePorcelainPaths(trimmedFirstLine)).toEqual([
      'packages/operator-core/lib/a.ts',
      'packages/operator-core/lib/b.ts',
      'papercusp-desktop',
    ]);
  });

  it('a path whose first character is itself a status letter still parses', () => {
    // The backtracking case that makes the status-field match safe: `M Makefile` could
    // read as status "M " + path "akefile" if {1,2} were greedy without a fallback.
    expect(parsePorcelainPaths('M Makefile\n?? Dockerfile')).toEqual(['Makefile', 'Dockerfile']);
  });

  it('the committed-stage LEVER carries the blast radius when the sweep takes more than your file', () => {
    // `git-sync:run` told to an agent mid-refactor is an instruction to commit the
    // broken intermediate on purpose. The lever stays — it is right once the set is
    // done — but it must not read as "commits your file".
    const stages = computeStages(
      stageInput(
        evaluateSweepExposure({
          dirtyUncommitted: true,
          dirtyPaths: ['a.ts', 'b.ts', 'c.ts'],
          nextSweepAtMs: NOW + 60_000,
          nowMs: NOW,
        }),
      ),
    );
    const committed = stages.find((s) => s.name === 'committed')!;
    expect(committed.lever).toMatch(/git-sync:run/);
    expect(committed.lever).toMatch(/sweeps ALL 3 dirty paths/);
    expect(committed.lever).toMatch(/only fire it once the set is complete/);
    expect(committed.detail).toMatch(/SWEEP-EXPOSED/);
  });

  it('a SINGLE dirty path leaves the committed lever exactly as it was', () => {
    const stages = computeStages(
      stageInput(
        evaluateSweepExposure({
          dirtyUncommitted: true,
          dirtyPaths: ['x.ts'],
          nextSweepAtMs: NOW + 60_000,
          nowMs: NOW,
        }),
      ),
    );
    const committed = stages.find((s) => s.name === 'committed')!;
    expect(committed.lever).toBe('git-sync:run (commit the working tree — the gate cannot see it)');
  });

  it('end-to-end: a dirty path in a multi-file tree surfaces it in sweepExposure, notes AND the summary', async () => {
    const git = fakeGit({
      dirty: true,
      dirtyTree: [' M packages/operator-core/lib/a.ts', ' M packages/operator-core/lib/b.ts', '?? c.ts'].join('\n'),
      pathCommit: 'abc1234567',
      contains: { HEAD: ['abc1234567'], 'origin/staging': ['abc1234567'], 'origin/main': [], deployedsha0: [] },
    });
    const res = await gitPipelinePosition(
      { path: 'packages/operator-core/lib/a.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () =>
          ({
            ...snap(),
            routines: {
              gitSync: {
                name: 'git-sync',
                active: true,
                cron: null,
                lastFiredAtMs: null,
                nextFireAtMs: Date.now() + 4 * 60_000,
              },
            },
          }) as GitPipelineSnapshot,
        resolveGateCandidates: async () => ({ judgingSha: null, nextCandidateSha: null }),
      },
    );
    expect(res.sweepExposure.exposed).toBe(true);
    expect(res.sweepExposure.dirtyPathCount).toBe(3);
    expect(res.sweepExposure.nextSweepInMs).toBeGreaterThan(0);
    expect(res.notes.join(' ')).toMatch(/SWEEP-EXPOSED/);
    expect(res.summary).toMatch(/SWEEP-EXPOSED: the next git-sync tick \(~4 min\) commits all 3 dirty paths/);
  });

  it('end-to-end: a dirty path ALONE in the tree gets no sweep clause in the summary', async () => {
    const git = fakeGit({
      dirty: true,
      dirtyTree: ' M packages/operator-core/lib/a.ts',
      pathCommit: 'abc1234567',
      contains: { HEAD: ['abc1234567'], 'origin/staging': ['abc1234567'], 'origin/main': [], deployedsha0: [] },
    });
    const res = await gitPipelinePosition(
      { path: 'packages/operator-core/lib/a.ts' },
      {
        git,
        loadDeploy: async () => deploy(),
        loadSnapshot: async () => snap(),
        resolveGateCandidates: async () => ({ judgingSha: null, nextCandidateSha: null }),
      },
    );
    expect(res.sweepExposure.dirtyPathCount).toBe(1);
    expect(res.summary).toContain('⚠ +uncommitted edits');
    expect(res.summary).not.toMatch(/SWEEP-EXPOSED/);
  });

  it('a sha-only probe measures no exposure and pays for no status read at all', async () => {
    const seen: string[][] = [];
    const inner = fakeGit({ contains: { HEAD: ['abc1234567'] } });
    const git: GitRunner = async (repo, args) => {
      seen.push(args);
      return inner(repo, args);
    };
    const res = await gitPipelinePosition(
      { sha: 'abc1234567' },
      { git, loadDeploy: async () => deploy(), loadSnapshot: async () => snap() },
    );
    expect(res.sweepExposure.exposed).toBe(false);
    expect(seen.some((a) => a[0] === 'status')).toBe(false);
  });
});
