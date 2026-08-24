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
import { AGENT_GOAL_CELL_ID } from './agent-goal-ref';

/* ═══════════════════════════════════════════════════════════════════════════════
 * cell-assessment-schema-and-falsifier-removal-2026-08-21 P-004/P-006 — EVERY CELL
 * DECLARES AN `assessment`, AND THE AXIS-1 FALSIFIER IT ONCE SAT BESIDE IS GONE.
 *
 * Each block below was translated BY HAND from the P-001 truth tables (D-009 for the
 * six pipeline/gate cells, D-010 for host/goal/testing), never derived from the
 * `kills` prose that used to sit beside it — D-011 rule 2. A `kills` sentence was a
 * NEGATIVE claim and a `safeAction` is a POSITIVE one, so mapping one onto the other
 * mechanically manufactures guidance nobody authored. That is also why P-006 could
 * DELETE the old field rather than translate it: where its INDEPENDENT measurement
 * still carried information, that measurement appears below as assessment EVIDENCE
 * (D-004) — a different job, substantiating the positive reading rather than refuting
 * a wrong one — and where it carried none, it left with the field.
 *
 * ── ⚠ WHY SOME OBVIOUS EVIDENCE PATHS ARE DELIBERATELY ABSENT ───────────────────
 *
 * MEASURED against the live door 2026-08-24, not inferred from the types: a
 * `dev:pipeline_position` response bounded to its own budget DROPS `serving.*`,
 * `positionsUnknown`, and `changeInCandidate.judgingShaSource`, and sets
 * `projection.truncated`. `assessmentFrom` (cell-read.ts) DOWNGRADES a resolved code
 * to `unavailable` when any declared evidence path did not arrive — so declaring
 * `serving.startedSinceCodeChange` as evidence here, however natural it reads, would
 * make `git.pipelinePosition` and `deploy.3070.sha` answer `unavailable` on the
 * ordinary path, forever. That is WI-38266 one field over, and it is exactly the trap
 * this file's own history warns about: the declaration that is LITERALLY TRUE of the
 * shipped type is not the one that survives contact with the door.
 *
 * So every evidence path below was checked against a real payload before it was
 * written, and the assessment CODE — computed inside the resolver, before any door —
 * is what carries the distinction those dropped legs used to make. That is the
 * contract earning its keep: an interpretation computed at the source survives
 * shaping that its raw inputs do not.
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * The release-pipeline resolvers below describe the operator HOME Pot's checkout,
 * gate, release process, and incident lease. Other harnesses in this workspace
 * have independent pipelines, so exposing these cells workspace-wide lets their
 * agents read Papercusp state as if it were their own (EI-20709429494940822).
 */
const OPERATOR_PIPELINE_VISIBILITY = { kind: 'harness', ref: 'papercusp' } as const;

/**
 * The pipeline-position cell. Owned by su-28464 per P-006 — registration does not
 * transfer ownership of the resolver.
 *
 * GRAIN NOTE (open, filed for P-003): `gitPipelinePosition()` is ONE resolver, which
 * satisfies axis 5, but it returns several independently addressable values
 * (`positions`, `stages`, `serving`, `changeInCandidate`, `gitSync`,
 * `sweepExposure`) with DIFFERENT independent checks and different caller-relativity.
 * "One resolver" therefore does not imply "one cell". This registers the composite
 * under its strongest such pairing; if the registry later grows a declared grain, this
 * spec should split rather than be stretched.
 */
