/**
 * events sugar verbs — thin, DISCOVERABLE named waits over `events:await`
 * (event-await-discoverability-and-coverage-2026-07-03 P-003, D-002/D-005).
 *
 * Each verb is a ~convenience wrapper that (a) puts a named await in the tool list
 * so an agent FINDS it (the whole plan's point — agents poll because they never
 * find `events:await`), and (b) builds the correctly-shaped key from the catalog
 * (`events/await/catalog.ts` — the single source of truth) so a key shape lives in
 * exactly one place. NOT a second subscription system: every verb resolves to the
 * same `registerAwait` the raw `events:await` uses. Mirrors how `coord:wake` /
 * `coord:dispatch` hide the `coord:inbox-wake:<owner>` key.
 *
 * D-005: because the sugar sources keys from the catalog, a future Phase 4 (fold
 * await into the ECA engine) reshapes HOW these resolve, not the verbs themselves.
 *
 * DUAL-OUTCOME verbs (deploy, checkpoint) arm awaits on the two MUTUALLY-EXCLUSIVE
 * outcome keys (success + failure) so the agent wakes either way — safe because a
 * deploy either lands OR fails, never both, so there is no double-wake. Keys that
 * CO-fire (the general work-item:status and the specific work-item:done) are never
 * armed together — the verb picks exactly one.
 */

import * as path from "node:path";
import { z } from "zod";
import { defineTool, SU_ROLES } from "@papercusp/agent-mcp";
import { resolveAgentIdentity } from "../coordination/identity";
import { captureWakeHandleForOwner } from "../../events/await/handle";
import { registerAwait, cancelAwaitsForSubscribersOnKeys } from "../../events/await/store";
import { startAwaitSweeper } from "../../events/await/engine";
import { buildKey } from "../../events/await/catalog";
import { clampText, LIMITS } from "../limits";
import { devDeployState } from "../../dev-deploy-state";
import { liveBlockedState, liveSettledProbe } from "../../work-items-events";
import { withBoundedTimeout } from "../../bounded-timeout";
import { CHECKPOINT_MAX_RUNTIME_SEC } from "../../release-checkpoint-launch";
import { gitPipelinePosition } from "../../git-pipeline-position";
import { gitPipelineSnapshot } from "../../git-pipeline-stats";
import { findGreenCheckpointVerdictForCandidate } from "../../harness/git-sync/pipeline-events";

// The fallback timeout-wake window + hard cap — one shared source of truth
// (await-timeout-fallback-defaults-2026-07-03): 30min default, matches events:await.
// Aliased to the local names so every usage/describe below is unchanged.
import {
  AWAIT_DEFAULT_TIMEOUT_SEC as DEFAULT_TIMEOUT_SEC,
  AWAIT_MAX_TIMEOUT_SEC as MAX_TIMEOUT_SEC,
} from "../../events/await/types";

/** Shared timeout arg — identical semantics to events:await's. */
const timeoutArg = z
  .number()
  .int()
  .positive()
  .max(MAX_TIMEOUT_SEC)
  .optional()
  .describe(
    `Deadline in seconds (default ${DEFAULT_TIMEOUT_SEC}); on the deadline you are woken with a TIMEOUT marker.`,
  );

// WI-5685: checkpoint:await used to inherit the GENERIC 1800s (30min) default above, which is
// shorter than the green-checkpoint suite can legitimately run — the systemd backstop alone
// (CHECKPOINT_MAX_RUNTIME_SEC) allows up to 3h, well past the suite's own in-process timeout, and
// the run can still be salvaging/emitting its verdict for a bit after that. A DEFAULT await
// therefore used to strand the caller mid-suite on every single default-timeout call (2 for 2 in
// the WI-5685 evidence) — not an edge case, the COMMON case, since most callers never think to
// override a generic-sounding default. Give this verb its OWN default derived from the suite's
// real worst-case ceiling instead of the one-size-fits-all generic default; explicit timeout_sec
// still always wins.
export const CHECKPOINT_AWAIT_DEFAULT_TIMEOUT_SEC = CHECKPOINT_MAX_RUNTIME_SEC + 10 * 60; // 3h backstop + 10min grace for the verdict to land/emit after the process exits

