/**
 * pretooluse-locks-decision.test.ts — the file-lock PreToolUse hook's
 * OPERATOR-DEPENDENT decision rendering (coordination-test-suite-2026-06-08 P-008).
 *
 * cc-hooks.test.ts already covers the operator-INDEPENDENT paths (tool filtering,
 * workspace scoping, and the fail-open contract — operator unreachable / junk
 * input / not-installed never block an edit). The one path it leaves to a live
 * smoke is the DECISION rendering once the operator answers: a `busy` result must
 * become a `permissionDecision:'deny'` the MODEL can act on, and an `ok:true`
 * grant must allow + cache the lock_id for the matching PostToolUse release. This
 * closes that cell at the hook layer with a STUB operator (a real socket speaking
 * the JSON-RPC tools/call envelope), so the block-on-held → deny path — the file
 * lock the whole shared-tree discipline rests on — is regression-guarded without
 * needing a live operator.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

const HOOK = join(__dirname, '..', 'pretooluse-locks-acquire.sh');

let home: string, cache: string, ws: string, repo: string;
let server: Server;
let port: number;
/** The inner tools/call result the stub returns next ({ ok, lock_id?, busy?, reason? }). */
let nextInner: unknown = { ok: true, lock_id: 'stub-lock' };
/** Optionally frame the response as text/event-stream (the hook parses both). */
let useSse = false;

beforeAll(async () => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'cchook-dec-home-'));
  fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
  fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
  fs.writeFileSync(join(home, '.papercusp', 'su-agent-id'), 'test-agent\n');
  cache = fs.mkdtempSync(join(os.tmpdir(), 'cchook-dec-cache-'));
  ws = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'cchook-dec-ws-')));
  repo = join(ws, 'papercusp'); // the canonical staging tree (worktree guard default: <ws>/papercusp)
  fs.mkdirSync(join(repo, 'sub'), { recursive: true });
  fs.writeFileSync(join(repo, '.git'), 'gitdir: /nonexistent\n');

  // Stub operator: respond to the hook's POST /api/mcp with a JSON-RPC result
  // wrapping `nextInner` as the tools/call text content (the exact shape the
  // hook parses).
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const rpc = {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: JSON.stringify(nextInner) }] },
      };
      if (useSse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(rpc));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const d of [home, cache, ws]) fs.rmSync(d, { recursive: true, force: true });
});

afterEach(() => {
  nextInner = { ok: true, lock_id: 'stub-lock' };
  useSse = false;
});

