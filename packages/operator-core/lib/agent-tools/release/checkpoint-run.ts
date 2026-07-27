/**
 * release:checkpoint-run — fire the green-checkpoint GATE SUITE once, on demand (WI-1320 follow-up).
 *
 * Closes the last "no manual lever" gap in the release pipeline. The three moving parts each
 * now have a fire-now:
 *   - COMMIT  (staging ← agents' work) → git-sync:run
 *   - VERDICT (green pin ← full suite)  → THIS verb           ← was the missing one
 *   - DEPLOY  (:3070 ← green pin)       → release:deploy op:trigger/force
 *
 * The green-checkpoint is the VERDICT producer: it runs the full test battery under 8-fork load
 * and, if green, fast-forwards the green pin so release:deploy can ship it. It otherwise runs
 * ONLY on its hourly cron (or routines:set pause/retune) — so after fixing/quarantining reds you
 * had to WAIT up to an hour for a fresh verdict. This fires the SAME suite the cron tick runs.
 *
 * Detached (the suite runs up to ~55 min, bounded by RuntimeMaxSec) + OOM-safe: green-checkpoint.ts
 * self-locks, so firing this while a cron tick is mid-run no-ops rather than spawning a second
 * concurrent suite. Verdict lands on /admin/git, not this reply.
 *
 * WI-1562: a second manual fire while one was already in flight used to come back with only a
 * bare "may already be running" string — unclear enough that a concurrent caller could read it
 * as a transient failure and retry (or manually intervene), which starved the gate of a verdict.
 * Now the pre-launch check returns a STRUCTURED `already_running` reply (unit/candidate/
 * started_at/eta_sec) so a caller can tell "wait for it" from "try again" — pass `force:true` to
 * launch anyway.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  CANDIDATE_RERESOLVE_WINDOW_SEC,
  checkpointCandidateContainment,
  classifyReplaceRequest,
  launchDetachedCheckpoint,
  REPLACE_STALE_MIN_AGE_SEC,
} from '../../release-checkpoint-launch';

export default defineTool({
  name: 'release:checkpoint-run',
  profile: 'engineer',
  description:
    "FIRE the green-checkpoint NOW — run the full gate suite against current staging on demand (instead of waiting for the hourly cron tick), and if it's green, advance the green pin so release:deploy can ship it. The gate's VERDICT producer had no manual lever (only routines:set cron/pause) — the same gap git-sync:run closed for the commit routine. Use it after you've fixed or quarantined the reds to force a fresh verdict instead of waiting up to an hour. Detached (the suite runs up to ~55 min) + self-locked against a concurrent tick (won't OOM). Watch /admin/git for the verdict, then release:deploy { op:status } → op:trigger.",
  capability: 'operator:write',
  guidance: {
    when:
      "You've fixed or quarantined the reds and want a FRESH green verdict now rather than waiting for the next hourly green-checkpoint. Or the gate looks stale and you want to re-run the suite on demand.",
    notWhen:
      'To retune/pause the checkpoint cadence use routines:set. To SHIP an already-green pin use release:deploy op:trigger (checkpoint-run produces green; it does not deploy). To force an UN-green deploy use release:deploy op:force.',
    chaining:
      'fix/quarantine reds → release:checkpoint-run → (watch /admin/git for advanced/green) → release:deploy { op:status } → op:trigger { confirm:true }.',
    seeAlso: [
      'release:deploy (deploy the now-green pin — op:status then op:trigger)',
      'release:checkpoint-config (tune the checkpoint gate)',
    ],
  },
  requirePrincipal: false,
  // A red green-checkpoint blocks EVERY agent's deploys, and the persona tells any red-fixing
  // agent to "fix the reds → release:checkpoint-run → release:deploy". Firing the verdict is a
  // SAFE, verification-only op: it runs the suite and only ADVANCES the green pin if green — it
  // never ships code, mutates config, or regresses the pin, and green-checkpoint.ts self-locks so
  // a concurrent fire no-ops (won't OOM). So the invoke allowlist mirrors release:deploy's safe
  // ops — the full red-fix cohort — and there is NO in-handler operator-config-write gate (EI-7426:
  // the copy from checkpoint-config, which DOES mutate config, wrongly rejected the pipeline roles
  // the persona tells to fire it, recurring as a structural tool-error).
  agentRoles: [...SU_ROLES, 'cup', 'release-fixer', 'release-manager'],
  rolesQuota: { operator: { perRun: 5 } },
  args: z.object({
    force: z
      .boolean()
      .optional()
      .describe(
        'Skip the already-running refusal (WI-1562) and attempt the launch anyway. systemd itself still refuses a truly concurrent same-unit run — force only bypasses OUR proactive check and usually still fails while a run is genuinely active (EI-9672). Prefer replaceStale when the reply says candidate_stale:true.',
      ),
    replaceStale: z
      .boolean()
      .optional()
      .describe(
        'EI-9672: when the active run is CONFIRMED stale (candidate_stale:true in a prior already_running reply) AND ≥20 min old (EI-11667: a YOUNG stale run is normal on a busy tree and is refused, not stopped — serial replacement starves the gate of every verdict), stop that run and launch a fresh one. Unlike force, this actually frees the singleton; a run judging the current candidate is never stopped.',
      ),
    paths: z
      .array(z.string())
      .optional()
      .describe(
        'Repo-relative files your change touches. The reply then reports callerEditsInCandidate { included, missing } — whether the commit this run judges actually CARRIES them, so a red you get back is unambiguously about your code. PASS THIS: without it the check falls back to the whole shared tree\'s uncommitted files, which includes peers\' edits and cannot see a change you already committed.',
      ),
  }),
  async handler(args, _ctx) {
    // No in-handler role gate: firing the verdict is verification-only + self-locked (see the
    // agentRoles note above). Access control is the invoke allowlist; any invoke-allowed red-fixer
    // may fire a fresh green verdict.
    const result = await launchDetachedCheckpoint({ force: args.force, replaceStale: args.replaceStale });
    if (!result.launched && result.reason === 'already_running' && result.alreadyRunning) {
      const a = result.alreadyRunning;
      // P-004: a refusal is not a dead end — the in-flight run's verdict IS the one about
      // to land, so "does THAT candidate carry my files?" is exactly as decisive here as on
      // a successful launch, and is the difference between waiting for a useful verdict and
      // waiting for one that cannot mention your change.
      const containment = await checkpointCandidateContainment({
        candidateSha: a.candidate ?? null,
        tipSha: a.current_head ?? null,
        paths: args.paths,
      });
      // EI-18757736867106199: the ADVICE must come from the SAME oracle as the ENFORCEMENT.
      // classifyReplaceRequest (EI-18757156963245979) already refuses to stop a `delivering`
      // run at any age — but this note was still computed from age ALONE, so the tool went on
      // telling callers "Pass replaceStale:true to stop it" about runs it would then refuse to
      // stop. That disagreement is not cosmetic: it is the documented path to the harm. On
      // 2026-07-27 a caller followed this very string against a run 85s into its stale-red
      // re-triage; being told by the tool that killing it was correct, the refusal read as an
      // obstacle rather than an answer, and the run was killed out-of-band instead — discarding
      // an auto-refire that was working. Deriving both from one call makes that class
      // unreachable: the string can no longer recommend a move the policy rejects.
      const replaceDecision = classifyReplaceRequest(a);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              already_running: true,
              unit: a.unit,
              candidate: a.candidate ?? null,
              current_head: a.current_head ?? null,
              current_candidate: a.current_candidate ?? null,
              candidate_stale: a.candidate_stale ?? false,
              quiet_cut_sec: a.quiet_cut_sec ?? null,
              started_at: a.started_at ?? null,
              elapsed_sec: a.elapsed_sec ?? null,
              eta_sec: a.eta_sec ?? null,
              replace_refused_young: a.replace_refused_young ?? false,
              // EI-18757736867106199: expose the phase signal the decision actually turns on.
              // It was computed and enforced but never returned, so a caller could not see WHY
              // a replace was refused — only that it was.
              delivering: a.delivering ?? null,
              replace_refused_delivering: a.replace_refused_delivering ?? false,
              /** The policy's own verdict on `replaceStale` for THIS run — the same call the
               *  launch path enforces, so the note below can never recommend a rejected move. */
              replace_allowed: replaceDecision.replace,
              replace_refused_reason: replaceDecision.replace ? null : replaceDecision.reason,
              held_externally: a.held_externally ?? false,
              callerEditsInCandidate: containment,
              // Lead with it: the caller's next move differs entirely depending on whether
              // the run it is being told to wait for can even see the change.
              containment_warning: containment.warning,
              note: a.held_externally
                ? // WI-5685: the shared run-lock (cron + manual serialize on the SAME lock) is held by a
                  // process that is NOT this root's manual unit — almost certainly the hourly cron tick.
                  // force:true would still spawn (this proactive check is the only thing standing in the
                  // way), but that new process would just lose the exact same lock race a second later and
                  // produce no verdict either — force/replaceStale are BOTH useless here, unlike the
                  // manual-vs-manual collision case below. The only real lever is to wait for the verdict:
                  // it covers your commit too as long as your commit is an ancestor of whatever it judges
                  // (release:trace confirms after waking if you didn't pass candidateSha).
                  // EI-18695275971973546: `candidate` above is (best-effort) the REAL judged sha, read
                  // straight from the isolated checkpoint checkout's own HEAD — trust IT for "what is this
                  // run testing", never `current_candidate`/`candidate_stale` below, which describe a
                  // HYPOTHETICAL run started fresh right now, not the one actually in flight.
                  `A checkpoint run for this root is already in flight, held by a DIFFERENT process than the manual unit (almost certainly the hourly cron tick — it runs as a plain child process, not this unit, so this tool cannot see or control it directly). ${a.candidate ? `The in-flight run is judging candidate ${a.candidate.slice(0, 12)} (read from the isolated checkpoint checkout's HEAD) — verify your fix against THAT sha, not current_candidate below.` : "This run's exact candidate could not be resolved (the checkpoint checkout wasn't readable) — do not assume it matches current_candidate below, which is only what a NEW run would pick if launched now."} force:true and replaceStale CANNOT free this slot — a forced launch would just spawn a second process that loses the identical run-lock race a moment later and silently produces no verdict (the exact failure this check exists to prevent). Wait for it instead: checkpoint:await (omit candidateSha to wake on this run\'s verdict regardless of exact sha, then release:trace to confirm your commit is included).`
                : replaceDecision.replace
                  ? 'A checkpoint run for this root is already in flight, judging an older candidate than current staging; it is OLD enough that it should have verdicted by now AND it has not published the `delivering` phase (EI-9672: the genuine wedged-salvage case). Pass replaceStale:true to stop it and launch a fresh run for the current candidate — force:true alone will NOT help (systemd still refuses the collision).'
                  : replaceDecision.reason === 'delivering'
                    ? // EI-18757736867106199: the case that used to read "pass replaceStale:true".
                      // A run here has FINISHED its suite and is in the verdict path — it may be
                      // re-triaging a stale red and auto-refiring onto a newer tip, which is the
                      // gate repairing itself. Age cannot distinguish this from wedged; the phase
                      // can, and it is decisive.
                      'A checkpoint run for this root is already in flight and has published the `delivering` phase: its SUITE IS DONE and it is in the verdict path (stale-red re-triage → auto-refire → prefix salvage). It is seconds-to-minutes from a verdict, and may VOID a stale red and re-fire itself onto a newer tip — this is the gate self-healing, not a wedge. It is NOT replaceable at any age: replaceStale:true will be refused (replace_refused_delivering), and killing it out-of-band DISCARDS the salvage (that is exactly how four consecutive runs died on 2026-07-27 with nothing actually broken). Wait for it: checkpoint:await, then release:trace to confirm your commit is included.'
                    : replaceDecision.reason === 'young'
                      ? `A checkpoint run is in flight and its candidate trails current staging — that is NORMAL for a young run on a busy tree (the tip moves faster than the ~20-55 min suite runs; the NEXT run picks up the newer tip). Do NOT replace it: serial replaceStale calls are the EI-11667 replace-storm that starves the gate of every verdict. Wait for its verdict (see eta_sec); replaceStale only unlocks once the run is ≥${Math.round(REPLACE_STALE_MIN_AGE_SEC / 60)} min old AND not delivering.`
                      : 'A checkpoint run for this root is already in flight and its candidate matches the current quiet-cut-eligible staging state; a re-fire is unnecessary and replaceStale will NOT touch it (only a confirmed-stale run is ever stopped) — wait for it, or pass force:true to launch a second one anyway.',
            }),
          },
        ],
      };
    }
    // WI-5124: the #1 reason this tool is fired manually is "I just fixed the reds — re-judge"
    // — at which point the fix may be seconds old and the quiet-cut (default 240s) silently
    // steps the candidate BACK to an older commit that doesn't have it, guaranteeing a red on
    // tests the caller just fixed. Surface that loudly in the reply instead of leaving it only
    // in the detached process's own /tmp log (which nobody reads when the tool just said ok:true).
    // P-004 (EI-18752644493166307): the containment check, at the moment of the mistake.
    // Prose could not do this — the filer had restated the correct rule to the owner an
    // hour before making both mistakes, which is the evidence that a rule you must recall
    // at exactly the right instant is a detector that only fires for someone who already
    // knows. It belongs in the return value.
    const containment = result.launched
      ? await checkpointCandidateContainment({
          candidateSha: result.willJudge?.candidate ?? null,
          tipSha: result.willJudge?.tip ?? null,
          paths: args.paths,
        })
      : null;

    const excluded = result.willJudge?.excludedCommits ?? [];
    const excludedPaths = result.willJudge?.excludedPaths ?? [];
    // EI-18759622667757826: the exclusion is a pure AGE test and the detached run re-resolves
    // its candidate ~1-2s from now, so an excluded commit that is seconds short of the quiet
    // window will be judged after all. Split them out: the two cases need opposite advice, and
    // conflating them is what let a caller read "excluded" as "this run is worthless".
    const agingIn = (result.willJudge?.excludedEligibility ?? []).filter(
      (e) => e.eligibleInSec <= CANDIDATE_RERESOLVE_WINDOW_SEC,
    );
    const soonestSec = result.willJudge?.soonestEligibleInSec ?? null;

    // COMPOSED, not either/or. The containment verdict is the SPECIFIC answer and the
    // exclusion notice is the GENERIC one, so containment leads — but the generic notice
    // is not dropped, because a caller may have edited files it did not declare. An
    // earlier either/or chain let the generic branch shadow a definitive positive, which
    // is the same "the reader must resolve it themselves" failure in a new place.
    const declaredAllIn =
      !!containment && containment.source === 'caller-supplied' && !containment.missing.length && !!containment.included.length;
    const containmentPart = containment?.warning
      ? ` ${containment.warning}`
      : declaredAllIn
        ? ` ✓ the judged candidate carries all ${containment.included.length} file(s) you named — this is a real verdict on your change.`
        : '';

    // The old text ended at "if your fix is among them" and listed SHAS — the one space the
    // reader has no information about. Answer in PATH space, which a caller can match
    // against its own edits at a glance.
    const touchedPart = excludedPaths.length
      ? `Those commits touch: ${excludedPaths.slice(0, 8).join(', ')}${excludedPaths.length > 8 ? ` (+${excludedPaths.length - 8} more)` : ''}.`
      : `Excluded: ${excluded.slice(0, 5).join(' | ')}${excluded.length > 5 ? ' | …' : ''}`;

    // EI-18759622667757826: this sentence used to be written in the grammar of settled fact
    // ("quiet-cut EXCLUDED N commits … they get the NEXT run", "THIS run judges the older
    // version") about a decision the run had not made yet. It is a PREDICTION taken ~1-2s
    // before the detached run re-resolves its own candidate, and because the quiet cut is a
    // pure age test, its most likely error is the pessimistic one — telling a caller its
    // expensive in-flight run cannot see the fix, when the fix ages in and is judged after
    // all. A caller who believes that reaches for the only lever that looks like it helps:
    // killing the run. On 2026-07-27 the filer came within one call of doing exactly that to
    // the run that then went green and shipped. So: never assert the exclusion as fact, lead
    // with the aging number when it is about to flip, and never leave "kill it" as the
    // reader's inference — name waiting as the correct move.
    const excludedPart = !excluded.length
      ? ''
      : declaredAllIn
        ? ` (${excluded.length} newer commit(s) are predicted to fall outside this run, touching ${excludedPaths.slice(0, 4).join(', ') || 'other files'} — none of the files you named, which were checked.)`
        : agingIn.length
          ? ` ⚠ PREDICTION ONLY — and this one is probably PESSIMISTIC: ${agingIn.length} of ${excluded.length} commit(s) newer than the predicted candidate age into quiet-cut eligibility within ${CANDIDATE_RERESOLVE_WINDOW_SEC}s (soonest ~${soonestSec ?? 0}s), and this run re-resolves its OWN candidate ~1-2s after launch — so it will very likely judge them after all. ${touchedPart} Do NOT treat this as a verdict on your change and do NOT kill the run over it: wait for the real verdict (checkpoint:await), then release:trace to see what it actually judged.`
          : ` ⚠ PREDICTED exclusion: ${excluded.length} commit(s) newer than the predicted candidate are expected to fall outside this run${soonestSec == null ? '' : ` (soonest ages into eligibility in ~${soonestSec}s, past the ~1-2s re-resolution window)`}, so they would get the NEXT run. ${touchedPart} If you edited any of them, this run most likely judges the older version and a red from it is not evidence your change failed. The run re-resolves its candidate at start, so confirm with release:trace rather than assuming — and wait for the verdict either way; killing a live run is never the recovery.`;
    const excludedWarning = `${containmentPart}${excludedPart}`;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: result.launched,
            ...result,
            ...(containment ? { callerEditsInCandidate: containment } : {}),
            note: result.launched
              ? result.replacedStale
                ? `green-checkpoint suite launched (detached, up to ~55 min) after stopping a STALE prior run (was judging ${result.replacedStale.candidate?.slice(0, 12) ?? 'unknown'}, superseded by ${result.replacedStale.current_candidate?.slice(0, 12) ?? 'current staging'}). Watch /admin/git or the log for the verdict; if green it advances the pin. Then release:deploy { op:status } → op:trigger.${excludedWarning}`
                : `green-checkpoint suite launched (detached, up to ~55 min). Watch /admin/git or the log for the verdict; if green it advances the pin. Then release:deploy { op:status } → op:trigger.${excludedWarning}`
              : `not launched: ${result.reason ?? 'unknown'} — a manual checkpoint may already be running (see the log), or a cron tick is mid-run (which is fine — it will produce the verdict).`,
          }),
        },
      ],
    };
  },
});