const checkpointTimeoutArg = z
  .number()
  .int()
  .positive()
  .max(MAX_TIMEOUT_SEC)
  .optional()
  .describe(
    `Deadline in seconds (default ${CHECKPOINT_AWAIT_DEFAULT_TIMEOUT_SEC} ≈ ${Math.round(CHECKPOINT_AWAIT_DEFAULT_TIMEOUT_SEC / 60)}min — WI-5685: sized to the suite's real worst-case ceiling, the ${Math.round(CHECKPOINT_MAX_RUNTIME_SEC / 60)}min systemd backstop + slack, NOT the generic events:await default (${DEFAULT_TIMEOUT_SEC}s) which used to strand a default-timeout caller mid-suite); on the deadline you are woken with a TIMEOUT marker.`,
  );

/**
 * Arm one or more awaits sharing ONE wake handle (captured now — the agent is
 * asleep at fire time). Mirrors events:await, so the sugar and the raw verb are
 * the same primitive. Returns the registered keys + a resume advice line.
 *
 * EI-12457: `opts.payloadFilter` (applied to every key in this call) binds the wait
 * to an exact subject (e.g. a candidate SHA) so a same-key fire for a DIFFERENT
 * subject never wakes this caller. `opts.supersedeKeys` cancels this SAME
 * subscriber's own prior, still-pending awaits on those keys FIRST — re-arming a
 * wait for a moved-on candidate retires the stale registration instead of leaving
 * it to accumulate/eventually fire a stale wake.
 */
async function armAwaits(
  ctx: Parameters<typeof resolveAgentIdentity>[0],
  keys: string[],
  note: string,
  timeoutSec: number | undefined,
  opts: { payloadFilter?: unknown; supersedeKeys?: string[] } = {},
): Promise<{
  ok: true;
  events: string[];
  await_ids: number[];
  superseded?: number;
  advice: string;
}> {
  const identity = resolveAgentIdentity(ctx);
  startAwaitSweeper();
  let superseded: number | undefined;
  if (opts.supersedeKeys && opts.supersedeKeys.length > 0) {
    try {
      superseded = await cancelAwaitsForSubscribersOnKeys([identity.ownerId], opts.supersedeKeys);
    } catch {
      /* best-effort — a failed retirement must never block arming the new wait */
    }
  }
  const { handle } = await captureWakeHandleForOwner(identity.ownerId, {});
  const awaitIds: number[] = [];
  for (const key of keys) {
    const row = await registerAwait({
      subscriberId: identity.ownerId,
      eventKey: key,
      policy: "wake",
      note: clampText(note, LIMITS.ANNOTATION) ?? null,
      wakeHandle: handle,
      timeoutBehavior: "wake",
      timeoutSec: timeoutSec ?? DEFAULT_TIMEOUT_SEC,
      payloadFilter: opts.payloadFilter ?? null,
    });
    awaitIds.push(row.id);
  }
  return {
    ok: true,
    events: keys,
    await_ids: awaitIds,
    ...(superseded != null ? { superseded } : {}),
    advice:
      "Registered. End your turn now — you are re-invoked when it fires (or at the deadline). Do not poll.",
  };
}

function reply(body: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(body) }] };
}

export function checkpointPipelineName(integrationRoot: string): string {
  const base = path.basename(path.resolve(integrationRoot));
  return (base.replace(/[^a-zA-Z0-9_-]/g, "-") || "default").slice(0, 64);
}

async function defaultCheckpointPipeline(): Promise<string | undefined> {
  try {
    const state = await devDeployState();
    return checkpointPipelineName(state.integrationRoot);
  } catch {
    return undefined;
  }
}