// Async spawn (NOT spawnSync): spawnSync blocks the event loop, so the in-process
// stub operator below could never serve the hook's request — it would always fall
// through to the 10s timeout + fail-open. Async keeps the loop free to respond.
function run(input: object, extraEnv: Record<string, string> = {}): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [HOOK], {
      env: {
        ...process.env,
        HOME: home,
        PAPERCUSP_LOCKS_CACHE_DIR: cache,
        PAPERCUSP_WORKSPACE_ROOT: ws,
        PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}`,
        ...extraEnv,
      },
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout: stdout.trim() }));
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

const editOf = (rel: string, toolUseId: string) => ({
  tool_name: 'Edit',
  tool_input: { file_path: join(repo, rel) },
  tool_use_id: toolUseId,
  session_id: 's',
  cwd: repo,
});

describe('cc PreToolUse hook — operator decision rendering (stub operator)', () => {
  it('grant (ok:true) → allow (exit 0, no decision) and CACHES the lock_id for release', async () => {
    nextInner = { ok: true, lock_id: 'lock-xyz' };
    const r = await run(editOf('sub/grant.ts', 'tu-grant'));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(''); // allow = no decision
    // The lock_id is cached by tool_use_id so PostToolUse can release it.
    const cached = join(cache, 'tu-grant.lock');
    expect(fs.existsSync(cached)).toBe(true);
    expect(fs.readFileSync(cached, 'utf8')).toBe('lock-xyz');
  });

  it('block-on-held (busy) → permissionDecision:deny carrying the holder + intent', async () => {
    nextInner = {
      ok: false,
      busy: [
        {
          path: 'sub/held.ts',
          owner: 'su-peer',
          owner_label: 'su · peer',
          intent: 'PreToolUse:Edit',
          holder_intent: 'refactoring the auth module',
          holder_focused: true,
          expires_ts: '2026-06-08T23:59:00Z',
        },
      ],
    };
    const r = await run(editOf('sub/held.ts', 'tu-busy'));
    expect(r.status).toBe(0); // deny path emits JSON then exits 0
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    const reason: string = out.hookSpecificOutput.permissionDecisionReason;
    // The reason the MODEL sees names the file, the holder, and (preferentially)
    // the holder's DECLARED coord intent, plus the focused marker + wake guidance.
    expect(reason).toContain('sub/held.ts');
    expect(reason).toContain('su · peer');
    expect(reason).toContain('refactoring the auth module');
    expect(reason).toContain('[focused on this file]');
    expect(reason).toContain('wake_on_grant');
    // A deny must NOT have cached any lock (nothing to release).
    expect(fs.existsSync(join(cache, 'tu-busy.lock'))).toBe(false);
  });

  it('server refusal with a `reason` (e.g. policy) → deny carrying that reason', async () => {
    nextInner = { ok: false, reason: 'path is on the protected list' };
    const r = await run(editOf('sub/refused.ts', 'tu-reason'));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('path is on the protected list');
  });

  it('text/event-stream framed grant is parsed → allow + cache (transport robustness)', async () => {
    useSse = true;
    nextInner = { ok: true, lock_id: 'sse-lock' };
    const r = await run(editOf('sub/sse.ts', 'tu-sse'));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.readFileSync(join(cache, 'tu-sse.lock'), 'utf8')).toBe('sse-lock');
  });

  it('text/event-stream framed busy is parsed → deny (transport robustness)', async () => {
    useSse = true;
    nextInner = { ok: false, busy: [{ path: 'sub/sse2.ts', owner: 'su-peer2', expires_ts: 'soon' }] };
    const r = await run(editOf('sub/sse2.ts', 'tu-sse2'));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('worktree guard: refuses an edit in a stray sibling worktree, BEFORE any acquire', async () => {
    // A sibling worktree under the workspace root that is NOT the canonical
    // staging tree (papercusp) — e.g. the detached papercup-staging that
    // stranded a feature on 2026-06-30. The guard must deny locally, before
    // ever reaching the operator, with a reason the model can act on.
    const stray = join(ws, 'papercup-staging');
    fs.mkdirSync(join(stray, 'sub'), { recursive: true });
    fs.writeFileSync(join(stray, '.git'), 'gitdir: /nonexistent\n');
    nextInner = { ok: true, lock_id: 'should-not-be-acquired' }; // operator would grant…
    const r = await run({
      tool_name: 'Edit',
      tool_input: { file_path: join(stray, 'sub/x.ts') },
      tool_use_id: 'tu-stray',
      session_id: 's',
      cwd: stray,
    });
    expect(r.status).toBe(0); // deny emits JSON then exits 0
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('worktree guard');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('canonical staging tree');
    // …but the guard fired first, so no lock was acquired/cached.
    expect(fs.existsSync(join(cache, 'tu-stray.lock'))).toBe(false);
  });

  it('worktree guard: ALLOWS an edit in a .papercusp/worktrees isolation tree', async () => {
    // Migration/synthesis roles get their own isolation worktree under
    // <canonical>/.papercusp/worktrees/<name>. Its parent is NOT the workspace
    // root (it's deep inside the canonical tree), so it is not a stray sibling —
    // the guard must let it through. This is the documented exception in
    // pretooluse-locks-acquire.sh; guarding it would break those roles.
    const iso = join(repo, '.papercusp', 'worktrees', 'iso-1');
    fs.mkdirSync(join(iso, 'sub'), { recursive: true });
    fs.writeFileSync(join(iso, '.git'), 'gitdir: /nonexistent\n');
    const r = await run({
      tool_name: 'Edit',
      tool_input: { file_path: join(iso, 'sub/x.ts') },
      tool_use_id: 'tu-iso',
      session_id: 's',
      cwd: iso,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(''); // allow = no decision
    // Isolation trees have a non-workspace-root parent, so they're not
    // coordinated — the guard passes them through without acquiring a lock.
    expect(fs.existsSync(join(cache, 'tu-iso.lock'))).toBe(false);
  });
});
