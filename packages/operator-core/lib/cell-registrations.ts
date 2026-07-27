/**
 * cell-registrations.ts — the built-in cell registrations
 * (unified-agent-state-plane-2026-07-27 P-006, and P-007 extends this file).
 *
 * P-006's point is NOT to have a first cell. It is to run the D-038 contract
 * against SHIPPED code rather than a greenfield example, on the theory that a
 * contract derived from real cells should be registrable by one — and that if it
 * is not, we would rather learn it from the flagship cell than from the fifth.
 *
 * It did not pass first time, and the failure was worth the exercise. Recorded
 * here because the next author will hit the same wall:
 *
 * ── WHAT THE FIRST REGISTRATION ATTEMPT EXPOSED ─────────────────────────────
 *
 * `positions.*` were BARE BOOLEANS built by `refContains`, which returned
 * `contained === '0'` over a `GitRunner` that yields `null` on any failure. So a
 * FAILED git read produced `false` — byte-identical to the honest "your change
 * genuinely has not reached this stage". An agent reads `onStaging: false` and
 * waits for a stage it may already have passed.
 *
 * That is the same defect class as `systemctl is-active` printing `inactive` for
 * a unit that does not exist, sitting in the headline leg of the very cell we
 * intended to register as the contract's exemplar.
 *
 * The registry could not have caught it. Declaring `nullable: false` — which was
 * LITERALLY TRUE of the shipped type — passed the gate with zero rejections,
 * because axis 2's enforcement rests on a self-declared boolean no validator can
 * verify against the resolver's behaviour. Note the incentive that creates: an
 * author who admits their value can be unknown is asked for a hoist, while one who
 * ships a bare boolean sails through. The gate rewarded the weaker cell.
 *
 * So the fix was in the RESOLVER, not the declaration: `refContains` now returns
 * `boolean | null`, and an unreadable leg is named in `positionsUnknown` (the
 * D-039 result-level hoist, modelled on `unitsUnknown[]`). Only then could this
 * cell be registered honestly, which is what the declaration below now is.
 */

import { registerCell, type CellSpec } from './cell-registry';

/**
 * The pipeline-position cell. Owned by su-28464 per P-006 — registration does not
 * transfer ownership of the resolver.
 *
 * GRAIN NOTE (open, filed for P-003): `gitPipelinePosition()` is ONE resolver, which
 * satisfies axis 5, but it returns several independently addressable values
 * (`positions`, `stages`, `serving`, `changeInCandidate`, `gitSync`,
 * `sweepExposure`) with DIFFERENT falsifiers and different caller-relativity. "One
 * resolver" therefore does not imply "one cell". This registers the composite under
 * its strongest axis-1 pairing; if the registry later grows a declared grain, this
 * spec should split rather than be stretched.
 */
