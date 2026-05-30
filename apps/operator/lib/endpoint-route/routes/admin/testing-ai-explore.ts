/**
 * POST /api/admin/testing/ai-explore — SSE stream of an AI browser
 * exploration run (stagehand-runner subprocess).
 *
 * Ported from app/api/admin/testing/ai-explore/route.ts. `auth:'public'`,
 * `sampleRate: 0` (SSE). The Next `import 'server-only'` is dropped.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { sseResponse } from '@papercusp/sse';
import { readCredentials } from '@/lib/credentials';
import { defineTool } from '@papercusp/agent-mcp';

type AiExploreVocab = {
  start: { goal: string; model: string; startUrl: string };
  step: { n: number; action: string; ok: boolean; durationMs: number; result?: string | null };
  log: { level: string; line: string };
  metrics: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
  done: { totalMs: number; steps: number; costUsd: number; exitCode: number };
  error: { message: string };
}

type ParsedConfig = {
  goal: string;
  startUrl: string;
  model: string;
  maxSteps: number;
  maxCostUsd: number;
  headless: boolean;
};

function parseConfig(body: unknown): { ok: true; cfg: ParsedConfig } | { ok: false; msg: string } {
  if (!body || typeof body !== 'object') return { ok: false, msg: 'invalid body' };
  const b = body as Record<string, unknown>;
  const goal = typeof b.goal === 'string' ? b.goal.trim() : '';
  if (!goal) return { ok: false, msg: 'goal is required' };
  return {
    ok: true,
    cfg: {
      goal,
      startUrl: typeof b.startUrl === 'string' ? b.startUrl : 'http://127.0.0.1:3055/',
      model: typeof b.model === 'string' ? b.model : 'anthropic/claude-sonnet-4-6',
      maxSteps: Math.max(1, Math.min(50, Number(b.maxSteps ?? 20))),
      maxCostUsd: Math.max(0.05, Math.min(20, Number(b.maxCostUsd ?? 1.0))),
      headless: b.headless !== false,
    },
  };
}

export default defineTool({
  method: 'POST',
  path: '/admin/testing/ai-explore',
  auth: { trust: ['verified', 'trusted'] },
  sampleRate: 0,
  async handler(req): Promise<Response> {
    const body = await req.json().catch(() => null);
    const parsed = parseConfig(body);
    if (!parsed.ok) return new Response(parsed.msg, { status: 400 });

    const creds = await readCredentials();
    const apiKey = creds.anthropic_api_key;
    if (!apiKey) {
      return new Response('No Anthropic API key configured. Set one in /admin/testing → AI Explore.', { status: 400 });
    }

    const runnerPath = path.resolve(process.cwd(), 'scripts/stagehand-runner.mjs');
    const config = { ...parsed.cfg, apiKey };

    return sseResponse<AiExploreVocab>({
      signal: req.signal,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      setup: async (sink) => {
        const child = spawn(process.execPath, [runnerPath], {
          cwd: process.cwd(),
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, NODE_OPTIONS: '' },
        });

        child.stdin.write(JSON.stringify(config));
        child.stdin.end();

        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        rl.on('line', (line) => {
          if (sink.closed) return;
          try {
            const evt = JSON.parse(line);
            if (typeof evt?.type !== 'string') return;
            const { type, ...payload } = evt;
            sink.event(type as keyof AiExploreVocab, payload as AiExploreVocab[keyof AiExploreVocab]);
          } catch {
            sink.event('log', { level: 'info', line: line.slice(0, 500) });
          }
        });

        const errRl = createInterface({ input: child.stderr, crlfDelay: Infinity });
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