// ── EI-18676050719521433: the deploy-already-landed LATCH. `release:deployed:<sha>`
// is emitted ONLY for the shas in the deploy BATCH that ships them
// (apps/operator/lib/release/deploy.ts: plan.targetSha + each plan.commitShas) — a
// sha deployed in an EARLIER batch, awaited AFTERWARD, can never re-fire that exact
// key. Without an arm-time check the caller slept the FULL timeout holding its work-
// item claim even though release:trace already knew the target had landed (live
// case: su-29fe479d parked 2026-07-26T02:22Z on a sha release:trace confirmed was
// already deployed; the wait could only ever time out). Same class as the
// EI-9270 announced-gate latch and EI-13095 work-item:done latch elsewhere in this
// file/events:await — probe NOW, answer already_deployed instead of registering a
// dead-on-arrival wait. Best-effort + time-bounded: an unresolvable probe (timeout,
// unknown sha) falls through to a normal registration, never blocks arming.
async function deployAlreadyLiveProbe(
  sha: string,
): Promise<{ deployed: boolean; targetSha: string | null; deployedSha: string | null }> {
  const snapshot = await gitPipelineSnapshot();
  const position = await gitPipelinePosition(
    { sha },
    { loadSnapshot: () => Promise.resolve(snapshot), loadDeploy: () => Promise.resolve(snapshot.deploy) },
  );
  return {
    deployed: !!position.targetSha && position.positions.deployed,
    targetSha: position.targetSha,
    deployedSha: position.deployedSha,
  };
}

// ── deploy:await — "wake when my sha is live on :3070" ───────────────────────
defineTool({
  name: "deploy:await",
  description:
    "Sleep until a deploy lands (a staging sha reaches the live GREEN :3070 operator) instead of polling dev:pipeline_position. Arms awaits on BOTH release:deployed (success) and release:deploy-failed (failure) so you wake either way. Pass sha to target a specific commit; omit to wake on the next deploy of any sha. A targeted sha that is ALREADY live returns already_deployed immediately instead of registering a dead wait. Then END YOUR TURN.",
  capability: "coord:write",
  guidance: {
    when: "You left an edit in the tree and need it LIVE on :3070 before your next step — instead of re-polling dev:pipeline_position, arm this and end your turn.",
    notWhen:
      "Just checking where a change sits (not blocked on it) — that is dev:pipeline_position, one read. Forcing a deploy — release:deploy / the deploy-cli.",
    chaining:
      "deploy:await { sha } → end turn → on wake, payload.sha confirms which deploy landed; resume the work that needed it live.",
    seeAlso: [
      "events:catalog (all awaitable keys)",
      "dev:pipeline_position (a one-shot position read)",
      "events:await (the raw primitive)",
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    sha: z
      .string()
      .min(4)
      .max(64)
      .optional()
      .describe(
        "Target commit sha; omit to wake on the next deploy of any sha (the global key).",
      ),
    note: z
      .string()
      .max(LIMITS.ANNOTATION)
      .optional()
      .describe("Why you are waiting — echoed into the wake turn."),
    timeout_sec: timeoutArg,
  }),
  async handler(args, ctx) {
    const keys = [
      buildKey("deploy", { sha: args.sha }),
      buildKey("deploy-failed"),
    ];
    const note =
      args.note ??
      `deploy:await${args.sha ? ` ${args.sha}` : ""} — blocked until the deploy lands (or fails)`;

    if (args.sha) {
      const probe = await withBoundedTimeout(deployAlreadyLiveProbe(args.sha), {
        fallback: { deployed: false, targetSha: null, deployedSha: null },
        timeoutMs: 3_000,
        label: "deploy-await:alreadyDeployedLatch",
      });
      if (probe.value.deployed) {
        return reply({
          ok: true,
          already_deployed: true,
          event: keys[0],
          sha: probe.value.targetSha,
          deployedSha: probe.value.deployedSha,
          advice: `${args.sha} is ALREADY deployed (live on :3070) — its exact "${keys[0]}" key is emitted only for shas in a FUTURE deploy batch, so it can never re-fire for this one. Do not wait; proceed with the work that needed it live now.`,
        });
      }
    }

    return reply(await armAwaits(ctx, keys, note, args.timeout_sec));
  },
});