export const GIT_PIPELINE_POSITION_CELL: CellSpec = {
  cell: 'git.pipelinePosition',
  registeredOn: '2026-07-27',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'positions.deployed',


  /**
   * D-009's ladder, first-match. The codes are ORDERED CLAIMS about one journey, so
   * the safe actions differ by LEVER rather than by urgency — and two of them tell
   * the reader to do nothing, which is the point: `awaiting-push` and
   * `awaiting-gate` are states agents routinely mistake for something to fix.
   *
   * ⚠ `live` vs `restart-required` is decided by `serving.startedSinceCodeChange`,
   * which the door drops (see the file header). The code below is the ONLY surviving
   * carrier of that distinction — which is precisely why it must not be re-derived
   * downstream from `positions.deployed`, the exact misreading CLAUDE.md has had
   * filed against it four separate times.
   */
  assessment: {
    path: 'assessments.pipelinePosition',
    codes: {
      live: {
        meaning:
          'The path is deployed AND the serving process started after that code last changed — the running process is executing it.',
        safeAction: 'Exercise the behaviour through the running service; no deploy or restart step is outstanding.',
      },
      'restart-required': {
        meaning:
          'The code is deployed, but the serving process has been running since BEFORE the code changed, so it is still executing the old bytes.',
        safeAction:
          'Restart the serving runtime named by `serving.restartLever` (dev:restart). A further deploy will not change what is running.',
      },
      uncommitted: {
        meaning: 'The edit exists only in the working tree — git-sync has not committed it yet.',
        safeAction:
          'Finish the atomic edit and leave it in the tree; the git-sync sweep commits it. Do not hand-commit, and do not stash or branch to isolate it.',
      },
      'awaiting-push': {
        meaning: 'Committed locally, not yet on origin/staging.',
        safeAction:
          'Nothing to fix — or fire `git-sync:run` if you specifically need it on the REMOTE now. Note the gate cuts its candidate from LOCAL staging, so this state does not block gate entry.',
      },
      'awaiting-gate': {
        meaning:
          'On staging, not yet fast-forwarded into main: no green-checkpoint verdict has promoted a candidate containing it.',
        safeAction:
          'Read `gate.greenCheckpoint.verdict` before you wait — a red or non-firing gate is a lever you can act on, not a queue to sit in.',
      },
      'awaiting-deploy': {
        meaning: 'In main, but the release checkout has not been moved onto it yet.',
        safeAction:
          "Wait for the release trigger, or expedite with release:deploy { op:'trigger', confirm:true } — which can only ship the already-green pin and refuses on a red gate.",
      },
    },
    evidence: ['dirtyUncommitted', 'positions.committedLocal', 'positions.onStaging', 'positions.inMain'],
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
   * P-019 (a)/(b). Harness-visible: pipeline position is about the operator HOME
   * Pot's shared tree. Other harnesses in this workspace have independent trees and
   * gates, so showing them this value would answer "did my commit land" about the
   * wrong checkout.
   *
   * `local` despite that: the positions are relative to THIS hive's checkout and
   * serving process, so the value is not merely uninteresting to a foreign hive, it
   * would be actively misread there as a statement about their own pipeline.
   */
  visibility: OPERATOR_PIPELINE_VISIBILITY,
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
 * PAIRED WITH CELL 4 AS MUTUAL CHECKS, which is not a shortcut but the whole point: a
 * test-verdict TALLY and a git ANCESTRY check are two different apparatus answering
 * "is the pipeline healthy", so either can catch the other lying. The live exercise
 * caught exactly that (see `provenance.evidence`).
 */
export const GATE_VERDICT_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.verdict',
  registeredOn: '2026-07-27',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'gate.consecutiveReds',


  /**
   * D-009, first-match. THE ORDER IS THE CONTENT HERE: `inconclusive` and `red-stale`
   * both outrank the red counters they sit above, because in each of those states the
   * tally describes a run that is no longer the subject. An agent who branches on
   * `consecutiveReds` alone cannot see either, and both send them to fix failures that
   * belong to an abandoned candidate — the single most expensive misread on this fleet.
   *
   * Note `not-firing` carries a NONZERO safe action off a ZERO counter. That inversion
   * is the whole reason this cell needed an assessment: the healthy-looking number is
   * the one that needs an intervention.
   */
  assessment: {
    path: 'assessments.gateVerdict',
    codes: {
      inconclusive: {
        meaning:
          'The newest run ended with NO verdict (cancelled, timed out, or crashed before tests ran), so the red/green counters beside it describe an OLDER run.',
        safeAction:
          'Follow the status-specific lever in `gate.inconclusive`. Do NOT act on the frozen red counters as though they judged the current tree.',
      },
      'red-stale': {
        meaning:
          'Reds are on record, but the verdict is stale: it judged a candidate that has since been superseded.',
        safeAction:
          'Verify the CURRENT candidate before fixing anything — the named failures may belong to a run that has already been abandoned.',
      },
      'red-current': {
        meaning: 'The gate is red about the candidate it is judging now.',
        safeAction:
          'Fix the named failing tests, re-running each individually to confirm it is genuinely red at HEAD. A red gate freezes every agent\'s deploys, so this is yours to green regardless of lane.',
      },
      'not-firing': {
        meaning:
          'Zero reds — but the gate has not FIRED within its interval, so nothing is being judged at all.',
        safeAction:
          'Recover the green-checkpoint producer. A zero-red tally from a gate that never ran is not a pass, and waiting on it will never resolve.',
      },
      'passing-buffered': {
        meaning:
          'The gate is firing and green, and main sits behind staging — the ordinary steady state on this fleet.',
        safeAction:
          'Proceed. Do not read the buffer as a stall unless the separate buffer-stale evidence fires.',
      },
      'passing-current': {
        meaning: 'The gate is firing and green, and main is level with staging.',
        safeAction: 'Proceed; nothing is outstanding on the gate.',
      },
    },
    evidence: ['gate.inconclusive', 'gate.verdictStale', 'gate.fireStale', 'verdictProvenance.mainBehindStaging'],
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
      'dev:pipeline_position run against the live repo 2026-07-27T08:55Z returned gate.consecutiveReds=0 with fireStale=false — while verdictProvenance.mainFastForwarded=FALSE, deployedBehindGreenPin=19 and stages[main].health="stalled". THE INDEPENDENT CHECK FIRED IN THE REAL SYSTEM: the headline read as a passing gate while an independent git-ancestry measurement showed main 19 commits behind the pin and not fast-forwarded. The tool\'s own summary said "gate reports 0 reds, but main has NOT fast-forwarded — do not read this as fully healthy". RE-EXERCISED 09:2xZ with the P-007 hoist in place, against the real gate_health blob: countersUnknown=null and verdictUnknown=[] — i.e. the live counter IS measured and the hoist correctly stays SILENT. That negative result is the one worth recording: a hoist that fired on the healthy path would be one agents learn to ignore.',
  },

  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',

  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'gate.consecutiveReds' },
  doorProjections: [
    { tool: 'release:deploy', path: 'gate.consecutiveReds' },
    { tool: 'routines:list', path: 'health.gate_health.consecutiveReds' },
  ],

  /**
   * P-006 — THE DISCOVERY LEG, and this cell is the primary reason the field exists.
   *
   * A red gate is the single most-read state on this fleet, and `consecutiveReds` is
   * where an agent lands. The question that follows a nonzero read is always the same —
   * *is anyone already on this?* — and until now nothing in this answer said that
   * question had a home. Measured while writing P-006: `dev:pipeline_position` carries
   * the whole ownership block, but `state:read { cell: 'gate.greenCheckpoint.verdict' }`
   * carried no ownership and no route to it, so an agent following this repo's own
   * re-read-the-cell guidance was strictly WORSE informed than one who called the tool.
   *
   * ⚠ THE `shape` STRING ABOVE ALREADY MENTIONED `ownership`, AND THAT IS EXACTLY WHY
   * THIS IS NOT REDUNDANT. `shape` is prose describing the RESOLVER'S payload; it named
   * a block without naming the cell that owns it, and a reader who noticed it had no id
   * to read next. Naming a field is not naming a door.
   *
   * NOT a second independent check (D-014). The mutual pairing with cell 4 documented
   * above is untouched; this adds no measurement and makes no claim of its own.
   */
  pointers: [
    {
      cell: 'gate.greenCheckpoint.ownership',
      when: 'the streak is nonzero (or `stalled`) — i.e. any time you are about to act on a red gate',
      answers:
        'WHO owns this red and whether that ownership is REAL — the owning work-item, its claim state, and the holder\'s live session state, which is the independent check that separates "someone is on it" from a lease held by an agent that died. Read it before you claim the incident yourself or conclude nobody has it.',
    },
  ],

  shape:
    '{ gate: { consecutiveReds, stalled, lastGreenAtMs, fireStale, fireStaleReason, ' +
    'ownership: { eventKey, workItem, claimState, takenBy, takenAt, expiresAt, duplicates[] } }, verdictUnknown[] }',
};

/**
 * Cell 2 — WHICH commit the gate is judging. The question that comes before "is it
 * red": a red about a candidate that does not contain your change reads as *your fix
 * did not work* instead of *your fix was not present*.
 */
