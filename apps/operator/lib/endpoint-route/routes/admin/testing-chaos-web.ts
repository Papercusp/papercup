/**
 * POST /api/admin/testing/chaos-web — raw-NDJSON stream of a browser chaos run
 * (the `chaos` browser variant; testing-shell-platform-variants P-006).
 *
 * Spawns the shared libs/testing-shell/src/web/chaos-runner.mjs (a
 * headless-Chromium random-clicker) against a base URL and relays its NDJSON
 * stdout VERBATIM to <ChaosWebPanel>, which parses the lines. Deliberately NOT
 * `sseResponse`: the shared panel (also used by Restart) reads raw NDJSON, so
 * the framing must match across both hosts.
 *
 * papercup ships Playwright + chromium (its e2e suite uses them), so the runner
 * resolves `import('playwright')` from the repo node_modules. Spawn pattern
 * mirrors testing-ai-explore.ts; the default baseUrl is the BUILT operator SPA
 * on :3070 (the port the desktop webview loads) — NOT the :3055 Vite HMR dev
 * server, which fails to render `createHotContext` in a plain headless browser.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { defineTool } from '@papercusp/agent-mcp';

// Browser chaos drives a same-box dev origin only — never an arbitrary URL.
const ALLOWED_BASE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

// chaos-runner.mjs lives in the testing-shell submodule at the repo root. The
// :3070 host runs with cwd = apps/operator (cf. ai-explore's runner resolve);
// tolerate cwd = repo root too.
function resolveRunner(): string | null {
  const rel = ['libs', 'testing-shell', 'src', 'web', 'chaos-runner.mjs'];
  const candidates = [
    path.resolve(process.cwd(), '..', '..', ...rel),
    path.resolve(process.cwd(), ...rel),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export default defineTool({
  method: 'POST',
  path: '/admin/testing/chaos-web',
  auth: { trust: ['verified', 'trusted'] },
  sampleRate: 0,
  async handler(req): Promise<Response> {
    const body = (await req.json().catch(() => null)) as { baseUrl?: string; maxSteps?: number } | null;
    const baseUrl =
      typeof body?.baseUrl === 'string'
        ? body.baseUrl
        : process.env.CHAOS_WEB_BASE_URL ?? 'http://127.0.0.1:3070/';
    if (!ALLOWED_BASE.test(baseUrl)) return new Response('baseUrl must be a localhost http(s) URL', { status: 400 });
    const maxSteps = Math.max(1, Math.min(200, Math.floor(Number(body?.maxSteps)) || 25));

    const runnerPath = resolveRunner();
    if (!runnerPath) return new Response('chaos-runner.mjs not found', { status: 500 });

    const enc = new TextEncoder();
    let child: ChildProcess | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        child = spawn(process.execPath, [runnerPath, baseUrl, String(maxSteps)], {
          cwd: process.cwd(),
          env: { ...process.env, NODE_OPTIONS: '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        // chaos-runner emits NDJSON on stdout — forward verbatim.
        child.stdout?.on('data', (b: Buffer) => {
          try { controller.enqueue(enc.encode(b.toString())); } catch { /* stream closed */ }
        });
        // Surface runner stderr (e.g. a failed chromium launch) as an error event.
        child.stderr?.on('data', (b: Buffer) => {
          const msg = b.toString().trim();
          if (msg) {
            try { controller.enqueue(enc.encode(JSON.stringify({ type: 'error', message: msg }) + '\n')); } catch { /* closed */ }
          }
        });
        const finish = () => { try { controller.close(); } catch { /* already closed */ } };
        child.on('close', finish);
        child.on('error', (err: Error) => {
          try { controller.enqueue(enc.encode(JSON.stringify({ type: 'error', message: err.message }) + '\n')); } catch { /* closed */ }
          finish();
        });
        req.signal.addEventListener('abort', () => {
          try { child?.kill('SIGTERM'); } catch { /* already dead */ }
        });
      },
      cancel() {
        try { child?.kill('SIGTERM'); } catch { /* already dead */ }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    });
  },
});
