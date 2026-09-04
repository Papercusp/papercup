/**
 * WI-5268 — regression coverage for the durable p2p/federation/rig title-fence
 * helper (p2p-lane-fence.ts). The `backlog-drain` fleet's claim spec has had its
 * hand-authored p2p/federation/rig exclusion regressed TWICE (stripped at rev5,
 * restored at rev6, regressed again at rev9, fixed again at rev10) because the
 * fence lived only as ad hoc glob clauses in the spec JSON with no shared source
 * a test could pin. This file pins `buildP2pLaneFence()`'s CONTENT against
 * representative p2p/federation/rig-titled items — a future edit to
 * `P2P_LANE_EXCLUSION_TERMS` that drops or narrows a term fails a test here
 * instead of silently leaking rig-only work to a single-box fleet member.
 */
import { describe, it, expect } from 'vitest';
import type { WorkItem } from '../work-items';
import type { ClaimSpec } from './claim-spec';
import { matchesWorkItemClaimSpec } from './claim-spec-match';
import { buildP2pLaneFence, P2P_LANE_EXCLUSION_TERMS, P2P_LANE_REJECTED_ANTI_TERMS } from './p2p-lane-fence';

function issueItem(overrides: Partial<WorkItem> & Pick<WorkItem, 'id' | 'title'>): WorkItem {
  return {
    kind: 'change',
    family: 'issue',
    harness: 'papercusp',
    summary: '',
    state: 'open',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    severity: 'minor',
    parent: null,
    payload: {},
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  } as WorkItem;
}

function specWithFence(): ClaimSpec {
  return {
    specVersion: '1.0',
    specId: 'p2p-lane-fence-test',
    revision: 1,
    view: { filter: buildP2pLaneFence() },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  };
}

