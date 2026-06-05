/**
 * POST /api/admin/testing/ai-explore — SSE stream of an AI browser exploration
 * run (stagehand-runner subprocess).
 *
 * Thin operator mount over `@papercusp/testing-shell/server` (Phase 6 of
 * universal-testing-domains-generic-2026-06-03): the runner, config parsing, and
 * spawn now live in the lib (`parseAiExploreConfig` / `spawnAiExplore` /
 * `parseAiExploreLine`). This route keeps the operator's `defineTool` +
 * `sseResponse` wrapper (typed vocab + heartbeats) and injects the Anthropic key
 * from the operator credential store. Hono consumers (Restart) use
 * `spawnAiExploreSSE` directly.
 */
import { createInterface } from 'node:readline';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { sseResponse } from '@papercusp/sse';
import { parseAiExploreConfig, spawnAiExplore, parseAiExploreLine } from '@papercusp/testing-shell/server';
import { readCredentials } from '../../../credentials';
import { defineTool } from '@papercusp/agent-mcp';

type AiExploreVocab = {
  start: { goal: string; model: string; startUrl: string };
  step: { n: number; action: string; ok: boolean; durationMs: number; result?: string | null };
  log: { level: string; line: string };
  metrics: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
  done: { totalMs: number; steps: number; costUsd: number; exitCode: number };
  error: { message: string };
}

// The :3070 host runs with cwd = apps/operator; the lib resolves the bundled
// stagehand-runner.mjs from <repoRoot>/libs/testing-shell/. Tolerate cwd = repo root too.
function resolveRepoRoot(): string {
  const up = path.resolve(process.cwd(), '..', '..');
  return existsSync(path.join(up, 'libs', 'testing-shell')) ? up : process.cwd();
}

export default defineTool({
  method: 'POST',
  path: '/admin/testing/ai-explore',
  auth: { trust: ['verified', 'trusted'] },
  sampleRate: 0,
  async handler(req): Promise<Response> {
    const body = await req.json().catch(() => null);
    // Project-agnostic (D-002): the AI walk drives whatever startUrl it's given;
    // the operator's default is its own :3055 SPA, overridable via AI_EXPLORE_BASE_URL.
    const parsed = parseAiExploreConfig(body, {
      defaultStartUrl: process.env.AI_EXPLORE_BASE_URL ?? 'http://127.0.0.1:3055/',
    });
    if (!parsed.ok) return new Response(parsed.msg, { status: 400 });

    const creds = await readCredentials();
    const apiKey = creds.anthropic_api_key;
    if (!apiKey) {
      return new Response('No Anthropic API key configured. Set one in Settings → API keys.', { status: 400 });
    }

    const repoRoot = resolveRepoRoot();

    return sseResponse<AiExploreVocab>({
      signal: req.signal,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      setup: async (sink) => {
        const child = spawnAiExplore(parsed.cfg, { repoRoot, apiKey });
        if (!child) {
          if (!sink.closed) sink.event('error', { message: `stagehand-runner not found under ${repoRoot}` });
          sink.done();
          return;
        }

        const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
        rl.on('line', (line) => {
          if (sink.closed) return;
          const evt = parseAiExploreLine(line);
          if (!evt) return;
          const { type, ...payload } = evt;
          sink.event(type as keyof AiExploreVocab, payload as AiExploreVocab[keyof AiExploreVocab]);
        });

        const errRl = createInterface({ input: child.stderr!, crlfDelay: Infinity });
        errRl.on('line', (line) => {
          if (!sink.closed) sink.event('log', { level: 'error', line: line.slice(0, 500) });
        });

        child.on('error', (err) => {
          if (!sink.closed) sink.event('error', { message: String(err?.message ?? err) });
        });

        child.on('exit', (code) => {
          if (sink.closed) return;
          sink.event('done', { totalMs: 0, steps: 0, costUsd: 0, exitCode: code ?? -1 });
          sink.done();
        });

        // Kill child if client aborts.
        req.signal.addEventListener('abort', () => {
          try { child.kill('SIGTERM'); } catch { /* already dead */ }
        });
      },
    });
  },
});
