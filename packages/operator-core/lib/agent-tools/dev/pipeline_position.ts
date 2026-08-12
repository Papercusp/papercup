/**
 * dev:pipeline_position — "where is my change, and is it live?" in one read
 * (git-sync-dx-hardening-2026-06-17 P-002 / EI-1164).
 *
 * Pass a repo-relative `path` (its latest commit) or a `sha`; returns whether it
 * is committed → on `origin/staging` → in `origin/main` (passed the green gate)
 * → reached the live `:3070` operator (the deployed sha), plus the
 * green-checkpoint stall context + a one-line summary. READ-ONLY (no fetch).
 */

import { z } from 'zod';
import { defineTool, readJsonResult, type SeeAlsoEntry } from '@papercusp/agent-mcp';
import { gitPipelinePosition } from '../../git-pipeline-position';
import { buildKey } from '../../events/await/catalog';
import { listCells } from '../../cell-registry';
import { stampStatePlane, type StatePlaneBlock } from '../../state-plane-stamp';
import { resolveAgentIdentity } from '../coordination/identity';

const TOOL_NAME = 'dev:pipeline_position';

/**
 * state-plane-adoption-2026-08-02 P-010 — EMIT the plane instead of competing with it.
 *
 * P-002 (the `seeAlso` below) POINTS at the plane and names one cell. That is promotion,
 * and promotion asymptotes: measured ACT/QUOTE adoption is 1.7% (D-030). This stamps every
 * volatile value in the answer with the cell that re-answers it, so a caller about to quote
 * one is already holding the reference and never has to know to switch tools.
 *
 * The door→cell map is not maintained here — it is each cell's own `changeSignal`
 * declaration, filtered by this tool's name (see state-plane-stamp.ts).
 *
 * TOTAL BY CONSTRUCTION. This decorates a read-only probe that agents depend on, so it
 * degrades to "no block" rather than failing the call: `resolveAgentIdentity` throws on a
 * malformed principal (this tool is `requirePrincipal: false`, so that is reachable), and
 * an enrichment that can fail the operation it enriches is the defect cell-read.ts already
 * documents. A reader we could not resolve keeps its roles empty, which under `canReadCell`
 * admits workspace-visible cells only — under-advertising, never over-advertising.
 */
function planeFor(payload: unknown, args: { path?: string; sha?: string }, ctx: unknown): StatePlaneBlock | null {
  try {
    let reader = { ownerId: '', roles: [] as string[], harnessSlug: undefined as string | undefined };
    try {
      const c = (ctx ?? {}) as { role?: string; harnessSlug?: string | null };
      const identity = resolveAgentIdentity(c as never);
      reader = {
        ownerId: identity.ownerId,
        roles: c.role ? [c.role] : [],
        harnessSlug: c.harnessSlug ?? undefined,
      };
    } catch {
      // Unresolvable principal — fall through with the empty reader (workspace cells only).
    }
    return stampStatePlane({
      payload,
      tool: TOOL_NAME,
      // The subject for a caller-relative cell. Keyed by the PARAM NAME the spec declares,
      // never positionally — `path` here, `ownerId` for coord:goal's cell.
      args: { path: args.path, sha: args.sha },
      cells: listCells(reader),
      reader,
    });
  } catch {
    return null;
  }
}

