import { describe, it, expect } from 'vitest';
import {
  classifyImprovement,
  partitionByTier,
  matchGlob,
  infraEnvironmentHit,
  DEFAULT_RISK_TIER_POLICY,
  type ImprovementCandidate,
  type RiskTierPolicy,
} from './policy';

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return { kind: 'change', scope: 'operator', title: 'a thing', ...p };
}

describe('matchGlob', () => {
  it('matches single-segment * within a path segment', () => {
    expect(matchGlob('libs/flags/*', 'libs/flags/types.ts')).toBe(true);
    expect(matchGlob('libs/flags/*', 'libs/flags/sub/types.ts')).toBe(false);
  });
  it('matches ** across segments', () => {
    expect(matchGlob('libs/flags/**', 'libs/flags/sub/deep/types.ts')).toBe(true);
    expect(matchGlob('**/auth/**', 'apps/operator/lib/auth/login.ts')).toBe(true);
  });
  it('does not match a different prefix', () => {
    expect(matchGlob('packages/operator-core/lib/release/**', 'packages/operator-core/lib/foo.ts')).toBe(false);
  });
  it('treats regex specials literally', () => {
    expect(matchGlob('libs/a.b/**', 'libs/a.b/x.ts')).toBe(true);
    expect(matchGlob('libs/a.b/**', 'libs/axb/x.ts')).toBe(false);
  });
});

describe('classifyImprovement — kind gate (D-004)', () => {
  it('AUTO for kind=bug with nothing protected', () => {
    const d = classifyImprovement(cand({ id: '1', kind: 'bug', title: 'list overflows' }));
    expect(d.tier).toBe('auto');
  });
  it('HUMAN for kind=change (not in default autoKinds)', () => {
    const d = classifyImprovement(cand({ id: '2', kind: 'change' }));
    expect(d.tier).toBe('human');
    expect(d.reasons.join(' ')).toMatch(/not auto-eligible/);
  });
  it('HUMAN for kind=feature', () => {
    expect(classifyImprovement(cand({ id: '3', kind: 'feature' })).tier).toBe('human');
  });
  it('HUMAN for kind=chunk', () => {
    expect(classifyImprovement(cand({ id: '4', kind: 'chunk' })).tier).toBe('human');
  });
});

describe('classifyImprovement — protected paths force human even for a bug', () => {
  const protectedCases: Array<[string, string]> = [
    ['release machinery', 'packages/operator-core/lib/release/deploy.ts'],
    ['routines engine', 'packages/operator-core/lib/harness/routines/system-actions.ts'],
    ['dbos engine', 'packages/operator-core/lib/dbos/routines-workflow.ts'],
    ['git-sync', 'packages/operator-core/lib/git-sync/git-sync-action.ts'],
    ['migrations', 'libs/papercusp/libs/db/sql/140-something.sql'],
    ['flags', 'libs/flags/src/types.ts'],
    ['the loop itself', 'packages/operator-core/lib/harness/improvements/policy.ts'],
  ];
  it.each(protectedCases)('bug touching %s → human', (_label, path) => {
    const d = classifyImprovement(cand({ id: 'p', kind: 'bug', paths: [path] }));
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toBeTruthy();
  });
  it('bug touching an ordinary path stays AUTO', () => {
    const d = classifyImprovement(cand({ id: 'ok', kind: 'bug', paths: ['packages/operator-core/lib/issues-engineer.ts'] }));
    expect(d.tier).toBe('auto');
  });
});

describe('classifyImprovement — protected keywords (pre-paths proxy)', () => {
  it('bug whose title mentions a migration → human', () => {
    const d = classifyImprovement(cand({ id: 'k1', kind: 'bug', title: 'migration 131 collision dark table' }));
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toBe('migration');
  });
  it('bug mentioning auth/security in the body → human', () => {
    const d = classifyImprovement(cand({ id: 'k2', kind: 'bug', title: 'token refresh', body: 'the credential rotates' }));
    expect(d.tier).toBe('human');
  });
  it('plain bug with no protected keyword → auto', () => {
    const d = classifyImprovement(cand({ id: 'k3', kind: 'bug', title: 'presence list dumps 233 stale rows' }));
    expect(d.tier).toBe('auto');
  });
});

