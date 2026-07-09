/**
 * fleet:launch-on-plan — stand up a desktop fleet ON a plan in ONE call.
 *
 * Collapses the multi-step "create a desktop fleet to work a plan" flow
 * (improve-fleet-launch-autokickoff / EI-5504) that used to be:
 *   fleet:create → write a launch brief → capability:terminal (N psu windows)
 *   → coord:send a manual kickoff wake to each parked member.
 * into a single tool:
 *   1. ensure the named fleet exists (idempotent) with the caller as leader;
 *   2. validate the target plan exists in the harness;
 *   3. open N visible desktop member terminals, each running a scripted psu
 *      launch on the plan.
 *
 * The members AUTO-START: a scripted `psu --no-picker --plan=…` launch now seeds
 * the agent's first user turn (EI-5503), so each member begins working the plan on
 * boot — no leader kickoff wake needed (the gap this pairs with).
 *
 * Plan AUTHORING + START stay their own well-factored tools (plans:apply-plan-block
 * / plans:new + plans:add-item, then plans:start) — chain them before this. plans:start
 * is REQUIRED, not optional: fleet members self-pull via `scheduler:get_next`, which leases
 * WORK-ITEMS (not raw plan items), and plan items become claimable work-items ONLY via the
 * plans:start promotion path (promotePlanItems). Skip plans:start and the fleet launches
 * onto an EMPTY backlog — every member's get_next returns nothing and they idle (the
 * research-desk 2026-07-08 miss: plan authored + set active, never started → zero work-items).
 * So the primary contract is "plans:start BEFORE this tool." As a FAILSAFE (not a substitute),
 * this tool idempotently promotes the plan's open items to claimable work-items before opening
 * any terminal, so a forgotten plans:start can never strand the fleet; it also sets a
 * plan-scoped claim spec so members' get_next stays on THIS plan.
 *
 * Reuses the maintained machinery rather than forking: createFleetIfAbsent (the
 * fleet:create registry path) + buildConsoleEnvelope/spawnConsole (the
 * capability:terminal desktop-spawn path). Desktop-spawn works on Linux + macOS
 * (server-side) AND Windows (WI-3289: relayed to the desktop shell's Tauri
 * console_launch over the sync-bus bridge — the desktop window must be open).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, SU_ROLES, fuzzyEnum } from '@papercusp/agent-mcp';
import { buildConsoleEnvelope } from '../../console-launcher';
import { spawnConsole } from '../../console-spawn';
import { activeWorkspaceId } from '../../workspace-registry';
import { papercuspPathForWorkspace } from '../../papercusp-root';
import { validateCloudModelSpec } from '../../agent-config-constants';
import {
  claimFleetLaunchSlot,
  createFleetIfAbsent,
  fleetSlugFromName,
  getFleetScheme,
  releaseFleetLaunchSlot,
} from '../../agent-fleets-store';
import { DEFAULT_CLAIM_SPEC } from '../../scheduler/claim-spec';
import { fleetSpecBeeKey, resolveClaimSpecWorkspace, setClaimSpec } from '../../scheduler/claim-spec-store';
import { heartbeatPresence, setPresenceFleet } from '../coordination/presence';
import { resolveHarnessPlansDir, readPlanBySlug } from '../plans/source';
import { fleetRoleFor, json, recolorCallerTerminal, resolveFleetCaller } from './_shared';
import { resolveSeatLaunch, seatAvailabilityForFleet } from '../../fleet/seat-accounting';
import type { ColorScheme } from '../../console-color-schemes';
import { liveFleetMemberIds } from '../../fleet/fleet-roster';
import { fetchGatewayHeadroom } from '../../inference-gateway/observability';
import { localModelIdsSync } from '../../inference-gateway/local-model-ids-cache';
import { buildCapacityReport, buildFleetSizingAdvisory } from '../../fleet/capacity-dispatch';
// type-only: the runtime call is a LAZY dynamic import in the handler (the promotion failsafe),
// keeping the heavy promotion graph out of this module's load path — the type is erased.
import type { PromotePlanResult } from '../../plan-workitem-promotion-run';

/** Opening more than this many desktop windows in one call is heavy + almost always
 *  a mistake — mirrors capability:terminal's MAX_TERMINALS. */
const MAX_MEMBERS = 12;

/** The operator's own base URL for the spawned terminal's API-callback env. Mirrors
 *  capability:terminal's resolver (strip a trailing /api/mcp back to the origin). */
function resolveOperatorBaseUrl(): string {
  const fromEnv = process.env.PAPERCUSP_OPERATOR_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/api\/mcp\/?$/, '').replace(/\/$/, '');
  const port = process.env.PAPERCUSP_HONO_PORT?.trim() || '3070';
  return `http://localhost:${port}`;
}

/** Optional psu launch flags threaded onto EVERY member's `psu` invocation (EI-5765 /
 *  owner request). Each maps to the matching `psu --flag=value`; `brain` is the boolean
 *  `--brain`; `extraArgs` is a verbatim escape hatch for any psu flag without a first-class
 *  field. The fleet/agent/harness/plan/no-picker tokens are owned by the tool and not
 *  overridable here. */
export interface MemberLaunchOpts {
  fleetSlug: string;
  agent: string;
  harness: string;
  plan: string;
  account?: string;
  workspace?: string;
  role?: string;
  model?: string;
  feature?: string;
  launchContext?: string;
  profile?: string;
  contextSize?: 'full' | 'trimmed';
  brain?: boolean;
  addDir?: string[];
  /** psu --allow-subagents (default OFF — owner mandate 2026-07-02): opt every member's
   *  su session back IN to its built-in subagent-launch (Task/Agent) tool. Subagents are
   *  DENIED BY DEFAULT for every psu launch (su + role), so a desktop fleet member cannot
   *  fan out unless this is set true. */
  allowSubagents?: boolean;
  /** P-005 launch-from-seats: the delegated agent_slot template this member
   *  consumes ('<model>:<effort>:<account>'). Emits `--seat=<ref>`, which the
   *  psu launcher threads to bootstrap-su for the consumption ledger (mig 487). */
  seat?: string;
  extraArgs?: string[];
}

/** Shell-quote a value for the spawned greetingCmd: leave a safe token bare (clean,
 *  matches the slug-style flags) and single-quote anything with whitespace / shell
 *  metacharacters (paths, free-form extraArgs) so a member command can never be injected. */