export const GIT_PIPELINE_POSITION_CELL: CellSpec = {
  cell: 'git.pipelinePosition',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'positions.deployed',

  /**
   * Axis 1. The falsifier is deliberately NOT `stages[].health`, even though D-038's
   * table pairs them at the cell level: for the SERVING stage, `health` is computed
   * FROM `startedSinceCodeChange` (git-pipeline-position.ts, computeStages), so that
   * pairing would be "derived from the headline value" — which the registry's own
   * axis-1 rule rejects, and rightly.
   *
   * `serving.startedSinceCodeChange` is a genuinely INDEPENDENT measurement: a live
   * systemd probe of the serving process, which knows nothing about git. This is the
   * pairing CLAUDE.md already states as a rule, after the same confusion was filed
   * four separate times.
   */
  falsifier: {
    field: 'serving.startedSinceCodeChange',
    measurement:
      'live systemd start time of the serving unit (probeServiceStart) compared against codeAsOfMs — a PROCESS measurement that shares no input with any git read',
    kills:
      '"deployed ✓" read as "the running process is executing my code". The two disagree whenever the host was never restarted after the deploy, and the git fact alone cannot see it.',
  },

  /**
   * Axis 2. TRUE, and it is true because of what the first registration attempt
   * found — not as a formality. A leg whose git read fails is unknown, and saying
   * `false` for it is manufacturing a verdict from an absence.
   */
  nullable: true,
  unknownHoist: 'positionsUnknown',

  /**
   * Axis 3. Explicitly `parameter`, not `global`: this cell answers per-path, and
   * it is the cell that motivated the axis. Two different paths legitimately get
   * two different answers from the same repo state.
   */
  callerRelativity: { kind: 'parameter', param: 'path' },

  /** Axis 4. Live-exercised — and this cell is the reason that rule exists: its
   *  `realGit` defect (a `stdout.trim()` eating a leading space) was invisible to
   *  every fixture and only ever surfaced against the real repo. */
  provenance: {
    obtainedBy:
      'git rev-list/rev-parse/ls-remote against the live repo, plus a live systemd probe for the serving leg',
    liveExercised: true,
    evidence:
      'gitPipelinePosition() run against the real repo 2026-07-27 for both a real path and a sha-only probe; the sha-only branch returned the enumerated not-applicable unknown and the prose surface rendered unchanged.',
  },

  /** Axis 5. ONE resolver; dev:pipeline_position PROJECTS it and never re-derives. */
  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',

  /**
   * P-019 (a)/(b). Workspace-visible: pipeline position is about the SHARED tree, so
   * every agent in the workspace legitimately reads it — and narrowing it would break
   * the very "did my commit land" question it exists to answer.
   *
   * `local` despite that: the positions are relative to THIS hive's checkout and
   * serving process, so the value is not merely uninteresting to a foreign hive, it
   * would be actively misread there as a statement about their own pipeline.
   */
  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },

  /** Poll rides predicate_watches — deliberately NOT a second subscription mechanism. */
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'positions.deployed' },

  shape:
    '{ positions, positionsUnknown[], stages[], serving, changeInCandidate, gitSync, sweepExposure, summary }',

  /**
   * Axis 6. This cell is one of the few that legitimately claims an order — which is
   * itself decent evidence that demoting `ordered` to OPTIONAL was right, rather than
   * it being contract-level. Most cells have no sequence at all.
   */
  ordered: { stages: ['committedLocal', 'onStaging', 'inMain', 'deployed', 'serving'] },
};

/* ═══════════════════════════════════════════════════════════════════════════════
 * P-007 — THE FOUR VERDICT CELLS
 *
 * These are the values agents were demonstrably hand-COPYING out of pipeline reads
 * and into prose, where they went stale and were then acted on. The point is not to
 * format them better (D-032/D-034 settled that presentation proves nothing); it is
 * that a cell is RE-DERIVED at the moment of acting.
 *
 * ── GRAIN: #D-065 ───────────────────────────────────────────────────────────────
 * Four SIBLING cells over the ONE `gitPipelinePosition()` resolver, which is also
 * `git.pipelinePosition`'s resolver. That is axis 5 SATISFIED, not stretched: axis 5
 * demands exactly one resolver per cell and explicitly blesses surfaces that PROJECT
 * or subset a derivation ("one derivation, many lenses"); what it forbids is
 * RE-deriving. Each cell below is a lens. The alternative — telling agents to read
 * the composite `git.pipelinePosition` — would defeat the item's entire purpose,
 * since the observed behaviour is agents copying these four values SPECIFICALLY.
 * This also discharges the GRAIN NOTE above: the registry now has a declared grain,
 * and the composite spec SPLIT rather than being stretched, exactly as it asked.
 *
 * ── WHAT REGISTERING THEM HONESTLY COST (read this before editing a spec) ────────
 * Three of the four headlines turned out to be degradable, and NONE of them
 * degrades into an obvious error — each degrades into GOOD NEWS:
 *
 *   `gate.consecutiveReds`  → `0`, which reads as "the gate is passing"
 *   `deployedSha`           → `null`, which reads as "nothing is deployed"
 *   `mainFastForwarded`     → `null`, which reads as "no opinion"
 *   `judgingSha`            → `null`, which reads as "no run is in flight"
 *
 * The reds counter is the one worth dwelling on, because it is P-006's trap
 * reproduced exactly. `git-pipeline-stats.ts` had `num(gateHealth.consecutiveReds)
 * ?? 0`, so an ABSENT counter became a `0` indistinguishable from a measured green —
 * and the shipped type is `number`, so `nullable: false` was LITERALLY TRUE and would
 * have sailed through this gate with zero rejections. That is the incentive the
 * P-006 note above warns about, and the correct response was the same one: fix the
 * RESOLVER (capture the presence bit before the `?? 0` erases it, hoist it in
 * `verdictUnknown`), not the declaration.
 *
 * Two existing staleness models look like they already cover it and do not:
 * `fireStale` asks "is the routine FIRING?", and `verdictStale`'s own evaluator opens
 * with `if (consecutiveReds <= 0) return { stale: false }` — commented "a stale green
 * is inert". True of a stale green; FALSE of one that was never measured. The
 * short-circuit lands precisely on the case that needed naming.
 * ═══════════════════════════════════════════════════════════════════════════════ */