describe('WI-5268 — buildP2pLaneFence excludes every representative p2p/federation/rig-titled item', () => {
  const fenced = [
    'p2p offer-store publish leg is flaky',
    'P2P handshake timeout under load',
    'Harden federation swarm re-key handling',
    'Federation capture trigger missing for audit table',
    'VM<->host swarm holepunch fails intermittently',
    'steering lease renewal races the DHT announce',
    'bridge the shared-hive projection gap',
    // WI-5639, the item that actually leaked into fleet nonp2p-bug-drain-0725.
    // snake_case: the boundary must treat `_` as a separator, or this is admitted.
    'replication_soak: WI-183-class zombie-connection recovery still misses 90s SLA',
    '[replication-liveness] no_replicator: harness=papercusp log=4072cfad012b',
    // Named stack components folded in from the fleet's hand-typed rev9 spec.
    'udx punch-path instrumentation is unmeasurable',
    'hyperbee snapshot read races the hyperdht announce',
    'relay fallback never retries after a failed hole punch',
    // WI-6995: the pot-git transport leg. Each of these is a REAL open item that
    // leaked into fleet nonp2p-bug-drain-0801's lane because no term above matched.
    'pot-git cross-machine repoKey NEVER rendezvouses: each device keys the store by its LOCAL id',
    'Every failed pot-git fetch leaks its whole partial packfile forever — 21 GB of orphaned tmp_pack_*',
    'A stuck ref-announce receive fetch reports NOTHING: fetch-failed drops timedOut/code',
    'half-duplex stream never completes its second leg',
    // EI-13285: 'federation' (whole-word) never matches the inflected form
    // "Federated" — this is the actual title that leaked into fleet
    // nonp2p-bug-drain-0801's lane before 'federated' was added as its own term.
    'Federated issue ID collision replaced a newly captured local improvement with an unrelated remote issue',
    // EI-19928699840338901 / P-008: the substrate terms. WI-6076 is the real open item
    // that leaked — genuine wire work (replicate()/protomux core pairing) that NO
    // transport term above matched. Asserting these here is what proves the newly
    // added terms actually fence, rather than merely sitting in the array.
    "Shared peer socket + per-harness Corestores: the 2nd store's replicate() clobbers the 1st's protomux hypercore/alpha pairing, making its COLD cores permanently unservable",
    'hyperblobs range read returns a short buffer past the snapshot boundary',
    'hyperdrive mirror stalls when the source core is sparse',
    'autobase linearization diverges after a writer is removed',
  ];

  it.each(fenced)('excludes: %s', (title) => {
    const item = issueItem({ id: 'WI-x', title });
    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(false);
  });

  it('does NOT exclude an unrelated item (no over-fencing of the general backlog)', () => {
    const item = issueItem({ id: 'WI-y', title: 'Fix dashboard pagination off-by-one' });
    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(true);
  });

  it('does not false-positive on a title merely CONTAINING a term inside a larger word (word-boundary correctness, EI-18690730909662985 class)', () => {
    const item = issueItem({
      id: 'WI-z',
      title: "Fleet nonp2p-bug-drain-0725's own claim-spec can't self-claim a meta-bug naming the fleet",
    });
    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(true); // admitted, not excluded
  });

  /**
   * WI-6995 — this asserts a SUPERSET, not set equality, and that is deliberate.
   *
   * The guard's purpose (and its name) is that the list has not SHRUNK. It used to
   * assert exact equality, which also failed on every ADDITION — so a peer widening
   * the fence correctly would red-pin the SHARED green gate unless they happened to
   * edit this file in the same change. That fired for real on 2026-08-02: a peer
   * added 'federated' (EI-13285) minutes after this test was last touched, and it
   * was caught by luck rather than by design.
   *
   * Additions are the cheap, common, usually-correct edit and are covered by the
   * over-fencing tests below, which fail if a new term hides on-lane work. Removals
   * are the expensive, rare, usually-wrong edit — so pin those and only those.
   */
  const BASELINE_TERMS_MUST_REMAIN = [
    'p2p',
    'shared-hive',
    'federation',
    // EI-13285 — added by a peer concurrently with WI-6995. `word` matches
    // exact words, not stems, so 'federation' never matched the inflected
    // "Federated"; measured against the live backlog, every hit is genuine
    // federation-lane work, so this is a widening of the SAME term rather
    // than a new homonym risk (contrast the anti-terms below).
    'federated',
    // WI-7184 — the verb inflections. EI-13285 named this class and stopped
    // one inflection short, so it re-opened for "federate" and leaked
    // EI-19328707367010003 into a single-box drain fleet. All three land
    // together so the federat- stem is CLOSED, not widened a fourth time;
    // pinning each individually means a partial revert fails loudly.
    'federate',
    'federates',
    'federating',
    'holepunch',
    'steering lease',
    'replication',
    'swarm',
    'hyperswarm',
    'hyperdht',
    'hyperbee',
    'dht',
    'udx',
    'relay',
    'pot-git',
    'ref-announce',
    'duplex',
    // EI-19928699840338901 / P-008 — the substrate family. `hypercore` is the sibling
    // of hyperbee/hyperswarm/hyperdht above; the other three have zero live matches
    // and land on the `duplex` precedent so the family is CLOSED rather than met one
    // term at a time (the mistake the federat- stem made twice).
    'hypercore',
    'hyperblobs',
    'hyperdrive',
    'autobase',
  ] as const;

  it.each(BASELINE_TERMS_MUST_REMAIN)(
    'P2P_LANE_EXCLUSION_TERMS still contains %s (content regression guard — WI-5265/9 class)',
    (term) => {
      expect(P2P_LANE_EXCLUSION_TERMS as readonly string[]).toContain(term);
    },
  );

  /**
   * WI-6995 — the OTHER direction of drift. The guard above stops the term list
   * SHRINKING; nothing stopped it growing into the general backlog. `word` matching
   * cured `glob`'s substring false positives but not homonyms, and this pot uses
   * "rig"/"tower"/"announce"/"dial" for plenty of non-p2p things. Each title below
   * is a REAL open item that a well-meaning widening would have hidden from the very
   * fleet that needs it.
   */
  const mustStayAdmitted: Array<[string, string]> = [
    [
      'rig — a perf test rig, not the federation rig',
      'perf-regression-rig.test.ts TS2345 PerfRegressionMetrics arg mismatch',
    ],
    [
      'rig — a desktop build rig',
      'Desktop/rig builds report sha:null at /api/health — nothing asserts a test rig runs a real build',
    ],
    [
      'tower — the local box, the most on-lane subject there is',
      'Tower load rising unbounded (142→190→240 on 112 cores) — heavy-command admission now rejecting agents',
    ],
    [
      'announce — publish-guard, not the p2p announce leg',
      "publish-guard's G-10 secrets scan is unbounded in memory AND spawns one git per blob",
    ],
    [
      'announce — identity resolution, not the wire',
      'A transient identity-resolution failure permanently disables presence announce for the whole process',
    ],
    // WI-7184 — `hive` is the most tempting anti-term and the most damaging: this
    // pot runs a LOCAL coding hive as well as the federated shared-hive.
    [
      'hive — the local coding hive, not the federated one',
      'generic-hive bee completes + posts a completion but never calls work_items:complete',
    ],
    [
      'hive — a mem0 recall scope, not the wire',
      'initialize/harness recall pool: harness-scoped memories are systematically outranked by hive+user memories',
    ],
    // EI-19928699840338901 / P-008 — the SUBSTRATE tranche. Every title below is a
    // REAL open item measured on 2026-08-09 that the proposed widening would have
    // hidden. They are here because this repo bundles a corestore seed into the
    // desktop release, so the storage vocabulary also names ordinary single-box
    // release-engineering work.
    [
      'corestore — a git-history purge, not the wire',
      'papercusp-desktop submodule: 77 seed corestore blobs (~1.5GB, 50–99MB each) were git-TRACKED — untracked+gitignored 2026-07-05; history purge still needed',
    ],
    [
      'corestore — a single-process advisory lock, executable on one box',
      'Add single-instance advisory lock to own-log Corestore (prevents concurrent-process key contention)',
    ],
    [
      "corestore — the item's OWN motivating critical, and it is a LOCAL deadlock",
      'Sparse seed cuts are PERMANENTLY deadlocked: bg-host holds the corestore WRITE lock while getBootedHarness reports booted:false for that same hive, so the cut can neither open the store itself nor find anyone to ask',
    ],
    [
      'seed cut — the release pipeline, not the wire',
      'P-014: take a REAL release seed cut with the DEFAULTS and MEASURE coreSparseFrom > 0 + the size drop toward ~40MB',
    ],
    // `peer` is the worst of the tranche: 3 of its 4 critical/major hits are ordinary
    // single-box bugs whose titles just use the word for ANOTHER AGENT.
    [
      'peer — another AGENT, not a network peer',
      "`WHERE attempts = 0` silently excludes the 99.8% of rows where attempts IS NULL — a peer's committed drop rested on 30 of 17,318 rows and inverted its conclusion",
    ],
    [
      'peer — another AGENT, not a network peer',
      "facts:assert cap-eviction reports the loss to the EVICTOR (who cannot fix it) and never to the fact's AUTHOR (who can) — a peer's verified fact silently vanishes",
    ],
    [
      'peer — another AGENT, not a network peer',
      "PEER agents' session turns crowd the durable answer out of the corpus injection budget",
    ],
    // `replicate` is the DEBUGGING VERB here — the stem-closing analogy to federate
    // does not transfer, because unlike "federate" this word has two meanings.
    [
      'replicate — the debugging verb, not the transport',
      'A fleet-scoped windDown:true miss is NOT necessarily a spec bug — before assuming so, replicate the floor set',
    ],
    [
      'replicates — the debugging verb, not the transport',
      "[verified] the '~1s first-arm spike replicates 2/2 BOOTS' claim was wrong as stated",
    ],
  ];

  it.each(mustStayAdmitted)('does NOT over-fence (%s)', (_why, title) => {
    const item = issueItem({ id: 'WI-anti', title });
    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(true);
  });

  it('every rejected anti-term is absent from the live term list (WI-6995)', () => {
    for (const anti of P2P_LANE_REJECTED_ANTI_TERMS) {
      expect(P2P_LANE_EXCLUSION_TERMS as readonly string[]).not.toContain(anti);
    }
  });

  // The fence is only as good as the `word` op's boundary definition. `\b` (JS) and
  // `\m`/`\M` (Postgres) both count `_` as a WORD character, so a `word` term never
  // matched across an underscore — and this pot names its soak/test identifiers in
  // snake_case. That is the exact mechanism by which WI-5639 leaked. Pin it here so
  // a revert to `\b` fails loudly instead of silently re-opening the lane.
  it('matches across an underscore — `_` is a boundary, not a word char (WI-5639 leak mechanism)', () => {
    const leaked = issueItem({
      id: 'WI-5639',
      title: 'replication_soak: WI-183-class zombie-connection recovery still misses 90s SLA',
    });
    expect(matchesWorkItemClaimSpec(leaked, specWithFence())).toBe(false); // excluded
  });

  // WI-7184 — the real leaked titles, verbatim. The `word` op matches exact words
  // and NOT stems, so each inflection of a stem is a separate hole: `federation`
  // did not cover "Federated" (EI-13285) and neither covered "federate", which is
  // how EI-19328707367010003 reached single-box fleet nonp2p-bug-drain-0801. These
  // pin the stem CLOSED — a partial revert of any one inflection fails here with
  // the title that actually leaked, not an abstract assertion.
  it.each([
    [
      'federate (EI-19328707367010003, the reported leak)',
      'Remote work-offers federate with HOURS of latency and arrive in bursts, so they are DOA against the 60-minute spawn-request honor window',
    ],
    [
      'federate (WI-5631)',
      'Rig frames federate the REAL papercusp home-harness backlog → frame-internal event-loop starvation',
    ],
    [
      'federates (EI-19333624101736074)',
      "A delegated spawn's SUCCESS never federates — local_disposition is host-local and no receipt is emitted",
    ],
    ['federating (WI-183)', 'Hive peer silently stops federating after restart: swarm re-peers but state diverges'],
  ])('fences the %s inflection', (_why, title) => {
    expect(matchesWorkItemClaimSpec(issueItem({ id: 'WI-fed', title }), specWithFence())).toBe(false);
  });

  it('validateClaimSpec accepts a spec built with buildP2pLaneFence()', async () => {
    const { validateClaimSpec } = await import('./claim-spec');
    const v = validateClaimSpec(specWithFence());
    expect(v.ok, `spec invalid: ${v.errors.join('; ')}`).toBe(true);
  });
});