// EI-18676650746298156: checkpoint:await's candidateSha sibling to
// EI-18676050719521433's deploy-already-landed latch (deployAlreadyLiveProbe, above). A
// candidateSha binds via a payload predicate on a FUTURE `release:green`/
// `green-checkpoint:red` emit — a candidate ALREADY judged before the wait armed produces
// no future emit to match, so the caller would sleep the FULL (3h+) checkpoint timeout
// even though the verdict already exists.
//
// Unlike the deploy sibling this MUST be an exact-match probe against RECORDED verdicts
// (harness_shared.pipeline_events, kind='green_checkpoint'), never an ancestry/ready-pin
// check — WI-5685 is the OPPOSITE failure mode: a LATER candidate that still contains your
// commit must NOT short-circuit you, because its verdict is for a DIFFERENT candidate than
// the one you asked about. findGreenCheckpointVerdictForCandidate matches on the recorded
// `detail.candidate` exactly (prefix-safe both directions), so it can never conflate the
// two races. Best-effort + time-bounded, same contract as the deploy sibling: an
// unresolvable probe (timeout, no matching row) falls through to a normal registration,
// never blocks arming.
async function checkpointAlreadyJudgedProbe(
  candidateSha: string,
  installSlug: string | null,
  runId?: string,
): Promise<{ judged: boolean; green: boolean | null; status: string | null; createdAtMs: number | null }> {
  const match = await findGreenCheckpointVerdictForCandidate(installSlug, candidateSha, { runId });
  if (!match) return { judged: false, green: null, status: null, createdAtMs: null };
  const rawGreen = match.detail.green;
  return {
    judged: true,
    green: typeof rawGreen === "boolean" ? rawGreen : null,
    status: match.status,
    createdAtMs: match.createdAtMs,
  };
}

