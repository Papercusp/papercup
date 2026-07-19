/**
 * github-bridge-tick (github-bridge-hive-egress P-008) — the composed bridge
 * pass with every mechanism seam injected (unit-hermetic: no git, no PG, no
 * network). The mechanisms themselves are covered by their own suites
 * (P-001/P-002/P-005/P-006); this proves the COMPOSITION contract.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => {
    throw new Error('getOrgPg must not be reached — inject seams in tests');
  },
}));

import { runGithubBridgeTick, BRIDGE_REMOTE_STAGING_REF, BRIDGE_CANONICAL_REF, type BridgeTickInput } from './github-bridge-tick';
import type { IngressResult } from './github-ingress';
import type { AdmissionResult } from './github-ingress-admission';
import type { EgressResult } from './github-egress';
import type { DivergenceVerdict } from './github-divergence';

const CANONICAL = 'c'.repeat(40);
const HEAD_A = 'a'.repeat(40);

const cleanIngress = (over: Partial<IngressResult> = {}): IngressResult => ({
  ok: true,
  namespaceKey: 'ns',
  updated: [],
  upToDate: ['main'],
  nonFF: [],
  absent: [],
  errors: [],
  ...over,
});

const admitClean = (): AdmissionResult => ({
  admit: true,
  basis: 'clean',
  blockedAuthors: [],
  unknownAuthors: [],
  checkedAuthorIds: [],
  errors: [],
});

const cleanEgress = (over: Partial<EgressResult> = {}): EgressResult => ({
  ok: true,
  pushed: [{ remoteRef: BRIDGE_REMOTE_STAGING_REF, from: null, to: CANONICAL }],
  upToDate: [],
  rejectedNonFF: [],
  blockedSecrets: [],
  tagsPushed: [],
  tagsRejected: [],
  errors: [],
  ...over,
});

/** Base input: canonical ref resolvable, all seams injected + captured. */
function bridgeInput(over: Partial<BridgeTickInput> = {}, seams: Partial<NonNullable<BridgeTickInput['deps']>> = {}) {
  const recorded: DivergenceVerdict[] = [];
  const egressCalls: unknown[] = [];
  const input: BridgeTickInput = {
    potHomeSlug: 'shop-hive',
    workspaceId: 'ws',
    repoKey: 'shop',
    githubRemote: 'https://github.com/acme/shop.git',
    branches: ['main'],
    upstreamWrite: true,
    lastAdmitted: null,
    deps: {
      repoPath: '/tmp/fake-bare.git',
      runGit: async (args) =>
        args[0] === 'rev-parse' ? { code: 0, stdout: `${CANONICAL}\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' },
      ingress: async () => cleanIngress(),
      admit: async () => admitClean(),
      egress: async (i) => (egressCalls.push(i), cleanEgress()),
      record: async (_h, _w, v) => void recorded.push(v),
      ...seams,
    },
    ...over,
  };
  return { input, recorded, egressCalls };
}

describe('runGithubBridgeTick — an unreachable remote must not read green', () => {
  // The oddsmith regression (2026-07-19): the bare store resolved a different
  // git credential than the clone, so ingress hit `Repository not found` on
  // every tick. Every structured residue was empty BECAUSE nothing was
  // fetched, so the tick classified `clear` while the bridge was inert and
  // origin was frozen.
  it('ingress that reaches NOTHING and only errors → escalate + needsOwner (not clear)', async () => {
    const { input, recorded } = bridgeInput(
      {},
      {
        ingress: async () =>
          cleanIngress({
            ok: false,
            upToDate: [],
            errors: [{ branch: 'main', message: 'remote: Repository not found.' }],
          }),
      },
    );
    const out = await runGithubBridgeTick(input);
    expect(out.verdict.action).toBe('escalate');
    expect(out.verdict.needsOwner).toBe(true);
    expect(out.verdict.signals.map((s) => s.kind)).toContain('bridge-remote-unreachable');
    expect(recorded.at(-1)?.action).toBe('escalate');
  });

  it('a per-branch error alongside a branch that DID resolve is not "unreachable"', async () => {
    const { input } = bridgeInput(
      {},
      {
        ingress: async () =>
          cleanIngress({ errors: [{ branch: 'gone', message: "couldn't find remote ref gone" }] }),
      },
    );
    const out = await runGithubBridgeTick(input);
    expect(out.verdict.signals.map((s) => s.kind)).not.toContain('bridge-remote-unreachable');
  });
});

describe('runGithubBridgeTick — composition', () => {
  it('clean pass: ingress → egress canonical staging to the resolved target → clear verdict', async () => {
    const { input, recorded, egressCalls } = bridgeInput();
    const out = await runGithubBridgeTick(input);
    expect(out.ran).toBe(true);
    expect(out.egressTarget).toBe('upstream');
    expect(out.egress).toMatchObject({ pushed: 1, rejectedNonFF: 0 });
    expect((egressCalls[0] as { refs: Array<{ sha: string; remoteRef: string }> }).refs).toEqual([
      { sha: CANONICAL, remoteRef: BRIDGE_REMOTE_STAGING_REF },
    ]);
    expect(out.verdict.action).toBe('clear');
    expect(recorded).toHaveLength(1); // clean pass still records (clears) the escalation
  });

  it('fork wins over upstream write (D-007b preserved)', async () => {
    const { input, egressCalls } = bridgeInput({ forkRemote: 'https://github.com/me/shop.git' });
    const out = await runGithubBridgeTick(input);
    expect(out.egressTarget).toBe('fork');
    expect((egressCalls[0] as { remoteUrl: string }).remoteUrl).toBe('https://github.com/me/shop.git');
  });

  it('no fork + GitHub AFFIRMATIVELY refused write → egress skipped, ingress still runs', async () => {
    const { input, egressCalls } = bridgeInput({ upstreamWrite: false });
    const out = await runGithubBridgeTick(input);
    expect(out.egressTarget).toBe('skipped');
    expect(out.egress).toBeNull();
    expect(egressCalls).toHaveLength(0);
    expect(out.ingressed.upToDate).toBe(1);
  });

  it('no fork + UNKNOWN upstream write → still egresses (probe and transport are different credential planes)', async () => {
    const { input, egressCalls } = bridgeInput({ upstreamWrite: null });
    const out = await runGithubBridgeTick(input);
    expect(out.egressTarget).toBe('upstream');
    expect(egressCalls).toHaveLength(1);
  });

  it('no canonical staging yet → egress skipped, and the pass ESCALATES rather than reading clear', async () => {
    // Regression (hello-world-3-pot canary, 2026-07-18): a live egress target
    // with an unestablished canonical ref used to be indistinguishable from a
    // healthy no-op — `egress: null` + verdict 'clear' every tick — so GitHub
    // origin silently froze 8 commits / ~22h behind while the bridge reported
    // green. Nothing may be pushed without a canonical, but it MUST be loud.
    const { input, recorded, egressCalls } = bridgeInput({}, { runGit: async () => ({ code: 1, stdout: '', stderr: '' }) });
    const out = await runGithubBridgeTick(input);
    expect(out.egress).toBeNull();
    expect(egressCalls).toHaveLength(0); // still never pushes a canonical it cannot read
    expect(out.verdict.action).toBe('escalate');
    expect(out.verdict.signals).toEqual([
      { kind: 'egress-canonical-missing', canonicalRef: BRIDGE_CANONICAL_REF, watermarkSha: null },
    ]);
    // Not an owner lever — the integrator's next publish (or the catch-up pin) clears it.
    expect(out.verdict.needsOwner).toBe(false);
    expect(out.verdict.detail).toMatch(/canonical ref absent/i);
    expect(out.errors.some((e) => e.includes(BRIDGE_CANONICAL_REF))).toBe(true);
    expect(recorded).toHaveLength(1);
  });

  it('canonical missing is NOT signalled when there is no egress target at all (nothing to freeze)', async () => {
    const { input } = bridgeInput({ upstreamWrite: false }, { runGit: async () => ({ code: 1, stdout: '', stderr: '' }) });
    const out = await runGithubBridgeTick(input);
    expect(out.egressTarget).toBe('skipped');
    expect(out.verdict.action).toBe('clear');
  });

  it('no github remote at all → skipped pass, watermark untouched', async () => {
    const { input } = bridgeInput({ githubRemote: undefined, lastAdmitted: HEAD_A });
    const out = await runGithubBridgeTick(input);
    expect(out).toMatchObject({ ran: false, skipped: 'no_github_remote', lastAdmitted: HEAD_A });
  });

  it('admitted ingressed head advances the watermark; blocked head does NOT and escalates needs_owner', async () => {
    const updated = [{ branch: 'main', from: null, to: HEAD_A, forced: false }];
    // admitted:
    let { input } = bridgeInput({}, { ingress: async () => cleanIngress({ updated, upToDate: [] }) });
    let out = await runGithubBridgeTick(input);
    expect(out.lastAdmitted).toBe(HEAD_A);
    expect(out.admissions).toEqual([{ head: HEAD_A, admit: true, basis: 'clean' }]);
    // blocked:
    ({ input } = bridgeInput(
      {},
      {
        ingress: async () => cleanIngress({ updated, upToDate: [] }),
        admit: async () => ({ ...admitClean(), admit: false, basis: 'blocked', blockedAuthors: [{ githubUserId: 7, commits: [HEAD_A] }] }),
      },
    ));
    out = await runGithubBridgeTick(input);
    expect(out.lastAdmitted).toBeNull();
    expect(out.verdict.action).toBe('escalate');
    expect(out.verdict.needsOwner).toBe(true);
  });

  it('egress rejectedNonFF + ingress nonFF fold into the recorded divergence verdict', async () => {
    const { input, recorded } = bridgeInput(
      {},
      {
        ingress: async () => cleanIngress({ nonFF: [{ branch: 'main', local: 'l'.repeat(40), remote: 'r'.repeat(40) }], upToDate: [] }),
        egress: async () =>
          cleanEgress({ pushed: [], rejectedNonFF: [{ remoteRef: BRIDGE_REMOTE_STAGING_REF, remoteSha: 'x'.repeat(40), localSha: CANONICAL, reason: 'diverged' }] }),
      },
    );
    const out = await runGithubBridgeTick(input);
    expect(out.verdict.action).toBe('escalate');
    expect(out.verdict.needsOwner).toBe(true); // the ingress rewrite is the owner lever
    expect(recorded[0].signals.map((s) => s.kind).sort()).toEqual(['egress-non-ff', 'ingress-non-ff']);
  });

  it('isBridgeWriter=false skips the pass (D-002 affinity seam)', async () => {
    const { input } = bridgeInput({}, { isBridgeWriter: async () => false });
    const out = await runGithubBridgeTick(input);
    expect(out).toMatchObject({ ran: false, skipped: 'not_bridge_writer' });
  });
});
