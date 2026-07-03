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
    'Read-only: where a change sits along the git-sync → green-checkpoint → release pipeline. Pass a repo-relative `path` (its latest commit) OR a `sha`; returns committed/on-staging/in-main/deployed + the green-gate stall context + a one-line summary. Answers "did my edit land + is it live on :3070?" without forensic git/PG/curl.',
  capability: 'intel:read',
  guidance: {
    when: 'After leaving an edit in the tree (git-sync owns commit/push), to confirm it reached origin/staging, passed the green gate into main, and deployed to the live :3070 operator — or to see WHY it is stuck (gate red/stalled).',
    notWhen: 'To PAUSE sync (use locks:acquire_resource on git-sync:<slug>). For the whole-pipeline dashboard use the /admin Git tab; this is the targeted per-path/sha probe.',
    chaining: 'Edit a file → (git-sync commits within minutes) → dev:pipeline_position{path} to confirm it reached staging/main/:3070.',
    seeAlso: [
      'dev:build_status (deploy / build status)',
      'release:deploy (force or inspect the deploy)',
    ],
  },
  requirePrincipal: false,
  // Read-only (intel:read) "where is my change + is the gate stalled" probe. Available to
  // EVERY execution/judgment role — the shared DEPLOY_PIPELINE_NOTE tells all of them to reach
  // for it instead of polling :3070, so the allowlist must cover them all (deploy-pipeline-legibility-2026-06-18 P-005).
  agentRoles: [
    'operator', 'queen', 'architect', 'worker', 'scoper', 'validator', 'reviewer',
    'debugger', 'documenter', 'curator', 'bee', 'sentinel', 'overwatch',
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
    // event-await-discoverability P-001: this is the #1 poll site the leader hit
    // repeatedly this session while `release:deployed` already fired. Advertise the
    // awaitable so the answer to "is it live yet?" is a sleep, not a re-poll. Point
    // at the GLOBAL key (fires on every deploy, always live) — deploy:await refines
    // it to the per-sha key. Only when the change isn't deployed yet is a wait useful.
    const deployed = (result as { positions?: { deployed?: boolean } }).positions?.deployed === true;
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