// ── checkpoint:await — "wake when the green gate resolves" ────────────────────
defineTool({
  name: "checkpoint:await",
  description:
    // WI-5690-drain: trimmed from a 1180-char description (was over the 1600-char
    // hard cap at 1875 total) — the detailed WI-5685 race-condition explanation now
    // lives ONLY on the candidateSha arg's own .describe() (still full detail there,
    // uncounted by the prompt-weight budget), not duplicated here.
    "Sleep until the pipeline green-checkpoint resolves — arms awaits on BOTH release:green:<pipeline> (passed) and green-checkpoint:red:<pipeline> (held), so you wake either way instead of polling. candidateSha (EI-12457) binds to your exact candidate; omit it to wake on any candidate and lineage-check payload.sha via release:trace — see the candidateSha arg description for the WI-5685 race caveat (a later candidate that still contains your commit will NOT wake a sha-bound await). A candidateSha ALREADY judged before you armed returns already_judged immediately instead of a dead wait. runId (WI-4957) binds to the exact judging run. pipeline overrides; global:true = every co-hosted pipeline. Re-arming retires your prior pending wait. Then END YOUR TURN.",
  capability: "coord:write",
  guidance: {
    when: "You need the gate verdict — green (your change cleared into main) or held/red — before proceeding, instead of re-polling dev:pipeline_position / dev:build_status.",
    notWhen:
      "Waiting for the DEPLOY (past the gate, live on :3070) — that is deploy:await. Configuring the gate — release:checkpoint-config. Unsure your commit will be the EXACT judged candidate (a cron tick may race ahead of you) — omit candidateSha instead of binding to a sha that may never be the one that verdicts; lineage-check with release:trace on wake.",
    chaining:
      "checkpoint:await { candidateSha } → end turn → on wake, payload tells you green (advanced) or red (payload.summary = failing tail) for this pipeline/candidate; resume or go fix the red.",
    seeAlso: [
      "events:catalog",
      "deploy:await (the next stage — live on :3070)",
      "release:trace (exact-SHA lineage check — use when you did NOT pass candidateSha)",
      "events:await",
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    pipeline: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        "Scope to ONE pipeline's gate — the repo basename of its integration root (e.g. 'papercusp'). " +
          "Omit to default to the current dev pipeline. Use global:true for the global keys, which wake " +
          "on EVERY co-hosted pipeline's verdict (EI-7646: you then must lineage-check payload.sha/payload.pipeline yourself).",
      ),
    candidateSha: z
      .string()
      .min(4)
      .max(64)
      .optional()
      .describe(
        "EI-12457: bind the wait to this exact candidate (full sha or a prefix) via a payload predicate on the " +
          "emitted payload.sha — a verdict for any OTHER candidate (a stale/superseded run) will NOT wake you; " +
          "you keep sleeping until the correct candidate resolves or the deadline. Strongly recommended whenever " +
          "you know which commit you are judging (e.g. right after a git-sync:await/deploy). WI-5685: this is an " +
          "EXACT match, not an ancestry check — a LATER candidate that still contains your commit (e.g. the hourly " +
          "cron races ahead and judges a newer tip) will NOT wake you even though its green verdict already covers " +
          "you. If a cron tick could plausibly land before your exact candidate does, omit candidateSha (wake on " +
          "ANY verdict for this pipeline) and confirm inclusion afterwards with release:trace instead of binding here. " +
          "EI-18676650746298156: if this EXACT candidate was already judged before you armed (recorded in " +
          "harness_shared.pipeline_events), you get already_judged:true immediately instead of sleeping to the " +
          "timeout — this is the same EXACT-match rule as above, so it can never be fooled by a later candidate " +
          "that merely contains your commit.",
      ),
    runId: z
      .string()
      .min(4)
      .max(64)
      .optional()
      .describe(
        "WI-4957: bind further to the EXACT run (payload.runId, an exact match) that judged your candidate — " +
          "only needed when two runs might judge the SAME candidate sha (a re-fire, or a routine/manual race) " +
          "and you must not accept the other one's verdict. Combines with candidateSha (both must match); rarely " +
          "needed on its own.",
      ),
    global: z
      .boolean()
      .optional()
      .describe(
        "Use the global release:green / green-checkpoint:red keys instead of the current pipeline's keys. Only for cross-pipeline monitors.",
      ),
    note: z
      .string()
      .max(LIMITS.ANNOTATION)
      .optional()
      .describe("Why you are waiting — echoed into the wake turn."),
    timeout_sec: checkpointTimeoutArg,
  }),
  async handler(args, ctx) {
    const pipeline = args.global
      ? undefined
      : (args.pipeline ?? (await defaultCheckpointPipeline()));
    const keys = [
      buildKey("checkpoint", { pipeline }),
      buildKey("checkpoint-red", { pipeline }),
    ];
    const note =
      args.note ??
      `checkpoint:await${pipeline ? ` [${pipeline}]` : " [global]"}${args.candidateSha ? ` @ ${args.candidateSha.slice(0, 8)}` : ""}${args.runId ? ` (run ${args.runId.slice(0, 8)})` : ""} — blocked until the green gate resolves`;
    // WI-4957: candidateSha and runId compose into ONE AND-filter — a payload must satisfy
    // both when both are given (payloadMatchesFilter/evaluateDataCondition treats a
    // multi-key MatchMap as an implicit AND, same as every other predicate in this codebase).
    const payloadFilter =
      args.candidateSha || args.runId
        ? {
            ...(args.candidateSha ? { sha: { startsWith: args.candidateSha } } : {}),
            ...(args.runId ? { runId: args.runId } : {}),
          }
        : undefined;
    // WI-5685: this verb's OWN default (not the generic events:await one) — see
    // CHECKPOINT_AWAIT_DEFAULT_TIMEOUT_SEC's doc comment for why the generic 30min default
    // strands a caller mid-suite.
    const timeoutSec = args.timeout_sec ?? CHECKPOINT_AWAIT_DEFAULT_TIMEOUT_SEC;

    // EI-18676650746298156: the already-judged latch — see checkpointAlreadyJudgedProbe's
    // doc above. Only meaningful when candidateSha is given (an unbound wait has no exact
    // candidate to look up, exactly like deploy:await skipping its probe when sha is omitted).
    if (args.candidateSha) {
      const probe = await withBoundedTimeout(
        checkpointAlreadyJudgedProbe(args.candidateSha, args.global ? null : (pipeline ?? null), args.runId),
        {
          fallback: { judged: false, green: null, status: null, createdAtMs: null },
          timeoutMs: 3_000,
          label: "checkpoint-await:alreadyJudgedLatch",
        },
      );
      if (probe.value.judged && probe.value.green !== null) {
        const firedKey = probe.value.green ? keys[0] : keys[1];
        return reply({
          ok: true,
          already_judged: true,
          green: probe.value.green,
          status: probe.value.status,
          event: firedKey,
          candidateSha: args.candidateSha,
          judgedAtMs: probe.value.createdAtMs,
          advice: probe.value.green
            ? `${args.candidateSha} ALREADY resolved GREEN (status=${probe.value.status}) — its exact "${firedKey}" key already fired when this candidate was judged and will not re-fire for it. Do not wait; proceed with the work that needed the gate green now.`
            : `${args.candidateSha} ALREADY resolved HELD/RED (status=${probe.value.status}) — its exact "${firedKey}" key already fired when this candidate was judged and will not re-fire for it. Do not wait; go fix the red / handle the hold now (dev:pipeline_position / release:trace for the current failing-test detail).`,
        });
      }
    }

    return reply(
      await armAwaits(ctx, keys, note, timeoutSec, {
        payloadFilter,
        // EI-12457: a re-await for this pipeline supersedes any prior pending
        // checkpoint-family wait this same subscriber still holds for it.
        supersedeKeys: keys,
      }),
    );
  },
});