export const GATE_CANDIDATE_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.candidate',
  registeredOn: '2026-07-27',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'changeInCandidate.judgingSha',


  /**
   * D-009, first-match. `no-active-run` is the code worth reading twice: it is a
   * MEASURED absence, and its safe action is deliberately not "wait". A null headline
   * here reads as "no run in flight" to anyone who branches on the sha, which is the
   * same reassuring-degradation trap the block comment above catalogues for the other
   * three headlines.
   *
   * ⚠ `inferred-candidate` is decided by `changeInCandidate.judgingShaSource`, which
   * the door drops (file header), so this code is its only surviving carrier. It is
   * also the one code here that refuses an action rather than granting one — firing a
   * manual re-run off an inferred candidate discards a live auto-refire rescue and
   * costs a full suite.
   */
  assessment: {
    path: 'assessments.gateCandidate',
    codes: {
      'no-active-run': {
        meaning: 'No gate run is in flight — a measured absence, not a failed read.',
        safeAction:
          'Nothing to wait on. If you need a verdict now, fire release:checkpoint-run — but check for an in-flight re-triage first, which that verb now refuses on by itself.',
      },
      'candidate-not-yet-published': {
        meaning:
          'A gate run is authoritatively active, but setup has not published the candidate sha yet. This is a live pre-candidate phase, not an idle gate.',
        safeAction:
          'WAIT for this run to publish its candidate or verdict. Do NOT fire release:checkpoint-run: that would collide with or replace the live singleton.',
      },
      'judging-current-path': {
        meaning: 'A run is in flight and its candidate CONTAINS the path you asked about.',
        safeAction: 'Treat a red from this run as being about YOUR change, and own it.',
      },
      'judging-without-current-path': {
        meaning: 'A run is in flight and its candidate does NOT contain your path.',
        safeAction:
          'Do not fix this run\'s failures as though they were yours, and do not read its verdict as a judgement on your change. Wait for a candidate that contains your path.',
      },
      'inferred-candidate': {
        meaning:
          "A candidate sha is present, but it came from a non-authoritative probe rather than the run's own published marker — on a CRON run that degrades to the checkpoint checkout's live HEAD, an inference that can change between two reads.",
        safeAction:
          'Treat the sha as a hint only and re-read once marker-backed provenance is available. Do NOT fire a manual re-run off it.',
      },
    },
    evidence: [
      'changeInCandidate.judgingContainsPath',
      'changeInCandidate.missingReason',
      'changeInCandidate.nextCandidateSha',
    ],
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

  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'changeInCandidate.judgingSha' },
  // release:trace returns the same exact candidate under target.sha; keep that
  // alternate door tied to this cell instead of making callers transcribe it.
  doorProjections: [{ tool: 'release:trace', path: 'target.sha' }],

  /**
   * WI-36259 — THE RUNTIME PROVENANCE, and this cell is why the field exists.
   *
   * The headline can be reached two ways with very different trust, and until now the cell
   * could not say which one answered. Worse, it did not merely omit the label: the headline
   * itself was resolved from the marker-BLIND probe while the run's own published marker sat
   * loaded one field away, so during a re-triage window this cell served the ABANDONED
   * candidate while `checkpointRunInFlight.candidate` served the live one. Same subject, two
   * shas, one resolver. `reconcileGateCandidates` fixes the value; this declares its source.
   *
   * The distinction is exactly the one a triager needs and cannot otherwise get: a
   * 'run-probe' reading on a CRON run is the checkpoint checkout's live HEAD — an inference
   * that changes between two reads — and acting on it is how agents re-fire a gate that
   * already carries their fix.
   */
  headlineSource: {
    path: 'changeInCandidate.judgingShaSource',
    authoritative: ['retriage-marker'],
    why: "'retriage-marker' is the run's OWN published inFlightRetriage marker — an authoritative observation of what it is judging. Anything else is a probe: on a MANUAL run its /tmp unit log, but on a CRON run it degrades to the checkpoint checkout's live HEAD, which is an INFERENCE that can change between two reads and is only right while that checkout stays pinned. Do not fire a manual re-run off a non-authoritative reading.",
  },

  /**
   * P-021 — THE MATERIALITY THRESHOLD, and this cell is why the field exists.
   *
   * `judgingSha` follows the gate's in-flight candidate, which is drawn from the
   * staging tip: MEASURED at 335 commits in 24h on this fleet (`git rev-list
   * --count --since=24h staging`, 2026-07-27). A fact resting on this cell
   * therefore re-renders a stale-verdict paragraph into the orient fold dozens of
   * times a day — for every agent the fold reaches.
   *
   * But re-read what the cell is FOR, three doc-blocks up: "WHICH commit the gate
   * is judging… a red about a candidate that does not contain your change reads
   * as *your fix did not work* instead of *your fix was not present*". The
   * question is not which sha. It is WHETHER THE GATE IS JUDGING YOUR CHANGE —
   * and that is `judgingContainsPath`, which moves only when YOUR file lands, not
   * when the other 334 commits do.
   *
   * So this is the item's rule exactly: push what changed the SENDER'S OWN MODEL.
   * The candidate advancing A→B with your change in both is news about someone
   * else's work; the flip to a candidate that does NOT contain your path is news
   * about yours.
   *
   * ⚠ NOT declared on the other four cells, and that restraint is the point. The
   * P-020 verdict rule applies to its own author: add a knob where churn is REAL
   * and MEASURED, never everywhere it would fit. `deploy.3070.sha` moves 13×/24h
   * (release reflog, same date) and every move is genuinely material — a new
   * deployed sha IS the news. `positions.deployed` and `mainFastForwarded` are
   * booleans, where a change already IS a verdict flip. And
   * `gate.greenCheckpoint.verdict` genuinely wants one — `consecutiveReds` 1→2 is
   * a bump, 0→1 is a flip — but its resolver exposes no coarse verdict field to
   * name, and computing `reds >= 1` HERE would be the registry re-deriving a
   * verdict, which axis 5 forbids. Per this file's own twice-stated precedent the
   * fix there belongs in the RESOLVER, not the declaration; until it exposes one,
   * that cell correctly stays un-gated rather than gaining a threshold DSL.
   */
  materiality: {
    path: 'changeInCandidate.judgingContainsPath',
    why:
      'judgingSha follows the staging tip — measured 335 commits/24h (git rev-list --since=24h staging, 2026-07-27) — but the question this cell exists to answer is "is the gate judging MY change", which is judgingContainsPath and moves only when the subject path itself lands. Suppressing a candidate step A→B that contains the path in both cases withholds news about OTHER agents\' commits; a containment flip is still reported loudly.',
  },

  /**
   * P-006 — the same discovery leg as cell 1, and the pairing is the point rather than
   * duplication: these two ARE the pair an agent reads when the gate is red. Cell 1
   * answers "is it red", cell 2 "is it red about MY change" — and both leave the reader
   * one question short of knowing whether to pick the incident up.
   *
   * `when` is narrower here than on cell 1, and deliberately so. A caller reading this
   * cell about their own path has a containment answer, not a redness answer: the
   * pointer earns its line only once containment says the red IS about them. Firing it
   * on every candidate read would spend the channel on the healthy path — the noise
   * failure `pointer-when-missing` rejects at registration.
   */
  pointers: [
    {
      cell: 'gate.greenCheckpoint.ownership',
      when: 'IF `judgingContainsPath` is true — the gate is judging YOUR change, so the red is yours to answer for',
      answers:
        'WHO already owns this red, so you join the existing incident instead of opening a duplicate — including whether the recorded holder is still alive, which a claim row alone cannot tell you.',
    },
  ],

  shape:
    '{ changeInCandidate: { judgingSha, judgingContainsPath, nextCandidateSha, nextContainsPath, missingReason, detail }, ' +
    'gate: { ownership: { eventKey, workItem, claimState, takenBy, takenAt, expiresAt, duplicates[] } }, verdictUnknown[] }',
};

/**
 * Cell 2b — WHO owns the gate incident, and whether that ownership is real.
 *
 * A SEPARATE cell rather than a second independent check bolted onto cells 1/2. A
 * `CellSpec` describes exactly ONE subject, and the validator rejects any field that is
 * the headline wearing a hat. The plan's P-005 assumed a cell could carry a per-BLOCK
 * side-claim; it cannot, and the honest expression of "this block has its own headline
 * and its own independent check" is its own cell (see D-014).
 */
