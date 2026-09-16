/** GET /api/harness/:slug/project-history — generate the portable History document on demand. */
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveHarnessRepoRoot } from '../../../harness/docs/harness-repo';
import {
  resolveCliBin,
  resolvePtool,
  runProjectHistoryGenerate,
  type ProjectHistoryConfig,
} from '../../../harness/routines/project-history-refresh-action';

const CACHE_MS = 60_000;
const cache = new Map<string, { expiresAt: number; document: unknown }>();

/**
 * The generator is a child CLI that colours its own diagnostics, so its stderr
 * arrives wrapped in SGR escapes. Those bytes are meaningless to an HTTP client
 * and render as literal `[31m` noise in the History tab's error box, so strip
 * them at this boundary rather than asking every consumer to.
 */
function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?:]*[ -/]*[@-~]/g, '');
}

/**
 * A condition no retry can clear: the project is structurally incapable of
 * producing a history document. Carries a machine-readable code so the client
 * renders its empty state instead of an alarming error box.
 */
export class ProjectHistoryUnavailableError extends Error {
  constructor(readonly code: 'not-a-git-repository', message: string) {
    super(message);
    this.name = 'ProjectHistoryUnavailableError';
  }
}

/** A git root holds a `.git` DIRECTORY — or a `.git` FILE when it is a worktree/submodule. */
async function isGitRepository(repoRoot: string): Promise<boolean> {
  try {
    await access(join(repoRoot, '.git'));
    return true;
  } catch {
    return false;
  }
}

export async function generateHarnessProjectHistory(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown> {
  const cached = cache.get(slug);
  if (cached && cached.expiresAt > Date.now()) return cached.document;
  const repoRoot = await resolveHarnessRepoRoot(slug);
  if (!repoRoot) throw new Error(`unknown project: ${slug}`);
  // Ask the filesystem directly rather than letting the generator fail: a pot
  // that is not a git checkout has no commits to report, which is an empty
  // history, not a fault. Detecting it here keeps a deterministic structural
  // check in front of a child process whose only signal would be `git`'s own
  // localised, colourised stderr.
  if (!await isGitRepository(repoRoot)) {
    throw new ProjectHistoryUnavailableError(
      'not-a-git-repository',
      `${slug} is not a git repository, so it has no commit history to report.`,
    );
  }
  const runnerEnv: NodeJS.ProcessEnv = {
    ...env,
    PAPERCUSP_INTEGRATION_ROOT: env.PAPERCUSP_INTEGRATION_ROOT?.trim()
      || join(dirname(fileURLToPath(import.meta.url)), '../../../../../..'),
  };
  if (!resolvePtool(runnerEnv)) throw new Error('ptool is unavailable to the Project History generator');

  const directory = await mkdtemp(join(tmpdir(), 'papercusp-history-route-'));
  const output = join(directory, 'project-history.json');
  const config: ProjectHistoryConfig = {
    workspace: runnerEnv.PAPERCUSP_WORKSPACE_ID?.trim() || 'papercusp-workspace',
    harness: slug,
    planPrefix: '',
    projectId: slug,
    projectName: slug,
    repoRoot,
    output,
    format: 'json',
    exportName: 'PROJECT_HISTORY',
  };
  try {
    const result = await runProjectHistoryGenerate(resolveCliBin(runnerEnv), config, 90_000, runnerEnv);
    if (result.code !== 0 || result.timedOut) {
      throw new Error(result.timedOut
        ? 'Project History generation timed out'
        : stripAnsi(result.stderr).trim() || `generator exited ${result.code}`);
    }
    const document = JSON.parse(await readFile(output, 'utf8')) as unknown;
    cache.set(slug, { expiresAt: Date.now() + CACHE_MS, document });
    return document;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/project-history',
  auth: 'loopback',
  // Generation reads the complete plan/work-item export and allows 90s for the
  // child CLI. Keep the route watchdog above that ceiling so the default 30s
  // stack timeout cannot turn a valid v2 document into an opaque 408.
  timeoutSec: 120,
  async handler(_req, ctx) {
    const slug = String(ctx.params.slug ?? '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,119}$/i.test(slug)) {
      return Response.json({ error: 'invalid project slug' }, { status: 400 });
    }
    try {
      return Response.json(await generateHarnessProjectHistory(slug));
    } catch (error) {
      if (error instanceof ProjectHistoryUnavailableError) {
        // 422, not 503: the request is well-formed and the server is healthy —
        // this project simply cannot produce the document, and no retry helps.
        return Response.json({ error: error.message, code: error.code }, { status: 422 });
      }
      const message = stripAnsi(error instanceof Error ? error.message : String(error));
      const status = message.startsWith('unknown project:') ? 404 : 503;
      return Response.json({ error: message }, { status });
    }
  },
});
