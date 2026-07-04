/**
 * GET /api/desktop/onboarding-launch-context — render the onboarding-tutor
 * prompt with live state and return the launch-context file path the
 * concierge passes to `psu --launch-context=…`
 * (plan agent-first-onboarding-2026-07-03, P-005).
 *
 * Query: ?agent=<claude|codex|omp> (required) · ?mode=<first-run|tutorial>
 * (default first-run).
 */
import { platform } from 'node:os';
import { defineTool } from '@papercusp/agent-mcp';
import { collectSetupStatus } from './setup-status';
import { readOperatorState } from '../../../operator-state-pg';
import { activeWorkspaceId, workspaceDir } from '../../../workspace-registry';
import {
  resolveTutorPromptSource,
  writeTutorLaunchContext,
} from '../../../onboarding/launch-context';

const AGENTS = new Set(['claude', 'codex', 'omp']);

export default defineTool({
  method: 'GET',
  path: '/desktop/onboarding-launch-context',
  auth: {},
  async handler(req: Request) {
    const q = new URL(req.url).searchParams;
    const agent = q.get('agent') ?? '';
    if (!AGENTS.has(agent)) {
      return Response.json({ error: `agent must be one of ${[...AGENTS].join('|')}` }, { status: 400 });
    }
    const mode = q.get('mode') === 'tutorial' ? 'tutorial' : 'first-run';

    const source = resolveTutorPromptSource();
    if (!source) {
      return Response.json({ error: 'onboarding-tutor.md prompt source not found' }, { status: 500 });
    }

    const [status, progress] = await Promise.all([
      collectSetupStatus().catch(() => null),
      readOperatorState<Record<string, unknown>>('tutorial_progress').catch(() => null),
    ]);

    let workspacePath = '';
    try {
      workspacePath = workspaceDir(activeWorkspaceId());
    } catch {
      /* fresh installs may have no workspace yet */
    }

    const path = writeTutorLaunchContext(source, {
      os: platform(),
      agent,
      workspacePath,
      appVersion: process.env.npm_package_version ?? process.env.PAPERCUSP_VERSION ?? 'dev',
      mode,
      setupStatusJson: JSON.stringify(status ?? {}, null, 2),
      tutorialProgressJson: JSON.stringify(progress ?? {}, null, 2),
    });
    return Response.json({ path, mode, agent });
  },
});
