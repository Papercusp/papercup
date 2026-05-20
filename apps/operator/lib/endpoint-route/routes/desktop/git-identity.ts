/**
 * GET /api/desktop/git-identity — resolve the user's git identity from
 * global, then system, git config.
 *
 * Ported from app/api/desktop/git-identity/route.ts. `auth: {}`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { defineRoute } from '../../define-route';

const exec = promisify(execFile);

async function readConfig(scope: 'global' | 'system', key: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['config', `--${scope}`, '--get', key], { timeout: 3000 });
    const v = stdout.trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

export default defineRoute({
  method: 'GET',
  path: '/desktop/git-identity',
  auth: {},
  async handler() {
    const [globalName, globalEmail, systemName, systemEmail] = await Promise.all([
      readConfig('global', 'user.name'),
      readConfig('global', 'user.email'),
      readConfig('system', 'user.name'),
      readConfig('system', 'user.email'),
    ]);

    if (globalName || globalEmail) {
      return Response.json({ name: globalName, email: globalEmail, source: 'global' });
    }
    if (systemName || systemEmail) {
      return Response.json({ name: systemName, email: systemEmail, source: 'system' });
    }
    return Response.json({ source: 'none' });
  },
});
