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

/** Register every built-in cell. Idempotent — safe to call from more than one entry
 *  point, since re-registering an identical resolver is a no-op in the registry. */
export function registerBuiltinCells(): void {
  registerCell(GIT_PIPELINE_POSITION_CELL);
}