export const GATE_OWNERSHIP_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.ownership',
  registeredOn: '2026-08-03',
  owner: 'gate-ownership-condition-singleton-2026-08-03',
  headline: 'gate.ownership.claimState',

  /**
   * D-009, first-match. This table is where the holder-liveness correction history
   * (D-018, EI-20209536730887204 — see `ownershipContradicted` in coord/gate-ownership.ts,
   * which carries it in full) finally becomes BRANCHABLE: `held-live`,
   * `held-needs-confirmation` and
   * `held-by-ended-session` are the three readings that the single word `held` on a
   * claim row collapses into one, and each carries a DIFFERENT action — coordinate,
   * confirm, reclaim. D-018's sign-flip (treating `recorded` as dead) and the
   * ambiguous case that silently lost its stand-down protection were both errors of
   * INTERPRETATION over a correct field; a closed code map with a safe action per
   * entry is what stops that class recurring, because there is no interpretation left
   * for a caller to get wrong.
   */
  assessment: {
    path: 'assessments.gateOwnership',
    codes: {
      'duplicate-owners': {
        meaning: 'More than one work-item claims this condition.',
        safeAction:
          'Reconcile the duplicates to a single owning item before working it — two owners is how two agents each conclude the other has it.',
      },
      unowned: {
        meaning: 'No work-item exists for this condition yet.',
        safeAction: 'File the owning work-item and claim it before starting, so a peer can see the incident is taken.',
      },
      claimable: {
        meaning: 'An owning work-item exists and nobody holds it.',
        safeAction: 'Claim it, then work it.',
      },
      'lease-expired': {
        meaning: "The claim's lease has lapsed.",
        safeAction: "Re-claim it — the previous holder's lease no longer protects their work.",
      },
      'held-live': {
        meaning: "Held, and the presence oracle positively says the holder's session is alive.",
        safeAction:
          'Do not take it over. Coordinate with the holder (coord:send) if you need it moved.',
      },
      'held-needs-confirmation': {
        meaning:
          "Held by a session whose liveness is AMBIGUOUS — draining, suspect, or unresolved. This is not a live holder and not a dead one.",
        safeAction:
          'Confirm with a required wake before acting. A delivered wake proves a coordination-live peer; a missed one does NOT prove a dead holder, so fail open rather than seizing the claim.',
      },
      'held-by-ended-session': {
        meaning:
          'Held by a session the oracle confirms has ENDED — the lease outlived its holder.',
        safeAction:
          'Reclaim it. This is the exact case a claim row alone reports as "someone is on it" indefinitely, suppressing the next agent who could have picked it up.',
      },
    },
    evidence: ['gate.ownership.holderSessionState', 'gate.ownership.duplicates', 'gate.ownership.expiresAt'],
  },

  /**
   * TRUE, and this is the field the cell contract earned its keep on. The block
   * originally shipped (P-004) with a non-null enum that degraded to `'no-object'`
   * whenever the store was unreachable — so an unreadable store and a genuinely
   * un-owned condition produced the identical value, and the failure rendered as
   * the reassuring one ("nobody owns this red"). Registering the cell forced axis
   * 2 to be answered out loud, which is what surfaced it.
   */
  nullable: true,
  unknownHoist: VERDICT_HOIST,

  /** Axis 3. GLOBAL: the gate's incident is one condition for the whole workspace —
   *  every caller asking "who owns this red" gets the same answer, unlike cell 2's
   *  per-path containment question. */
  callerRelativity: { kind: 'global' },

  provenance: {
    obtainedBy:
      "findConditionObjects() over the work-item↔condition link for `green-stall:<harness>`, with the holder's liveness resolved separately through the shared presence oracle",
    liveExercised: true,
    evidence:
      'P-006 (thread fold) re-exercised UNMOCKED 2026-08-03T02:55Z, and the run CAUGHT A REAL DEFECT that every unit test had passed over: the window reader was dispatching issue-family reads to work-items.ts\'s coord store, which is pinned to the `default` workspace while live issue threads sit in `papercusp-workspace`. It matched zero rows and returned a confident `total: 0` — WI-6857, which has TEN posts, read back as 0/0, indistinguishable from an item nobody had commented on. Fixed by dispatching issue-family to issues-engineer\'s dynamically-scoped store (guarded by work-items-thread-window-family-dispatch.test.ts). Post-fix live reads: WI-6857 -> shown 3 / total 10, oldest-first, bodies 3,933/4,928/2,317 chars all correctly flagged truncated at 400; EI-19379911903391487 -> topic pointer `topic:papercusp-improvement` with since=incident-start, proving the tags leg is scoped correctly too (its empty counterpart on WI-6857 is a genuine absence, verified by contrast); WI-7282 (bridge-minted) -> a MEASURED silence, shown 0 / total 0 / unknown null, which is the default state of a fresh incident since threads are created on first post; a nonexistent id -> `resolver-failed`, never silence. ALSO: readGateOwnership() run UNMOCKED against the live store 2026-08-03T02:22Z. (a) `green-stall:papercusp` resolved to a MEASURED `no-object` — the condition is genuinely resolved right now (alarm 2026-08-02T15:00:02Z, recovery 15:45:03Z), and the run confirms the empty is measured rather than a swallowed failure, since the same call path returned a real row for another key. (b) The shared condition query returned `single-primary:no-primary -> WI-7282, claimState claimable, duplicates []` — a live non-empty proving the join resolves real rows and the singleton holds. (c) THE FALSIFIER APPARATUS, exercised on real owners: resolveSessionStates returned `su-4a6e2255… -> live/heartbeatFresh:true` and a nonexistent owner -> `ended`/**heartbeatFresh:true**. That second pair IS the premise this independent check rests on, observed live: heartbeat freshness reads TRUE for an owner the oracle calls ended, so a reader substituting heartbeatFresh for sessionState would report a dead holder as live. NOT yet covered live: a genuinely HELD lease contradicted by a dead holder — no agent has claimed this condition yet, so the held+ended path remains unit-only. THE RUN ALSO CAUGHT A REAL ERROR: it falsified the author\'s own recorded belief that the bridge was not yet running (it was — bg-host executes tsx straight from the staging tree, so no deploy is involved), which is precisely the confidently-wrong-resolver class this axis exists to catch.',
  },

  resolver: 'readGateOwnership() @ packages/operator-core/lib/coord/gate-ownership.ts',

  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'gate.ownership.claimState' },
  shape:
    '{ gate: { ownership: { eventKey, workItem, claimState, unknown, takenBy, takenAt, expiresAt, holderSessionState, duplicates[], ' +
    'thread: { recent[{ at, author, text, chars, truncated }], shown, total, topics[{ slug, ref, since }], unknown } } }, verdictUnknown[] }',
};

/**
 * Cell 3 — the sha :3070 is running.
 *
 * ⚠ Cites `serving.startedSinceCodeChange` as evidence, exactly as `git.pipelinePosition`
 * does. That is legal and deliberate, not copy-paste: the two cells have DIFFERENT
 * headlines (a position boolean vs the deployed sha), and the probe is independent of both. It is
 * also the pairing CLAUDE.md already states as a rule after the confusion was filed
 * four separate times, so re-pairing it here is the point rather than an oversight.
 */
