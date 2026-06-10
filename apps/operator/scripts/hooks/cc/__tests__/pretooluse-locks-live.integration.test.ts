/**
 * pretooluse-locks-live.integration.test.ts — the lock-hook LIVE rung
 * (coord-system-e2e-testing-2026-06-10 P-008).
 *
 * cc-hooks.test.ts covers the operator-independent paths and
 * pretooluse-locks-decision.test.ts covers decision rendering against a
 * STUB operator. This suite closes the remaining cell: the REAL hook
 * scripts against a LIVE operator (real /api/mcp, real papercusp_su lock
 * store, real grant cascade) — the exact flow a psu session experiences:
 *
 *   1. peer A holds the path (real locks:acquire over HTTP MCP);
 *   2. session B's PreToolUse hook on the same path → DENY, with the
 *      busy reason naming the holder + its intent + the queue-and-sleep
 *      guidance (what the model is told to do instead of polling);
 *   3. B queues with wake_on_grant:true (the coordinate-instead-of-spin
 *      protocol the deny reason instructs);
 *   4. A releases → the grant cascade hands the lock to B;
 *   5. B's hook re-run now ALLOWS (exit 0, no stdout) and caches the
 *      lock_id under <tool_use_id>.lock — allow-on-grant;
 *   6. the matching PostToolUse hook releases via the cache, leaving the
 *      path free (A can immediately re-acquire).
 *
 * Live-gated like su-locks-http-mcp.integration.test.ts: skips when no
 * operator answers. All paths are run-id namespaced; everything acquired
 * is released (and TTL covers a crashed run).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OP_PORT = process.env.OP_PORT ?? null;
const BASE = OP_PORT
  ? `http://localhost:${OP_PORT}`
  : (process.env.OPERATOR_BASE_URL ?? 'http://localhost:3070');

const PRE_HOOK = join(__dirname, '..', 'pretooluse-locks-acquire.sh');
const POST_HOOK = join(__dirname, '..', 'posttooluse-locks-release.sh');

let TOKEN = '';
let reachable = false;
try {
  TOKEN = fs.readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
  const probe = await fetch(`${BASE}/api/mcp?superuser=1`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(4000),
  });
  reachable = probe.status < 500;
} catch { /* operator not running → suite skips */ }

const describeLive = reachable ? describe : describe.skip;

const RUN_ID = `${process.pid}-${Date.now()}`;
const OWNER_A = `e2e-hooklive-A-${RUN_ID}`;
const OWNER_B = `e2e-hooklive-B-${RUN_ID}`;
const REL_PATH = `e2e-hook-live/${RUN_ID}/contested.ts`;

/** Call a tool over the real HTTP MCP transport as `client`. */
async function callTool(client: string, tool: string, args: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${BASE}/api/mcp?superuser=1&client=${encodeURIComponent(client)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: tool, arguments: args },
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const raw = await res.text();
  for (let line of raw.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('event:')) continue;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    try {
      const cand = JSON.parse(line);
      if (cand && typeof cand === 'object' && 'result' in cand) {
        for (const item of (cand.result?.content ?? [])) {
          if (item.type === 'text') return JSON.parse(item.text);
        }
      }
    } catch { /* not the result line */ }
  }
  throw new Error(`no tool result in response: ${raw.slice(0, 300)}`);
}

/** Spawn a hook script with a Claude-shaped stdin payload; returns stdout + exit code. */
function runHook(
  script: string,
  payload: unknown,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

let home: string, cache: string, ws: string, repo: string;
let hookEnvB: Record<string, string>;
let editedAbsPath: string;

beforeAll(() => {
  // Hook identity home: REAL token (live operator), e2e agent id.
  home = fs.mkdtempSync(join(os.tmpdir(), 'cchook-live-home-'));
  fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
  fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), TOKEN + '\n');
  fs.writeFileSync(join(home, '.papercusp', 'su-agent-id'), `${OWNER_B}-machine\n`);
  cache = fs.mkdtempSync(join(os.tmpdir(), 'cchook-live-cache-'));

  // A workspace-shaped temp tree: <ws>/papercup-test is a "worktree"
  // (a `.git` FILE is enough for the hook's repo-root walk).
  ws = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'cchook-live-ws-')));
  repo = join(ws, 'papercup-test');
  fs.mkdirSync(join(repo, `e2e-hook-live/${RUN_ID}`), { recursive: true });
  fs.writeFileSync(join(repo, '.git'), 'gitdir: /nonexistent\n');
  editedAbsPath = join(repo, REL_PATH);
  fs.writeFileSync(editedAbsPath, '// contested\n');

  hookEnvB = {
    HOME: home,
    PAPERCUSP_OPERATOR_URL: BASE,
    PAPERCUSP_LOCKS_CACHE_DIR: cache,
    PAPERCUSP_WORKSPACE_ROOT: ws,
    PAPERCUSP_SID: OWNER_B,
  };
});

