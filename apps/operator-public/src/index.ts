/**
 * Cupboard server entrypoint (Cloudflare Worker).
 *
 * Mounted at cupboard.papercusp.dev (per v5 §10 / addendum 1).
 * D1 + KV bindings declared in wrangler.toml; secrets installed via
 * `wrangler secret put GITHUB_CLIENT_ID` etc.
 */

import type { Env } from './env.ts';
import { buildApi } from './routes/index.ts';

const api = buildApi();

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return api.fetch(req, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // Daily indexer GC runs here in P-076 (Cupboard stats indexer).
    // Wired separately so this entrypoint stays minimal.
  },
};
