/**
 * Observe what a `claude` session ACTUALLY advertises to the model.
 *
 * The advertised tool list is the `tools` array of the /v1/messages request
 * body — nothing else is authoritative. Asking the model to list its own tools
 * is self-report; reading a deny literal out of psu-launcher.mjs says only what
 * SOME launch path passes (roleLaunchArgs / suLaunchArgs / resumeArgsFor carry
 * deliberately different sets). So this captures the real body.
 *
 * Method: point ANTHROPIC_BASE_URL at a throwaway local endpoint that records
 * `body.tools` and answers with a minimal valid SSE stream. No network, no API
 * spend, no account state — the endpoint never forwards anything.
 *
 * Used by the deny-liveness guard (psu-launcher-deny-liveness.test.ts) and
 * reusable for launch-cost measurement.
 */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

export interface AdvertisedTool {
  name: string;
  /** Serialized size of this tool's full definition, in bytes. */
  bytes: number;
}

export interface AdvertisedToolCapture {
  tools: AdvertisedTool[];
  names: string[];
  /** Total bytes of the `tools` array. */
  toolsBytes: number;
  /** Total bytes of the whole request body. */
  bodyBytes: number;
}

/** True when a `claude` binary is on PATH and can report a version. */
export function claudeBinaryAvailable(): boolean {
  try {
    const r = spawnSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

function writeStubSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const ev = (t: string, d: unknown) =>
    res.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`);
  ev('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_probe',
      type: 'message',
      role: 'assistant',
      model: 'probe',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  ev('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  ev('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'ok' },
  });
  ev('content_block_stop', { type: 'content_block_stop', index: 0 });
  ev('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  ev('message_stop', { type: 'message_stop' });
  res.end();
}

/**
 * Spawn `claude -p` with `extraArgs` and return the advertised tool list.
 *
 * MCP servers are disabled (`--strict-mcp-config` + an empty config) so the
 * capture is the NATIVE surface only and cannot vary with whatever MCP servers
 * happen to be configured on the running host.
 *
 * Returns null when no request was captured — treat that as "not measured",
 * never as "the list was empty": a failed capture and a perfect deny look
 * identical, which is why callers must pair this with a positive control.
 */
export async function captureAdvertisedTools(
  extraArgs: string[] = [],
  opts: { timeoutMs?: number } = {},
): Promise<AdvertisedToolCapture | null> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const captures: AdvertisedToolCapture[] = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url?.includes('/v1/messages')) {
        try {
          const parsed = JSON.parse(body) as { tools?: { name: string }[] };
          if (Array.isArray(parsed.tools)) {
            const tools = parsed.tools.map((t) => ({
              name: t.name,
              bytes: Buffer.byteLength(JSON.stringify(t), 'utf8'),
            }));
            captures.push({
              tools,
              names: tools.map((t) => t.name),
              toolsBytes: tools.reduce((s, t) => s + t.bytes, 0),
              bodyBytes: Buffer.byteLength(body, 'utf8'),
            });
          }
        } catch {
          /* non-JSON body: no capture from this request */
        }
        writeStubSse(res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  try {
    await new Promise<void>((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
      // Deliberately not key-shaped: the endpoint ignores auth, and a
      // key-shaped literal in this shared tree trips the secrets guard.
      env.ANTHROPIC_API_KEY = 'probe-local-endpoint-no-auth';
      // Strip every competing auth/gateway route, or the run can escape to a
      // real endpoint — which both costs money and captures nothing.
      for (const k of [
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BEDROCK_BASE_URL',
        'ANTHROPIC_VERTEX_BASE_URL',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
      ])
        delete env[k];

      const child = spawn(
        'claude',
        [
          '-p',
          'say ok',
          '--strict-mcp-config',
          '--mcp-config',
          '{"mcpServers":{}}',
          ...extraArgs,
        ],
        { env, cwd: '/tmp', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout.on('data', () => {});
      child.stderr.on('data', () => {});
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // The richest body is the one carrying the full toolset; earlier/among
  // retries a request can legitimately carry fewer.
  return captures.sort((a, b) => b.tools.length - a.tools.length)[0] ?? null;
}

/**
 * Extract the BARE tool names from `--disallowedTools=` argv tokens.
 *
 * Sub-tool forms (`Skill(loop)`, `Bash(crontab:*)`) are deliberately dropped:
 * they gate an invocation of a tool that remains advertised, so they are not
 * claims about the advertised list and must not be asserted as absences.
 */
export function bareDeniedToolNames(args: string[]): string[] {
  const out = new Set<string>();
  for (const a of args) {
    if (!a.startsWith('--disallowedTools=')) continue;
    for (const entry of a.slice('--disallowedTools='.length).split(',')) {
      const name = entry.trim();
      if (name && /^[A-Za-z][A-Za-z0-9_]*$/.test(name)) out.add(name);
    }
  }
  return [...out];
}
