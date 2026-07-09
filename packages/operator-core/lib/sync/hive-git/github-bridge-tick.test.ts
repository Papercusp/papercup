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

import { runGithubBridgeTick, BRIDGE_REMOTE_STAGING_REF, type BridgeTickInput } from './github-bridge-tick';
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

  it('no fork + no upstream write → egress skipped, ingress still runs', async () => {
    const { input, egressCalls } = bridgeInput({ upstreamWrite: null });
    const out = await runGithubBridgeTick(input);
    expect(out.egressTarget).toBe('skipped');
    expect(out.egress).toBeNull();
    expect(egressCalls).toHaveLength(0);
    expect(out.ingressed.upToDate).toBe(1);
  });

  it('no canonical staging yet → egress skipped (nothing canonical to publish)', async () => {
    const { input, egressCalls } = bridgeInput({}, { runGit: async () => ({ code: 1, stdout: '', stderr: '' }) });
    const out = await runGithubBridgeTick(input);
    expect(out.egress).toBeNull();
    expect(egressCalls).toHaveLength(0);
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
