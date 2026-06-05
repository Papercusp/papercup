/**
 * GET /binding/:github_repository_id — the cross-engineer canonical-binding
 * lookup (Entry 2 "join existing" discovery). Exercised through the Hono
 * route with a tiny in-memory D1 fake; no Workers runtime / network.
 */

import { describe, expect, it } from 'vitest';
import { bindingRoute } from '../routes/binding.ts';
import type { Env } from '../env.ts';

interface HRow {
  id: string;
  github_repository_id: number;
  github_url: string;
  title: string;
  description: string | null;
  topic_hex: string;
  claim_status: string;
  claimant_github_login: string | null;
  publisher_github_login: string | null;
  unlisted_at: number | null;
}

function envWith(harnesses: HRow[]): Env {
  const DB = {
    prepare(sql: string) {
      return {
        bind(...b: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              // Whitespace-tolerant: getHarnessByGithubRepoId is now a
              // multi-line, harness-kind-scoped lookup (migration 004).
              if (/FROM harnesses[\s\S]*github_repository_id/i.test(sql)) {
                const [id] = b as [number];
                return (harnesses.find((h) => h.github_repository_id === id) ?? null) as T | null;
              }
              return null;
            },
          };
        },
      };
    },
  };
  return { DB } as unknown as Env;
}

const row = (over: Partial<HRow> = {}): HRow => ({
  id: 'h1',
  github_repository_id: 123,
  github_url: 'https://github.com/o/r',
  title: 'R',
  description: 'desc',
  topic_hex: 'abcd',
  claim_status: 'claimed',
  claimant_github_login: 'alice',
  publisher_github_login: 'alice',
  unlisted_at: null,
  ...over,
});

async function call(env: Env, id: string) {
  const app = bindingRoute();
  const res = await app.request(`/binding/${id}`, undefined, env);
  return { res, body: await res.json() as Record<string, unknown> };
}

describe('GET /binding/:github_repository_id', () => {
  it('400 for a non-numeric or non-positive repository id', async () => {
    const env = envWith([]);
    expect((await call(env, 'abc')).res.status).toBe(400);
    expect((await call(env, '0')).res.status).toBe(400);
    expect((await call(env, '-5')).res.status).toBe(400);
  });

  it('{ exists: false } when no binding exists for the repo', async () => {
    const { res, body } = await call(envWith([]), '123');
    expect(res.status).toBe(200);
    expect(body).toEqual({ exists: false });
  });

  it('{ exists: false } when the matching harness is unlisted', async () => {
    const { body } = await call(envWith([row({ unlisted_at: Date.now() })]), '123');
    expect(body).toEqual({ exists: false });
  });

  it('returns the public binding projection when a listed harness matches', async () => {
    const { body } = await call(envWith([row()]), '123');
    expect(body.exists).toBe(true);
    expect(body.harness).toMatchObject({
      id: 'h1',
      github_repository_id: 123,
      github_url: 'https://github.com/o/r',
      claim_status: 'claimed',
      claimant_github_login: 'alice',
      publisher_github_login: 'alice',
    });
  });
});
