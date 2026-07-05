/**
 * Tests for GET /api/desktop/github-user — resolves the local gh identity via
 * `gh api user`, with 404 (not installed / logged out) + 500 (bad output) paths.
 * Run with: cd packages/operator-core && npx vitest run lib/endpoint-route/routes/desktop/github-user.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('execa', () => ({ default: execaMock.fn }));

import { desktopGithubUser } from './github-user';

const handler = (desktopGithubUser as unknown as { handler: (ctx: unknown) => Promise<Response> }).handler;

describe('GET /desktop/github-user', () => {
  it('returns the id + login from `gh api user`', async () => {
    execaMock.fn.mockResolvedValue({ stdout: '{"id":42,"login":"octocat"}' });
    const res = await handler({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 42, login: 'octocat' });
  });

  it('returns 500 on unexpected gh output shape', async () => {
    execaMock.fn.mockResolvedValue({ stdout: '{"id":"not-a-number","login":"x"}' });
    const res = await handler({});
    expect(res.status).toBe(500);
  });

  it('returns 404 when gh is unavailable / not authenticated', async () => {
    execaMock.fn.mockRejectedValue(new Error('command not found: gh'));
    const res = await handler({});
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not available or not authenticated/);
  });
});
