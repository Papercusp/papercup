/**
 * prompt-studio routes (P-011) — the source-id WHITELIST is the security boundary
 * (no user-controlled path segments → no traversal). These pin that boundary + the
 * project-guide path derivation; the preview/read/write handlers are thin wrappers
 * over `renderSuPlaybook` + fs that the live host exercises.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { __test } from './prompt-studio';
import promptStudioRoutes from './prompt-studio';

const { resolveSourcePath, projectGuidePath, PROMPT_SOURCES, PROJECT_GUIDE_ID } = __test;
const DIR = '/repo/apps/operator/prompts';

describe('prompt-studio source whitelist (P-011 security boundary)', () => {
  it('resolves whitelisted playbook + overlay ids to paths inside the prompts dir', () => {
    expect(resolveSourcePath('engineer-playbook', DIR)?.path).toBe(join(DIR, 'papercusp-su-engineer.tools.md'));
    expect(resolveSourcePath('power-playbook', DIR)?.path).toBe(join(DIR, 'papercusp-su-power.tools.md'));
    expect(resolveSourcePath('overlay-claude', DIR)?.path).toBe(join(DIR, 'papercusp-su.claude.md'));
    expect(resolveSourcePath('overlay-codex', DIR)?.kind).toBe('overlay');
  });

  it('resolves the project-guide id to the repo CLAUDE.md (3 up from the prompts dir)', () => {
    expect(resolveSourcePath(PROJECT_GUIDE_ID, DIR)?.path).toBe('/repo/CLAUDE.md');
    expect(projectGuidePath(DIR)).toBe('/repo/CLAUDE.md');
  });

  it('rejects unknown ids + path-traversal attempts (the id is never a path segment)', () => {
    expect(resolveSourcePath('', DIR)).toBeNull();
    expect(resolveSourcePath('nope', DIR)).toBeNull();
    expect(resolveSourcePath('../../../etc/passwd', DIR)).toBeNull();
    expect(resolveSourcePath('../package.json', DIR)).toBeNull();
    // a raw filename is NOT a whitelisted id — only the declared ids resolve
    expect(resolveSourcePath('papercusp-su-engineer.tools.md', DIR)).toBeNull();
  });

  it('the whitelist covers exactly the renderSuPlaybook playbook + overlay sources', () => {
    expect(Object.keys(PROMPT_SOURCES).sort()).toEqual([
      'engineer-playbook',
      'overlay-claude',
      'overlay-codex',
      'overlay-omp',
      'power-playbook',
    ]);
  });
});

describe('prompt-studio routes — loopback authz boundary (security regression)', () => {
  // Every handler reads/rewrites the SOURCES of every agent's system prompt, so each must
  // reject a non-loopback caller (requireLoopbackOr403). Guards the HIGH finding: auth:'public'
  // is the codebase norm; loopback is the perimeter — don't let any route silently lose it.
  type RouteObj = { handler: (req: Request, ctx: unknown) => Promise<Response> };
  const routes = promptStudioRoutes as RouteObj[];
  const hit = async (r: RouteObj, host: string) => {
    const res = (await r.handler(
      new Request(`http://${host}/api/prompt-studio/x`, { method: 'POST', body: '{}' }) as never,
      {} as never,
    )) as Response;
    return { status: res.status, body: (await res.json().catch(() => null)) as { error?: string } | null };
  };

  it('403s a non-loopback caller on EVERY route', async () => {
    expect(routes.length).toBe(4);
    for (const r of routes) {
      const { status, body } = await hit(r, 'evil.example.com');
      expect(status).toBe(403);
      expect(body?.error).toBe('loopback_only');
    }
  });

  it('lets a loopback caller past the guard on every route (not 403)', async () => {
    for (const r of routes) {
      const { status } = await hit(r, '127.0.0.1');
      expect(status).not.toBe(403);
    }
  });
});