export const DEPLOYED_SHA_CELL: CellSpec = {
  cell: 'deploy.3070.sha',
  registeredOn: '2026-07-27',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'deployedSha',


  /**
   * D-009, first-match. Three codes, and the third is the one that did not exist as a
   * readable state before: `process-unverified` says the serving probe itself did not
   * answer, which is neither "running your sha" nor "running an old one". Collapsing
   * it into either — the natural move when all you have is a sha and a boolean — is
   * how a deploy gets reported live off a probe that never returned.
   *
   * ⚠ A null `deployedSha` is NEVER a code here. It is a FAILED READ of the release
   * checkout's HEAD, not "nothing is deployed"; that inference is the one the resolver
   * used to make and P-007 corrected. Absence stays `unavailable`.
   */
  assessment: {
    path: 'assessments.deployedSha',
    codes: {
      executing: {
        meaning:
          'A sha is deployed and the serving process started after the code changed — the process is running that sha.',
        safeAction: 'Exercise the deployed behaviour; nothing is outstanding.',
      },
      'restart-required': {
        meaning: 'A sha is deployed, but the process predates it and is executing older code.',
        safeAction: 'Restart the serving runtime. Another deploy will not change what is running.',
      },
      'process-unverified': {
        meaning:
          'A sha is deployed, but the serving process could not be probed — whether it is EXECUTING that sha is unestablished.',
        safeAction:
          'Do not conclude the deploy is live. Re-probe the serving runtime before relying on the deployed behaviour.',
      },
    },
    evidence: ['positions.deployed', 'verdictUnknown'],
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
      "devDeployState()'s release-checkout HEAD (a single `git log -1`), plus a live systemd probe for the independent start-time evidence",
    liveExercised: true,
    evidence:
      'dev:pipeline_position run against the live repo 2026-07-27T08:55Z returned deployedSha="dab4a3d8d7471313bd704f2aadbd0910025a470d" with serving.startedSinceCodeChange=true, pid=1607181, codeAsOfSource="deploy" — the independent start-time probe agreed on this read, and deployOrigin="stale-behind-gate" showed the deployed sha trailing the green pin by 19 commits, which is the state this cell exists to make legible.',
  },

  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',

  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'deployedSha' },
  doorProjections: [{ tool: 'release:deploy', path: 'deploy.deployedSha' }],
  shape: '{ deployedSha, serving: { startedSinceCodeChange, unknownReason, pid, codeAsOfSource }, verdictUnknown[] }',
};

/**
 * Cell 4 — is main fast-forwarded to the newest green pin.
 *
 * NAMING — AND THE POLARITY BUG IT USED TO CARRY (EI-20046248345042252). The cell is
 * `git.mainBehindStaging` because that is the question agents ask and hand-copy. It
 * used to headline `verdictProvenance.mainFastForwarded`, which is the SAME measurement
 * in the OPPOSITE polarity — so the cell answered its own name backwards: measured
 * 2026-08-10, `state:read { cell: 'git.mainBehindStaging' }` returned `false` while main
 * sat 22 commits behind staging. Because `greenPinAtStagingHead` is false in the normal
 * steady state (staging outruns the ~hourly gate), the wrong answer was the STANDING
 * one, not an edge case.
 *
 * The fix belongs in the RESOLVER, not here: `headline` is a field path and axis 5
 * forbids a surface from re-deriving (negating) what it projects, so
 * `verdictProvenance.mainBehindStaging` is published already-negated from the same
 * single read. Do not repoint this back at `mainFastForwarded`.
 *
 * There is still deliberately NO raw main-behind-staging COUNT — grepped
 * git-pipeline-stats, none exists — and inventing one would be a second derivation of a
 * question already answered (axis 5). The negated boolean is a projection, not a
 * derivation: same read, same `null`, one negation.
 */
export const MAIN_BEHIND_STAGING_CELL: CellSpec = {
  cell: 'git.mainBehindStaging',
  registeredOn: '2026-07-27',
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'verdictProvenance.mainBehindStaging',


  /**
   * D-009, first-match — and this is the table where the assessment contract most
   * obviously beats the boolean it wraps. `mainBehindStaging: true` carries TWO
   * opposite meanings that no amount of reading the boolean can separate:
   * `normal-buffer` (proceed, this is the steady state) and `gate-stalled` (recover
   * the producer). Only `gate.fireStale` tells them apart, which is why that
   * SCHEDULER-LIVENESS measurement — the green-checkpoint routine's own last-fire
   * timestamp against its fire interval, sharing no input with any commit-graph read —
   * is carried as evidence below rather than discarded with the retired axis-1 field.
   *
   * The safe action on `normal-buffer` is deliberately a REFUSAL to escalate. This is
   * the reading that made the deploy stage report degraded essentially always and
   * shadowed every real downstream cause (EI-11012).
   */
  assessment: {
    path: 'assessments.mainBehindStaging',
    codes: {
      'caught-up': {
        meaning: 'main is level with staging — there is no un-promoted buffer.',
        safeAction: 'Nothing outstanding on the promotion leg.',
      },
      'normal-buffer': {
        meaning:
          'main is behind staging while the gate is still FIRING — the ordinary steady state here, since git-sync commits continuously and the gate promotes only hourly and only when green.',
        safeAction:
          'Proceed. Do NOT report this as a stalled pipeline or open an incident for it: the lag alone is not a fault.',
      },
      'gate-stalled': {
        meaning: 'main is behind staging AND the gate is not firing — the buffer is not draining.',
        safeAction:
          'Recover the green-checkpoint producer. This is the reading a lag figure alone can never distinguish from the normal buffer.',
      },
    },
    evidence: ['gate.fireStale', 'verdictUnknown'],
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
      'dev:pipeline_position run against the live repo 2026-07-27T08:55Z returned mainFastForwarded=FALSE with lastGreenSha="7ad7d26cf991…", deployedBehindGreenPin=19 and stages[main].health="stalled" / detail "main is not fast-forwarded to the newest green pin", while the independent check gate.fireStale=false and lastGreenAtMs=1785142161612 showed the gate WAS still firing — i.e. the live system was in exactly the state this cell must not misreport as a stall.',
  },

  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',

  visibility: OPERATOR_PIPELINE_VISIBILITY,
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'verdictProvenance.mainBehindStaging' },
  shape:
    '{ verdictProvenance: { mainBehindStaging, mainFastForwarded, lastGreenSha, lastGreenAgeMs, deployedBehindGreenPin, deployOrigin }, verdictUnknown[] }',
};

/*
 * EI-20449419111876508 — HOST MEMORY-PRESSURE CELL.
 *
 * The infra-liveness alarm already had the authoritative derivation:
 * `readLatestPerfSignals()` → `evaluatePerfSignals()`. What it lacked was a
 * re-readable cell, leaving agents to reconstruct CURRENT pressure from old
 * fired/cleared messages. The resolver lens exposes `evaluateMemoryPressure()`,
 * which the full evaluator itself now consumes, so the pull surface and alarm
 * cannot drift into separate threshold implementations.
 */