// ── work-item:await — "wake on a work item's status change" ───────────────────
const WI_STATE_FAMILY: Record<string, string> = {
  done: "work-item-done",
  unblocked: "work-item-unblocked",
  blocked: "work-item-blocked",
  claimed: "work-item-claimed",
};

defineTool({
  name: "work-item:await",
  description:
    "Sleep until a work item changes status instead of polling work_items:get. With no `state`, arms the general work-item:status:<id> (ANY transition). With a single `state` (done|unblocked|blocked|claimed), arms only that specific key. Then END YOUR TURN.",
  capability: "coord:write",
  guidance: {
    when: "You are blocked on a peer/dependency work item (its completion, unblock, or any transition) — arm this and end your turn instead of re-reading work_items:get.",
    notWhen:
      "Just inspecting an item once — work_items:get. Waiting on a PLAN item (P-NNN) — plan-item:await. Ambient interest in a topic — topics:subscribe.",
    chaining:
      'work-item:await { id: "WI-123", state: "done" } → end turn → on wake the item has settled; continue.',
    seeAlso: [
      "events:catalog",
      "work_items:get (one-shot read)",
      "plan-item:await",
      "events:await",
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    id: z.string().min(1).max(64).describe("The work-item id, e.g. WI-1234."),
    state: z
      .enum(["any", "done", "unblocked", "blocked", "claimed"])
      .optional()
      .describe(
        "Which transition to wake on. 'any' (default) = the general status key; a specific state arms only that key.",
      ),
    note: z
      .string()
      .max(LIMITS.ANNOTATION)
      .optional()
      .describe("Why you are waiting — echoed into the wake turn."),
    timeout_sec: timeoutArg,
  }),
  async handler(args, ctx) {
    const state = args.state ?? "any";
    const key =
      state === "any"
        ? buildKey("work-item", { id: args.id })
        : buildKey(WI_STATE_FAMILY[state], { id: args.id });
    // Registration LATCHES (EI-13095): the sugar used to bypass the latches the raw
    // events:await handler carries, so a wait armed AFTER the fact could only time
    // out. Same probes, same answers: state:'done' on an ALREADY-settled item ⇒
    // already_done (the done key fired at settle time and never re-fires);
    // state:'unblocked' on an item with no live blocker / settled ⇒
    // already_unblocked (the P-006 edge-key latch). Best-effort + time-bounded —
    // an 'unknown' probe arms normally.
    if (state === "done") {
      const probe = await withBoundedTimeout(liveSettledProbe(args.id), {
        fallback: { verdict: "unknown" as const },
        timeoutMs: 1_500,
        label: "work-item-await:doneLatch",
      });
      if (probe.value.verdict === "settled") {
        return reply({
          ok: true,
          already_done: true,
          event: key,
          item_state: probe.value.itemState ?? "settled",
          advice: `${args.id} is ALREADY settled (${probe.value.itemState ?? "terminal"}) — "${key}" fired when it settled and will not fire again. Do not wait; proceed now.`,
        });
      }
    } else if (state === "unblocked") {
      const probe = await withBoundedTimeout(liveBlockedState(args.id), {
        fallback: "unknown" as const,
        timeoutMs: 1_500,
        label: "work-item-await:unblockedLatch",
      });
      if (probe.value === "unblocked" || probe.value === "settled") {
        return reply({
          ok: true,
          already_unblocked: true,
          event: key,
          item_state: probe.value,
          advice:
            probe.value === "settled"
              ? `${args.id} is already SETTLED — "${key}" will never fire. Do not wait on it.`
              : `${args.id} has NO live blocker right now — "${key}" fires only on a future blocked→unblocked edge. Proceed with the blocked work now.`,
        });
      }
    }
    return reply(
      await armAwaits(
        ctx,
        [key],
        args.note ?? `work-item:await ${args.id} (${state})`,
        args.timeout_sec,
      ),
    );
  },
});