/** The result-level hoist all four share. Named once so a spec cannot drift from it. */
const VERDICT_HOIST = 'verdictUnknown';

/**
 * Cell 1 — what the gate's last verdict was.
 *
 * PAIRED WITH CELL 4 AS MUTUAL FALSIFIERS, which is not a shortcut but the whole
 * point: a test-verdict TALLY and a git ANCESTRY check are two different apparatus
 * answering "is the pipeline healthy", so either can catch the other lying. The live
 * exercise caught exactly that (see `provenance.evidence`).
 */
export const GATE_VERDICT_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.verdict',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'gate.consecutiveReds',

  falsifier: {
    field: 'verdictProvenance.mainFastForwarded',
    measurement:
      'a git ancestry check (is the newest green pin exactly at main HEAD, from devDeployState) — a REF-GRAPH measurement that shares no input with the green-checkpoint routine metadata the red streak is counted from',
    kills:
      '"0 consecutive reds" read as "the pipeline is healthy". A gate that never FIRED cannot go red, and a gate whose verdict never promoted main leaves the tally green while nothing advances — the count alone cannot see either.',
  },

  /**
   * TRUE, against the shipped type, and this is the honest answer rather than the
   * convenient one — see the block comment above on the `?? 0`.
   */
  nullable: true,
  unknownHoist: VERDICT_HOIST,

  /** Axis 3. GLOBAL, said out loud: the gate judges a candidate commit, not a caller's
   *  path. Every caller gets the same red streak — unlike `git.pipelinePosition`, whose
   *  whole subject is per-path. Two lenses on one resolver differing here is why axis 3
   *  is declared per-CELL and not per-resolver. */
  callerRelativity: { kind: 'global' },

  provenance: {
    obtainedBy:
      'the green-checkpoint routine metadata (`gate_health`) via gitPipelineSnapshot, corrected by pinProvenGateCorrection',
    liveExercised: true,
    evidence:
      'dev:pipeline_position run against the live repo 2026-07-27T08:55Z returned gate.consecutiveReds=0 with fireStale=false — while verdictProvenance.mainFastForwarded=FALSE, deployedBehindGreenPin=19 and stages[main].health="stalled". THE FALSIFIER FIRED IN THE REAL SYSTEM: the headline read as a passing gate while an independent git-ancestry measurement showed main 19 commits behind the pin and not fast-forwarded. The tool\'s own summary said "gate reports 0 reds, but main has NOT fast-forwarded — do not read this as fully healthy".',
  },

  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',

  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'gate.consecutiveReds' },
  shape: '{ gate: { consecutiveReds, stalled, lastGreenAtMs, fireStale, fireStaleReason }, verdictUnknown[] }',
};

/**
 * Cell 2 — WHICH commit the gate is judging. The question that comes before "is it
 * red": a red about a candidate that does not contain your change reads as *your fix
 * did not work* instead of *your fix was not present*.
 */