describe('classifyImprovement — keyword match is WORD-anchored, not substring (EI-19485505354981364)', () => {
  // The gate was `hay.includes(kw)`. A hit sets payload.needsHuman, which is claim floor #6 —
  // the item goes INVISIBLE to every queue rather than failing loudly. Measured on
  // papercusp-workspace 2026-08-10: 109 items gated on "auth", only 13 of which say "auth";
  // the other 96 said "author"/"authoritative"/"authority". One was a critical hidden 18 days.
  //
  // BOTH halves are required. Without the negative cases the bug is back; without the positive
  // cases a narrowing could silently disarm the safety gate entirely — which is the worse
  // failure, since these keywords are the pre-paths proxy for the TCB surfaces.

  const tierFor = (title: string, body?: string) =>
    classifyImprovement(cand({ id: 'kw', kind: 'bug', title, body }));

  const falsePositives: [string, string][] = [
    ['authoritative', 'the most authoritative thing in the tree is wrong'],
    ['author', 'so the next author does not reach for it'],
    ['authority', 'completionAuthority is not set on the row'],
    ['authored', 'the remote-authored row cannot be completed here'],
    ['author_pubkey', 'unbounded read of author_pubkey in the event log'],
    ['cueAuthority', 'coord:send stamps cueAuthority.scope=fleet-members'],
    ['urls (vs the `rls` keyword)', 'the plan claims P-002 raises loud urls in the store'],
    ['urlsearchparams (vs `rls`)', 'empty --client value breaks urlsearchparams parsing'],
  ];
  it.each(falsePositives)('%s does NOT trip the gate', (_label, text) => {
    expect(tierFor(text).tier).toBe('auto');
  });

  const truePositives: [string, string][] = [
    ['auth as a bare word', 'the auth perimeter rejects the token'],
    ['auth with punctuation', 'papercusp_auth: the gym fixture cannot log in'],
    ['oauth', 'the oauth attestation fails after peer_connect'],
    ['authentication', 'authentication regressed for federated peers'],
    ['authorization', 'authorization header is dropped by the proxy'],
    ['security', 'a security hole in the capability envelope'],
    ['credential', 'the credential rotates before the refresh lands'],
    ['rls as a bare word', 'rls policies are missing on the new table'],
  ];
  it.each(truePositives)('%s DOES trip the gate', (_label, text) => {
    expect(tierFor(text).tier).toBe('human');
  });

  // The reason a bare \b...\b anchor (the originally-proposed fix) is NOT what landed: it would
  // have stopped these from matching, converting a false-positive bug into false NEGATIVES on
  // the safety gate. Measured: `deploy` covers 65 gated items, `migration` 32.
  const inflections: [string, string][] = [
    ['deployment', 'the deployment step leaves the release inconsistent'],
    ['deployed', 'nothing was deployed after the green checkpoint'],
    ['undeployed', 'fleet:capacity miscounts undeployed members'],
    ['redeploy', 'we redeploy on every red gate'],
    ['migrations', 'two migrations race for the same number'],
    ['deploys', 'the routine deploys the wrong sha'],
  ];
  it.each(inflections)('%s still trips the gate (no false negatives)', (_label, text) => {
    expect(tierFor(text).tier).toBe('human');
  });

  it('a caller-supplied keyword containing regex metacharacters is escaped, not executed', () => {
    // protectedKeywordAdditions is caller-supplied via improvements:set-auto-policy — an
    // unescaped metachar would either throw at RegExp construction or silently widen the gate.
    const policy = { ...DEFAULT_RISK_TIER_POLICY, protectedKeywords: ['c++ (unsafe)'] };
    expect(() => classifyImprovement(cand({ id: 'rx', kind: 'bug', title: 'anything' }), policy)).not.toThrow();
    expect(classifyImprovement(cand({ id: 'rx1', kind: 'bug', title: 'uses c++ (unsafe) casts' }), policy).tier)
      .toBe('human');
    expect(classifyImprovement(cand({ id: 'rx2', kind: 'bug', title: 'cxx unsafe casts' }), policy).tier)
      .toBe('auto');
  });
});