export const HOST_MEMORY_PRESSURE_CELL: CellSpec = {
  cell: 'host.memoryPressure',
  registeredOn: '2026-08-14',
  owner: 'su-30c473f3-c5b8-43d0-bba2-8d6b40e1aabd',
  headline: 'memory.pressure',


  /**
   * D-010. `stable-low-free` is the code this table exists for: PSI says reclaim is
   * fine while free capacity is under the warning threshold, and BOTH halves of that
   * are true at once. The old boolean pairing could only report one of them, so a
   * reader got either a false alarm or a false all-clear depending on which field they
   * happened to read. Its `meaning` names the distinction and its `safeAction` closes
   * it with an explicit prohibition — reclaim capacity, but do NOT call this PSI
   * pressure, because escalating it as pressure is what teaches a fleet to discount
   * the real `warning`.
   *
   * ⚠ Single-purpose resolver, so the producer path is the bare `assessment` (D-008).
   */
  assessment: {
    path: 'assessment',
    codes: {
      critical: {
        meaning: 'PSI reports tasks stalling on memory reclaim at the critical threshold.',
        safeAction:
          'Stop adding load, and remove the attributed pressure source named in `memory.cgroupAttribution` rather than restarting blindly.',
      },
      warning: {
        meaning: 'PSI reports reclaim stalling at the warning threshold.',
        safeAction: 'Reduce or inspect load before starting anything new.',
      },
      'stable-low-free': {
        meaning:
          'Reclaim is STABLE, but immediately-free memory is below the declared capacity warning threshold. Both halves are true; they are different claims.',
        safeAction:
          'Reclaim capacity if you are about to allocate heavily — but do NOT report this as PSI memory pressure.',
      },
      stable: {
        meaning: 'Reclaim is stable and free capacity is above the warning threshold.',
        safeAction: 'No pressure action; proceed.',
      },
    },
    evidence: ['host.memFreePct', 'memory.stale', 'memory.unknown'],
  },

  /** Missing/stale inputs that cannot establish a band yield `pressure:null`.
   *  A measured threshold crossing may still establish a lower-bound warn/crit
   *  while the other missing leg stays hoisted in `memory.unknown`; absence is
   *  never collapsed to a healthy zero. */
  nullable: true,
  unknownHoist: 'memory.unknown',
  callerRelativity: { kind: 'global' },

  provenance: {
    obtainedBy:
      'the newest perf-signals-v1 capture via readLatestPerfSignals(), evaluated by the same evaluateMemoryPressure() branch consumed by the infra-liveness perf verdict; free-memory evidence via getHostSnapshot()',
    liveExercised: true,
    evidence:
      'host:memory_pressure run against the live 2026-08-14 perf capture returned a timestamped memory verdict with both PSI units, the exact PERF_BUDGETS thresholds, and an independently-sampled host.memFreePct; cell-assessment-reality exercises the real handler so shape drift cannot hide behind fixtures.',
  },

  resolver:
    'evaluateMemoryPressure(readLatestPerfSignals()) @ packages/operator-core/lib/system-health/perf-budgets.ts',
  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'host:memory_pressure', path: 'memory.pressure' },
  shape:
    '{ memory: { pressure: "ok"|"warn"|"crit"|null, measuredAt, ageMs, stale, psiMemorySome60, psiMemoryFull60, cgroupAttribution: { accounting, partial, top[{ path, memoryBytes, swapBytes, directPids }] }|null, thresholds: { source, psiMemorySomeWarn, psiMemoryFullCrit, staleMs, blindMs }, reasons[], unknown[] }, host: { measuredAt, memFreePct, memTotalGb, psiMemSome60 } }',
};

/* ═══════════════════════════════════════════════════════════════════════════════
 * P-016 — THE AGENT GOAL CELL
 *
 * The first cell on this registry that is about an AGENT rather than about the
 * tree, and the substrate D-051 and P-030 both wait on: "anything that can read a
 * cell can read a holder's goal", so eight holder-bearing surfaces each add a
 * LENS instead of each re-deriving a goal from their own columns.
 *
 * ⚠ IT IS THE CURRENT-STATE SURFACE, AND ITS SIBLING IS NOT. D-051 draws the line
 * this cell sits on: the DECLARATION (this) answers "what is this agent doing
 * right now" and belongs to presence/holder surfaces; the P-009 tool-call STAMP
 * answers "what was true when this call was made" and belongs to postmortems.
 * Deriving current state from the newest row of a historical log is a
 * re-derivation and a lossy one — it goes stale between calls and is silent for
 * an agent that has declared but not yet acted. Nothing here reads the stamp.
 * ══════════════════════════════════════════════════════════════════════════════ */
export const AGENT_GOAL_CELL: CellSpec = {
  // ⚠ THE ID IS IMPORTED, NEVER RETYPED. Every holder surface gates its goal read
  // on `getCell(AGENT_GOAL_CELL_ID, reader)`; a literal here that drifts from the
  // gate's literal there fails SILENTLY (getCell returns undefined and the surface
  // discloses nothing, forever). See the constant's own note.
  cell: AGENT_GOAL_CELL_ID,
  registeredOn: '2026-07-27',
  owner: 'unified-agent-state-plane-2026-07-27',
  headline: 'goalRef',


  /**
   * D-010. The three ref-bearing codes differ ONLY in how well-supported the ref is —
   * `corroborated` (a link-graph edge agrees), `sole` (one source, nothing agrees),
   * `divergent` (sources disagree or competing claims exist) — and they all return the
   * SAME `goalRef`. That is the point: a caller reading the ref alone cannot tell a
   * coin-flip from a corroborated answer, which is exactly the measured case (3 of 19
   * holders held two work-items at once).
   *
   * ⚠ EVERY EVIDENCE PATH IS FLAT, and that is not a style choice. `goal` is `null` for
   * an agent holding nothing, and `pathExists` stops at a null segment — so nesting any
   * of these under `goal.` would make the evidence absent, downgrading the assessment to
   * `unavailable` in THE SINGLE MOST ORDINARY CASE THERE IS. That is P-011's bug
   * verbatim, one field over: the headline was hoisted flat to avoid it and the
   * independent leg beside it was not. `coord:goal` hoists all three flat precisely so
   * this works.
   */
  assessment: {
    path: 'assessment',
    codes: {
      'nothing-held': {
        meaning:
          "The agent holds no work-item, plan-item claim or fleet mission — an honest \"nothing declared\", not a failed read.",
        safeAction: 'Treat the agent as unassigned. Do not infer a goal from its history or its last message.',
      },
      corroborated: {
        meaning:
          'A goal ref is held, an independent link-graph edge agrees it serves the claimed lane, and nothing competes with it.',
        safeAction: 'Act on the linked ref.',
      },
      sole: {
        meaning: 'A goal ref is held, but only one source names it — nothing corroborates it.',
        safeAction: 'Use the ref, and disclose that it rests on a single source whenever you rely on it.',
      },
      divergent: {
        meaning:
          'The sources disagree, or the agent holds competing claims naming different work, and precedence picked one of them arbitrarily.',
        safeAction:
          'Inspect ALL the refs in `goalCompeting` before coordinating. The returned ref may not be what the agent is actually doing.',
      },
    },
    evidence: ['goalAgreement', 'goalCompeting', 'goalUnknown'],
  },

  /**
   * Axis 2. TRUE — an agent holding nothing has no goal, and that is an honest
   * unknown rather than an empty string. `competing` is the hoist: a caller who
   * never inspects `agreement` still cannot miss that other claims exist, because
   * they are enumerated at the result level (D-039).
   */
  nullable: true,
  unknownHoist: 'goalUnknown',

  /** Axis 3. Relative to WHICH AGENT you are asking about — the cell cell-read.ts
   *  names as the motivating example for the `subject` parameter. */
  callerRelativity: { kind: 'parameter', param: 'ownerId' },

  /* ⚠ WHY THE HEADLINE IS TOP-LEVEL `goalRef` AND NOT `goal.ref`. `valueAtPath`
   * returns `undefined` as soon as any path segment is null, so a nested path
   * against a goal-less agent (`goal: null`) makes `readCell` answer
   * `insufficient-data` — a code whose message says the resolver's shape has
   * "drifted apart" from the cell. That would be a confidently WRONG diagnosis of
   * the most ordinary case there is: an agent holding nothing. Flattened, the same
   * case reads `value: null`, and `goalUnknown` carries the reason. */

  /**
   * Axis 4. Live-exercised against the real fleet BEFORE the resolver was
   * written, which is what produced the corroboration rule: the item's literal
   * "claimed work-item > plan item" precedence was measured to be
   * under-determined, and the edge is what resolves it.
   */
  provenance: {
    obtainedBy:
      'work_items.taken_by + plan_item_claims (live claims) + fleet_membership_events + an agent_facts override key, joined by coord_links `implements` edges',
    liveExercised: true,
    evidence:
      'Measured live 2026-07-27 across the whole fleet: 19 holders of a work-item, 4 also holding a plan-item claim, 0 holding a plan-item claim alone, 3 holding two work-items; the corroborating edges WI-6407→unified-agent-state-plane-2026-07-27#P-016 and WI-6390→learning-tab-surface-public-release-2026-07-27#P-007 were both confirmed present with their holders claiming exactly those plan items.',
  },

  /** Axis 5. ONE resolver. Every holder surface (P-025, P-030, the lock-block
   *  message) PROJECTS it through `getCell(cell, reader)` and never re-derives. */
  resolver: 'resolveOwnerGoal() @ packages/operator-core/lib/agent-tools/coordination/agent-goal-sources.ts',

  /**
   * P-019 (a). WORKSPACE-visible, and that is a decision rather than a default.
   * A narrower audience would make the cell useless for the thing it exists to
   * do — D-051's whole point is that a BLOCKED PEER reads the holder's goal to
   * decide whether to wait — and it would be a false promise of secrecy anyway:
   * `claim-holder.ts` records that a claim's goal is already disclosed
   * unconditionally to anyone who collides with it. The audience boundary here is
   * the claim read itself.
   *
   * P-019 (b). `local`: owner ids, `WI-` refs and plan slugs do not resolve in a
   * foreign hive, so the value would not merely be uninteresting there — it would
   * be actively misread as a statement about their own agents.
   */
  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },

  changeSignal: { kind: 'poll', tool: 'coord:goal', path: 'goalRef' },

  shape:
    '{ ownerId, goalRef: string|null, goalUnknown: "nothing-held"|null, goal: { ref, source, declaredAt, corroboratedBy, competing[], agreement } | null }',

  /**
   * Axis 6 is deliberately ABSENT. A goal has no stage order — the four SOURCES
   * are a precedence, not a sequence, and declaring them as stages would invite a
   * reader to treat `fleet-mission` as "further along" than `work-item`. Absence
   * means "this cell has no opinion", which is the honest answer.
   */
};