// ── service:await-up — "wake when a service recovers" ────────────────────────
defineTool({
  name: "service:await-up",
  description:
    "Sleep until a monitored service transitions back to HEALTHY (service:up:<name>) instead of re-polling dev:service_health. Then END YOUR TURN.",
  capability: "coord:write",
  guidance: {
    when: "A service you depend on is down and you need it back before proceeding — arm this and end your turn instead of re-polling dev:service_health.",
    notWhen:
      "A one-shot health check — dev:service_health. Restarting the service yourself — the systemctl/dev:restart path.",
    chaining:
      'service:await-up { name: "inference-gateway" } → end turn → on wake it is healthy; resume.',
    seeAlso: [
      "events:catalog",
      "dev:service_health (one-shot read)",
      "events:await",
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    name: z
      .string()
      .min(1)
      .max(120)
      .describe(
        "The service name, e.g. inference-gateway / substrate-sidecar / git-sync.",
      ),
    note: z
      .string()
      .max(LIMITS.ANNOTATION)
      .optional()
      .describe("Why you are waiting — echoed into the wake turn."),
    timeout_sec: timeoutArg,
  }),
  async handler(args, ctx) {
    return reply(
      await armAwaits(
        ctx,
        [buildKey("service-up", { name: args.name })],
        args.note ?? `service:await-up ${args.name}`,
        args.timeout_sec,
      ),
    );
  },
});

