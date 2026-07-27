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
import { defineTool } from '@papercusp/agent-mcp';
import { gitPipelinePosition } from '../../git-pipeline-position';
import { buildKey } from '../../events/await/catalog';

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
    seeAlso: [
      'dev:restart (loads an edit into gateway / bg-host / embed-sidecar / :3170 — what `activation` points at)',
      'dev:build_status (deploy / build status)',
      'release:deploy (force or inspect the deploy)',
    ],
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
        'A distinctive LITERAL string from YOUR change (a new function name, an added error message, an id). ' +
          'Answers "is MY change in the commit the gate is judging?" definitively — which the default containment check CANNOT, ' +
          'because it compares the file byte-for-byte and any peer commit to the same file breaks that permanently. Use it whenever you see missingReason:"newer-commit".',
      ),
  }),
  async handler(args) {
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
          activations: runtimes.map((r) => ({
            hint: r.activation,
            host: r.host,
            releasePipelineApplies: r.releasePipelineApplies,
            ...(r.restartTarget ? { tool: 'dev:restart', args: { target: r.restartTarget, confirm: true } } : {}),
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
          activation: {
            hint: runtime.activation,
            host: runtime.host,
            releasePipelineApplies: false,
            ...(runtime.restartTarget
              ? { tool: 'dev:restart', args: { target: runtime.restartTarget, confirm: true } }
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
    const awaitable =
      deployed || result.nextAction
        ? undefined
        : {
            hint: 'Not live yet — instead of re-polling, sleep on the deploy: deploy:await (or events:await the key below), then END YOUR TURN. You are re-invoked when it lands. See events:catalog for all awaitable keys.',
            event: buildKey('deploy'), // global `release:deployed` — check payload.sha on wake
            sugar: 'deploy:await',
          };
    return { data: { ...result, ...(awaitable ? { awaitable } : {}) } };
  },
});
