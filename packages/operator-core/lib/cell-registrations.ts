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
    // Repointed to the polarity-correct projection of the SAME devDeployState reading
    // (EI-20046248345042252). The measurement is unchanged; only its sign is.
    field: 'verdictProvenance.mainBehindStaging',
    measurement:
      'a git ancestry check (is the newest green pin exactly at STAGING head, from devDeployState) — a REF-GRAPH measurement that shares no input with the green-checkpoint routine metadata the red streak is counted from. ⚠ pin-vs-STAGING, not pin-vs-main: the green pin IS main HEAD by devDeployState\'s own definition, so a pin-vs-main check could never diverge and would be a falsifier that can never fire (WI-6357 / EI-18790908999972569 corrected the same stale wording on the resolver field).',
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
      'dev:pipeline_position run against the live repo 2026-07-27T08:55Z returned gate.consecutiveReds=0 with fireStale=false — while verdictProvenance.mainFastForwarded=FALSE, deployedBehindGreenPin=19 and stages[main].health="stalled". THE FALSIFIER FIRED IN THE REAL SYSTEM: the headline read as a passing gate while an independent git-ancestry measurement showed main 19 commits behind the pin and not fast-forwarded. The tool\'s own summary said "gate reports 0 reds, but main has NOT fast-forwarded — do not read this as fully healthy". RE-EXERCISED 09:2xZ with the P-007 hoist in place, against the real gate_health blob: countersUnknown=null and verdictUnknown=[] — i.e. the live counter IS measured and the hoist correctly stays SILENT. That negative result is the one worth recording: a hoist that fired on the healthy path would be one agents learn to ignore.',
  },

  resolver: 'gitPipelinePosition() @ packages/operator-core/lib/git-pipeline-position.ts',

  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'gate.consecutiveReds' },

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
   * NOT a second falsifier (D-014). The mutual-falsifier pairing with cell 4 documented
   * above is untouched; this adds no measurement and kills no misreading of its own.
   */
  pointers: [
    {
      cell: 'gate.greenCheckpoint.ownership',
      when: 'the streak is nonzero (or `stalled`) — i.e. any time you are about to act on a red gate',
      answers:
        'WHO owns this red and whether that ownership is REAL — the owning work-item, its claim state, and the holder\'s live session state, which is the falsifier that separates "someone is on it" from a lease held by an agent that died. Read it before you claim the incident yourself or conclude nobody has it.',
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
 * A SEPARATE cell rather than a second falsifier on cells 1/2, because `CellSpec`
 * carries exactly ONE `falsifier` and the validator rejects a falsifier that is
 * the headline wearing a hat. The plan's P-005 assumed a cell could carry a
 * falsifier per BLOCK; it cannot, and the honest expression of "this block has its
 * own headline and its own independent check" is its own cell (see D-014).
 */
export const GATE_OWNERSHIP_CELL: CellSpec = {
  cell: 'gate.greenCheckpoint.ownership',
  owner: 'gate-ownership-condition-singleton-2026-08-03',
  headline: 'gate.ownership.claimState',

  falsifier: {
    field: 'gate.ownership.holderSessionState',
    measurement:
      "the presence oracle's per-owner liveness verdict (resolveSessionStates — heartbeat freshness, wakeability, a pid probe and recorded-session authority), which shares no input with the work-item lease columns `taken_by`/`expires_at` the headline is computed from",
    kills:
      '"someone is on it", read off a claim row. A lease lapses on a CLOCK, so a claim with a long or absent expiry reads `held` forever — including one taken by an agent that died minutes later. Reporting a dead holder as live ownership is worse than reporting none, because it actively suppresses the next agent from picking the work up. ⚠ CORRECTION 2026-08-03 (D-018): the VERDICT HELPER over this field, ownershipContradicted(), shipped in P-005 counting `recorded` as a dead holder. It is the opposite — `recorded` is authoritatively ALIVE per the session log, merely not inbox-wake-dispatchable, and the oracle classifies it before the heartbeat/pid path precisely so it is never force-ended. So the helper reported LIVE holders as abandoned claims: this falsifier`s own failure mode, sign-flipped. Only `ended` is a confirmed contradiction; `draining`/`suspect` are ambiguous and are CLASSIFIED by ownershipNeedsLivenessConfirmation(). ⚠ READ THAT PRECISELY (EI-20209536730887204): until 2026-08-12 this sentence said they "route to" that helper, which readers reasonably took to mean the ambiguous case was HANDLED — it was not. The helper had ZERO production callers, so an ambiguous holder silently lost stand-down protection and `release:checkpoint-run` fell straight through to launch with nothing recorded. It is now wired: checkpoint-run sends the holder a required wake; a delivered wake confirms a coordination-live peer and refuses the redundant launch, while a wake miss fails open so an uncertain signal cannot wedge the fleet\'s only verdict lever. Missed confirmations remain visible through `ownershipLivenessAmbiguous: true` metadata. The field itself was always right — the interpretation of it was not.',
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
      'P-006 (thread fold) re-exercised UNMOCKED 2026-08-03T02:55Z, and the run CAUGHT A REAL DEFECT that every unit test had passed over: the window reader was dispatching issue-family reads to work-items.ts\'s coord store, which is pinned to the `default` workspace while live issue threads sit in `papercusp-workspace`. It matched zero rows and returned a confident `total: 0` — WI-6857, which has TEN posts, read back as 0/0, indistinguishable from an item nobody had commented on. Fixed by dispatching issue-family to issues-engineer\'s dynamically-scoped store (guarded by work-items-thread-window-family-dispatch.test.ts). Post-fix live reads: WI-6857 -> shown 3 / total 10, oldest-first, bodies 3,933/4,928/2,317 chars all correctly flagged truncated at 400; EI-19379911903391487 -> topic pointer `topic:papercusp-improvement` with since=incident-start, proving the tags leg is scoped correctly too (its empty counterpart on WI-6857 is a genuine absence, verified by contrast); WI-7282 (bridge-minted) -> a MEASURED silence, shown 0 / total 0 / unknown null, which is the default state of a fresh incident since threads are created on first post; a nonexistent id -> `resolver-failed`, never silence. ALSO: readGateOwnership() run UNMOCKED against the live store 2026-08-03T02:22Z. (a) `green-stall:papercusp` resolved to a MEASURED `no-object` — the condition is genuinely resolved right now (alarm 2026-08-02T15:00:02Z, recovery 15:45:03Z), and the run confirms the empty is measured rather than a swallowed failure, since the same call path returned a real row for another key. (b) The shared condition query returned `single-primary:no-primary -> WI-7282, claimState claimable, duplicates []` — a live non-empty proving the join resolves real rows and the singleton holds. (c) THE FALSIFIER APPARATUS, exercised on real owners: resolveSessionStates returned `su-4a6e2255… -> live/heartbeatFresh:true` and a nonexistent owner -> `ended`/**heartbeatFresh:true**. That second pair IS the premise this falsifier rests on, observed live: heartbeat freshness reads TRUE for an owner the oracle calls ended, so a reader substituting heartbeatFresh for sessionState would report a dead holder as live. NOT yet covered live: a genuinely HELD lease contradicted by a dead holder — no agent has claimed this condition yet, so the held+ended path remains unit-only. THE RUN ALSO CAUGHT A REAL ERROR: it falsified the author\'s own recorded belief that the bridge was not yet running (it was — bg-host executes tsx straight from the staging tree, so no deploy is involved), which is precisely the confidently-wrong-resolver class this axis exists to catch.',
  },

  resolver: 'readGateOwnership() @ packages/operator-core/lib/coord/gate-ownership.ts',

  visibility: { kind: 'workspace' },
  federation: { kind: 'local' },
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'gate.ownership.claimState' },
  shape:
    '{ gate: { ownership: { eventKey, workItem, claimState, unknown, takenBy, takenAt, expiresAt, holderSessionState, duplicates[], ' +
    'thread: { recent[{ at, author, text, chars, truncated }], shown, total, topics[{ slug, ref, since }], unknown } } }, verdictUnknown[] }',
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
  owner: 'su-2846407f-4f4c-4313-8db8-dce7592e269d',
  headline: 'verdictProvenance.mainBehindStaging',

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
  changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'verdictProvenance.mainBehindStaging' },
  shape:
    '{ verdictProvenance: { mainBehindStaging, mainFastForwarded, lastGreenSha, lastGreenAgeMs, deployedBehindGreenPin, deployOrigin }, verdictUnknown[] }',
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
  owner: 'unified-agent-state-plane-2026-07-27',
  headline: 'goalRef',

  /**
   * Axis 1. NOT staleness — `HolderContext` rule (e) already carries that, and
   * reusing it here would add interpretation without new information.
   *
   * The independent measurement is the `coord_links` LINK GRAPH, which shares no
   * input with either claim row, and it kills a false reading the precedence rule
   * cannot see on its own: measured 2026-07-27, **3 of 19 holders hold TWO
   * work-items at once**, so "the one ref returned is what this agent is doing"
   * is a coin flip exactly when it matters. `agreement` says whether the legs
   * corroborate, diverge, or stand alone.
   */
  falsifier: {
    /**
     * ⚠ FLAT, for the reason the headline is flat — P-011 found this declared as
     * `goal.agreement`, which does not exist against a goal-less agent (`goal:
     * null`), making the falsifier unreadable in the most ordinary case there is.
     * `coord:goal` hoists it (goal.ts). Re-nesting this reintroduces the bug
     * silently, because every fixture with a goal in it still passes.
     */
    field: 'goalAgreement',
    measurement:
      "the coord_links `implements` edge joining a held work-item to a separately-claimed plan item — a link-graph read sharing no input with work_items.taken_by or plan_item_claims",
    kills:
      '"the single ref returned IS this agent\'s goal", when the agent holds several claims naming different work and precedence picked one arbitrarily. Measured: 3 of 19 holders hold two work-items; the edge is what says which one serves the claimed lane.',
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

/** Every built-in cell, in registration order. */
export const BUILTIN_CELLS: CellSpec[] = [
  GIT_PIPELINE_POSITION_CELL,
  GATE_VERDICT_CELL,
  GATE_CANDIDATE_CELL,
  GATE_OWNERSHIP_CELL,
  DEPLOYED_SHA_CELL,
  MAIN_BEHIND_STAGING_CELL,
  AGENT_GOAL_CELL,
];

/** Register every built-in cell. Idempotent — safe to call from more than one entry
 *  point, since re-registering an identical resolver is a no-op in the registry. */
export function registerBuiltinCells(): void {
  for (const spec of BUILTIN_CELLS) registerCell(spec);
}