export const GATE_CANDIDATE_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.candidate',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'changeInCandidate.judgingSha',

  falsifier: {
    field: 'changeInCandidate.judgingContainsPath',
    measurement:
      'a blob comparison of the working-tree content against the candidate commit (classifyPathsAgainstCandidate) — a CONTENT containment check, independent of which sha the gate happens to be running',
    kills:
      '"the gate is red" read as "the gate is red ABOUT MY CHANGE". The quiet-cut routinely steps the candidate back from the tip, so an in-flight run can be judging a commit that predates the fix entirely.',
  },

  /**
   * TRUE. Note which hoist this uses and why it is NOT `changeInCandidate.missingReason`,
   * which is the field that looks built for the job: `missingReason` answers "a
   * containment verdict came back FALSE — which lever fixes it", and is null in both
   * cases where the headline is genuinely UNMEASURABLE (a sha-only probe; a submodule
   * path, where the gate sees only a gitlink). Those two arrive as `not-applicable` in
   * the shared hoist — FINAL answers with no lever, which must not read as "no run in
   * flight" and send a caller off to wait for a verdict that will never mention them.
   */
  nullable: true,
  unknownHoist: VERDICT_HOIST,

  /** Axis 3. PER-PATH: the candidate sha is global, but "does the candidate contain
   *  YOUR path" — the thing this cell exists to answer — is not. */
  callerRelativity: { kind: 'parameter', param: 'path' },

  provenance: {
    obtainedBy:
      'resolveGateCandidates (the in-flight + next candidate shas) plus a per-path blob containment check against each',
    liveExercised: true,
    evidence:
      'dev:pipeline_position run against the live repo 2026-07-27T08:55Z for packages/operator-core/lib/agent-tools/state/state-tools.test.ts returned judgingSha=null with missingReason=null (no run in flight — a MEASURED absence, verified in source as legitimate and NOT hoisted) while nextCandidateSha=8e997f9a with nextContainsPath=true. The live read is what established that a null headline with a null missingReason is a real state, which is why the not-applicable cases had to be hoisted separately rather than inferred from that pair.',
  },

  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',

  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'changeInCandidate.judgingSha' },
  shape:
    '{ changeInCandidate: { judgingSha, judgingContainsPath, nextCandidateSha, nextContainsPath, missingReason, detail }, verdictUnknown[] }',
};

/**
 * Cell 3 — the sha :3070 is running.
 *
 * ⚠ Shares `serving.startedSinceCodeChange` with `git.pipelinePosition`'s falsifier.
 * That is legal and deliberate, not copy-paste: the two cells have DIFFERENT headlines
 * (a position boolean vs the deployed sha), and the probe is independent of both. It is
 * also the pairing CLAUDE.md already states as a rule after the confusion was filed
 * four separate times, so re-pairing it here is the point rather than an oversight.
 */
export const DEPLOYED_SHA_CELL: CellSpec = {
  cell: 'deploy.3070.sha',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'deployedSha',

  falsifier: {
    field: 'serving.startedSinceCodeChange',
    measurement:
      'a live systemd start-time probe of the serving unit (probeServiceStart) compared against when the code last changed — a PROCESS measurement that shares no input with any git read',
    kills:
      '"deployed sha X" read as "the process is EXECUTING X". A deploy that moved the checkout without restarting the host leaves the two disagreeing, and the git fact alone cannot see it.',
  },

  /**
   * TRUE — and the reason is worth stating because the code used to assert otherwise.
   * `deployedSha` is `commitRef(releaseRoot, 'HEAD')`, and dev-deploy-state pushes
   * 'could not resolve HEAD of release checkout …' onto `errors[]` whenever that comes
   * back null. So a null here is a FAILED READ, never "nothing is deployed" — a comment
   * in the resolver claimed the latter and derived a confident `positions.deployed:
   * false` from it, which P-007 corrected.
   */
  nullable: true,
  unknownHoist: VERDICT_HOIST,

  /** Axis 3. GLOBAL: one release checkout per host — every caller reads the same sha. */
  callerRelativity: { kind: 'global' },

  provenance: {
    obtainedBy:
      "devDeployState()'s release-checkout HEAD (a single `git log -1`), plus a live systemd probe for the falsifier",
    liveExercised: true,
    evidence:
      'dev:pipeline_position run against the live repo 2026-07-27T08:55Z returned deployedSha="dab4a3d8d7471313bd704f2aadbd0910025a470d" with serving.startedSinceCodeChange=true, pid=1607181, codeAsOfSource="deploy" — the falsifier agreed on this read, and deployOrigin="stale-behind-gate" showed the deployed sha trailing the green pin by 19 commits, which is the state this cell exists to make legible.',
  },

  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',

  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'deployedSha' },
  shape: '{ deployedSha, serving: { startedSinceCodeChange, unknownReason, pid, codeAsOfSource }, verdictUnknown[] }',
};