export default defineTool({
  name: 'dev:pipeline_position',
  profile: 'engineer',
  description:
    '"Is my edit live YET — and what actually makes it live?" Read-only. Pass a repo-relative `path` (preferred) or a `sha`: returns committed/on-staging/in-main/deployed + the green-gate stall context + a one-line summary — AND, from the path, WHICH PROCESS RUNS THAT CODE. That second half matters: the gateway (:8788), bg-host (routines/DBOS) and embed-sidecar all run tsx STRAIGHT FROM THE STAGING TREE, so a deploy NEVER carries their code — the edit is already on their disk and a `dev:restart { target }` is what loads it. For those paths this returns an `activation` block (the exact restart call) and deliberately does NOT tell you to wait on the deploy. A few paths have 2 consumers on different routes — those return `activations` (plural) instead.',
  // @cell-lens git.pipelinePosition
  // This tool is the RESOLVER behind all five registered cells (git.pipelinePosition,
  // gate.greenCheckpoint.verdict/.candidate, deploy.3070.sha, git.mainBehindStaging) —
  // see packages/operator-core/lib/cell-registrations.ts. It already satisfies D-038
  // axis 5: those cells project this one derivation rather than recomputing it, and a
  // no-arg call is legal precisely so the three GLOBAL cells resolve (P-007 / D-067).
  capability: 'intel:read',
  guidance: {
    when: 'After leaving an edit in the tree (git-sync owns commit/push): to confirm it reached staging/main/:3070, to see WHY it is stuck (gate red/stalled) — or, whenever the code you touched might not be operator code, to find out whether a deploy or a RESTART is what activates it. Pass `path`, not `sha`: the sha cannot tell you which host runs the code.',
    notWhen: 'To PAUSE sync (use locks:acquire_resource on git-sync:<slug>). For the whole-pipeline dashboard use the /admin Git tab; this is the targeted per-path/sha probe.',
    chaining: 'Edit → dev:pipeline_position{path} → if `activation` is present, dev:restart{target} (a deploy would be a no-op); else deploy:await / release:deploy.',
    /**
     * state-plane-adoption-2026-08-02 P-002: route this incumbent door at the state
     * plane. Deliberately a `seeAlso` and NOT a `chaining` line, for two independent
     * reasons — the second is the real one:
     *
     *  1. WEIGHT. `chaining` is prompt-resident, and this tool projects at 1411 against
     *     the 1500 budget — 89 chars of headroom. Its siblings are worse (dev:restart
     *     1491, release:deploy 1472). The prompt-time route is effectively closed across
     *     this whole family, so "add a pointer to the guidance" does not scale here.
     *  2. TIMING. The plane's entire claim is "RE-READ this value at the moment you ACT
     *     on it, don't transcribe it" (CLAUDE.md). The moment to say that is when the
     *     value is in the caller's hand — not at catalog-selection time, minutes earlier.
     *     A result-time pointer also self-gates, so it names the ONE cell that re-answers
     *     the question this caller demonstrably already has.
     */
    seeAlso: (result) => {
      const j = readJsonResult<{ blockedOn?: string | null }>(result);
      // seeAlso runs on the SERIALIZED result — on the MCP transport the {data} envelope
      // may be TOON, so readJsonResult returns undefined and a JSON-only gate would
      // silently never fire. Same regex fallback coord:presence uses; fail open.
      const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
      const raw = j?.blockedOn ?? /\bblockedOn\b["']?\s*:\s*["']?([a-z]+)/i.exec(text)?.[1] ?? null;
      // Validate against the real StageName union — this also rejects a rendered
      // `blockedOn: null` (the change is live), which a bare [a-z]+ would capture.
      const blockedOn =
        raw && ['committed', 'pushed', 'gate', 'main', 'deployed', 'serving'].includes(raw)
          ? raw
          : null;

      const out: SeeAlsoEntry[] = [
        'dev:restart (loads an edit into gateway / bg-host / embed-sidecar / :3170 — what `activation` points at)',
        'dev:build_status (deploy / build status)',
        'release:deploy (force or inspect the deploy)',
      ];

      const cell =
        blockedOn === 'gate'
          ? 'gate.greenCheckpoint.verdict'
          : blockedOn === 'main'
            ? 'git.mainBehindStaging'
            : blockedOn === 'deployed' || blockedOn === 'serving'
              ? 'deploy.3070.sha'
              : 'git.pipelinePosition';
      out.push({
        tool: 'state:read',
        selector: `{ cell: '${cell}' }`,
        reason:
          'these values drift mid-turn — re-read before you ACT on one or quote it into a plan/message, never transcribe it',
      });

      // Only where it is not a SECOND door for a wait that already has one: the deploy
      // leg already gets `awaitable`/deploy:await from the handler below, and shipping
      // both is the "two contradictory instructions in one payload" failure this file
      // warns about. The gate is the genuine gap — blockedOn:'gate' with nextAction null
      // is this tool's own documented "waiting is correct, and there is NO lever" verdict,
      // which is exactly the case that cost a live session ~26min of silence (WI-6595).
      if (blockedOn === 'gate') {
        out.push({
          tool: 'state:subscribe',
          selector: `{ cell: 'gate.greenCheckpoint.verdict' }`,
          reason: 'wait for the verdict to CHANGE instead of re-polling this tool',
        });
      }
      return out;
    },
  },
  requirePrincipal: false,
  // Read-only (intel:read) "where is my change + is the gate stalled" probe. Available to
  // EVERY execution/judgment role — the shared DEPLOY_PIPELINE_NOTE tells all of them to reach
  // for it instead of polling :3070, so the allowlist must cover them all (deploy-pipeline-legibility-2026-06-18 P-005).
  agentRoles: [
    'operator', 'mug', 'architect', 'worker', 'scoper', 'validator', 'reviewer',
    'debugger', 'documenter', 'curator', 'cup', 'papercup', 'papercup-deep', 'kettle',
    'release-fixer', 'merge-resolver', 'content-fixer', 'release-manager',
  ],
  args: z.object({
    path: z.string().min(1).max(400).optional(),
    sha: z.string().min(4).max(64).optional(),
    /**
     * EI-18797292094433710. Kept OPTIONAL rather than folded into `path` because it is a
     * different KIND of input — the caller's own change, which nothing on this box can
     * derive: git-sync commits the whole shared tree under one identity, so there is no
     * commit that is identifiably "yours" to test ancestry against.
     */
    marker: z
      .string()
      .min(3)
      .max(200)
      // Refused rather than silently ignored: a caller that named a marker is asking for
      // a DEFINITIVE verdict, so quietly handing back the ambiguous one is the worse
      // failure. (min(3) alone admits "   ", which would match indentation everywhere.)
      .refine((s) => s.trim().length >= 3, {
        message: 'marker must contain at least 3 non-whitespace characters — a blank marker matches everywhere.',
      })
      .optional()
      .describe(
        'A distinctive LITERAL string YOUR CHANGE INTRODUCED (a new function name, an added error message, an id) — ' +
          'NEVER a pre-existing identifier, table/type name, or symbol the file already contained: a marker that was ' +
          'already present before your edit proves nothing (EI-19325915429897280/EI-19325709344484737), so a leg only ' +
          'gets corrected on a STRICT net-new occurrence count against the pre-change baseline, not bare presence. ' +
          'Answers "is MY change there?" definitively where the default checks CANNOT: they resolve a path to its NEWEST commit, ' +
          'so any peer commit to the same file breaks them permanently. Settles BOTH `changeInCandidate` (the commit the gate judges) ' +
          'AND the `positions.inMain` / `positions.deployed` legs, correcting them in either direction. ' +
          'Use it whenever you see missingReason:"newer-commit" or a leg named in `positionsNewerCommit`.',
      ),
  }),
  async handler(args, ctx) {
    /**
     * unified-agent-state-plane-2026-07-27 P-007: a NO-ARG call is now legal and returns
     * the PIPELINE-WIDE legs (`gate`, `deployedSha`, `verdictProvenance`) with the
     * per-path legs reported as unmeasured.
     *
     * It used to return `{ error: 'Provide a path or a sha.' }`, which was reasonable
     * while every caller was asking a per-path question. It stopped being reasonable
     * when the cell registry began serving `gate.greenCheckpoint.verdict`,
     * `deploy.3070.sha` and `git.mainBehindStaging` — cells whose `callerRelativity` is
     * GLOBAL, precisely because the gate's red streak and the deployed sha are not
     * relative to anyone's path. `readCell` dispatches a global cell with `{}` (see
     * argsForRelativity), so the guard made those three cells resolve to an error
     * payload: registered, and dead. A registration that reads as an error is worse than
     * no registration, because the registry is supposed to be the trustworthy surface.
     *
     * The resolver already handled a null path correctly — it notes 'Provide a path or a
     * sha' and computes every global leg — so this is the removal of a wrapper-level
     * guard, not a new code path. Callers who omit both args still get told, in `notes`,
     * that the per-path legs are unanswerable; they simply also get the facts that do
     * not depend on a path.
     */
    const result = await gitPipelinePosition({ path: args.path, sha: args.sha, marker: args.marker });

    // P-010. Computed ONCE and spread into every return below — this handler has three
    // exits (multi-consumer, non-release runtime, default), and stamping only the default
    // would drop the plane for exactly the paths with unusual activation routes, which are
    // the ones whose readers are most likely to be reasoning about staleness.
    const plane = planeFor(result, args, ctx);

    // WI-5440: a path can have MORE THAN ONE consumer on DIFFERENT activation
    // routes (e.g. a file read by both a bg-host-only routine and an
    // operator-served MCP tool) — collapsing to a single `activation` block
    // confidently routes the activation decision the WRONG way for whichever
    // consumer isn't named. When `runtimes` has more than one entry, return
    // one activation per consumer instead of picking one.
    const runtimes = result.runtimes;
    if (runtimes && runtimes.length > 1) {
      const anyReleaseCarried = runtimes.some((r) => r.releasePipelineApplies);
      return {
        data: {
          ...result,
          ...(plane ? { plane } : {}),
          activations: runtimes.map((r) => ({
            hint: r.activation,
            host: r.host,
            releasePipelineApplies: r.releasePipelineApplies,
            ...(r.restartTarget
              ? { tool: 'dev:restart', args: { target: r.restartTarget, confirm: true, authorize: true, reason: 'load the edit' } }
              : {}),
          })),
          note: anyReleaseCarried
            ? `This path has ${runtimes.length} distinct consumers on different activation routes (${runtimes
                .map((r) => r.host)
                .join(' + ')}) — at least one of them (${runtimes
                .filter((r) => r.releasePipelineApplies)
                .map((r) => r.host)
                .join(', ')}) genuinely needs the deploy pipeline, so do NOT blanket-skip deploy:await; check each entry in \`activations\` against which consumer you actually care about before picking a route.`
            : `This path has ${runtimes.length} distinct consumers on different activation routes (${runtimes
                .map((r) => r.host)
                .join(' + ')}), none carried by the release pipeline — do NOT deploy:await; pick the restart matching the consumer you care about from \`activations\`.`,
        },
      };
    }

    // EI-10895: the `awaitable` below is only TRUE ADVICE for code the release
    // pipeline actually carries. For a staging-tree tsx host (gateway / bg-host /
    // embed-sidecar) or the Tauri shell, a deploy is a NO-OP — telling the agent to
    // sleep on `deploy:await` sends it to wait forever for an event that will land
    // and change nothing. Emit the real activation lever instead.
    const runtime = result.runtime;
    if (runtime && !runtime.releasePipelineApplies) {
      return {
        data: {
          ...result,
          ...(plane ? { plane } : {}),
          activation: {
            hint: runtime.activation,
            host: runtime.host,
            releasePipelineApplies: false,
            ...(runtime.restartTarget
              ? {
                  tool: 'dev:restart',
                  args: { target: runtime.restartTarget, confirm: true, authorize: true, reason: 'load the edit' },
                }
              : {}),
            note: 'Do NOT deploy:await this path — the process that runs it never reads the release checkout. The `positions.deployed` flag below is about the operator, not about this code being live.',
          },
        },
      };
    }

    // event-await-discoverability P-001: this is the #1 poll site the leader hit
    // repeatedly this session while `release:deployed` already fired. Advertise the
    // awaitable so the answer to "is it live yet?" is a sleep, not a re-poll. Point
    // at the GLOBAL key (fires on every deploy, always live) — deploy:await refines
    // it to the per-sha key. Only when the change isn't deployed yet is a wait useful.
    const deployed = result.positions?.deployed === true;
    // P-005 coherence: "sleep on the deploy" is only true advice when the deploy is what
    // the change is actually waiting for. If an EARLIER stage owns the next move — the work
    // is uncommitted, the push leg is faulted, the gate is red or judging a candidate
    // without this change — then sleeping on `release:deployed` waits for an event that
    // will land and carry someone else's code, while the thing that would actually help
    // goes undone. Two contradictory instructions in one payload is worse than one, so the
    // awaitable defers to `nextAction` whenever there IS one.
    //
    // ⚠ `nextAction` ALONE IS NOT ENOUGH, and the gap cost a live session ~26 minutes of
    // silence on 2026-07-28 (WI-6595). The paragraph above names "the gate is red" as a case
    // this must suppress — but a red gate with a run ALREADY IN FLIGHT has NO lever, so
    // `nextAction` is correctly null (blockedOn set + nextAction null is this tool's own
    // documented "waiting is correct" verdict). The guard therefore did not fire, the agent
    // was told to sleep on `release:deployed`, and the gate then went red: no deploy was ever
    // attempted, so NEITHER `release:deployed` NOR `release:deploy-failed` could fire (the
    // latter means an attempted deploy failed, not a gate that went red). Because a session
    // sleeping on an await has its monitor-loop fires suppressed, that advice also silenced
    // the agent's own 60s heartbeat — it had to be woken by hand.
    //
    // So gate the advice on WHERE THE CHANGE ACTUALLY SITS, not on whether a lever exists.
    // `blockedOn` is the first pending stage; `release:deployed` is only the event that
    // decides this change's fate once it has cleared everything before the deploy. Anything
    // earlier (committed / pushed / gate / main) is decided by a DIFFERENT event, and the
    // deploy that eventually fires would carry someone else's code.
    const blockedOn = result.blockedOn;
    const waitingOnTheDeployItself = blockedOn === 'deployed' || blockedOn === 'serving';
    const awaitable =
      deployed || result.nextAction || !waitingOnTheDeployItself
        ? undefined
        : {
            hint:
              'Not live yet — instead of re-polling, sleep on the deploy: deploy:await (or events:await the key below), ' +
              'then END YOUR TURN. You are re-invoked when it lands. ' +
              '⚠ PASS AN EXPLICIT timeout_sec (600 is a good default here) AND TREAT IT AS THE REAL GUARANTEE: an await ' +
              'SUPPRESSES your monitor-loop fires while you sleep, so if the event never comes the wait takes your own ' +
              'heartbeat down with it and the timeout is the ONLY thing that wakes you. It defaults to 1800s — i.e. 30 ' +
              'minutes dark. On the deadline you are re-invoked with a TIMEOUT marker, which is your cue to RE-READ this ' +
              'tool rather than re-arm the same wait. See events:catalog for all awaitable keys.',
            event: buildKey('deploy'), // global `release:deployed` — check payload.sha on wake
            sugar: 'deploy:await',
            // Concrete + copy-pasteable: the bound is the part agents omit, and the schema
            // default (1800) is far too long to be a safe fallback for a wait that also
            // silences the monitor loop (WI-6604).
            sugarArgs: { timeout_sec: 600 },
          };
    return { data: { ...result, ...(plane ? { plane } : {}), ...(awaitable ? { awaitable } : {}) } };
  },
});