/* ═══════════════════════════════════════════════════════════════════════════════
 * deterministic-coverage-census-2026-08-17 P-005 — THE TWO COVERAGE CELLS
 *
 * A coverage number is the most transcribable value in this system: it is small,
 * it sounds like a fact, and it is quoted into plans, completion evidence and
 * status reports where nobody re-reads it. It is also one of the least stable —
 * it moves every time the census runs or a test is deleted.
 *
 * They are a PAIR, split along the line between a RATIO and a COUNT, because the
 * two have different honesty problems. The ratio has no answer over an empty
 * population (nullable). The population is a row count and always has one
 * (not nullable). Collapsing them into a single cell would force one of those
 * two truths to be stated wrongly.
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * WHY THE POPULATION IS A CELL AT ALL, and not just a field of the one below: it is
 * the independent check on the ratio, and a check a reader cannot independently
 * re-read is a promise rather than a check.
 */
export const TESTING_CENSUS_POPULATION_CELL: CellSpec = {
  cell: 'testing.census.population',
  registeredOn: '2026-08-18',
  owner: 'deterministic-coverage-census-2026-08-17',
  headline: 'census.surfaces',

  /**
   * D-010. Three of these four codes are reached with `surfaces === 0`, and they are
   * the reason this cell has an assessment at all: the number is identical in every
   * one, while the actions are register-a-provider, run-the-census, and trust-the-zero.
   * A count cannot carry that, and the day the whole feature sat inert (all four census
   * tables at 0 rows, cadence reporting healthy fires) is what a reader branching on
   * the count alone could not see.
   *
   * `empty-measured` is the code that had no name before: a census that RAN and honestly
   * found nothing. Without it, an accurate zero is indistinguishable from an unasked
   * question, and readers learn to discount both.
   */
  assessment: {
    path: 'assessments.censusPopulation',
    codes: {
      'no-providers': {
        meaning:
          'Zero surfaces AND zero registered providers — the census loop had nothing to iterate, so it could not have written a surface however healthy its fires look.',
        safeAction:
          "Register or enable a provider. Do NOT read the zero as \"this project has nothing to test\".",
      },
      'census-not-run': {
        meaning: 'Providers are registered, but no census run has ever written a surface row for this scope.',
        safeAction: 'Run or repair the census before quoting any population figure.',
      },
      'empty-measured': {
        meaning:
          'Providers are registered and a census HAS run — it enumerated zero matching surfaces. The zero is a measurement.',
        safeAction: 'Trust the zero. Widen the scope or filters if you expected rows.',
      },
      populated: {
        meaning: 'The census enumerated a non-empty surface population.',
        safeAction: 'Use the count together with its fidelity and basis, which qualify what it counted.',
      },
    },
    evidence: ['census.providersRegistered', 'census.lastCensusAt'],
  },

  /**
   * Axis 2. FALSE, deliberately, and the asymmetry with its sibling is the point:
   * this is a COUNT of rows, so 0 is a real measurement rather than an absent one.
   * Declaring it nullable would invent an unknown that cannot occur and teach
   * readers to discount an honest zero.
   */
  nullable: false,
  callerRelativity: {
    kind: 'ambient',
    source:
      'the census scope — the operator home harness + active workspace, resolved by resolveCensusScope(); a cell reader cannot pass it',
  },

  provenance: {
    obtainedBy:
      'count(*) over harness_shared.testing_surface_depth for the scope, alongside a count over census_provider_registrations, via the testing:coverage handler',
    liveExercised: true,
    evidence:
      'Run live against the operator DB 2026-08-18T14:1xZ: 1105 surfaces (http-route 832, mcp-tool 49, sync-query 224), all fidelity=declared, providersRegistered=3, lastCensusAt=2026-08-18T13:57:07.645Z. Exercised in its ZERO state first — before the registrations were seeded the same handler returned surfaces=0 with the no-providers-registered hoist, which is the branch this falsifier exists for.',
  },

  resolver:
    'the testing:coverage handler (assembleCoverage over harness_shared.testing_surface_depth) @ packages/operator-core/lib/agent-tools/testing/coverage.ts',

  visibility: { kind: 'workspace' },
  /** `local`: a surface population is a statement about THIS pot's own code. In a
   *  foreign hive it would not merely be uninteresting, it would be read as a
   *  claim about their surfaces. */
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'testing:coverage', path: 'census.surfaces' },
  shape:
    '{ census: { surfaces, retired, lastCensusAt, ageMs, providersRegistered, providersEnabled, fidelity: { counts, weakest, declaredPct }, basis }, verdict, censusUnknown[]|null }',
};