describe('classifyImprovement — declared clean paths outrank the prose keyword proxy (EI-16013)', () => {
  // The keyword scan is the PRE-PATHS PROXY (see the describe block above): a stand-in for the
  // path check used when we do not know which files an item touches. Once paths ARE declared and
  // none is protected, the proxy is answering a question we now have the structured answer to.
  //
  // Filing case EI-11109: a sandbox seccomp `listen` syscall denial, gated to human-only because
  // its body listed "migration helpers" among affected script types. Measured 2026-09-05: 27 of
  // the 35 items gated on "migration" had declared a non-empty, entirely-unprotected path set.
  //
  // BOTH halves are required here for the same reason the block above states — without the
  // preserved-gate cases a narrowing could silently disarm the TCB proxy, which is the worse
  // failure. These four cases pin each of the three properties the narrowing must not break.

  const migrationProse = 'the sandbox denies the listen syscall; affects migration helpers and lint scripts';

  it('PRESERVED: no declared paths → the keyword proxy still gates (the proxy fires)', () => {
    const d = classifyImprovement(cand({ id: 'e1', kind: 'bug', title: 'seccomp denial', body: migrationProse }));
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toBe('migration');
  });

  it('FIXED: declared paths, none protected → prose mention no longer gates (the proxy yields)', () => {
    const d = classifyImprovement(
      cand({
        id: 'e2',
        kind: 'bug',
        title: 'seccomp denial',
        body: migrationProse,
        paths: ['packages/operator-core/lib/agent-tools'],
      }),
    );
    expect(d.tier).toBe('auto');
    expect(d.protectedHit).toBeUndefined();
    expect(d.reasons.some((r) => r.includes('keyword proxy skipped'))).toBe(true);
  });

  it('PRESERVED: a declared path that IS protected still gates, whatever the prose says', () => {
    const d = classifyImprovement(
      cand({ id: 'e3', kind: 'bug', title: 'benign title', body: 'nothing notable here', paths: ['libs/flags/types.ts'] }),
    );
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toBe('libs/flags/**');
  });

  it('PRESERVED: a real migration that declares its migration path is still gated by the PATH rule', () => {
    // The property that makes the narrowing safe for the filing keyword: an item genuinely
    // touching a migration is caught by `libs/papercusp/libs/db/sql/**` before the proxy runs.
    const d = classifyImprovement(
      cand({ id: 'e4', kind: 'bug', title: 'two rows collide', paths: ['libs/papercusp/libs/db/sql/731-thing.sql'] }),
    );
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toBe('libs/papercusp/libs/db/sql/**');
  });
});

