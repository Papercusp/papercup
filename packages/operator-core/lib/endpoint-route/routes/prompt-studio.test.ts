/**
 * prompt-studio routes (P-011) — the source-id WHITELIST is the security boundary
 * (no user-controlled path segments → no traversal). These pin that boundary + the
 * project-guide path derivation; the preview/read/write handlers are thin wrappers
 * over `renderSuPlaybook` + fs that the live host exercises.
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { __test } from './prompt-studio';
import promptStudioRoutes from './prompt-studio';

// The repository test harness defaults runtime flags off. This suite exercises the
// declared loopback tier itself, so keep that tier enabled (and let auth reject the
// request before any feature-gated handler can run).
vi.mock('@papercusp/flags/server', async (original) => ({
  ...(await original<typeof import('@papercusp/flags/server')>()),
  getFlag: vi.fn().mockResolvedValue(true),
}));

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
  // Every handler reads/rewrites the SOURCES of every agent's system prompt, so each
  // must reject a non-loopback caller. The perimeter moved from an in-handler
  // requireLoopbackOr403 call to the DECLARED `auth: 'loopback'` tier (auth-tier
  // Wave 1), enforced by the route-stack authStep — so this guard now pins BOTH:
  // the declaration on every route, and the mounted stack actually rejecting a
  // remote Host. Don't let any route silently lose the tier.
  type RouteDef = { method: string; path: string; auth: unknown };
  const routes = promptStudioRoutes as unknown as RouteDef[];

  it("declares auth: 'loopback' on EVERY route", () => {
    expect(routes.length).toBe(4);
    for (const r of routes) {
      expect(r.auth, `${r.method} ${r.path} must stay loopback-tier`).toBe('loopback');
    }
  });

  it('the mounted stack 403s a non-loopback caller on every route', async () => {
    // Developer shells may deliberately opt into remote administration. This test
    // pins the default security boundary, so do not inherit that ambient override.
    vi.stubEnv('PAPERCUSP_ALLOW_REMOTE_ADMIN', '0');
    const { Hono } = await import('hono');
    const { registerRoute } = await import('../define-route');
    const app = new Hono();
    try {
      for (const r of routes) registerRoute(app, r as never);
      for (const r of routes) {
        const init = r.method === 'GET' ? undefined : {
          method: r.method, body: '{}', headers: { 'content-type': 'application/json' },
        };
        const res = await app.request(`http://evil.example.com${r.path}`, init);
        expect(res.status, `${r.method} ${r.path}`).toBe(403);
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        expect(body?.error).toBe('loopback_only');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