/**
 * The ratio. Registered SECOND so its pointer target already exists in the file's
 * reading order (registration order does not matter to the validator — pointer
 * targets are resolved at read time — but the reader's order does).
 */
export const TESTING_COVERAGE_FLOOR_CELL: CellSpec = {
  cell: 'testing.coverage.floor',
  registeredOn: '2026-08-18',
  owner: 'deterministic-coverage-census-2026-08-17',
  headline: 'coverage.pct',

  /**
   * ⚠ `census.surfaces` IS THE DENOMINATOR, AND IT IS CARRIED AS EVIDENCE BELOW FOR A
   * MEASURED REASON. The headline ratio JOINS surfaces against coverage_evidence; the
   * surface table ALONE, with no join, can disagree with it in both directions (a
   * population with no evidence, evidence for retired surfaces). Two readings depend on
   * seeing it, and the second is the subtle one:
   *   - the vacuous ratio: 0 of 0 rendered as 0% or 100%.
   *   - the TRUNCATED population: a ratio computed over a world smaller than the real
   *     one, which always flatters. Measured 2026-08-18: the mcp-tool population
   *     censused as 49 against 675 tool files on disk (WI-39812), so that kind's ratio
   *     was computed over 7% of its world and could not show the other 93% as gaps.
   */
  /**
   * D-010, with the code RENAMED to `no-population` per D-012 — the truth table called
   * it `not-measured`, which is also a `CellUnknownCode`, and D-008 forbids a domain
   * code that collides with the read-health vocabulary. That collision was undetectable
   * until a cell actually declared an assessment; see the producer's own note in
   * coverage.ts for why the fix landed there rather than here.
   *
   * The rule is right, and this cell is its sharpest case. An empty census is a MEASURED
   * FINDING — the census ran and found no denominator — while read-health `not-measured`
   * means the apparatus produced nothing. One token for both is precisely the confusion
   * that lets "we never looked" be reported as "there is nothing there".
   *
   * ⚠ `coverage.pct` is the HEADLINE and appears nowhere below. D-010 is explicit that
   * pct is evidence only and never the branch condition: the aggregate decides the code,
   * so a limit-capped row list cannot move it.
   */
  assessment: {
    path: 'assessments.coverageFloor',
    codes: {
      'no-population': {
        meaning:
          'There is no denominator — the census enumerated zero surfaces, so a ratio would be vacuous. This is a measured state of the census, NOT a failed read.',
        safeAction:
          'Follow `censusUnknown` to repair the census. Do NOT report 0% or 100%; neither is a measurement anyone made.',
      },
      'meets-floor': {
        meaning: 'Every censused surface meets the floor, with no unwaived gaps.',
        safeAction: 'No gap action outstanding.',
      },
      'below-floor': {
        meaning: 'Surfaces sit below the floor without a waiver.',
        safeAction: 'Work the returned unwaived gap queue.',
      },
      'measured-with-waivers': {
        meaning:
          'Nothing is below the floor UNWAIVED, but surfaces ARE below it under live waivers — the apparent pass rests on accepted exceptions.',
        safeAction:
          'Record that the gaps are waived rather than covered, and re-check the waivers before relying on the floor as evidence.',
      },
    },
    evidence: ['census.surfaces', 'coverage.below', 'coverage.belowUnwaived', 'verdict'],
  },

  /**
   * Axis 2. TRUE — and this is the whole reason the cell exists. `pct` is `null`
   * whenever its denominator is 0, never 0 and never 100. `censusUnknown` is the
   * result-level hoist enumerating WHY (no-providers-registered |
   * census-has-not-run | no-surfaces-match-filters), so a caller who reads only
   * the headline gets a null and a caller who reads only the hoist gets prose.
   */
  nullable: true,
  unknownHoist: 'censusUnknown',
  callerRelativity: {
    kind: 'ambient',
    source:
      'the census scope — the operator home harness + active workspace, resolved by resolveCensusScope(); a cell reader cannot pass it',
  },

  provenance: {
    obtainedBy:
      "count(*) FILTER (WHERE meets_lN) over harness_shared.testing_surface_depth, divided by the matching population — the view's own rung FLAG, never depth >= N, because the rungs are not nested",
    liveExercised: true,
    evidence:
      'Run live against the operator DB 2026-08-18T14:1xZ at floor l1: meets=0, below=1105, pct=0 with verdict "measured" and censusUnknown null — a GENUINE zero (the census enumerated 1105 surfaces and no attribution evidence exists yet), which is the reading that must not be confused with the vacuous one. The same handler over the pre-seed empty census returned pct=null + verdict "not-measured".',
  },

  resolver:
    'the testing:coverage handler (assembleCoverage over harness_shared.testing_surface_depth) @ packages/operator-core/lib/agent-tools/testing/coverage.ts',

  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'testing:coverage', path: 'coverage.pct' },

  /**
   * A coverage ratio moves on every census run as surfaces churn. The MATERIAL
   * change is whether the gap count moved — a percentage drifting because the
   * denominator grew by one route is not news, and a cell that woke a subscriber
   * for it would be unsubscribed within a day.
   */
  materiality: {
    path: 'coverage.below',
    why: 'the number of surfaces BELOW the floor is the actionable quantity — it is the gap queue\'s length. The ratio moves whenever the census adds or retires a surface, including when nothing about the testing changed; the gap count moves only when the set of unproven surfaces does.',
  },

  pointers: [
    {
      cell: 'testing.census.population',
      when: 'pct is null, or verdict reads "not-measured"',
      answers:
        'whether a census exists at all for this scope, and whether any provider was ever registered to produce one — the difference between "nothing is covered" and "nobody looked".',
    },
  ],

  shape:
    '{ verdict: "measured"|"not-measured", censusUnknown: string[]|null, coverage: { floor, floorMeans, surfaces, meets, below, waived, pct: number|null, fidelity, basis, byRung }, byKind[], census }',
};

/** Every built-in cell, in registration order. */
export const BUILTIN_CELLS: CellSpec[] = [
  GIT_PIPELINE_POSITION_CELL,
  GATE_VERDICT_CELL,
  GATE_CANDIDATE_CELL,
  GATE_OWNERSHIP_CELL,
  DEPLOYED_SHA_CELL,
  MAIN_BEHIND_STAGING_CELL,
  HOST_MEMORY_PRESSURE_CELL,
  AGENT_GOAL_CELL,
  TESTING_CENSUS_POPULATION_CELL,
  TESTING_COVERAGE_FLOOR_CELL,
];

/** Register every built-in cell. Idempotent — safe to call from more than one entry
 *  point, since re-registering an identical resolver is a no-op in the registry. */
export function registerBuiltinCells(): void {
  for (const spec of BUILTIN_CELLS) registerCell(spec);
}
