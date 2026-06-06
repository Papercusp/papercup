/**
 * workspace-map — the generated "Where to work" section of the SU playbooks
 * (staging-branch-pipeline-2026-06-06).
 *
 * Agents kept needing to know WHICH directory is the real workspace vs the
 * pipeline artifacts (the release + checkpoint checkouts), and which branch the
 * shared tree lives on. Those facts are CONFIG, not prose — they changed on
 * 2026-06-06 (main→staging) and hand-written playbook text drifted. So the
 * playbook carries a `<!-- PAPERCUSP-SU:WORKSPACE-MAP -->` marker and this
 * renderer derives the section from the same env seams `release-config.ts`
 * (apps/operator) and `dev-deploy-state.ts` use — change the config and every
 * freshly-rendered psu prompt follows.
 *
 * Resolution mirrors `dev-deploy-state.ts` (operator-core must not import the
 * apps/operator release lib): explicit env > git-toplevel fallback > cwd, with
 * sibling-dir defaults for the release/checkpoint roots.
 */
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

export interface WorkspaceMapConfig {
  integrationRoot: string;
  releaseRoot: string;
  checkpointRoot: string;
  integrationBranch: string;
  releaseRef: string;
}

/** Resolve the release-gate paths/branches exactly like release-config.ts. */
export function resolveWorkspaceMapConfig(): WorkspaceMapConfig {
  let integrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT ?? '';
  if (!integrationRoot) {
    try {
      integrationRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
    } catch {
      integrationRoot = process.cwd();
    }
  }
  const parent = path.dirname(integrationRoot);
  return {
    integrationRoot,
    releaseRoot: process.env.PAPERCUSP_RELEASE_ROOT ?? path.join(parent, 'papercup-release'),
    checkpointRoot: process.env.PAPERCUSP_CHECKPOINT_ROOT ?? path.join(parent, 'papercup-checkpoint'),
    integrationBranch: process.env.PAPERCUSP_INTEGRATION_BRANCH ?? 'staging',
    releaseRef: process.env.PAPERCUSP_RELEASE_REF ?? 'main',
  };
}

/**
 * Render the "Where to work" markdown section. Pure over the (injectable)
 * config so the content is unit-testable without env games.
 */
export function renderWorkspaceMapSection(cfg: WorkspaceMapConfig = resolveWorkspaceMapConfig()): string {
  const { integrationRoot, releaseRoot, checkpointRoot, integrationBranch, releaseRef } = cfg;
  return [
    `**Where to work — the workspace map** *(generated from the live release-gate config — these paths/branches are authoritative)*:`,
    ``,
    `- ✅ \`${integrationRoot}\` — the canonical shared tree (branch \`${integrationBranch}\`). ALL repo work happens here — superproject and submodules alike, edited in place; git-sync sweeps this tree to \`origin/${integrationBranch}\` on a schedule.`,
    `- 🚫 \`${releaseRoot}\` — the live operator's deploy artifact, pinned to green \`${releaseRef}\`. NEVER edit it: every deploy resets + cleans it and rebuilds its SPA dist, so a change there is clobbered and never reaches origin. If the live host lacks your fix, the fix isn't deployed yet — work in the canonical tree and let the pipeline carry it.`,
    `- 🚫 \`${checkpointRoot}\` — the green-checkpoint's ISOLATED test tree. Never edit it and never leave stray files in it (it is reset + cleaned every run; untracked debris there can poison the green gate for the whole fleet).`,
    `- 🚫 other sibling \`papercup-*\` directories — preserved special-purpose worktrees on their own branches. Not for new work.`,
    ``,
    `\`${releaseRef}\` is automation-only — green-checkpoint fast-forwards it from green \`${integrationBranch}\`; a pre-push hook blocks manual pushes. Quick self-check before editing: \`pwd\` is under \`${integrationRoot}\` and \`git branch --show-current\` prints \`${integrationBranch}\`.`,
  ].join('\n');
}
