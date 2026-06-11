/**
 * GET /binding/:github_repository_id — public lookup of canonical binding.
 *
 * Extends Phase 1b's per-engineer binding service for cross-engineer
 * discovery. A user pasting a GitHub URL into Entry 2 of the
 * CreateHarnessPicker calls this to find out whether a Cupboard
 * listing already binds to that repo, before creating a new one
 * (the "join existing" alert from addendum 1).
 *
 * Public (no auth). Cached at the edge for 60s by default.
 */

import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { getHarnessByGithubRepoId } from '../db.ts';

export function bindingRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/binding/:github_repository_id', async (c) => {
    const idStr = c.req.param('github_repository_id');
    const repoId = parseInt(idStr, 10);
    if (!Number.isFinite(repoId) || repoId <= 0) {
      return c.json({ error: 'invalid_repository_id' }, 400);
    }
    const row = await getHarnessByGithubRepoId(c.env.DB, repoId);
    if (!row || row.unlisted_at) return c.json({ exists: false });
    return c.json({
      exists: true,
      harness: {
        id: row.id,
        github_repository_id: row.github_repository_id,
        github_url: row.github_url,
        title: row.title,
        description: row.description,
        topic_hex: row.topic_hex,
        claim_status: row.claim_status,
        claimant_github_login: row.claimant_github_login,
        publisher_github_login: row.publisher_github_login,
        // Repo→Hive binding (migration 007): the owning Hive's identity, so a
        // pasted member-repo URL resolves to its hive (P-005 lookup resolver).
        hive_pubkey: row.hive_pubkey ?? null,
        hive_title: row.hive_title ?? null,
      },
    });
  });

  return app;
}