/**
 * Cell 4 — is main fast-forwarded to the newest green pin.
 *
 * NAMING. The cell is `git.mainBehindStaging` because that is the question agents ask
 * and hand-copy; the headline is the boolean the system actually measures
 * (`verdictProvenance.mainFastForwarded` = `deploy.greenPinAtStagingHead`). There is
 * deliberately NO raw main-behind-staging COUNT — grepped git-pipeline-stats, none
 * exists — and inventing one would be a second derivation of a question already
 * answered (axis 5).
 */
export const MAIN_BEHIND_STAGING_CELL: CellSpec = {
  cell: 'git.mainBehindStaging',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'verdictProvenance.mainFastForwarded',

  /**
   * ⚠ THE KILLS IS THE OPPOSITE OF THE OBVIOUS ONE, and writing the obvious one would
   * make this cell actively harmful. A nonzero staging buffer is NORMAL on this fleet:
   * git-sync commits staging continuously while the green-checkpoint promotes main only
   * hourly and only when green. `why-chain.ts` therefore DELIBERATELY does not fire on
   * it (EI-11012) — the naive "behind = broken" reading is what made the deploy stage
   * report degraded essentially always, shadowing every real downstream cause.
   *
   * So the false reading to kill is "nonzero lag means the pipeline is stalled", and
   * only gate FIRE-LIVENESS separates a normal buffer from a wedged gate.
   */
  falsifier: {
    field: 'gate.fireStale',
    measurement:
      "the green-checkpoint routine's own last-fire timestamp against the fire interval (the green-stall watchdog's rule) — a SCHEDULER-LIVENESS measurement, sharing no input with any commit-graph read",
    kills:
      '"main is behind staging, so the pipeline is stalled". A buffer of un-promoted commits is the normal steady state here and is NOT a fault; what distinguishes it from a wedged pipeline is whether the gate is still firing, which no lag figure can tell you. (The inverse misread is equally live: main behind staging with a green tally is what the mutual falsifier in `gate.greenCheckpoint.verdict` catches.)',
  },

  /** TRUE: `greenPinAtStagingHead` is null whenever the green pin or the staging head
   *  failed to resolve, and `commitRef` returns null for both "ref absent" and "git
   *  failed". The hoist names which operand was missing. */
  nullable: true,
  unknownHoist: VERDICT_HOIST,

  /** Axis 3. GLOBAL: a property of two branch tips, identical for every caller. */
  callerRelativity: { kind: 'global' },

  provenance: {
    obtainedBy:
      'the greenPinAtStagingHead leg of devDeployState() — a `rev-list --count` between the green pin (main) and staging HEAD, measured in the integration tree',
    liveExercised: true,
    evidence:
      'dev:pipeline_position run against the live repo 2026-07-27T08:55Z returned mainFastForwarded=FALSE with lastGreenSha="7ad7d26cf991…", deployedBehindGreenPin=19 and stages[main].health="stalled" / detail "main is not fast-forwarded to the newest green pin", while the falsifier gate.fireStale=false and lastGreenAtMs=1785142161612 showed the gate WAS still firing — i.e. the live system was in exactly the state this cell must not misreport as a stall.',
  },

  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',

  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'verdictProvenance.mainFastForwarded' },
  shape:
    '{ verdictProvenance: { mainFastForwarded, lastGreenSha, lastGreenAgeMs, deployedBehindGreenPin, deployOrigin }, verdictUnknown[] }',
};

/** Every built-in cell, in registration order. */
export const BUILTIN_CELLS: CellSpec[] = [
  GIT_PIPELINE_POSITION_CELL,
  GATE_VERDICT_CELL,
  GATE_CANDIDATE_CELL,
  DEPLOYED_SHA_CELL,
  MAIN_BEHIND_STAGING_CELL,
];

/** Register every built-in cell. Idempotent — safe to call from more than one entry
 *  point, since re-registering an identical resolver is a no-op in the registry. */
export function registerBuiltinCells(): void {
  for (const spec of BUILTIN_CELLS) registerCell(spec);
}