describe('classifyImprovement — OWNER FULL-AUTONOMY grant lifts the protected-path/keyword TCB (Phase 2)', () => {
  const ON = { ownerFullAutonomy: true };
  // A bug touching the deploy gate / flags / capability dispatch / migrations / the
  // loop's own code: HUMAN by default (the TCB bar), AUTO once the owner grants full
  // autonomy — both directions pinned (reversibility is the safety net).
  const tcbBug = (paths: string[]) => cand({ id: 'fa', kind: 'bug', title: 'fix it', paths });
  it('protected PATH bug → human OFF, auto ON', () => {
    const bug = tcbBug(['packages/operator-core/lib/release/deploy.ts']);
    expect(classifyImprovement(bug).tier).toBe('human');
    const on = classifyImprovement(bug, DEFAULT_RISK_TIER_POLICY, ON);
    expect(on.tier).toBe('auto');
    expect(on.reasons.join(' ')).toMatch(/full-autonomy grant/);
  });
  it('flags / capability-TCB / migration paths all flip to auto under the grant', () => {
    for (const p of [
      'libs/flags/src/types.ts',
      'libs/papercusp/libs/db/sql/140-x.sql',
      'packages/operator-core/lib/harness/improvements/policy.ts',
    ]) {
      expect(classifyImprovement(tcbBug([p])).tier).toBe('human');
      expect(classifyImprovement(tcbBug([p]), DEFAULT_RISK_TIER_POLICY, ON).tier).toBe('auto');
    }
  });
  it('protected KEYWORD bug → human OFF, auto ON', () => {
    const bug = cand({ id: 'fk', kind: 'bug', title: 'migration 131 collision' });
    expect(classifyImprovement(bug).tier).toBe('human');
    expect(classifyImprovement(bug, DEFAULT_RISK_TIER_POLICY, ON).tier).toBe('auto');
  });
  it('the grant does NOT lift the kind gate (autoKinds is a separate dial)', () => {
    // kind=change is still not auto-eligible — the grant lifts the protected TCB, not autoKinds.
    expect(classifyImprovement(cand({ id: 'fck', kind: 'change' }), DEFAULT_RISK_TIER_POLICY, ON).tier).toBe('human');
  });
  it('the grant does NOT lift needs-human routing', () => {
    expect(
      classifyImprovement(cand({ id: 'fnh', kind: 'bug', needsHuman: true }), DEFAULT_RISK_TIER_POLICY, ON).tier,
    ).toBe('human');
  });
  it('the grant does NOT auto-dispatch infra-environment (a worker still cannot fix a down service)', () => {
    const infra = cand({ id: 'fi', kind: 'bug', title: 'shop down', watchdogKey: 'service-down:shop' });
    expect(classifyImprovement(infra, DEFAULT_RISK_TIER_POLICY, ON).tier).toBe('human');
  });
  it('partitionByTier threads the grant — a protected-path bug lands in the auto lane', () => {
    const items = [tcbBug(['libs/flags/src/types.ts'])];
    expect(partitionByTier(items).auto).toHaveLength(0);
    expect(partitionByTier(items, DEFAULT_RISK_TIER_POLICY, { ownerFullAutonomy: true }).auto).toHaveLength(1);
  });
});