describe('WI-5280 — buildP2pLaneFence also fences structural source-plan provenance', () => {
  it('excludes a neutral-title item from the exact P2P source-plan family that leaked through revision 12', () => {
    const item = issueItem({
      id: 'WI-2144476',
      title: 'F4 — Make unapplied writes durably recoverable',
      summary: 'Replace retry exhaustion with a durable recovery path.',
      sourcePlanSlug: 'p2p-public-release-endgame-2026-09-01',
    });

    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(false);
  });

  it.each(P2P_LANE_EXCLUSION_TERMS.filter((term) => !term.includes(' ')))(
    'excludes a neutral item whose source-plan slug carries the vetted term %s',
    (term) => {
      const item = issueItem({
        id: 'WI-plan-term',
        title: 'Implement the next approved milestone',
        summary: 'The acceptance criteria are already recorded on the plan.',
        sourcePlanSlug: `release-${term}-lane-2026-09-04`,
      });

      expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(false);
    },
  );

  it.each([
    ['unplanned work', null],
    ['the current non-P2P fleet naming convention', 'nonp2p-feature-change-drain-2026-09-04-v3'],
    ['an unrelated local plan', 'operator-dashboard-pagination-2026-09-04'],
  ])('still admits %s', (_label, sourcePlanSlug) => {
    const item = issueItem({
      id: 'WI-plan-control',
      title: 'Fix dashboard pagination off-by-one',
      summary: 'The final row is skipped when the page is full.',
      sourcePlanSlug,
    });

    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(true);
  });

  it('does not promote rejected anti-terms into structural plan exclusions', () => {
    const item = issueItem({
      id: 'WI-plan-antiterm',
      title: 'Fix local agent lifecycle accounting',
      summary: 'The local coding session is otherwise healthy.',
      sourcePlanSlug: 'local-hive-agent-lifecycle-2026-09-04',
    });

    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(true);
  });
});