// ── git-sync:await — "wake when my edit is committed" ────────────────────────
defineTool({
  name: "git-sync:await",
  description:
    'Sleep until git-sync commits the tree (git-sync:committed:<sha>) — the "is my edit committed yet" wait — instead of polling dev:pipeline_position. Pass sha to target a commit; omit to wake on the next git-sync commit. Then END YOUR TURN.',
  capability: "coord:write",
  guidance: {
    when: "You left an edit in the tree and your next step needs it COMMITTED (on origin/staging) — arm this and end your turn instead of re-polling dev:pipeline_position.",
    notWhen:
      "You need it LIVE on :3070 (past commit → gate → deploy) — that is deploy:await. You own the commit yourself — you do not (git-sync owns commit+push).",
    chaining:
      "edit a file → git-sync:await → end turn → on wake it is committed; continue.",
    seeAlso: [
      "events:catalog",
      "dev:pipeline_position",
      'deploy:await (the later "live on :3070" stage)',
      "events:await",
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    sha: z
      .string()
      .min(4)
      .max(64)
      .optional()
      .describe("Target commit sha; omit to wake on the next git-sync commit."),
    note: z
      .string()
      .max(LIMITS.ANNOTATION)
      .optional()
      .describe("Why you are waiting — echoed into the wake turn."),
    timeout_sec: timeoutArg,
  }),
  async handler(args, ctx) {
    return reply(
      await armAwaits(
        ctx,
        [buildKey("git-sync", { sha: args.sha })],
        args.note ?? "git-sync:await — blocked until committed",
        args.timeout_sec,
      ),
    );
  },
});

// ── plan-item:await — "wake when a plan item is done" ────────────────────────
defineTool({
  name: "plan-item:await",
  description:
    "Sleep until a plan item flips to done (plan-item:done:<slug>:<id>) instead of polling plans:get. Then END YOUR TURN.",
  capability: "coord:write",
  guidance: {
    when: "You are blocked on another plan item (a dependency P-NNN) finishing before you can proceed — arm this and end your turn instead of re-reading plans:get.",
    notWhen:
      "Inspecting a plan once — plans:get. Waiting on a WORK item (WI-NNN) — work-item:await.",
    chaining:
      'plan-item:await { slug, id: "P-014" } → end turn → on wake the item is done; continue.',
    seeAlso: [
      "events:catalog",
      "plans:get (one-shot read)",
      "work-item:await",
      "events:await",
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    slug: z.string().min(1).max(200).describe("The plan slug."),
    id: z.string().min(1).max(16).describe("The plan item id, e.g. P-014."),
    note: z
      .string()
      .max(LIMITS.ANNOTATION)
      .optional()
      .describe("Why you are waiting — echoed into the wake turn."),
    timeout_sec: timeoutArg,
  }),
  async handler(args, ctx) {
    return reply(
      await armAwaits(
        ctx,
        [buildKey("plan-item", { slug: args.slug, id: args.id })],
        args.note ?? `plan-item:await ${args.slug}:${args.id}`,
        args.timeout_sec,
      ),
    );
  },
});

// ── fleet:await-drained — "wake when my fleet's lanes are all done" ──────────
defineTool({
  name: "fleet:await-drained",
  description:
    "Sleep until every claimable item in a fleet's lanes is done (fleet:drained:<slug>) — the leader's \"wake me when the fleet drains so I can loop:end + write the scorecard\" wait — instead of re-checking the roster. Then END YOUR TURN.",
  capability: "coord:write",
  guidance: {
    when: "You lead a fleet and are waiting for it to finish all lanes before you loop:end + write the fleet-execution-health scorecard — arm this and end your turn instead of re-polling the roster each wake.",
    notWhen:
      "You still have leadership work to do this wake (directing members, acking pings). Checking roster once — fleet:status / coord:roster.",
    chaining:
      "fleet:await-drained { slug } → end turn → on wake the lanes are drained; loop:end + scorecard.",
    seeAlso: [
      "events:catalog",
      "fleet:status (one-shot roster)",
      "loop:end",
      "events:await",
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    slug: z.string().min(1).max(120).describe("The fleet slug."),
    note: z
      .string()
      .max(LIMITS.ANNOTATION)
      .optional()
      .describe("Why you are waiting — echoed into the wake turn."),
    timeout_sec: timeoutArg,
  }),
  async handler(args, ctx) {
    return reply(
      await armAwaits(
        ctx,
        [buildKey("fleet-drained", { slug: args.slug })],
        args.note ?? `fleet:await-drained ${args.slug}`,
        args.timeout_sec,
      ),
    );
  },
});