describe('classifyImprovement — infra-environment never auto (EI-408 / D-002 / D-005)', () => {
  it('infra kind=bug via watchdog signal class → human (EI-187 service-down shape)', () => {
    const d = classifyImprovement(cand({ id: 'i1', kind: 'bug', title: 'Service shop is down', watchdogKey: 'service-down:shop' }));
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toMatch(/service-down/);
    expect(d.reasons.join(' ')).toMatch(/infra-environment/);
  });
  it('infra kind=bug via an environment path → human (.service file)', () => {
    const d = classifyImprovement(cand({ id: 'i2', kind: 'bug', title: 'restart loop', paths: ['deploy/papercup-staging-api.service'] }));
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toMatch(/\.service/);
  });
  it('fire-circuit-open + migration-drift signal classes are infra too', () => {
    expect(classifyImprovement(cand({ id: 'i3', kind: 'bug', title: 'gym backoff', watchdogKey: 'fire-circuit-open:gym' })).tier).toBe('human');
    expect(classifyImprovement(cand({ id: 'i4', kind: 'bug', title: 'drift', watchdogKey: 'migration-drift:live' })).tier).toBe('human');
    // P-010: the external rate-limit class is infra too → never auto (a worker can't fix a provider quota).
    expect(classifyImprovement(cand({ id: 'i5', kind: 'bug', title: 'embed 429', watchdogKey: 'repeated-tool-error:memory:search:rate-limit' })).tier).toBe('human');
    expect(infraEnvironmentHit({ watchdogKey: 'repeated-tool-error:memory:search:rate-limit' })).toMatch(/rate-limit/);
  });
  it('stalled-feature signal class is infra too (EI-805: the fix is the dispatch/scheduler machinery, never an inline code change)', () => {
    const d = classifyImprovement(
      cand({ id: 'i7', kind: 'bug', title: 'Dispatchable work in harness hive-canary is not being picked up', watchdogKey: 'stalled-feature:stalled:hive-canary' }),
    );
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toMatch(/stalled-feature/);
    expect(infraEnvironmentHit({ watchdogKey: 'stalled-feature:stalled:some-harness' })).toMatch(/stalled-feature/);
  });
  it('the HOST-WIDE admission outage takes the same infra lane (EI-21322935352272541 — its key has no :<harness> segment, so the anchored peer-federation-silence match cannot see it)', () => {
    // Same announce/admission-path condition as its per-scope sibling above, so
    // the same owner-escalate lane. It is NOT harness-scoped (the whole point:
    // one host-wide fact, one dedup bucket), which is exactly why the sibling's
    // `/^shared-hive:peer-federation-silence:/` match misses it. Left unmatched,
    // D-005 defaults it to code-bug -> tier=auto and the watchdog re-dispatches
    // an auto-implement attempt every tick at a root cause no worker can fix —
    // the precise regression EI-20983096990125721 was filed for.
    const key = 'shared-hive:host-admits-no-remote-logs';
    expect(infraEnvironmentHit({ watchdogKey: key })).toMatch(/host-wide admission outage/);
    const d = classifyImprovement(
      cand({
        id: 'i8b',
        kind: 'bug',
        title: 'shared-hive invariant: this host admits NO remote log in ANY booted scope',
        watchdogKey: key,
      }),
    );
    expect(d.tier).toBe('human');
    expect(d.tier).not.toBe('auto');
    // FALSIFIABILITY: the sibling's anchored pattern genuinely does not cover it,
    // so this branch is load-bearing rather than belt-and-braces.
    expect(/^shared-hive:peer-federation-silence:/.test(key)).toBe(false);
  });
  it('shared-hive peer-federation-silence is infra too (EI-20983096990125721: peer liveness/announce, not code — sibling shared-hive kinds like double-completion stay code-bug)', () => {
    const d = classifyImprovement(
      cand({
        id: 'i8',
        kind: 'bug',
        title: 'shared-hive invariant: peer federation silence in papercusp',
        watchdogKey: 'shared-hive:peer-federation-silence:papercusp',
      }),
    );
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toMatch(/peer federation silence/);
    expect(infraEnvironmentHit({ watchdogKey: 'shared-hive:peer-federation-silence:some-harness' })).toMatch(
      /peer federation silence/,
    );
    // A SIBLING shared-hive incident kind (same "shared-hive" source segment) is a
    // genuine, code-fixable defect class and must stay auto-eligible.
    expect(infraEnvironmentHit({ watchdogKey: 'shared-hive:double-completion:papercusp' })).toBeNull();
    expect(
      classifyImprovement(
        cand({ id: 'i9', kind: 'bug', title: 'shared-hive invariant: cross-swarm double completion', watchdogKey: 'shared-hive:double-completion:papercusp' }),
      ).tier,
    ).toBe('auto');
  });
  it('infra beats graduation — even with every kind graduated, an infra item stays human', () => {
    const graduated: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: ['bug', 'change', 'feature'] };
    const d = classifyImprovement(cand({ id: 'i5', kind: 'bug', watchdogKey: 'service-down:openai' }), graduated);
    expect(d.tier).toBe('human');
  });
  it('a non-infra signal class (red-test) does NOT trip the infra gate', () => {
    const d = classifyImprovement(cand({ id: 'i6', kind: 'bug', title: 'red e2e', watchdogKey: 'red-test:apps/operator/e2e/foo' }));
    expect(d.tier).toBe('auto');
  });
  it('infraEnvironmentHit: signal class > path > null', () => {
    expect(infraEnvironmentHit({ watchdogKey: 'service-down:shop' })).toMatch(/service-down/);
    expect(infraEnvironmentHit({ paths: ['ops/docker-compose.dev.yml'] })).toMatch(/docker-compose/);
    expect(infraEnvironmentHit({ watchdogKey: 'red-test:e2e', paths: ['packages/operator-core/lib/x.ts'] })).toBeNull();
    expect(infraEnvironmentHit({})).toBeNull();
  });
});