describe('EI-20240035377782004 — buildP2pLaneFence also fences on SUMMARY, not title alone', () => {
  it('excludes an item with a GENERIC title whose SUMMARY names p2p/federation/rig work (the live leak, verbatim shape)', () => {
    // Mirrors EI-20239498607103954: a title that reveals nothing, admitted by the
    // title-only fence, whose summary explicitly says "accepted P-205 Mac peer",
    // "federation drills", and "vm-rig MCP parity".
    const item = issueItem({
      id: 'EI-leak',
      title: 'Follow up on outstanding review feedback',
      summary:
        'Team accepted P-205 Mac peer for the next round of federation drills; still need vm-rig MCP parity before sign-off.',
    });
    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(false);
  });

  it('excludes on a summary-only term hit even when the title is completely unrelated', () => {
    const item = issueItem({
      id: 'EI-summary-only',
      title: 'Fix dashboard pagination off-by-one',
      summary: 'Root cause traced to a hyperswarm reconnect storm corrupting the shared pagination cursor.',
    });
    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(false);
  });

  it('still admits a genuinely unrelated item whose summary is also unrelated', () => {
    const item = issueItem({
      id: 'EI-clean',
      title: 'Fix dashboard pagination off-by-one',
      summary: 'The page-size calculation drops the final row when total % pageSize === 0.',
    });
    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(true);
  });

  it('does not over-fence a summary merely CONTAINING a term inside a larger word (word-boundary correctness carries to summary)', () => {
    const item = issueItem({
      id: 'EI-summary-boundary',
      title: 'Meta-bug about a fleet claim spec',
      summary: "Fleet nonp2p-bug-drain-0725's own claim-spec can't self-claim a meta-bug naming the fleet.",
    });
    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(true); // admitted, not excluded
  });

  it('an anti-term (e.g. "hive") in the summary does not over-fence, same as in the title', () => {
    const item = issueItem({
      id: 'EI-summary-antiterm',
      title: 'Recall pool outranking bug',
      // NOTE: deliberately avoids the real exclusion term "federated" (unlike "hive",
      // which is a REJECTED anti-term) — this is testing the anti-term, not accidentally
      // tripping a genuine one.
      summary:
        'harness-scoped memories are systematically outranked by hive+user memories — a local coding hive issue.',
    });
    expect(matchesWorkItemClaimSpec(item, specWithFence())).toBe(true);
  });
});