function shq(v: string): string {
  return /^[A-Za-z0-9_.:=/+@-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/** A model routed through the LOCAL inference gateway / ollama (e.g. `ollama-cc/…ornith`)
 *  runs ONLY on the `omp` backend — the `claude`/`codex` CLIs cannot load an ollama model id.
 *  `agent` and `model` are therefore COUPLED. Used to (a) infer agent:'omp' when only such a
 *  model is given, and (b) reject an explicit claude/codex + local-model pairing that would
 *  otherwise launch the WRONG backend nominally `--model`-set to an unrunnable id — and since
 *  the fleet-status echoes the model string (not the agent), it LOOKS like ornith while the
 *  members are really claude. That exact trap spawned 4 claude members mislabelled ornith on
 *  2026-07-03 (a leader relaunched with `model: ollama-cc/…ornith` but no `agent: omp`). */
export function isOmpLocalModel(model: string | undefined): boolean {
  if (!model) return false;
  return /^ollama(-cc)?\//i.test(model.trim()) || /\bornith\b/i.test(model);
}

/** The three fleet-member backends (psu `--agent`). Guards an inherited caller backend. */
const FLEET_BACKENDS = new Set(['claude', 'omp', 'codex']);

export type FleetAgentResolution =
  | { agent: 'claude' | 'omp' | 'codex'; model: string | undefined }
  | { error: string };

/**
 * PURE (fleet-launch-agent-inheritance-2026-07-03): resolve a fleet member's backend + model from
 * the launch args and the CURRENT calling agent's stamped backend/model. Precedence:
 *   agent = explicit `args.agent` → omp (inferred from a local/ollama model) → the CALLER's own
 *           backend (`ctx.callerAgent`, so an omp/ornith leader that omits `agent` spawns omp
 *           members, not the historical claude default) → 'claude' (last-resort fallback).
 *   model = explicit `args.model` → the CALLER's model, but ONLY when the backend was ALSO
 *           inherited (never cross a claude model onto an omp member) → the backend default.
 * Rejects an explicit claude/codex + local-model pairing (the "thought ornith, got claude" trap).
 * Unit-tested without PG.
 */
export function resolveFleetAgent(opts: {
  argAgent?: 'claude' | 'omp' | 'codex';
  argModel?: string;
  callerAgent?: string | null;
  callerModel?: string | null;
}): FleetAgentResolution {
  const argModel = opts.argModel?.trim() || undefined;
  const localModel = isOmpLocalModel(argModel);
  if (opts.argAgent && opts.argAgent !== 'omp' && localModel) {
    return {
      error:
        `model \`${argModel}\` is a local/gateway model that only the \`omp\` backend can run — ` +
        `pass \`agent: "omp"\` (not \`agent: "${opts.argAgent}"\`). The claude/codex CLIs cannot load an ollama model id.`,
    };
  }
  const inherited =
    opts.callerAgent && FLEET_BACKENDS.has(opts.callerAgent)
      ? (opts.callerAgent as 'claude' | 'omp' | 'codex')
      : null;
  const agent = opts.argAgent ?? (localModel ? 'omp' : inherited ?? 'claude');
  // Inherit the caller's model ONLY when we also inherited its backend (no explicit agent) — else
  // an omp member would launch on omp's default, not the ornith the leader is actually running.
  const inheritedBackend = !opts.argAgent && agent === opts.callerAgent;
  const model = argModel ?? (inheritedBackend && opts.callerModel ? opts.callerModel : undefined);
  return { agent, model };
}

/** Window inside which a repeat launch of the same fleet is suppressed (the P-005 idempotency
 *  guard). The state lives in PG (agent_fleets.last_launch_at, migration 484) — NOT an in-process
 *  map: :3070 serves MCP from a multi-process worker pool, and the 2026-07-03 ornith incident
 *  proved a per-worker map is porous (a leader re-fired the tool 7× in 40s treating "launch" as a
 *  status check; 6 calls each landed on a worker with an empty map and opened 2 terminals apiece —
 *  12 unwanted desktop windows). claimFleetLaunchSlot is one atomic SQL check-and-set shared by
 *  every worker, so exactly ONE call per fleet can win the window. */
const RELAUNCH_SUPPRESS_MS = 300_000;

export interface FleetLaunchCapacityClamp {
  requestedOpenCount: number;
  openCount: number;
  clamped: boolean;
  reachable: boolean;
  healthyAccounts: number | null;
  dispatchBudget: number | null;
  recommendedHeadroom: number | null;
  /** ADVISORY (not a clamp): the weekly-token-BUDGET window is tight for this many members
   *  (recommendedHeadroom < openCount). They still all launch; they may burn the remaining
   *  weekly budget faster and hit the wall sooner. See clampFleetTopUpToCapacity. */
  utilizationTight: boolean;
  reason: string;
}

function floorCap(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

/**
 * EI-6805: a relaunch/top-up wave must not only warn about capacity, it must
 * clamp the number of NEW terminals it opens to the shared capacity oracle.
 * Missing/unreachable capacity fails open so an observability outage never
 * strands a fleet; a reachable zero-headroom report suppresses the top-up.
 */
export function clampFleetTopUpToCapacity(
  requestedOpenCount: number,
  report: Pick<ReturnType<typeof buildCapacityReport>, 'reachable' | 'healthyAccounts' | 'dispatchBudget' | 'recommendedHeadroom'>,
): FleetLaunchCapacityClamp | null {
  const requested = Math.max(0, Math.floor(requestedOpenCount));
  if (!report.reachable) return null;
  const healthyAccounts = floorCap(report.healthyAccounts);
  const dispatchBudget = floorCap(report.dispatchBudget);
  const recommendedHeadroom = floorCap(report.recommendedHeadroom);
  // CONCURRENCY is the only HARD cap on how many desktop-fleet members open at once, and
  // `dispatchBudget` (bee-tier spare admission slots = cap − inFlight − queued, gateway
  // DEFAULT_CONCURRENCY 24) is that authority. It is INDEPENDENT of BOTH:
  //  - account COUNT — ONE account paces MANY concurrent sessions through the gateway.
  //    Putting account-count in this min() was the "1 account = 1 session" bug (a top-up of
  //    N collapsed to 1 on a single-account install with tens of free slots). It informs the
  //    sizing ADVISORY only (buildFleetSizingAdvisory), never a hard cap.
  //  - weekly-token-BUDGET utilization — `recommendedHeadroom` folds in `capacityFactor`'s
  //    budget leg, which throttles on `utilization` (the most-constraining budget WINDOW,
  //    e.g. an account at 0.94 of its 7-DAY token cap → factor ~0.4 → recommendedHeadroom
  //    floored to minHeadroom 2). That collapsed an owner's EXPLICIT 5-member fleet to 2 even
  //    with ~20 free admission slots (fleet-launch-utilization-not-concurrency, 2026-07-08).
  //    A near-weekly-cap account can still run many SIMULTANEOUS sessions right now — weekly
  //    budget tightness is not a concurrency limit, so it is DEMOTED to an advisory
  //    (utilizationTight): the members still all launch; they may just burn the remaining
  //    weekly budget faster. Same treatment `healthyAccounts` already got.
  // `healthyAccounts` still gates the ZERO case: no routable account ⇒ no valid credential ⇒
  // nothing could authenticate, so suppress the top-up entirely.
  const caps = [dispatchBudget].filter((n): n is number => n != null);
  if (healthyAccounts === 0) caps.push(0); // no routable account ⇒ suppress the top-up entirely
  if (caps.length === 0) return null; // no concurrency signal ⇒ fail open (never strand on a missing signal)
  const capacityHeadroom = Math.min(...caps);
  const openCount = Math.min(requested, capacityHeadroom);
  const clamped = openCount < requested;
  // ADVISORY only — the weekly budget is tight for this many members, but never a clamp.
  const utilizationTight = recommendedHeadroom != null && recommendedHeadroom < openCount;
  const detail = `dispatchBudget=${dispatchBudget ?? 'n/a'} (concurrency — the real cap), recommendedHeadroom=${recommendedHeadroom ?? 'n/a'} (weekly-budget util — ADVISORY, not a cap), healthyAccounts=${healthyAccounts ?? 'n/a'} (accounts do NOT cap sessions)`;
  return {
    requestedOpenCount: requested,
    openCount,
    clamped,
    reachable: true,
    healthyAccounts,
    dispatchBudget,
    recommendedHeadroom,
    utilizationTight,
    reason: clamped
      ? `capacity-clamped top-up ${requested}→${openCount} (${detail})`
      : utilizationTight
        ? `capacity-ok top-up ${requested}, but weekly-token-budget is tight for this many members (recommendedHeadroom=${recommendedHeadroom}) — they still all launch, may hit the wall sooner (${detail})`
        : `capacity-ok top-up ${requested} (${detail})`,
  };
}

/**
 * cross-platform-member-credential-inheritance (Mac fleet-member login fix, 2026-07-06):
 * the account routing an un-pinned fleet member should DEFAULT to, per host platform.
 *
 * A member launched with NO `--account` falls to bootstrap-su's `resolveAccountPin(undefined)`
 * DIRECT system-credential default (`env:{}` — no `ANTHROPIC_BASE_URL`). On Linux/Windows that
 * works: the member's isolated per-session `CLAUDE_CONFIG_DIR` inherits the global
 * `~/.claude/.credentials.json` login via the file reconcile/symlink machinery. On **macOS** the
 * OAuth login lives in the login Keychain keyed PER config-dir suffix (`Claude Code-credentials-…`)
 * and claude DELETES any seeded `.credentials.json`, so a headless member's fresh config dir never
 * matches the default `~/.claude` login → it boots LOGGED OUT (`/login`, "could not proceed") with
 * no human to re-auth it. So on darwin, default an un-pinned member to `'auto'`: it routes through
 * the always-on desktop inference gateway, which owns the Keychain bundle (+ refresh) and whose
 * local-fallback resolves the single default account (`localLoginCredentialRef → keychain:Claude
 * Code-credentials`) — the member authenticates with ZERO per-session login. Fail-soft: gateway off
 * ⇒ `resolveAccountPin('auto')` falls back to the direct default (byte-identical to today). An
 * explicit `--account` (incl. the `'default'`/`'system'` escape hatches) or a seat-pinned account
 * ALWAYS wins. Pure — `platform` injectable for tests.
 */
export function defaultMemberAccountRouting(
  account: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (account) return account;
  return platform === 'darwin' ? 'auto' : account;
}

/**
 * Build the scripted psu launch command for one fleet member working a plan. Pure +
 * exported for tests. `--no-picker --plan` is what triggers the EI-5503 auto-kickoff, so a
 * member starts working on boot. The base tokens (fleet/agent/harness/plan) are constrained
 * slugs/enums (no quoting needed); every optional flag's VALUE is shell-quoted via shq.
 */
export function memberLaunchCommand(opts: MemberLaunchOpts): string {
  const parts = [
    'psu',
    '--no-picker',
    `--fleet=${opts.fleetSlug}`,
    `--agent=${opts.agent}`,
    `--harness=${opts.harness}`,
    `--plan=${opts.plan}`,
  ];
  if (opts.account) parts.push(`--account=${shq(opts.account)}`);
  if (opts.workspace) parts.push(`--workspace=${shq(opts.workspace)}`);
  if (opts.role) parts.push(`--role=${shq(opts.role)}`);
  if (opts.model) parts.push(`--model=${shq(opts.model)}`);
  if (opts.feature) parts.push(`--feature=${shq(opts.feature)}`);
  if (opts.launchContext) parts.push(`--launch-context=${shq(opts.launchContext)}`);
  if (opts.profile) parts.push(`--profile=${shq(opts.profile)}`);
  // su-context-size-variants: enum-constrained ('full'|'trimmed'), so no shq needed.
  if (opts.contextSize) parts.push(`--context-size=${opts.contextSize}`);
  if (opts.brain) parts.push('--brain');
  if (opts.allowSubagents) parts.push('--allow-subagents');
  if (opts.seat) parts.push(`--seat=${shq(opts.seat)}`);
  for (const d of opts.addDir ?? []) if (d) parts.push(`--add-dir=${shq(d)}`);
  for (const a of opts.extraArgs ?? []) if (a) parts.push(shq(a));
  return parts.join(' ');
}

/**
 * The universal MEMBER OPERATING BASELINE rules, composed onto EVERY member's
 * launch context ahead of any per-fleet brief. Encodes the drain-discipline
 * lessons learned watching real fleets run: check-already-fixed before building,
 * flag to the leader (not just the broadcast stream), don't re-claim a
 * ping-ponging item, and always ship completion evidence. Single source so the
 * member's full text and the leader's echo (headlines) can never drift.
 */
export const MEMBER_BASELINE_RULES: ReadonlyArray<{ head: string; body: string }> = [
  {
    head: 'Already-fixed check FIRST',
    body: 'Before building anything, spend ~2 min confirming the fix has not already shipped — check code/tests, `git log`, sibling work-items. Re-implementing a peer\'s fix is the single biggest fleet-time waste. If already done, close it as already-fixed WITH the evidence you checked — do not rebuild it.',
  },
  {
    // EI-8318: members were completing exactly ONE item per external wake, then ending
    // their turn with no armed self-wake — the leader became a manual clock, capping
    // fleet throughput at its re-wake cadence instead of draining continuously.
    // EI-8393: kept tight — this rule is the single biggest driver of the P-013
    // prompt-bloat budget; trim further before adding anything to it.
    head: 'STAY ALIVE across turns — loop:arm at spawn, not park',
    body: 'You have no human at your keyboard: as your FIRST action, call `loop:arm { intervalSec, goal }` to drain your lane. Each wake: pull via `scheduler:get_next` → work to terminal (`work_items:complete`) → repeat — the armed loop re-wakes you automatically. `loop:end` ONLY when nothing is claimable for your spec, or you are genuinely blocked. Ending a turn with no armed loop IS parking (EI-8318): you go silent until the leader manually re-wakes you, capping the WHOLE fleet at their wake cadence.',
  },
  {
    head: 'Flag to your LEADER; keep status in your FLEET, not the whole hive',
    body: 'Send blockers, systemic findings, and "nothing left to claim" to the leader addressed + `wakeOnReply:true` (coord:send/escalate) — a broadcast is easy to miss. Routine status belongs to your fleet: a bare to:["*"] auto-scopes to `@fleet:<slug>`; reserve `allHive:true` for genuinely system-wide news.',
  },
  {
    head: 'Do not re-claim a ping-ponging item',
    body: 'Releasing an item bumps its `updated_at`, so it can re-surface at the top of your next `scheduler:get_next` pull and you loop on it. If an item reappears right after you release it, sink it (work_items:set_priority) or set it `blocked` with a reason — do not re-claim.',
  },
  {
    head: 'Completion evidence is mandatory',
    body: 'Every terminal transition carries a completion_ref stating (a) files / root-cause, (b) the exact test or verification you ran AND its result, (c) any tests you added. Auditors mark you CLEAN on stated evidence — thin evidence on solid work still gets dinged.',
  },
  {
    head: '"Not available" means DEFERRED, not missing',
    body: 'An InputValidationError / "not available" on a tool means load it (ToolSearch / tools:find) and continue — never stop or report a tool as unavailable.',
  },
  {
    head: 'Edit only the staging tree; git-sync owns commit + push',
    body: 'Never git add / commit / push. If a file-lock blocks an edit, pivot to the next item rather than routing around the lock.',
  },
  {
    head: 'A hive pause is a Queen-loop signal, not a self-drain order',
    body: '`pauseNewWork` / `maxBees` / a pot-steering fact you SEE in orient governs the autonomous mug-cup loop — do NOT stop your claimed work on it. Wind down only on a graceful-drain cue ADDRESSED to you (check its authority+scope stamp: `hive-queen(<hive>)→hive-wide` is the Mug; a `fleet-leader(<other>)→fleet-members` cue is a DIFFERENT fleet\'s business — ignore it) or an explicit `fleet:*`/owner action. Unsure? Ask your leader, never self-drain on an observed pause.',
  },
  {
    // su-loop-capability-parity P-011: the bee turn-end reflection ritual + the overwatch
    // integrity clause, ported to fleet members (bee.base.md / the overwatch prompt).
    head: 'Turn-end reflection + reporting integrity',
    body: 'End each turn with ONE bounded reflection: file an observation (`improvements:capture lane:"observation"`) ONLY if the turn surfaced something a FUTURE agent benefits from — a routine turn records NOTHING (a sensor reading, never a fix or self-grade). Never fabricate a signal: a truthful `blocked` beats a fabricated all-clear — never report a state you weren\'t in, a send you didn\'t make, or a reading you didn\'t take.',
  },
  {
    // su-loop-capability-parity P-012: the bee checkpoint protocol (bee.base.md §"End of
    // turn — checkpoint"), ported to fleet members. Store + injection seam already exist.
    head: 'Carry-note checkpoint at every boundary',
    body: 'Write `work_items:checkpoint { id, checkpoint }` at task completion, before going idle at a task boundary, and on graceful-evict — so your successor resumes mid-thread instead of cold. Content = what you accomplished / what is left / the key insight / a gotcha for your successor; concrete facts, not self-evaluation; a compact digest, never a transcript. Replace-on-write (blank to clear).',
  },
];

/**
 * The fleet LEADER's standing-job checklist, rendered (auto-numbered) into the launch-result
 * message. Pure + exported so (a) its rendered length is test-guarded against silent balloon
 * (su-loop-capability-parity P-013 — context-blow is the #1 leader self-inflicted failure), and
 * (b) a future insert never has to hand-renumber the points. The universal
 * steer-don't-micromanage rules a leader runs each cycle until the plan drains. Numbering is
 * applied at render time (`${i + 1}.`) — keep each entry WITHOUT a leading number.
 */
/**
 * The AUTO-mode auto-enter directive rendered into the launch result the moment the caller
 * becomes a fleet LEADER. Leading a fleet from an ask-first posture is how fleets die
 * unsupervised: an AUTO-off leader parks waiting for permission while members stall, wedge,
 * or drain unnoticed (the 2026-07-03 ornith run: the leader stayed at its routing-gate
 * posture after this very call and only supervised when externally woken). The persona rule
 * ("creating or leading a fleet AUTO-ENTERS AUTO mode") is delivered HERE because this
 * result is the exact moment the caller becomes a leader — a persona clause alone is too
 * far from the act for weak models to bind it. Pure + exported for tests.
 */
export const LEADER_AUTO_MODE_DIRECTIVE =
  'LEADING THIS FLEET PUTS YOU IN AUTO MODE — effective NOW, for the rest of your session. ' +
  'You cannot supervise a fleet from an ask-first posture: act on your own judgment, do not ' +
  'stop to ask permission between steps, and NEVER end a turn waiting for an instruction while ' +
  'your fleet is live. Tell your owner you have switched to AUTO mode (a notice, not a question). ' +
  'Until the plan is drained, your standing job each cycle:';

export const LEADER_STANDING_JOB: readonly string[] = [
  'WATCH YOUR INBOX (coord:inbox) and handle anything addressed to you. Members ping the leader with wakeOnReply:true expecting an ack or a decision — blockers, systemic findings, "nothing left to claim" signals. An unacked flag is a dropped ball: coord:ack it or act on it; do not let it scroll past in the broadcast stream.',
  'STAY ALIVE across turns: loop:arm a monitor loop so your leadership persists — a leader that ends its turn with no loop stops leading and the fleet runs unsupervised. (To retune the cadence, loop:end then loop:arm fresh; an in-place interval change reverts.)',
  // su-loop-capability-parity P-002: steer-don't-dispatch (the queen model) + the completion mandate.
  "STEER, don't micro-dispatch: your members self-PULL via `scheduler:get_next`; you decide WHICH item each gets by SETTING/BUMPING its claim-spec — `scheduler:set_claim_spec { beeId, spec }` with a PROPERTY FILTER (e.g. `{field:'plan',op:'=',value:'<slug>'}` + a rank), NEVER id-pins for a standing lane (an `id in [...]` pin is a static one-off wave only). Re-steer a running member by bumping its spec (the revision auto-applies on its next pull), not by hand-assigning items. And you OWN driving the plan to done THROUGH the fleet — keep the lanes covered + the dependency order honest; do NOT quietly fall back to doing the work solo.",
  'Keep each wake LEAN: one dev:pg_query for burn-down + active-worker count. Do NOT dump fleet:assignments coverage[] or a full coord:presence every wake — that blows your OWN context within a few cycles and is the #1 leader self-inflicted failure.',
  'AUDIT completions: spot-check a few terminalCompletionRefs (work_items:get) for real evidence — files touched, the exact test run + its result — not just a status flip.',
  // su-loop-capability-parity P-006: the wave-close rubric-graded scorecard folded into the
  // wind-down point (per-WAVE, never per-turn) — keeps the leader block from growing a point.
  'Right-size + wind down: relaunch a wave (this tool again) if workers thin out while claimable work remains; when only owner-gated/blocked/other-fleet residue is left OR the Queen issues graceful-drain cues, loop:end and report the outcome to the owner. Do not spin empty wakes. AT WAVE CLOSE emit ONE `fleet-execution-health` scorecard — `improvements:capture { rubricRef:"fleet-execution-health", ratings }`, one rating per criterion, evidence MANDATORY, "unknown" the honest value for anything you could not assess — so the fleet gets a comparable wave-over-wave trend line (per-WAVE, never per-turn).',
  "Pausing the Hive Queen is NOT a 'drain your fleet' order. A hive pause / `pauseNewWork` / `maxBees` / a steering fact you SEE in orient governs the autonomous queen-bee loop, not your fleet — a fleet is drained ONLY by an explicit owner / `fleet:*` action or a graceful-drain cue ADDRESSED to you, never as a side-effect of a hive pause you happened to read. Check a drain cue's authority+scope stamp before acting: `hive-queen(<hive>)→hive-wide` is the Queen; a `fleet-leader(<other>)→fleet-members` cue is a PEER draining ITS members — not a command to you or your fleet. And never drain a peer fleet-leader or another fleet's members; if a hive pause has you unsure, `pot:get-steering` + ask the owner rather than self-draining.",
  // su-loop-capability-parity P-010: read the CURATED fleet feed at wave boundaries
  // (salience-ranked, triage-deduped) + the overwatch nudge-hygiene rule.
  'Read the CURATED fleet feed at wave boundaries: `curation:feed` gives you the salience-ranked, triage-deduped live signals — blockers / escalations / questions, "what matters across the fleet right now" — so you are not re-deriving state from a raw `coord:inbox` scan. Nudge hygiene: before you nudge, RE-READ state (the drift may already be resolved); a nudge that fails to land twice is an ESCALATION to the owner, not a third nudge.',
  // su-loop-capability-parity P-012 (leader side): park with carry-notes, not prose.
  'When you PARK or hand off (wind-down, restart, leadership change), leave carry-notes — not prose that scrolls away: a per-item `work_items:checkpoint` for anything mid-flight + a plan `## Now` pointer (`plans:set-now`) to the resume state, so the next leader / your next wake picks up from durable state.',
];

/** Render the full member-facing baseline markdown (the numbered rules with a
 *  short header). Pure + exported for tests. */
export function renderMemberBaseline(opts: { fleetSlug: string; plan: string; count: number }): string {
  const { fleetSlug, plan, count } = opts;
  const rules = MEMBER_BASELINE_RULES.map((r, i) => `${i + 1}. **${r.head}.** ${r.body}`).join('\n');
  return [
    '# Fleet member — operating baseline',
    '',
    `You are one of ${count} parallel worker agent${count === 1 ? '' : 's'} in fleet \`${fleetSlug}\`, working plan \`${plan}\`. The session that launched you is your LEADER — report notable completions and blockers to them.`,
    '',
    'Your loop, until nothing is claimable: **pull** via `scheduler:get_next` (NOT `work_items:claim_next` — leader steers WHICH item via `scheduler:set_claim_spec`; no spec = default order) → **read** it (`work_items:get`) → **classify + act** (fix / already-fixed-close / blocked) → drive to a **terminal** state with evidence → repeat. Do NOT self-prioritize by scanning `work_items:list` — scheduling is the leader\'s call, PICKUP is yours.',
    '',
    '## Non-negotiables',
    rules,
  ].join('\n');
}

/** Compose a member's launch context = the universal baseline + (optionally) the
 *  leader's per-fleet brief BELOW it (the brief wins on fleet-specifics). Pure +
 *  exported for tests. */
export function composeMemberLaunchContext(opts: {
  fleetSlug: string;
  plan: string;
  count: number;
  customBriefText?: string | null;
}): string {
  const baseline = renderMemberBaseline(opts);
  const brief = opts.customBriefText?.trim();
  if (!brief) return `${baseline}\n`;
  return `${baseline}\n\n---\n\n# Fleet-specific brief (from your leader — wins on specifics)\n\n${brief}\n`;
}

/**
 * EI-7671: build the FLEET-level claim spec that restricts every member's
 * scheduler:get_next self-pull to `kinds`. Pure + exported for a unit test — the
 * shape must satisfy validateClaimSpec (see scheduler:set_claim_spec's docstring
 * for the concrete field/op vocabulary). Rank/limits are inherited from
 * DEFAULT_CLAIM_SPEC unchanged: only the view.filter narrows (D-002 — a spec can
 * only narrow + reorder within the global floors, never widen past them).
 */
export function buildFleetKindClaimSpec(
  fleetSlug: string,
  kinds: readonly string[],
): Record<string, unknown> {
  return {
    specVersion: '1.0',
    specId: `fleet-launch-${fleetSlug}-kinds`,
    revision: 1,
    view: { filter: { field: 'kind', op: 'in', value: [...kinds] } },
    rank: DEFAULT_CLAIM_SPEC.rank,
    limits: DEFAULT_CLAIM_SPEC.limits,
  };
}

/**
 * fleet-launch-plan-scoped-claim-spec (2026-07-08): build the FLEET-level claim spec that keeps
 * every member's scheduler:get_next self-pull on THIS plan's work-items — `plan = <planSlug>`
 * (the `plan` spec field maps to the `source_plan_slug` column; promoted work-items always carry
 * it, so the filter matches exactly), optionally AND `kind ∈ kinds`. get_next's harness+workspace
 * FLOORS already scope pickup to the plan's harness, so this is defense-in-depth: it stops a member
 * drifting onto UNRELATED work if the pot ever holds other work-items, AND closes the boot-race
 * where members pull under the empty-filter DEFAULT_CLAIM_SPEC before the leader hand-sets a spec.
 * Pure + exported for a unit test — the shape must satisfy validateClaimSpec (D-002: view.filter
 * only narrows + reorders within the global floors, never widens). Rank/limits inherited unchanged.
 */
export function buildFleetPlanClaimSpec(
  fleetSlug: string,
  planSlug: string,
  kinds?: readonly string[],
): Record<string, unknown> {
  const planLeaf = { field: 'plan', op: '=', value: planSlug };
  const filter =
    kinds && kinds.length
      ? { all: [planLeaf, { field: 'kind', op: 'in', value: [...kinds] }] }
      : planLeaf;
  return {
    specVersion: '1.0',
    specId: `fleet-launch-${fleetSlug}-plan`,
    revision: 1,
    view: { filter },
    rank: DEFAULT_CLAIM_SPEC.rank,
    limits: DEFAULT_CLAIM_SPEC.limits,
  };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export default defineTool({
  name: 'fleet:launch-on-plan',
  description:
    'Open visible desktop su member terminals on a plan in one call. This is what "launch a fleet" means; use cup:spawn for background bees. Ensures the named fleet exists, opens N visible member terminals, and each scripted psu launch auto-starts work on the plan. Author the plan first. Works on Linux, macOS, and Windows desktop (WI-3289: Windows spawns relay through the open desktop window).',
  guidance: {
    when: 'Use when the owner wants a new visible desktop fleet working a plan immediately. Pass the plan slug, fleet name, and member count; terminals open on the desktop and start work on boot.',
    notWhen:
      'Not for background bees (cup:spawn), plain worker windows with no fleet/plan (capability:terminal), fleet registration only (fleet:create), or authoring/starting the plan itself. Unsure which spawn tool you want? See the decision table: /internal/docs/agent-insights/desktop-fleet-vs-loop-bee.',
    chaining:
      'plans:apply-plan-block or plans:new/plans:add-item → plans:start (REQUIRED) → fleet:launch-on-plan { name, plan, count }. plans:start is NOT optional: members self-pull WORK-ITEMS via scheduler:get_next, and plan items become claimable work-items ONLY via plans:start — skip it and the fleet launches onto an empty backlog and idles. This tool idempotently backstops a forgotten plans:start (promotes the plan + sets a plan-scoped claim spec before opening terminals), but run plans:start yourself so the Queen/orchestrator also gets plan-started visibility. As leader, loop:arm a lean monitor and avoid polling full rosters every wake.',
  },
  // Desktop-spawn is the privileged action — gate it exactly like capability:terminal.
  capability: 'capability:terminal',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'cup'],
  args: z.object({
    name: z
      .string()
      .min(1)
      .describe('Fleet name — created (you become leader) if new, else joined. Slugified to the durable handle.'),
    plan: z.string().min(1).describe('Plan slug (filename without .md) the members should work. Must already exist.'),
    harness: z
      .string()
      .optional()
      .describe("Harness the plan belongs to. Defaults to the session's harness scope; required when the session is unscoped."),
    agent: z
      .enum(['claude', 'omp', 'codex'])
      .optional()
      .describe(
        'Backend each member runs. Default `claude` — EXCEPT it auto-becomes `omp` when `model` is a local/gateway model (ollama-cc/…, ornith), which only omp can run. To launch an ORNITH fleet, set `agent: "omp"` (with or without an ornith `model`); passing only `model: ollama-cc/…ornith` also works. An explicit `claude`/`codex` + a local model is REJECTED (that pairing silently launches the wrong backend labelled with the ornith model).',
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(MAX_MEMBERS)
      .optional()
      .describe(`Number of member terminals to open (default 1, max ${MAX_MEMBERS}).`),
    // --- optional psu launch flags threaded onto EVERY member (EI-5765 / owner request) ---
    account: z
      .string()
      .optional()
      .describe(
        "psu --account routing for EVERY member (account-routing-3-options) — one of three: a POOL ACCOUNT ID (from accounts:list / gateway:status) → pin every member to it via the inference gateway (isolate/concentrate the fleet's load; no failover); \"auto\" → route through the gateway, which auto-selects an available account + fails over; \"default\" → skip the gateway, use the system / CLI-login credential. OMIT to auto-pick: \"auto\" on macOS (a headless Mac member can't inherit the Keychain login directly, so it routes via the always-on desktop gateway) and \"default\" elsewhere. (For a multi-account spread, launch in batches with different account ids.) ANNOUNCE the choice to the owner per the persona spawn-disclosure rule.",
      ),
    workspace: z
      .string()
      .optional()
      .describe(
        "psu --workspace: the workspace the fleet + every member launch under. Defaults to the launch session's workspace.",
      ),
    role: z
      .string()
      .optional()
      .describe('psu --role: the su role each member runs as (default the standard su collaborator).'),
    model: fuzzyEnum(localModelIdsSync, {
      applies: isOmpLocalModel,
      // A leader passes the PROVIDER-PREFIXED spec (ollama-cc/…); the backend registry stores the
      // BARE id — normalize both so a valid prefixed ornith model is never false-rejected.
      normalize: (v) => v.replace(/^ollama(-cc)?\//i, ''),
      label: 'local model',
    })
      // Defense-in-depth (WI-1993): the fuzzyEnum above only validates LOCAL models (applies:
      // isOmpLocalModel). A malformed CLOUD spec — a hand-typed `[1m]` marker (`fabel5[1m]`, the
      // WI-1979 incident) or a typo'd alias — would otherwise pass the tool's zod and open N desktop
      // windows that each die at psu boot with no useful hint. Mirror psu-launcher's validateModelSpec
      // at the TOOL BOUNDARY so the leader's call fails cleanly, BEFORE any window opens. Local/ornith
      // specs return ok:true here (fuzzyEnum owns those); the check is deliberately lenient on the open
      // cloud id set — it only rejects the unambiguous malformed classes (incl. the `sonnet-5`
      // versioned-shorthand leak, the most common agent typo).
      .superRefine((value, ctx) => {
        const v = validateCloudModelSpec(value);
        if (!v.ok) {
          ctx.addIssue({ code: 'custom', message: v.message ?? 'invalid model spec', params: { cloudModelSpec: true, got: value } });
        }
      })
      .optional()
      .describe(
        'psu --model: a per-member model spec, e.g. "opus:high" (default the role/tier default). A ' +
          'LOCAL/gateway model (ollama-cc/…, ornith) is fuzzy-validated against the registered local ' +
          'backends — an invalid id returns the nearest registered model + the allowed list (generic-' +
          'tool-arg-fuzzy-validation). A non-local (claude/codex) alias is the open set — full ids pass, ' +
          'but a malformed alias (a versioned shorthand like `sonnet-5`, or a typo) is caught + corrected.',
      ),
    feature: z.string().optional().describe('psu --feature: a feature id each member should pick up.'),
    launchContext: z
      .string()
      .optional()
      .describe("psu --launch-context: path to a brief/markdown file injected as each member's launch context."),
    profile: z.string().optional().describe('psu --profile: launch profile name for each member.'),
    contextSize: z
      .enum(['full', 'trimmed'])
      .optional()
      .describe(
        "psu --context-size: initial-context size variant for EVERY member — 'full' (~180k, whole tool catalog loaded up-front, native soft-trim OFF) or 'trimmed' (~50k, core spine + the client's native soft-trim). Omit for each backend's native default (byte-identical to no flag).",
      ),
    brain: z.boolean().optional().describe('psu --brain: launch each member in brain mode.'),
    addDir: z
      .array(z.string())
      .optional()
      .describe("psu --add-dir (repeatable): extra directories added to each member's workspace."),
    allowSubagents: z
      .boolean()
      .optional()
      .describe(
        "psu --allow-subagents (default OFF): opt every member's su session back IN to its own built-in subagent-launch (Task/Agent) tool. Subagents are DENIED BY DEFAULT for every psu launch (owner mandate 2026-07-02), so members CANNOT fan out unless this is true.",
      ),
    fromSeats: z
      .boolean()
      .optional()
      .describe(
        "P-005 launch-from-seats (agent-allocation-framework): spawn members that CONSUME the fleet's delegated agent_slot seats (resource:delegate / the /res Agent-seats group). The slot pins model+effort+account (D-002/D-003) — so `model`/`account` must be OMITTED — and the seat COUNT cap is enforced (count > free seats is refused; the N+1th spawn is refused at boot too). Implied by `seat`.",
      ),
    seat: z
      .string()
      .optional()
      .describe(
        "Which delegated slot template to launch from, as its ref '<model>:<effort>:<account>' (e.g. 'opus:xhigh:AUTO'). Required only when the fleet has MORE THAN ONE delegated template; a single template is picked automatically with `fromSeats: true`.",
      ),
    extraArgs: z
      .array(z.string())
      .optional()
      .describe(
        'Escape hatch for any other psu flag: each element is one full token (e.g. ["--yes", "--add-dir=/x"]), appended verbatim to every member\'s psu launch — covers psu args without a first-class field above.',
      ),
    claimKinds: z
      .array(z.enum(['feature', 'chunk', 'bug', 'change', 'task']))
      .min(1)
      .max(5)
      .optional()
      .describe(
        'EI-7671: restrict every member\'s scheduler:get_next self-pull to these work-item kinds — e.g. ' +
          '["bug","change","task"] for a bugs-only backlog-drain fleet. Sets a FLEET-level claim spec ' +
          'BEFORE any member terminal opens, closing the boot-race where members start pulling under the ' +
          'empty-filter DEFAULT_CLAIM_SPEC (which admits every kind, including feature/chunk) before the ' +
          'leader gets around to calling scheduler:set_claim_spec by hand. A member\'s own later per-bee ' +
          'spec still overrides this fleet default. Omit to leave scheduling exactly as before (no spec set).',
      ),
  }),
  async handler(args, ctx) {
    const { identity, ownerId, workspaceId: callerWs } = resolveFleetCaller(ctx);
    // An explicit `workspace` arg (psu --workspace) scopes the fleet + envelope + every
    // member; otherwise the launch session's workspace (never the '*' wildcard).
    const workspaceId =
      args.workspace?.trim() || (callerWs && callerWs !== '*' ? callerWs : activeWorkspaceId());
    // `agent` and `model` are COUPLED: a local/gateway model (ollama-cc/…ornith) only runs on
    // the omp backend. Infer omp from such a model when agent is unspecified, and reject an
    // explicit claude/codex pairing outright — otherwise psu launches that backend with an
    // unrunnable --model and the fleet-status (which shows model, not agent) reads as ornith
    // while the members are really claude (the 2026-07-03 "thought ornith, got claude" bug).
    // `agent` + `model` resolution: explicit arg → omp (inferred from a local model) → the CURRENT
    // calling agent's backend (ctx.callerAgent, stamped by psu into the MCP URL) → claude. Also
    // inherits the caller's model when the backend is inherited, so an omp/ornith leader that omits
    // both spawns omp + ornith members — not the historical claude default (the 2026-07-03 leak).
    const callerAgent = (ctx as { callerAgent?: string | null }).callerAgent ?? null;
    const callerModel = (ctx as { callerModel?: string | null }).callerModel ?? null;
    const agentResolution = resolveFleetAgent({
      argAgent: args.agent,
      argModel: args.model,
      callerAgent,
      callerModel,
    });
    if ('error' in agentResolution) return err(agentResolution.error);
    const { agent, model: memberModel } = agentResolution;
    const count = args.count ?? 1;

    // P-005 launch-from-seats: the delegated slot pins model+effort+account (D-002/
    // D-003) — an explicit model/account alongside it would silently contradict the
    // delegation, so refuse the combination outright.
    const seatsRequested = Boolean(args.fromSeats || args.seat?.trim());
    if (seatsRequested && (args.model || args.account)) {
      return err(
        'launch-from-seats derives model+effort+account FROM the delegated slot (D-002/D-003) — drop the explicit `model`/`account` args; pass `seat` to pick a template when several are delegated.',
      );
    }

    // Harness scope: explicit arg, else the session's scope (never the '*' wildcard).
    const ctxSlug = (ctx as { harnessSlug?: string | null }).harnessSlug;
    const harness = args.harness?.trim() || (ctxSlug && ctxSlug !== '*' ? ctxSlug : null);
    if (!harness) {
      return err(
        'No harness for the plan. Pass `harness: "<slug>"` (the harness the plan belongs to) — this session is not harness-scoped.',
      );
    }

    // Validate the plan exists before opening any windows (fail clean, not N dead members).
    // Hoist the resolved harness/workspace so the promotion failsafe below reuses them.
    let planHarnessSlug = harness;
    let planWorkspaceId = workspaceId;
    try {
      const resolved = await resolveHarnessPlansDir(harness, { workspaceId });
      planHarnessSlug = resolved.harnessSlug;
      planWorkspaceId = resolved.workspaceId;
      const found = await readPlanBySlug(args.plan, {
        harnessSlug: resolved.harnessSlug,
        workspaceId: resolved.workspaceId,
      });
      if (!found) {
        return err(
          `Plan \`${args.plan}\` not found in harness \`${harness}\`. Create it first (plans:apply-plan-block / plans:new + plans:add-item), then launch the fleet.`,
        );
      }
    } catch (e: any) {
      return err(`Could not resolve plan \`${args.plan}\` in harness \`${harness}\`: ${e?.message ?? e}`);
    }

    // #3 FAILSAFE (fleet-launch-promote-workitems-failsafe, 2026-07-08): members self-pull via
    // scheduler:get_next, which leases WORK-ITEMS — and plan items become claimable work-items ONLY
    // via the plans:start promotion path (promotePlanItems). The PRIMARY contract is that the leader
    // ran plans:start before this tool; if they DIDN'T (the research-desk 2026-07-08 miss: plan
    // authored + set active but never started), the fleet launches onto an EMPTY backlog and every
    // member idles. So idempotently promote the plan's open items to claimable work-items HERE, before
    // any terminal opens. Idempotent — promotePlanItems skips items already promoted, so a proper
    // upstream plans:start makes this a no-op (promoted:0). Best-effort: a failure NEVER blocks the
    // launch. This is a BACKSTOP, not a replacement for plans:start (which ALSO flips op_status=started
    // for Queen/orchestrator visibility — the failsafe deliberately does not).
    let promotionFailsafe: (PromotePlanResult & { ran: boolean }) | null = null;
    try {
      const { promotePlanItems } = await import('../../plan-workitem-promotion-run');
      const res = await promotePlanItems({
        workspaceId: planWorkspaceId,
        harnessSlug: planHarnessSlug,
        planSlug: args.plan,
        createdBy: ownerId,
      });
      promotionFailsafe = { ...res, ran: true };
    } catch {
      promotionFailsafe = null; // never block the launch on the failsafe
    }

    // Ensure the fleet (idempotent) with the caller as owner + leader, then label the
    // caller's presence — same path as fleet:create.
    const fleetSlug = fleetSlugFromName(args.name);
    let leaderRole = 'leader';
    try {
      const { record } = await createFleetIfAbsent({
        workspaceId,
        fleetSlug,
        title: args.name,
        owner: ownerId,
        leaderOwnerId: ownerId,
      });
      leaderRole = fleetRoleFor(record.leaderOwnerId, ownerId);
      await heartbeatPresence(identity);
      await setPresenceFleet(workspaceId, ownerId, fleetSlug, leaderRole);
      // Recolor the caller's live window to the fleet's bound scheme — every other
      // membership entry point (fleet:create / fleet:join / fleet:take-leadership)
      // does this; a leader whose window keeps its old color while the members open
      // in the fleet scheme is the bug, not a variant. Best-effort: a no-op for
      // non-psu-hosted callers, never throws.
      await recolorCallerTerminal(ownerId, record);
    } catch (e: any) {
      return err(`Failed to create/join fleet \`${fleetSlug}\`: ${e?.message ?? e}`);
    }

    // #4 (fleet-launch-plan-scoped-claim-spec, 2026-07-08) + EI-7671: ALWAYS set the fleet-level
    // claim spec BEFORE any member terminal opens — scoping every member's scheduler:get_next
    // self-pull to THIS plan (`plan = <slug>`), AND to args.claimKinds when given. Applied here,
    // pre-spawn, closing the boot-race where members self-pull under the empty-filter
    // DEFAULT_CLAIM_SPEC (admits every kind + every plan in the harness) before the leader gets
    // around to calling scheduler:set_claim_spec by hand. Best-effort: a spec-write failure never
    // blocks the launch (members still start; get_next's harness floor still scopes them to this pot).
    let claimSpecApplied: { ok: boolean; revision?: number; warning?: string; errors?: string[] } | null = null;
    try {
      claimSpecApplied = await setClaimSpec({
        beeId: fleetSpecBeeKey(fleetSlug),
        workspaceId: resolveClaimSpecWorkspace(workspaceId),
        spec: buildFleetPlanClaimSpec(fleetSlug, args.plan, args.claimKinds),
        updatedBy: ownerId,
        hiveSlug: null,
      });
    } catch (e: any) {
      claimSpecApplied = { ok: false, errors: [e?.message ?? String(e)] };
    }

    // LIVE-MEMBER deficit guard: a fleet that already has enough LIVE members gets NO new wave,
    // regardless of timing. The rate window alone cannot stop a doom-looping leader that re-fires
    // minutes apart (2026-07-03 second incident: leader 10040 re-fired at +5 min and +9 min — each
    // burst was past the 60s window and opened 2 more ornith terminals while its members were alive
    // and working). Presence is authoritative once members register; the window below covers only
    // the boot gap before they do. A read failure never blocks a launch (fail open to the window).
    let liveMembers = 0;
    try {
      liveMembers = (await liveFleetMemberIds(fleetSlug, workspaceId)).filter((id) => id !== ownerId).length;
    } catch {
      liveMembers = 0;
    }
    if (liveMembers >= count) {
      const lines = [
        `Fleet \`${fleetSlug}\` already has ${liveMembers} LIVE member${liveMembers === 1 ? '' : 's'} — you asked for ${count}, so NO new terminals were opened.`,
        'Your fleet is running: monitor it, do not relaunch. Re-call this tool only after members have actually drained (their presence goes stale), or with a HIGHER count to top up.',
        `Until the plan \`${args.plan}\` is drained, your standing job each cycle:`,
      ];
      LEADER_STANDING_JOB.forEach((point, i) => lines.push(`  ${i + 1}. ${point}`));
      return json({
        ok: true,
        fleet: fleetSlug,
        leaderRole,
        plan: args.plan,
        harness,
        agent,
        account: args.account?.trim() || null,
        requested: count,
        liveMembers,
        sizingAdvisory: null,
        memberBaselineApplied: false,
        claimSpecApplied,
        memberBaselineHeadlines: MEMBER_BASELINE_RULES.map((r) => r.head),
        memberLaunchContextPath: null,
        briefReadError: null,
        opened: [],
        failed: [],
        relaunchSuppressed: true,
        message: lines.join('\n'),
      });
    }
    // Only the DEFICIT opens — a leader asking for 2 with 1 alive gets 1, never a stacked 3.
    let openCount = count - liveMembers;
    const requestedOpenCount = openCount;

    let capacityClamp: FleetLaunchCapacityClamp | null = null;
    let sizingAdvisory: ReturnType<typeof buildFleetSizingAdvisory> = null;
    try {
      const capacity = buildCapacityReport(await fetchGatewayHeadroom({ timeoutMs: 1200 }), {
        clampArmed: true,
        headroom: openCount,
      });
      capacityClamp = clampFleetTopUpToCapacity(openCount, capacity);
      if (capacityClamp) openCount = capacityClamp.openCount;
      sizingAdvisory = buildFleetSizingAdvisory(count, capacity) ?? null;
    } catch {
      capacityClamp = null;
      sizingAdvisory = null;
    }
    if (openCount <= 0) {
      const lines = [
        `Fleet \`${fleetSlug}\` has ${liveMembers} LIVE member${liveMembers === 1 ? '' : 's'}; target ${count} leaves a deficit of ${requestedOpenCount}, but capacity allows 0 new member terminals now.`,
        capacityClamp?.reason ?? 'capacity report unavailable',
        'NO new terminals were opened. Re-call this tool after capacity recovers; the live-member deficit guard will still open only the remaining deficit.',
        `Until the plan \`${args.plan}\` is drained, your standing job each cycle:`,
      ];
      LEADER_STANDING_JOB.forEach((point, i) => lines.push(`  ${i + 1}. ${point}`));
      return json({
        ok: true,
        fleet: fleetSlug,
        leaderRole,
        plan: args.plan,
        harness,
        agent,
        account: args.account?.trim() || null,
        requested: count,
        liveMembers,
        requestedOpenCount,
        capacityClamp,
        sizingAdvisory,
        memberBaselineApplied: false,
        claimSpecApplied,
        memberBaselineHeadlines: MEMBER_BASELINE_RULES.map((r) => r.head),
        memberLaunchContextPath: null,
        briefReadError: null,
        opened: [],
        failed: [],
        relaunchSuppressed: true,
        capacitySuppressed: true,
        message: lines.join('\n'),
      });
    }

    // Idempotency guard (P-005): a weak model that re-fires launch-on-plan (the 9896 "take
    // leadership" fumble, the 2026-07-03 7×-re-fire) must NOT open a second wave. The claim is
    // an atomic PG check-and-set on the fleet row, shared across every operator worker — if ANY
    // launch of this fleet won the window, no-op with a notice instead of spawning again. This
    // covers the BOOT GAP: members just spawned are not yet in presence, so the deficit guard
    // above cannot see them for the first ~1-3 min.
    // P-005 launch-from-seats: resolve + ENFORCE the delegated seat cap and pin the
    // member launch to the slot's model:effort + gateway account (D-002/D-003). Placed
    // BEFORE the launch-slot claim so a seat refusal never burns the relaunch window.
    // Boot-time consumption (bootstrap-su → consumeSeatAtBoot, mig 487) is the durable
    // backstop that also refuses the N+1th member mid-race (P-006).
    let effAgent = agent;
    let effModel = memberModel;
    let effAccount = args.account?.trim() || undefined;
    let seatPin: { ref: string; delegated: number; consumedBefore: number; availableBefore: number } | null = null;
    if (seatsRequested) {
      let seatResolution;
      try {
        const availability = await seatAvailabilityForFleet({ workspaceId, fleetSlug });
        seatResolution = resolveSeatLaunch({ availability, count, seatRef: args.seat });
      } catch (e: any) {
        return err(`Failed to read fleet \`${fleetSlug}\`'s delegated seats: ${e?.message ?? e}`);
      }
      if (!seatResolution.ok) {
        return err(`[${seatResolution.refusal.code}] ${seatResolution.refusal.detail}`);
      }
      // The slot's model rides the SAME agent/model coupling as an explicit arg (a
      // local/gateway slot model implies the omp backend, etc.).
      const re = resolveFleetAgent({ argAgent: args.agent, argModel: seatResolution.launch.model, callerAgent, callerModel });
      if ('error' in re) return err(re.error);
      effAgent = re.agent;
      effModel = re.model;
      effAccount = seatResolution.launch.account;
      seatPin = {
        ref: seatResolution.slot.ref,
        delegated: seatResolution.slot.quantity,
        consumedBefore: seatResolution.slot.consumed,
        availableBefore: seatResolution.slot.available,
      };
    }
    // cross-platform-member-credential-inheritance: a member the leader didn't pin (no
    // --account, no seat account) defaults to gateway-auto routing on macOS so it inherits the
    // default Keychain login instead of booting logged out (see defaultMemberAccountRouting).
    // No-op on Linux/Windows and whenever an account/seat pin is already set.
    effAccount = defaultMemberAccountRouting(effAccount);

    let slot;
    try {
      slot = await claimFleetLaunchSlot({
        workspaceId,
        fleetSlug,
        count: openCount,
        windowMs: RELAUNCH_SUPPRESS_MS,
      });
    } catch (e: any) {
      return err(`Failed to check the fleet's launch guard: ${e?.message ?? e}`);
    }
    if (!slot.won) {
      const agoS = Math.max(1, Math.round((Date.now() - slot.priorAt) / 1000));
      const lines = [
        `Fleet \`${fleetSlug}\` was already launched — ${slot.priorCount} member${slot.priorCount === 1 ? '' : 's'} opened ${agoS}s ago (possibly by this very session).`,
        'You ARE the leader; do NOT call fleet:launch-on-plan again or fleet:take-leadership for this fleet — re-call only to add another wave once the current members have drained.',
        `Until the plan \`${args.plan}\` is drained, your standing job each cycle:`,
      ];
      LEADER_STANDING_JOB.forEach((point, i) => lines.push(`  ${i + 1}. ${point}`));
      lines.push(
        'Those members were launched with this MEMBER OPERATING BASELINE (do NOT re-issue or contradict it; a later custom brief still layers below it):',
      );
      MEMBER_BASELINE_RULES.forEach((rule, i) => lines.push(`  ${i + 1}. ${rule.head}`));
      return json({
        ok: true,
        fleet: fleetSlug,
        leaderRole,
        plan: args.plan,
        harness,
        agent: effAgent,
        account: effAccount ?? null,
        seats: seatPin ? { ...seatPin, requested: count } : null,
        requested: count,
        sizingAdvisory: null,
        memberBaselineApplied: false,
        claimSpecApplied,
        memberBaselineHeadlines: MEMBER_BASELINE_RULES.map((r) => r.head),
        memberLaunchContextPath: null,
        briefReadError: null,
        opened: [],
        failed: [],
        relaunchSuppressed: true,
        message: lines.join('\n'),
      });
    }

    // Compose every member's launch context = the universal MEMBER OPERATING
    // BASELINE + (optionally) the leader's per-fleet brief below it. Written to the
    // workspace's launch-context dir (NON-repo — never the staging tree, which
    // git-sync would try to commit) and passed to psu as each member's appended
    // system prompt. Resilient: any read/write failure falls back to the raw
    // launchContext so a launch never dies on a context-compose hiccup.
    let effectiveLaunchContext = args.launchContext?.trim() || undefined;
    let memberLaunchContextPath: string | null = null;
    let baselineApplied = false;
    let briefReadError: string | null = null;
    try {
      let customBriefText: string | null = null;
      if (effectiveLaunchContext) {
        try {
          customBriefText = readFileSync(effectiveLaunchContext, 'utf8');
        } catch (e: any) {
          briefReadError = `Could not read launchContext \`${effectiveLaunchContext}\` (${e?.message ?? e}) — members got the baseline only.`;
        }
      }
      const composed = composeMemberLaunchContext({ fleetSlug, plan: args.plan, count, customBriefText });
      const ctxDir = join(papercuspPathForWorkspace(workspaceId), 'launch-context');
      mkdirSync(ctxDir, { recursive: true });
      const ctxPath = join(ctxDir, `fleet-${fleetSlug}-launch-context.md`);
      writeFileSync(ctxPath, composed, 'utf8');
      effectiveLaunchContext = ctxPath;
      memberLaunchContextPath = ctxPath;
      baselineApplied = true;
    } catch {
      // Compose/write failed — fall back to the raw launchContext (or none). The
      // launch still proceeds; the baseline just isn't prepended this time.
      baselineApplied = false;
    }

    // Base envelope (cwd/env) once — skip the superuser .mcp.json (each member's psu
    // bootstraps its own MCP), exactly like capability:terminal.
    let base;
    try {
      base = await buildConsoleEnvelope({
        workspaceId,
        slug: harness,
        operatorBaseUrl: resolveOperatorBaseUrl(),
        skipMcpJson: true,
      });
    } catch (e: any) {
      return err(`Failed to prepare the fleet terminals: ${e?.message ?? e}`);
    }

    // The fleet's bound color scheme (cosmetic — a lookup failure never blocks launch).
    let scheme: ColorScheme | null = null;
    try {
      scheme = await getFleetScheme(workspaceId, fleetSlug);
    } catch {
      scheme = null;
    }

    const command = memberLaunchCommand({
      fleetSlug,
      agent: effAgent,
      harness,
      plan: args.plan,
      account: effAccount,
      workspace: args.workspace?.trim() || undefined,
      role: args.role?.trim() || undefined,
      model: effModel,
      seat: seatPin?.ref,
      feature: args.feature?.trim() || undefined,
      launchContext: effectiveLaunchContext,
      profile: args.profile?.trim() || undefined,
      contextSize: args.contextSize,
      brain: args.brain || undefined,
      addDir: args.addDir,
      allowSubagents: args.allowSubagents || undefined,
      extraArgs: args.extraArgs,
    });
    const opened: Array<{
      terminal: string;
      pid: number | null;
      display: string | null;
      desktopEnvResolvedVia: 'operator-env' | 'active-seat' | 'socket-scan' | null;
    }> = [];
    const failed: Array<{ error: string; code: number }> = [];
    // Concurrent spawns: spawnConsole is async since WI-1886 (it verifies each
    // window survives an early-exit probe instead of reporting ok+pid for a
    // client that died off-screen) — a serial loop would stack N probe windows.
    const results = await Promise.all(
      Array.from({ length: openCount }, (_v, i) =>
        spawnConsole({
          envelope: { ...base, greetingCmd: command, cwd: base.cwd },
          label: `${fleetSlug} · member ${i + 1}/${openCount} (${args.plan})`,
          writeMcpJson: false,
          scheme,
          // WI-3289: on a Windows desktop host, relay each member window to the
          // desktop shell's Tauri console_launch instead of hard-501ing.
          allowDesktopBridge: true,
        }),
      ),
    );
    for (const result of results) {
      if (result.status === 'ok') {
        opened.push({
          terminal: result.terminal,
          pid: result.pid,
          display: result.display,
          desktopEnvResolvedVia: result.desktopEnvResolvedVia,
        });
      } else {
        failed.push({ error: result.error, code: result.code });
      }
    }

    // The slot was claimed BEFORE spawning (the atomic winner). If the launch opened NOTHING
    // (every spawn failed), release it so an immediate legitimate retry isn't suppressed for
    // the whole window; a partial success keeps the claim. Best-effort — never fails the result.
    if (opened.length === 0) {
      try {
        await releaseFleetLaunchSlot({ workspaceId, fleetSlug, at: slot.at });
      } catch {
        /* the guard self-heals when the window elapses */
      }
    }

    const lines: string[] = [];
    if (sizingAdvisory) lines.push(sizingAdvisory.message);
    // Surface the capacity note when it CLAMPED (a real concurrency limit) OR when the
    // weekly-token-budget is merely tight (utilizationTight — advisory; members still launch).
    if (capacityClamp && (capacityClamp.clamped || capacityClamp.utilizationTight)) lines.push(capacityClamp.reason);
    // #3 failsafe report: tell the leader if the launch had to backstop a missing plans:start.
    if (promotionFailsafe?.ran) {
      if (promotionFailsafe.promoted > 0) {
        lines.push(
          `⚠ plans:start had not promoted this plan — the launch FAILSAFE auto-promoted ${promotionFailsafe.promoted} plan item${promotionFailsafe.promoted === 1 ? '' : 's'} to claimable work-items, so the fleet is NOT launching onto an empty backlog. Run plans:start yourself BEFORE launching next time (it also gives the Queen/orchestrator plan-started visibility, which this failsafe does not).`,
        );
      } else if (promotionFailsafe.flagOff) {
        lines.push(
          `⚠ plan→work-item promotion is dark (flag off) so the launch failsafe promoted nothing. If plans:start was not run, members' scheduler:get_next will find nothing and idle — ensure claimable work-items exist for plan \`${args.plan}\`.`,
        );
      } else if (promotionFailsafe.skipped === 0) {
        lines.push(
          `⚠ plan \`${args.plan}\` has no open items to promote — members may find nothing to claim. Confirm the plan has items (plans:items) and was started.`,
        );
      }
    }
    lines.push(
      opened.length
        ? `Launched fleet \`${fleetSlug}\` (you are ${leaderRole}) on plan \`${args.plan}\` — ${opened.length}/${openCount} member${openCount > 1 ? 's' : ''} opened${liveMembers > 0 ? ` (deficit top-up: ${liveMembers} already live of the ${count} requested)` : ''}${capacityClamp?.clamped ? `; requested deficit was ${requestedOpenCount}` : ''}${scheme ? ` (scheme: ${scheme.name})` : ''}:`
        : `No member terminals opened for fleet \`${fleetSlug}\`.`,
    );
    for (const o of opened) {
      const displayNote = o.display ? ` [DISPLAY=${o.display}]` : '';
      lines.push(`  • ${o.terminal} (pid ${o.pid ?? '?'})${displayNote} — ${command}`);
    }
    // EI-8289: a socket-scan placement means no real logged-in seat was found —
    // these windows MAY have landed on a virtual/sandbox display (a leased
    // Xvfb) rather than the owner's real desktop. The launch previously
    // reported bare "opened" here even when that happened, which is exactly
    // how the 2026-07-06 fleet-behavior-probe windows went invisible.
    if (opened.some((o) => o.desktopEnvResolvedVia === 'socket-scan')) {
      lines.push(
        '  ⚠ no active login seat was detected (who) — the DISPLAY(s) above were picked by a raw X11 ' +
          'socket scan and MAY be a virtual/sandbox display rather than the owner\'s real desktop ' +
          '(EI-8289). Confirm the owner can actually see these windows before assuming supervision works.',
      );
    }
    if (failed.length) {
      lines.push(`${failed.length} failed:`);
      for (const f of failed) lines.push(`  • ${f.error}`);
      if (failed.some((f) => f.code === 501 || f.error.includes('desktop-bridge'))) {
        lines.push(
          '(On Windows member windows are relayed to the desktop shell via the sync-bus bridge (WI-3289) — the Papercusp desktop window must be OPEN for the relay to land. Linux + macOS spawn server-side directly.)',
        );
      }
    }
    if (opened.length) {
      if (seatPin) {
        lines.push(
          `Seats (P-005): ${opened.length} member${opened.length === 1 ? '' : 's'} launched FROM slot \`${seatPin.ref}\` — ${seatPin.consumedBefore} of ${seatPin.delegated} seat${seatPin.delegated === 1 ? '' : 's'} were already consumed; each member consumes one at boot (the cap re-checks there too).`,
        );
      }
      lines.push(
        `You are this fleet's LEADER (${ownerId}). Members auto-start on boot — no kickoff needed. Do NOT ` +
          `call fleet:launch-on-plan or fleet:take-leadership again for this fleet — you already lead it (a ` +
          `re-call opens NO new members for ${Math.round(RELAUNCH_SUPPRESS_MS / 1000)}s).`,
      );
      lines.push(LEADER_AUTO_MODE_DIRECTIVE);
      // Auto-numbered from the single canonical LEADER_STANDING_JOB source (P-013): a future
      // insert never hand-renumbers, and the rendered length is test-guarded against balloon.
      LEADER_STANDING_JOB.forEach((point, i) => lines.push(`  ${i + 1}. ${point}`));
      if (baselineApplied) {
        lines.push(
          'Your members were launched with this MEMBER OPERATING BASELINE (already told to them — do NOT re-issue or contradict it; your custom brief, if any, is layered BELOW it and wins on fleet-specifics):',
        );
        for (let i = 0; i < MEMBER_BASELINE_RULES.length; i++) {
          lines.push(`  ${i + 1}. ${MEMBER_BASELINE_RULES[i].head}`);
        }
        if (memberLaunchContextPath) lines.push(`  (full composed member context: ${memberLaunchContextPath})`);
      }
      if (briefReadError) lines.push(briefReadError);
    }

    return json(
      {
        ok: opened.length > 0,
        fleet: fleetSlug,
        leaderRole,
        // The launch result is the moment the caller BECOMES a leader — leadership
        // auto-enters AUTO mode (persona rule; see the message text). Structured so
        // non-prose consumers (hooks, scorers) can key on it.
        autoModeEntered: opened.length > 0,
        plan: args.plan,
        harness,
        agent: effAgent,
        account: effAccount ?? null,
        // P-005: the seat pin this wave launched from (null = a plain, non-seat launch).
        seats: seatPin ? { ...seatPin, requested: count, launched: opened.length } : null,
        requested: count,
        liveMembers,
        requestedOpenCount,
        capacityClamp,
        sizingAdvisory,
        memberBaselineApplied: baselineApplied,
        claimSpecApplied,
        promotionFailsafe,
        memberBaselineHeadlines: MEMBER_BASELINE_RULES.map((r) => r.head),
        memberLaunchContextPath,
        briefReadError,
        opened,
        failed,
        message: lines.join('\n'),
      },
      opened.length === 0,
    );
  },
});
