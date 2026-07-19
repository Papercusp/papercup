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
    '"Is my edit live YET — and what actually makes it live?" Read-only. Pass a repo-relative `path` (preferred) or a `sha`: returns committed/on-staging/in-main/deployed + the green-gate stall context + a one-line summary — AND, from the path, WHICH PROCESS RUNS THAT CODE. That second half matters: the gateway (:8788), bg-host (routines/DBOS) and embed-sidecar all run tsx STRAIGHT FROM THE STAGING TREE, so a deploy NEVER carries their code — the edit is already on their disk and a `dev:restart { target }` is what loads it. For those paths this returns an `activation` block (the exact restart call) and deliberately does NOT tell you to wait on the deploy. A FEW paths have two genuinely distinct consumers on different routes (e.g. read by both a bg-host routine AND an operator-served tool) — for those you get `activations` (plural, one per consumer) instead of a single `activation`; check the one matching the consumer you actually care about.',
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
  }),
  async handler(args) {
    if (!args.path && !args.sha) {
      return { data: { error: 'Provide a path or a sha.' } };
    }
    const result = await gitPipelinePosition({ path: args.path, sha: args.sha });

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
    const awaitable = deployed
      ? undefined
      : {
          hint: 'Not live yet — instead of re-polling, sleep on the deploy: deploy:await (or events:await the key below), then END YOUR TURN. You are re-invoked when it lands. See events:catalog for all awaitable keys.',
          event: buildKey('deploy'), // global `release:deployed` — check payload.sha on wake
          sugar: 'deploy:await',
        };
    return { data: { ...result, ...(awaitable ? { awaitable } : {}) } };
  },
});