afterAll(async () => {
  // Hygiene: drop anything still held by either owner (TTL would cover it,
  // but leave the shared store clean).
  if (reachable) {
    await callTool(OWNER_A, 'locks:release', { all_mine: true }).catch(() => {});
    await callTool(OWNER_B, 'locks:release', { all_mine: true }).catch(() => {});
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

describeLive('lock-hook live rung (coord-e2e P-008)', () => {
  const TOOL_USE_ID = `tu-live-${RUN_ID}`;
  let lockIdA: string;

  it('peer A acquires the contested path over the real MCP transport', async () => {
    const r = await callTool(OWNER_A, 'locks:acquire', {
      paths: [REL_PATH],
      intent: `live-rung peer A holding ${RUN_ID}`,
      ttl_sec: 600,
    });
    expect(r.ok).toBe(true);
    expect(typeof r.lock_id).toBe('string');
    lockIdA = r.lock_id as string;
  });

  it("session B's PreToolUse hook DENIES with holder + intent + queue-and-sleep guidance", async () => {
    const r = await runHook(PRE_HOOK, {
      tool_name: 'Edit',
      tool_input: { file_path: editedAbsPath },
      tool_use_id: TOOL_USE_ID,
      session_id: 'sess-live-b',
      cwd: repo,
    }, hookEnvB);

    expect(r.code).toBe(0);
    expect(r.stdout).not.toBe(''); // deny emits a decision
    const decision = JSON.parse(r.stdout);
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    const reason: string = decision.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain(REL_PATH);
    // Holder is named by its (truncated) label — e.g. "su · e2e-hook" —
    // and unambiguously identified by the intent line carrying the run id.
    expect(reason).toMatch(/su · e2e-hook/);
    expect(reason).toContain(`live-rung peer A holding ${RUN_ID}`); // holder's intent, not a generic label
    expect(reason).toContain('wake_on_grant'); // the coordinate-don't-poll guidance
    // No lock cached on a deny.
    expect(fs.existsSync(join(cache, `${TOOL_USE_ID}.lock`))).toBe(false);
  });

  it('B queues with wake_on_grant (the protocol the deny reason instructs)', async () => {
    const r = await callTool(OWNER_B, 'locks:acquire', {
      paths: [REL_PATH],
      intent: `live-rung B queued ${RUN_ID}`,
      ttl_sec: 600,
      wake_on_grant: true,
    });
    expect(r.ok).not.toBe(true); // busy — queued, not granted
  });

  it('A releases → grant cascade → B re-runs the hook and is ALLOWED with the lock_id cached', async () => {
    const rel = await callTool(OWNER_A, 'locks:release', { lock_id: lockIdA });
    expect(rel.ok).toBe(true);

    // The cascade grants B's queued waiter; the hook's acquire as B then
    // resolves same-owner (refresh / grant pickup) → ok. Allow up to ~8s.
    let allowed = false;
    let lastStdout = '';
    for (let i = 0; i < 8 && !allowed; i++) {
      const r = await runHook(PRE_HOOK, {
        tool_name: 'Edit',
        tool_input: { file_path: editedAbsPath },
        tool_use_id: TOOL_USE_ID,
        session_id: 'sess-live-b',
        cwd: repo,
      }, hookEnvB);
      lastStdout = r.stdout;
      allowed = r.code === 0 && r.stdout === '';
      if (!allowed) await new Promise((res) => setTimeout(res, 1000));
    }
    expect(allowed, `hook still denying: ${lastStdout.slice(0, 300)}`).toBe(true);

    // Allow-on-grant cached the lock_id for the matching PostToolUse.
    const cacheFile = join(cache, `${TOOL_USE_ID}.lock`);
    expect(fs.existsSync(cacheFile)).toBe(true);
    expect(fs.readFileSync(cacheFile, 'utf8').trim().length).toBeGreaterThan(0);
  });

  it('the matching PostToolUse hook releases via the cache — path free for A again', async () => {
    const r = await runHook(POST_HOOK, {
      tool_name: 'Edit',
      tool_input: { file_path: editedAbsPath },
      tool_use_id: TOOL_USE_ID,
      session_id: 'sess-live-b',
      cwd: repo,
    }, hookEnvB);
    expect(r.code).toBe(0);

    // The release went through if A can immediately re-acquire (no queue).
    const again = await callTool(OWNER_A, 'locks:acquire', {
      paths: [REL_PATH],
      intent: `live-rung A reacquire ${RUN_ID}`,
      ttl_sec: 60,
    });
    expect(again.ok).toBe(true);
    await callTool(OWNER_A, 'locks:release', { lock_id: again.lock_id });
  });
});