describe('needs-human routing (close-loop D-001 — the resolve back-edge)', () => {
  it('needsHuman forces the human tier even for a plain auto-eligible bug', () => {
    const d = classifyImprovement(cand({ id: 'nh1', kind: 'bug', title: 'plain bug', needsHuman: true }));
    expect(d.tier).toBe('human');
    expect(d.reasons[0]).toMatch(/legacy needsHuman/);
  });
  it('needsHuman beats even a graduated policy', () => {
    const graduated: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: ['bug', 'change', 'feature'] };
    expect(classifyImprovement(cand({ id: 'nh2', kind: 'bug', needsHuman: true }), graduated).tier).toBe('human');
  });
  it('needsOwnerAction is a distinct strict owner-capability route', () => {
    const d = classifyImprovement(cand({ id: 'oa1', kind: 'bug', needsOwnerAction: true }));
    expect(d.tier).toBe('human');
    expect(d.reasons[0]).toMatch(/strict owner action/);
  });
});

describe('an item already triaged gate/reject never re-enters the auto lane (EI-815)', () => {
  it("triageDecision='gate' forces human even for a plain auto-eligible bug with no watchdogKey/paths", () => {
    const d = classifyImprovement(
      cand({
        id: 'gt1',
        kind: 'bug',
        title: 'Latitude VM creates platform-broken environment, unreachable on all ports',
        ideaLifecycle: { state: 'triaged', ideaType: 'infra-environment', triageDecision: 'gate' } as any,
      }),
    );
    expect(d.tier).toBe('human');
    expect(d.reasons.join(' ')).toMatch(/already triaged 'gate'/);
    expect(d.protectedHit).toBe('triageDecision:gate');
  });

  it("triageDecision='reject' also forces human", () => {
    const d = classifyImprovement(
      cand({ id: 'gt2', kind: 'bug', ideaLifecycle: { state: 'triaged', triageDecision: 'reject' } as any }),
    );
    expect(d.tier).toBe('human');
    expect(d.protectedHit).toBe('triageDecision:reject');
  });

  it("beats even a graduated policy (an explicit routing decision, not a kind dial)", () => {
    const graduated: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: ['bug', 'change', 'feature'] };
    const d = classifyImprovement(
      cand({ id: 'gt3', kind: 'bug', ideaLifecycle: { state: 'triaged', triageDecision: 'gate' } as any }),
      graduated,
    );
    expect(d.tier).toBe('human');
  });

  it("triageDecision='place' (or absent) is unaffected — stays auto-eligible on its own merits", () => {
    expect(
      classifyImprovement(
        cand({ id: 'gt4', kind: 'bug', ideaLifecycle: { state: 'triaged', triageDecision: 'place' } as any }),
      ).tier,
    ).toBe('auto');
    expect(classifyImprovement(cand({ id: 'gt5', kind: 'bug' })).tier).toBe('auto');
  });
});

