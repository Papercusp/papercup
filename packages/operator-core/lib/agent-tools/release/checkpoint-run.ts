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
import { defineTool, SU_ROLES, readJsonResult, type SeeAlsoEntry } from '@papercusp/agent-mcp';
import {
  assessPreLaunchExclusion,
  CANDIDATE_RERESOLVE_WINDOW_SEC,
  checkpointCandidateContainment,
  checkpointEligibilityPendingId,
  classifyReplaceRequest,
  launchDetachedCheckpoint,
  renderPreLaunchRefusal,
  REPLACE_STALE_MIN_AGE_SEC,
  scheduleCheckpointEligibilityWait,
  type CheckpointEligibilityWaitReceipt,
} from '../../release-checkpoint-launch';
import { integrationRoot } from '../../release-deploy-launch';
import { attributeRetriageToRun, describeRefireBudget, readInFlightRetriage } from '../../release/in-flight-retriage';
import { caveat, describeRefusal, isRefusedAnswer, refuseAnswer, withFieldReliability } from '../../field-reliability';
import { applyPendingMigrationsNow } from '../../db-boot-migrate';
import {
  readGateOwnership,
  shouldStandDownForLivePeer,
  ownershipNeedsLivenessConfirmation,
} from '../../coord/gate-ownership';
import { resolveAgentIdentity } from '../coordination/identity';
import { clampText, LIMITS, softText } from '../limits';

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
    /**
     * state-plane-adoption-2026-08-02 P-002 / D-001: route the gate's own verb at the
     * state plane, result-time rather than in `chaining` (see the plan decision — the
     * pointer belongs where the value is in the caller's hand, and `chaining` is
     * prompt-resident budget this family does not have).
     *
     * This tool is the single highest-value place in the repo for a "re-read, don't
     * transcribe" pointer: its `candidate` is the field CLAUDE.md devotes a whole
     * section to, because a run RE-CANDIDATES onto tip mid-flight (the in-process
     * auto-refire in green-checkpoint.ts) — so pid and started_at stay fixed while the
     * candidate legitimately advances. A candidate copied out of one reply and quoted
     * an hour later is how a correct observation becomes a confidently wrong report,
     * and it produced four contradictory agent verdicts in ninety minutes on
     * 2026-08-02. `state:read` re-answers it from the same resolver; `state:subscribe`
     * is the alternative to the re-fire reflex, which during a rescue window discards
     * the auto-refire and costs a full ~55min suite.
     */
    seeAlso: (result) => {
      const j = readJsonResult<{ already_running?: boolean; launched?: boolean }>(result);
      // Same TOON/serialization rail as dev:pipeline_position: seeAlso runs on the
      // SERIALIZED result, so a JSON-only gate can silently never fire. Fail open.
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
      const verdictIsComing =
        (j?.already_running ?? /\balready_running\b["']?\s*:\s*true/.test(text)) ||
        (j?.launched ?? /\blaunched\b["']?\s*:\s*true/.test(text));

      const out: SeeAlsoEntry[] = [
        'release:deploy (deploy the now-green pin — op:status then op:trigger)',
        'release:checkpoint-config (tune the checkpoint gate)',
      ];
      if (verdictIsComing) {
        out.push(
          {
            tool: 'state:read',
            selector: "{ cell: 'gate.greenCheckpoint.candidate' }",
            reason:
              'a run re-candidates onto tip mid-flight, so this candidate can go stale INSIDE one run — re-read it before you act on it or quote it, never transcribe it',
          },
          {
            tool: 'state:subscribe',
            selector: "{ cell: 'gate.greenCheckpoint.verdict' }",
            reason:
              'wait for the verdict to change instead of polling or re-firing — a re-fire during a rescue discards it and costs a full suite',
          },
        );
      }
      return out;
    },
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
        'Repo-relative files your change touches. The reply then reports callerEditsInCandidate { included, missing } — whether the commit this run judges actually CARRIES them, so a red you get back is unambiguously about your code. PASS THIS: without it the check falls back to the whole shared tree\'s uncommitted files, which includes peers\' edits and cannot see a change you already committed — and it is also what arms the pre-launch refusal (reason:would_exclude_declared_paths), which declines to spend a ~55min suite on a candidate that provably lacks these files.',
      ),
    waitForEligibility: z
      .boolean()
      .optional()
      .describe(
        'EI-20025784115349280: when the pre-launch check would refuse with would_exclude_declared_paths, enqueue a durable waiter that rechecks after the commits carrying your declared paths age into the quiet-cut window (wait_sec in that refusal, always ≤300s), then launches — instead of returning. The reply is immediate with pending_id, workflow_id, and completion_events for checkpoint:await; the MCP call never sleeps across the transport deadline. Ignored unless the refusal would fire.',
      ),
    // EI-20031402866608444: ACCEPTED, not ignored. This arg used to be undeclared, and the schema
    // is additionalProperties:false, so passing it was an `invalid_input` that launched NOTHING —
    // 19 of 22 rejections over 14 days (~11% of ALL calls to this verb), 6 distinct agents on
    // 2026-08-09 alone, every observed case a reject-then-retry-without-it 3–6s later, usually
    // mid-incident on the fleet's highest-blast-radius verb. Agents kept passing it because the
    // sibling lever on this same surface REQUIRES one (release:deploy { op:'force', reason }).
    //
    // softText, not hardText, and deliberately: this verb's entire defect was REJECTING callers,
    // so it must not gain a second rejection path. There is no `min` (a terse "gate red" is a
    // fine reason) and no length rejection — the handler clamps at the stamp instead.
    reason: softText(LIMITS.SHORT_TITLE)
      .optional()
      .describe(
        'OPTIONAL: why you are firing the gate by hand. Recorded to this call\'s tool_invocations metadata as an audit trail for a ~55min suite fired on demand — it does NOT change the launch decision. Worth passing: the strings agents already send here are exactly what an auditor wants ("gate RED 3x / ~2h, main frozen, no run in flight"). Never rejected for length or terseness; clamped if very long.',
      ),
  }),
  async handler(args, ctx) {
    // No in-handler role gate: firing the verdict is verification-only + self-locked (see the
    // agentRoles note above). Access control is the invoke allowlist; any invoke-allowed red-fixer
    // may fire a fresh green verdict.
    //
    // WI-6946: preflight pending migrations BEFORE spawning the detached suite, not after. The
    // detached run's OWN internal preflight (green-checkpoint.ts, EI-18757975681519069) already
    // fails CLOSED — aborting as `green: null, reason: 'migrations-pending'` — the moment it finds
    // a migration it cannot apply, rather than judging staging against a schema known to be behind
    // it (a red made of missing-column failures reading as unrelated flakes, not a real verdict).
    // That is the RIGHT call. The defect this closes is entirely on the CALLER side of that: this
    // tool used to report `launched:true` + "up to ~55 min" — and, with `paths`, the reassuring
    // "✓ the judged candidate carries all N file(s) you named" — for a run that then aborted
    // INCONCLUSIVE ~60s later, with nothing telling the caller short of `cat`-ing a `/tmp` log the
    // tool's own note never mentions. Measured 2026-08-02: an agent read the ~55min ETA at face
    // value and waited ~18 minutes for a verdict from a run that had already exited at minute one.
    // Reusing applyPendingMigrationsNow() HERE — the exact same idempotent, retry-on-contention
    // function (EI-19320461261471579: 3 attempts, 400ms→2s backoff, closing the transient
    // lock_timeout case this bug was first measured against) the detached run itself calls as its
    // own preflight — means: (a) a transient contention failure is very likely already resolved by
    // the time this returns, so the common case now just launches normally with nothing pending
    // left for the detached run to trip over; (b) a genuinely-broken migration is caught HERE,
    // before the systemd unit is even created, so the caller gets an immediate, honest
    // `{ok:false, reason:'migrations-pending', pending:[...]}` instead of a misleading launch
    // receipt for a run about to self-abort.
    const migrationPreflight = await applyPendingMigrationsNow();
    if (migrationPreflight && migrationPreflight.failed.length > 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              launched: false,
              reason: 'migrations-pending',
              pending: migrationPreflight.failed,
              note:
                `NOT launched: ${migrationPreflight.failed.length} migration(s) failed to apply to the dev PG ` +
                '(left pending). Launching the suite now would judge staging against a schema known to be behind ' +
                'it — a red made of missing-column failures that reads as unrelated flakes, not a real verdict on ' +
                'your code — so this refuses rather than repeat the WI-6946 defect (launched:true + a ~55min ETA ' +
                'for a run that then aborts INCONCLUSIVE ~60s later with no way for the caller to know). A ' +
                'transient lock_timeout is ALREADY retried automatically inside this same call (3 attempts, ' +
                'backoff to 2s) — if you are seeing this, the failure(s) below are not that. Fix the migration ' +
                `and call this again. Pending: ${migrationPreflight.failed.map((f) => `${f.file}: ${f.error}`).join('; ')}`,
            }),
          },
        ],
      };
    }
    // P-007 (gate-ownership-condition-singleton-2026-08-03): stand down when a LIVE peer is
    // already on this incident.
    //
    // The refusals below this line all answer "is a RUN in flight?" — a question about the
    // systemd unit. This one answers a question no probe can: "is a PERSON already on the red?"
    // The gate's stall condition owns a singleton work-item (P-002/P-003), so "someone is fixing
    // this" is now a claim in the store rather than folklore, and firing a redundant ~55min suite
    // against a red a peer is mid-fix is the exact waste that singleton exists to prevent. On
    // 2026-08-02 several agents did precisely that to one another.
    //
    // FAILS OPEN, deliberately and in every direction: `force`, an unread store, a dead holder,
    // an ambiguous verdict, and the caller's own claim all proceed. `readGateOwnership` itself
    // degrades to `no-object` rather than throwing. This is COORDINATION on top of the run-lock
    // singleton, which remains the actual safety mechanism — so the cost of a false refusal
    // (wedging the fleet's only verdict lever) is far higher than that of a false allow (one
    // redundant suite, which is merely the status quo ante).
    // EI-20209536730887204. P-007 defines THREE liveness verdicts and only two were ever wired.
    // The third — `ownershipNeedsLivenessConfirmation()` (`draining`/`suspect`) — had ZERO
    // production callers, while `cell-registrations.ts` documented a routing to it as though it
    // shipped. So an AMBIGUOUS holder silently lost stand-down protection: `POSITIVELY_LIVE` maps
    // both states false, `shouldStandDownForLivePeer` returns false, and this handler fell
    // straight through to launch with nothing recorded. Observed live 2026-08-12T01:35Z on
    // WI-38026, whose holder went `suspect` while still making tool calls.
    //
    // What lands here is OBSERVABILITY, deliberately not the required-wake. Sending a wake and
    // treating a miss as abandonment changes what the fleet's only manual verdict lever DOES, and
    // it belongs in its own atomic change with its own test — not smuggled into a stamping fix.
    // Until then the ambiguous case is at least VISIBLE instead of indistinguishable from
    // "nobody holds this".
    //
    // Carried to the launch stamp below rather than stamped here, because that seam is
    // OVERWRITE-not-merge (see the EI-20031402866608444 note): a second ctx.metadata() call on a
    // path that continues would wipe every preLaunchExclusion key.
    let ownershipLivenessAmbiguous = false;
    if (!args.force) {
      const ownership = await readGateOwnership();
      // Resolving the CALLER can throw (a power-user ctx missing its uiClientId). If we cannot
      // tell who we are, we cannot tell whether the claim is our OWN — and refusing then would
      // block an agent from re-firing its own gate. Unknown identity ⇒ fail open, like every
      // other unknown on this rail.
      let callerOwnerId: string | null = null;
      try {
        callerOwnerId = resolveAgentIdentity(ctx).ownerId;
      } catch {
        callerOwnerId = null;
      }
      // The decision is PURE and lives in gate-ownership.ts so it is testable without firing a
      // ~55min detached suite; it is false for every unknown (unread/ambiguous/dead holder,
      // unidentified caller, own claim).
      if (shouldStandDownForLivePeer(ownership, callerOwnerId)) {
        const said = ownership.thread.recent.at(-1);
        // EI-20208253097914491. WI-37618 added the launch stamp below expressly because "a refusal
        // was indistinguishable in the ledger from a call that spent a ~55min suite" — but it was
        // placed BELOW this branch, which RETURNS, so the newer P-007 rail inherited the exact bug
        // that fix removed. A `condition_claimed` refusal landed in `tool_invocations` as
        // status='ok', error_code=NULL, metadata_json holding only transport keys: unreadable.
        //
        // Measured cost of that blindness: answering "is the stand-down even firing?" on
        // 2026-08-12 took eight queries and one falsified hypothesis, and was only recoverable
        // from an `output_size` coincidence (5 non-holder callers all landing on 1620-1622 bytes)
        // — an accident of payload shape, not a designed signal.
        //
        // Stamped HERE rather than by hoisting the later call: the seam is OVERWRITE-not-merge
        // (dispatch-stack.ts:550, "last write wins"), so a hoisted stamp would be WIPED by the
        // preLaunchExclusion stamp on every path that does not refuse. This branch is terminal, so
        // one stamp inside it is both safe and the only stamp this path will ever emit.
        ctx.metadata?.({
          standDown: 'condition_claimed',
          standDownWorkItem: ownership.workItem,
          standDownTakenBy: ownership.takenBy,
          standDownHolderSessionState: ownership.holderSessionState,
          ...(args.reason != null ? { fireReason: clampText(args.reason, LIMITS.SHORT_TITLE) } : {}),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                launched: false,
                reason: 'condition_claimed',
                work_item: ownership.workItem,
                taken_by: ownership.takenBy,
                holder_session_state: ownership.holderSessionState,
                taken_at: ownership.takenAt,
                // P-006's thread is ADVISORY (D-006) — it says what was posted, never whether the
                // claim is true. Surfaced so the caller can read the holder's own words instead of
                // re-deriving the red, and labelled so it is not mistaken for the liveness evidence.
                last_said: said ? { at: said.at, author: said.author, text: said.text } : null,
                thread_total: ownership.thread.total,
                note:
                  `NOT launched: ${ownership.workItem ?? 'the gate stall condition'} is CLAIMED by ${ownership.takenBy}, ` +
                  `whose session the presence oracle reports as '${ownership.holderSessionState}' — a LIVE peer actively on this red. ` +
                  'Firing now would spend a ~55min suite re-judging a candidate someone is mid-fix on, and the verdict would land ' +
                  'after their fix anyway. Read what they have already found (work_items:get on the item above, thread excerpt in ' +
                  '`last_said`) and coordinate — coord:send them — instead of re-deriving it. ' +
                  'If you have a fix THEY do not (or the claim is genuinely abandoned), pass force:true; this rail is coordination, ' +
                  'not a lock, and it never blocks a dead/ambiguous holder or your own claim.',
              }),
            },
          ],
        };
      }
      // Not a stand-down, but not a clean "nobody holds this" either. `true` ⇒ a holder exists
      // whose liveness the oracle calls AMBIGUOUS (`draining`/`suspect`), so this launch is
      // proceeding against work a peer may still be doing. Recorded, not blocked — see the note
      // above this `if` for why the required-wake is deliberately a separate change.
      ownershipLivenessAmbiguous = ownershipNeedsLivenessConfirmation(ownership) === true;
    }
    // EI-20025784115349280: the containment verdict below (L~479) is assembled ENTIRELY from
    // values `launchDetachedCheckpoint` computes ~29 lines BEFORE it spawns — so when the answer
    // is "this run will not judge the files you declared", we already knew it while the cheapest
    // possible action (not starting) was still available, and reported it only once the ~55min
    // suite held the gate's serial slot. Ask it here instead, and refuse in the one narrow case
    // where the wait is short, bounded, and provably resolves the exclusion.
    //
    // Fails OPEN in every ambiguous direction (see assessPreLaunchExclusion's contract): no
    // declared paths, a run already in flight, an unresolved candidate, an undecidable or
    // uncommitted miss, or a wait we cannot compute all LAUNCH. `force` skips it entirely.
    const preflight = await assessPreLaunchExclusion({ paths: args.paths, force: args.force });
    // WI-37618: the refusal below is returned to the CALLER and recorded NOWHERE else.
    // `tool_invocations` keeps only transport metadata and `output_ref` is a reference, not a
    // body, so a refusal was indistinguishable in the ledger from a call that spent a ~55min
    // suite — and a FALSE refusal, the one failure mode that would wedge the fleet's only manual
    // verdict lever, left nothing behind to audit. Stamp the outcome through ctx.metadata, which
    // MERGES with the transport keys rather than replacing them (verified against live rows:
    // handler-emitted childFailureCount/effectiveStatus sit alongside requestOrigin/uiClientId).
    //
    // `passed` is stamped too, carrying its `proceedReason`, for two reasons. The refusal rate
    // needs a DENOMINATOR — without one, "the gate never fires" and "the gate never fires
    // WRONGLY" are the same observation. And the fail-open paths are not equivalent:
    // 'declared-paths-in-candidate' means the gate ASSESSED and allowed, while
    // 'exclusion-undecidable' / 'candidate-unresolved' mean it could not assess at all.
    // Collapsing those into one bare 'passed' would rebuild the exact ambiguity this fixes.
    //
    // EI-20031402866608444: the caller's `reason` rides THIS SAME stamp rather than a second
    // ctx.metadata() call, and that is load-bearing, not stylistic. The seam is
    // overwrite-not-merge — dispatch-stack.ts:550 is explicit ("last write wins",
    // `exec.metadataJson = { ...data }`) — so a second call here would silently WIPE every
    // preLaunchExclusion key above. (The "metadata MERGES" note in the comment above is about
    // handler keys merging with TRANSPORT keys at finalize, a different axis.) Omitted entirely
    // when absent, so `metadata_json ? 'fireReason'` cleanly separates calls that gave one.
    let waitReceipt: CheckpointEligibilityWaitReceipt | null = null;
    if (preflight.refuse && args.waitForEligibility) {
      try {
        const root = integrationRoot();
        waitReceipt = await scheduleCheckpointEligibilityWait({
          paths: args.paths ?? [],
          waitSec: preflight.waitSec ?? 0,
          pendingId: checkpointEligibilityPendingId({
            root,
            candidate: preflight.candidate,
            tip: preflight.tip,
            paths: args.paths ?? [],
          }),
          root,
          force: args.force,
          replaceStale: args.replaceStale,
        });
      } catch (error) {
        // DBOS is deliberately fail-closed here. A request-side fallback to setTimeout would
        // recreate the transport timeout this path exists to prevent, while launching anyway
        // would violate the caller's explicit request to judge its declared files.
        ctx.log?.(
          `[release:checkpoint-run] durable eligibility wait unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    ctx.metadata?.({
      // Rides THIS stamp rather than its own call, for the overwrite-not-merge reason above.
      // Present only when true, so `metadata_json ? 'ownershipLivenessAmbiguous'` cleanly selects
      // the launches that went ahead against an ambiguous holder.
      ...(ownershipLivenessAmbiguous ? { ownershipLivenessAmbiguous: true } : {}),
      preLaunchExclusion: preflight.refuse
        ? waitReceipt
          ? 'scheduled'
          : args.waitForEligibility
            ? 'wait-unavailable'
            : 'refused'
        : 'passed',
      ...(args.reason != null ? { fireReason: clampText(args.reason, LIMITS.SHORT_TITLE) } : {}),
      ...(preflight.refuse
        ? {
            preLaunchCandidate: preflight.candidate,
            preLaunchTip: preflight.tip,
            preLaunchWaitSec: preflight.waitSec,
            preLaunchBlockedPaths: preflight.blockedPaths.map((b) => ({
              path: b.path,
              eligibleInSec: b.eligibleInSec,
            })),
            ...(waitReceipt
              ? {
                  preLaunchWaitPendingId: waitReceipt.pendingId,
                  preLaunchWaitWorkflowId: waitReceipt.workflowId,
                }
              : {}),
          }
        : { preLaunchProceedReason: preflight.proceedReason }),
    });
    if (preflight.refuse) {
      if (!args.waitForEligibility) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                launched: false,
                reason: 'would_exclude_declared_paths',
                candidate: preflight.candidate,
                tip: preflight.tip,
                quiet_cut_sec: preflight.quietCutSec,
                wait_sec: preflight.waitSec,
                blocked_paths: preflight.blockedPaths,
                note: renderPreLaunchRefusal(preflight),
              }),
            },
          ],
        };
      }
      if (!waitReceipt) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                launched: false,
                reason: 'wait_for_eligibility_unavailable',
                candidate: preflight.candidate,
                tip: preflight.tip,
                quiet_cut_sec: preflight.quietCutSec,
                wait_sec: preflight.waitSec,
                blocked_paths: preflight.blockedPaths,
                note:
                  `${renderPreLaunchRefusal(preflight)} ` +
                  'A durable eligibility waiter is not installed on this host, so no MCP sleep was attempted and nothing was spawned; retry after DBOS is available or use force:true.',
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              launched: false,
              pending: true,
              reason: 'waiting_for_eligibility',
              pending_id: waitReceipt.pendingId,
              workflow_id: waitReceipt.workflowId,
              completion_events: waitReceipt.completionEvents,
              candidate: preflight.candidate,
              tip: preflight.tip,
              quiet_cut_sec: preflight.quietCutSec,
              wait_sec: preflight.waitSec,
              blocked_paths: preflight.blockedPaths,
              note:
                `NOT launched yet — durable eligibility waiter ${waitReceipt.workflowId} will ` +
                `recheck after ~${preflight.waitSec ?? 0}s and launch only if the declared paths are eligible. ` +
                'Use checkpoint:await with one of completion_events for the detached verdict.',
            }),
          },
        ],
      };
    }
    const result = await launchDetachedCheckpoint({ force: args.force, replaceStale: args.replaceStale });
    // WI-6962: the host could not be asked whether a run is in flight, so we refused rather
    // than gambled. This is a DIFFERENT answer from already_running and needs a different
    // response: retry in a moment (the probe is a fork, and it fails under host pressure),
    // do NOT reach for force — force replaces a live unit, which is the harm we just avoided.
    if (!result.launched && result.reason === 'probe_failed') {
      const a = result.alreadyRunning;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              probe_failed: true,
              unit: a?.unit ?? null,
              probe_detail: a?.probe_detail ?? null,
              held_externally: a?.held_externally ?? false,
              started_at: a?.started_at ?? null,
              elapsed_sec: a?.elapsed_sec ?? null,
              note:
                `NOT launched: could not determine whether a checkpoint run is already in flight (${a?.probe_detail ?? 'systemctl probe failed'}). ` +
                'This is almost always transient host pressure starving the `systemctl show` fork — WAIT ~30s and call again; the probe is cheap and self-heals. ' +
                'Do NOT pass force:true to get past this: force does not "launch only if idle", it launches unconditionally, and systemd REPLACES the same-named transient unit — ' +
                'that kills a live suite mid-run and produces no verdict at all (WI-6962: exactly how the gate went 5h without a verdict on 2026-08-02). ' +
                (a?.held_externally
                  ? 'The shared run-lock IS currently held by a live process, so a run is genuinely in flight — wait for it via checkpoint:await.'
                  : 'If it keeps failing, check the user systemd manager (`systemctl --user status`) before doing anything else.'),
            }),
          },
        ],
      };
    }
    if (!result.launched && result.reason === 'already_running' && result.alreadyRunning) {
      const a = result.alreadyRunning;
      // P-004: a refusal is not a dead end — the in-flight run's verdict IS the one about
      // to land, so "does THAT candidate carry my files?" is exactly as decisive here as on
      // a successful launch, and is the difference between waiting for a useful verdict and
      // waiting for one that cannot mention your change.
      // EI-19343516395023183: the marker FIRST, because it changes both of the answers below.
      // This is the tool an agent fires precisely when the gate "looks stuck" — and inside the
      // re-triage window that firing DISCARDS the rescue and costs a full ~55min suite
      // (green-checkpoint.ts:2566's own words). The authoritative signal for that window existed
      // and was already surfaced on dev:pipeline_position, coord:orient and /admin/git — but not
      // HERE, at the one call site where acting on its absence does damage. On 2026-08-02 that
      // gap cost three agents a morning of diagnosing reds the refire cleared unaided, and one
      // near-miss recommendation to fire this very verb into a live rescue.
      const retriage = attributeRetriageToRun(await readInFlightRetriage(), a);
      // Only trust it for THIS run: a marker written before this run started belongs to an
      // earlier one, and reporting it would silence a genuinely new red with a stale rescue.
      const liveRetriage = retriage && retriage.belongsToRun !== false ? retriage : null;
      // P-001 (plan agent-epistemics-2026-08-02): preferring the marker was necessary but not
      // sufficient. When the marker is ABSENT and the run is `held_externally`, the only candidate
      // left is `a.candidate` — the checkpoint checkout's live HEAD, re-read after the fact
      // (release-checkpoint-launch.ts:686). That is an INFERENCE about a process this tool cannot
      // see, and it silently changes between two reads. Computing containment from it returns a
      // fully-formed `callerEditsInCandidate` verdict — files, reasons, a warning string — resting
      // on a field that cannot support one, and a caller has no way to tell that verdict apart
      // from one computed against an observed sha.
      //
      // That is the exact shape the 2026-08-02 post-mortem indicts: four careful agents produced
      // four contradictory answers in ninety minutes, each reasoning correctly from a field that
      // could not bear the weight. REFUSE rather than return a plausible number — a refusal that
      // names the authoritative source costs one query; a plausible wrong verdict costs a morning.
      const candidateIsInferred = !liveRetriage && (a.held_externally ?? false);
      // `candidate` is still RETURNED when inferred — annotating is not censoring, and it remains
      // the only hint available. What changes is that it can no longer be read as an observation.
      const candidateCaveats =
        candidateIsInferred && a.candidate
          ? [
              caveat({
                field: 'candidate',
                reliability: 'inferred',
                cannotAnswer: 'Which sha is this run judging?',
                insteadRead: "in_flight_retriage.refiring_candidate, or gate_health->'inFlightRetriage' in harness_shared.routines",
                because:
                  "read from the checkpoint checkout's live HEAD at release-checkpoint-launch.ts:686, not from the running process",
              }),
            ]
          : [];
      const containment = candidateIsInferred
        ? refuseAnswer({
            question: 'Does the in-flight run judge a candidate that contains your change?',
            because:
              'This run is held by a DIFFERENT process (the cron tick) and has published no in-flight-retriage marker, ' +
              "so the only candidate available is the checkpoint checkout's live HEAD re-read after the fact — an inference " +
              'about a process this tool cannot observe, which changes silently between reads.',
            insteadRead:
              "the run's OWN published state: SELECT metadata->'gate_health'->'inFlightRetriage' FROM harness_shared.routines " +
              "WHERE target_role='system:green-checkpoint' AND install_slug=<harness> AND workspace_id=<workspace> " +
              '(scope BOTH — the table is multi-tenant); or wait for the verdict via checkpoint:await, which names its own candidate',
          })
        : await checkpointCandidateContainment({
            // The marker is what the running process published about ITSELF; `a.candidate` is at best
            // a log read and, on the cron path this branch usually describes, an INFERENCE from the
            // checkpoint checkout's live HEAD. Prefer the observation — same precedence
            // `mapCheckpointRunInFlight` already applies for dev:pipeline_position.
            candidateSha: liveRetriage?.marker.refiringCandidate ?? a.candidate ?? null,
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
              // Spreads to NOTHING when the candidate is observed, so a healthy reply gains no
              // noise; adds `_fieldReliability` + `_fieldReliabilityWarning` only when it matters.
              ...withFieldReliability({}, candidateCaveats),
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
              // A REFUSAL renders as its own line rather than collapsing to `undefined` — an
              // absent warning reads as "no problem found", which is the opposite of the truth.
              containment_warning: isRefusedAnswer(containment) ? describeRefusal(containment) : containment.warning,
              /** EI-19343516395023183: the run's OWN published rescue state, or null when no
               *  refire is in flight (null means "no refire", NOT "unknown"). `candidate` above
               *  is the checkout/log reading; when this is present its `refiring_candidate` is
               *  the authoritative answer to "which sha is this run judging". */
              in_flight_retriage: liveRetriage
                ? {
                    from_candidate: liveRetriage.marker.fromCandidate.slice(0, 12),
                    refiring_candidate: liveRetriage.marker.refiringCandidate.slice(0, 12),
                    budget: describeRefireBudget(liveRetriage.marker).label,
                    at_cap: describeRefireBudget(liveRetriage.marker).atCap,
                    failing_files: liveRetriage.marker.failingFiles,
                    observed_at_ms: liveRetriage.marker.observedAtMs,
                    /** false ⇒ the previous rescue SUCCEEDED and these failures are fresh tree
                     *  churn imported by the newer cut, not the same breakage surviving. */
                    charged: liveRetriage.marker.charged ?? null,
                    /** null ⇒ this run's start time was unreadable, so we cannot PROVE the marker
                     *  is this run's. The stand-down advice holds either way; the attribution does not. */
                    belongs_to_this_run: liveRetriage.belongsToRun,
                  }
                : null,
              note: liveRetriage
                ? // Leads the note unconditionally — ahead of every held_externally/replaceStale
                  // branch below — because it is the only line here that can prevent damage
                  // rather than merely explain a refusal.
                  `🚨 AUTO-REFIRE IN FLIGHT — STAND DOWN. This run hit a red at ` +
                  `${liveRetriage.marker.fromCandidate.slice(0, 12)}, re-tested at tip, and RE-FIRED itself onto ` +
                  `${liveRetriage.marker.refiringCandidate.slice(0, 12)} (${describeRefireBudget(liveRetriage.marker).label}). ` +
                  `That is the gate REPAIRING ITSELF, not a wedge. Do NOT fire a manual run and do NOT kill it: ` +
                  `either discards the rescue and costs a full ~55min suite. ` +
                  (liveRetriage.marker.failingFiles.length > 0
                    ? `The ${liveRetriage.marker.failingFiles.length} file(s) it named (${liveRetriage.marker.failingFiles.slice(0, 4).join(', ')}${liveRetriage.marker.failingFiles.length > 4 ? ', …' : ''}) already PASSED at tip — do not go fix them. `
                    : '') +
                  `Verify your own change against ${liveRetriage.marker.refiringCandidate.slice(0, 12)}, not ` +
                  `${liveRetriage.marker.fromCandidate.slice(0, 12)}, which this run has already discarded. ` +
                  `pid/started_at stay FIXED across a refire, so an advancing candidate under an unchanged ` +
                  `start time is the healthy signature — not corruption. ` +
                  (describeRefireBudget(liveRetriage.marker).atCap
                    ? `⚠ This is the LAST refire: if it comes back red the verdict STICKS and a human lever starts to matter. `
                    : '') +
                  (liveRetriage.belongsToRun === null
                    ? `(Attribution UNCONFIRMED: this run's start time was unreadable, so the marker could not be proven to be this run's — the stand-down still holds, the "this run" claim is unverified.) `
                    : '') +
                  `Wait for the verdict: checkpoint:await, then release:trace.`
                : a.held_externally
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
                  `A checkpoint run for this root is already in flight, held by a DIFFERENT process than the manual unit (almost certainly the hourly cron tick — it runs as a plain child process, not this unit, so this tool cannot see or control it directly). ${a.candidate ? `The checkpoint checkout's HEAD currently reads ${a.candidate.slice(0, 12)} — that is an INFERENCE about which sha this run is judging, NOT an observation of it: the checkout can move between two reads, and an in-process auto-refire advances the candidate while pid/started_at stay fixed. This run published no in-flight-retriage marker, so its candidate is genuinely undetermined here. Do NOT verify your fix against that sha on this basis alone — read gate_health->'inFlightRetriage' in harness_shared.routines (what the running process publishes about ITSELF, scoping BOTH install_slug and workspace_id), or wait for the verdict, which names its own candidate. It is certainly not current_candidate below.` : "This run's exact candidate could not be resolved (the checkpoint checkout wasn't readable) — do not assume it matches current_candidate below, which is only what a NEW run would pick if launched now."} force:true and replaceStale CANNOT free this slot — a forced launch would just spawn a second process that loses the identical run-lock race a moment later and silently produces no verdict (the exact failure this check exists to prevent). Wait for it instead: checkpoint:await (omit candidateSha to wake on this run\'s verdict regardless of exact sha, then release:trace to confirm your commit is included).`
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