describe('replication-liveness detector EIs never reach the auto lane (EI-8455)', () => {
  it('createdBy=system:replication-liveness forces human even for an auto-eligible kind=bug', () => {
    const d = classifyImprovement(
      cand({ id: 'rl1', kind: 'bug', title: 'connected_never_replicated', createdBy: 'system:replication-liveness' }),
    );
    expect(d.tier).toBe('human');
    expect(d.reasons.join(' ')).toMatch(/replication-liveness detector/);
    expect(d.protectedHit).toBe('system:replication-liveness');
  });

  it('is NOT lifted by the owner full-autonomy grant (a wrong-tool bar, not a safety bar)', () => {
    const d = classifyImprovement(
      cand({ id: 'rl2', kind: 'bug', createdBy: 'system:replication-liveness' }),
      DEFAULT_RISK_TIER_POLICY,
      { ownerFullAutonomy: true },
    );
    expect(d.tier).toBe('human');
  });

  it('a plain bug from a different createdBy is unaffected (still auto)', () => {
    expect(classifyImprovement(cand({ id: 'rl3', kind: 'bug', createdBy: 'some-other-filer' })).tier).toBe('auto');
  });
});

describe('remote-authored (federated) rows never reach the auto lane (EI-15659)', () => {
  it('workItemOrigin=remote forces human even for an auto-eligible kind=bug', () => {
    const d = classifyImprovement(cand({ id: 'ro1', kind: 'bug', workItemOrigin: 'remote' }));
    expect(d.tier).toBe('human');
    expect(d.reasons.join(' ')).toMatch(/remote-authored/);
    expect(d.protectedHit).toBe('workItemOrigin:remote');
  });

  it('is NOT lifted by the owner full-autonomy grant (this node structurally cannot complete a peer\'s item)', () => {
    const d = classifyImprovement(
      cand({ id: 'ro2', kind: 'bug', workItemOrigin: 'remote' }),
      DEFAULT_RISK_TIER_POLICY,
      { ownerFullAutonomy: true },
    );
    expect(d.tier).toBe('human');
  });

  it('a local (undefined workItemOrigin) bug is unaffected — still auto', () => {
    expect(classifyImprovement(cand({ id: 'ro3', kind: 'bug' })).tier).toBe('auto');
  });
});

describe('Phase 4 graduation is a CONFIG change', () => {
  it('adding change to autoKinds graduates change items to auto', () => {
    const graduated: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: ['bug', 'change'] };
    expect(classifyImprovement(cand({ id: 'g', kind: 'change' }), graduated).tier).toBe('auto');
    // feature is still human until further graduated
    expect(classifyImprovement(cand({ id: 'g2', kind: 'feature' }), graduated).tier).toBe('human');
  });
  it('empty autoKinds pauses ALL auto (everything human)', () => {
    const paused: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: [] };
    expect(classifyImprovement(cand({ id: 'pz', kind: 'bug' }), paused).tier).toBe('human');
  });
  it('protected surface stays human even after graduation', () => {
    const graduated: RiskTierPolicy = { ...DEFAULT_RISK_TIER_POLICY, autoKinds: ['bug', 'change', 'feature'] };
    const d = classifyImprovement(cand({ id: 'gp', kind: 'feature', paths: ['packages/operator-core/lib/release/deploy.ts'] }), graduated);
    expect(d.tier).toBe('human');
  });
});

describe('partitionByTier', () => {
  it('splits a mixed set and records a decision per id', () => {
    const items = [
      cand({ id: 'b1', kind: 'bug', title: 'plain bug' }),
      cand({ id: 'c1', kind: 'change', title: 'make it bigger' }),
      cand({ id: 'b2', kind: 'bug', title: 'deploy script flake' }), // keyword → human
    ];
    const { auto, human, decisions } = partitionByTier(items);
    expect(auto.map((c) => c.id)).toEqual(['b1']);
    expect(human.map((c) => c.id).sort()).toEqual(['b2', 'c1']);
    expect(Object.keys(decisions).sort()).toEqual(['b1', 'b2', 'c1']);
  });
});
