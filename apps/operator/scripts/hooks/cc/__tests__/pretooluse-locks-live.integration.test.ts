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
 *   5. B's hook re-run now ALLOWS (exit 0, no stdout) without caching a
 *      release token, because the queued lock is already held by B;
 *   6. the matching PostToolUse hook is a no-op for that preexisting hold,
 *      so B must explicitly release it before A can re-acquire.
 *
 * Live-gated like su-locks-http-mcp.integration.test.ts: skips when no
 * operator answers. All paths are run-id namespaced; everything acquired
 * is released (and TTL covers a crashed run).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { runHookProcess } from './spawn-hook';
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

// Both peers must resolve to the SAME workspace so they contend on one lock key.
const E2E_WS = 'papercusp-workspace';

// The scoped-superuser-workspace-clamp (2026-06-18, FLAGS.SCOPED_SUPERUSER_CLAMP,
// default-on) rejects a `?superuser=1&client=<owner>` whose workspace can't resolve.
// In production the owner is a real adv_session row; here the e2e owners are throwaway,
// so register them — exactly as a live agent is registered — and BOTH the test's MCP
// calls and the spawned hook scripts (same ?client= path) resolve their workspace.
// execFileSync (arg array, no shell): the SQL is one argument, so no interpolation
// reaches a shell. Values here are internal constants anyway (owner = e2e-…-<pid>-<ts>).
function psql(sql: string): void {
  execFileSync(
    'psql',
    ['-h', 'localhost', '-U', 'harness_admin', '-d', 'papercusp', '-tAc', sql],
    { env: { ...process.env, PGPASSWORD: 'harness_admin_pwd' }, stdio: 'ignore' },
  );
}
function registerSession(owner: string): void {
  psql(
    `INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id) ` +
      `VALUES ('${E2E_WS}', 'console', '${owner}')`,
  );
}
function unregisterSessions(): void {
  try {
    psql(`DELETE FROM harness_shared.adv_sessions WHERE coord_owner_id IN ('${OWNER_A}','${OWNER_B}')`);
  } catch { /* best-effort cleanup */ }
}

/**
 * Call a tool over the real HTTP MCP transport as `client`.
 *
 * ⚠ A file lock is keyed by `(coordination_domain, path)` — that is literally
 * `agent_file_locks_pkey` — so a peer that omits the domain does NOT contend
 * with one that sends it, however identical their paths look. This suite's
 * hooks run against the FIXTURE tree (`PAPERCUSP_CANONICAL_TREE=<repo>`) and
 * therefore acquire under `coordination_domain: <repo>`, while a bare
 * `locks:acquire` over MCP falls back to `defaultCoordinationDomain` — the
 * REAL checkout. Left unpinned the two peers sit in different domains, every
 * contention assertion silently inverts (deny→allow), and the suite reads as
 * a product regression when nothing is wrong.
 *
 * So pin every locks:* call to the same fixture domain the hook uses. An
 * explicit `coordination_domain` in `args` still wins.
 */
async function callTool(client: string, tool: string, args: unknown): Promise<Record<string, unknown>> {
  const scopedArgs =
    tool.startsWith('locks:') && args && typeof args === 'object' && !Array.isArray(args) &&
    (args as Record<string, unknown>).coordination_domain === undefined
      ? { ...(args as Record<string, unknown>), coordination_domain: repo }
      : args;
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
        // _meta.format:'json' — the MCP result-format default flipped to compact (TOON);
        // this test JSON.parses item.text, so declare json per-call (P-009 negotiation).
        params: { name: tool, arguments: scopedArgs, _meta: { format: 'json' } },
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
          if (item.type === 'text') {
            // Bulk-standardized locks verbs return { ok, results:[{…}], counts }; every
            // call here is single-item, so flatten the lone result onto the envelope.
            const parsed = JSON.parse(item.text) as Record<string, unknown>;
            const results = parsed.results as Array<Record<string, unknown>> | undefined;
            return Array.isArray(results) && results.length === 1 && parsed.counts != null
              ? { ...parsed, ...results[0] }
              : parsed;
          }
        }
      }
    } catch { /* not the result line */ }
  }
  throw new Error(`no tool result in response: ${raw.slice(0, 300)}`);
}

/**
 * Spawn a hook script with a Claude-shaped stdin payload; returns stdout + exit code.
 * ./spawn-hook.ts owns the two invariants (async spawn, and an EPIPE-tolerant stdin write —
 * the hook exits before reading stdin on its guard paths, by design).
 */
async function runHook(
  script: string,
  payload: unknown,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const { status, stdout, stderr } = await runHookProcess('bash', [script], {
    input: JSON.stringify(payload),
    env: { ...process.env, ...env },
  });
  return { stdout, stderr, code: status };
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
    // Do not inherit the real runner CODEX_HOME: the hook's diagnostic
    // lockOwnerSid deliberately outranks PAPERCUSP_SID, and would make this
    // throwaway hook acquire as the test runner rather than OWNER_B.
    CODEX_HOME: join(home, 'codex-home'),
    PAPERCUSP_OPERATOR_URL: BASE,
    PAPERCUSP_LOCKS_CACHE_DIR: cache,
    PAPERCUSP_WORKSPACE_ROOT: ws,
    // The worktree-discipline guard (worktree-discipline-single-tree-enforcement-
    // 2026-06-30) defaults the canonical tree to `<workspace_root>/papercusp`; this
    // fixture's repo is deliberately named `papercup-test` (a fake "worktree"), so
    // without this override the guard denies every edit as a stray sibling before
    // the lock-contention path under test ever runs.
    PAPERCUSP_CANONICAL_TREE: repo,
    PAPERCUSP_SID: OWNER_B,
  };

  // Register both e2e owners so the scoped-superuser clamp resolves their workspace
  // (workspaceForCoordOwner reads adv_sessions) for BOTH the test's MCP calls and the
  // spawned hooks — without this they're rejected as scoped_superuser_workspace_unresolved.
  if (reachable) {
    registerSession(OWNER_A);
    registerSession(OWNER_B);
  }
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
  if (reachable) unregisterSessions();
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

  it('A releases → grant cascade → B re-runs the hook and is ALLOWED without caching a preexisting lock', async () => {
    const rel = await callTool(OWNER_A, 'locks:release', { lock_id: lockIdA });
    expect(rel.ok).toBe(true);

    // The cascade grants B's queued waiter; the hook's automatic acquire as B
    // resolves the already-held lock → ok without claiming ownership of it.
    // Allow up to ~8s for the grant cascade.
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

    // The lock was granted by B's explicit queued acquire, so the automatic
    // hook must not cache a release token for it.
    const cacheFile = join(cache, `${TOOL_USE_ID}.lock`);
    expect(fs.existsSync(cacheFile)).toBe(false);
    expect(fs.existsSync(join(cache, `${TOOL_USE_ID}.paths`))).toBe(false);
  });

  it('the matching PostToolUse hook preserves the preexisting hold until B explicitly releases it', async () => {
    const r = await runHook(POST_HOOK, {
      tool_name: 'Edit',
      tool_input: { file_path: editedAbsPath },
      tool_use_id: TOOL_USE_ID,
      session_id: 'sess-live-b',
      cwd: repo,
    }, hookEnvB);
    expect(r.code).toBe(0);

    // There was no hook-owned cache entry, so PostToolUse must not release B's
    // preexisting queued lock. A remains blocked until B explicitly releases it.
    const stillHeld = await callTool(OWNER_A, 'locks:acquire', {
      paths: [REL_PATH],
      intent: `live-rung A must remain blocked ${RUN_ID}`,
      ttl_sec: 60,
    });
    expect(stillHeld.ok).not.toBe(true);

    await callTool(OWNER_B, 'locks:release', { all_mine: true });

    // After B's deliberate release, the path is free and A can re-acquire.
    const again = await callTool(OWNER_A, 'locks:acquire', {
      paths: [REL_PATH],
      intent: `live-rung A reacquire ${RUN_ID}`,
      ttl_sec: 60,
    });
    expect(again.ok).toBe(true);
    await callTool(OWNER_A, 'locks:release', { lock_id: again.lock_id });
  });

  // EI-63: the explicit multi-file lock survives a hook-driven edit + release
  // on ONE of its paths. B holds an explicit locks:acquire over two paths;
  // the automatic hook overlaps one of them, but does not claim either path
  // as hook-owned. PostToolUse therefore cannot dissolve B's deliberate set.
  it('EI-63: an explicit multi-file lock is NOT dissolved by a hook-driven edit+release on just one of its paths', async () => {
    const relKeep = `e2e-hook-live/${RUN_ID}/multi-keep.ts`;
    const relEdit = `e2e-hook-live/${RUN_ID}/multi-edit.ts`;
    const absEdit = join(repo, relEdit);
    fs.writeFileSync(join(repo, relKeep), '// keep\n');
    fs.writeFileSync(absEdit, '// edit\n');

    // B explicitly holds BOTH paths under one deliberate multi-file lock —
    // the documented "acquire once, edit several files, release after
    // committing" pattern (locks:acquire's own guidance).
    const explicit = await callTool(OWNER_B, 'locks:acquire', {
      paths: [relKeep, relEdit],
      intent: `EI-63 explicit multi-file hold ${RUN_ID}`,
      ttl_sec: 600,
    });
    expect(explicit.ok).toBe(true);
    const explicitLockId = explicit.lock_id as string;

    const toolUseId = `tu-ei63-${RUN_ID}`;

    // The normal per-edit hook flow on ONE of the two paths (B already holds
    // it) — expect ALLOW without a release cache entry.
    const preRes = await runHook(PRE_HOOK, {
      tool_name: 'Edit',
      tool_input: { file_path: absEdit },
      tool_use_id: toolUseId,
      session_id: 'sess-live-b',
      cwd: repo,
    }, hookEnvB);
    expect(preRes.code).toBe(0);
    expect(preRes.stdout).toBe(''); // allow — same owner already holds it
    expect(fs.existsSync(join(cache, `${toolUseId}.lock`))).toBe(false);
    expect(fs.existsSync(join(cache, `${toolUseId}.paths`))).toBe(false);

    // The matching PostToolUse fires (as it would right after the edit).
    const postRes = await runHook(POST_HOOK, {
      tool_name: 'Edit',
      tool_input: { file_path: absEdit },
      tool_use_id: toolUseId,
      session_id: 'sess-live-b',
      cwd: repo,
    }, hookEnvB);
    expect(postRes.code).toBe(0);

    // BOTH paths must STILL be held by B — a different owner (A) trying to
    // acquire either path must be refused (busy), not silently succeed.
    const intruder = await callTool(OWNER_A, 'locks:acquire', {
      paths: [relKeep],
      intent: `EI-63 intruder attempt ${RUN_ID}`,
      ttl_sec: 60,
    });
    expect(intruder.ok, 'the untouched path in the explicit multi-file lock was silently released').not.toBe(true);
    const editedIntruder = await callTool(OWNER_A, 'locks:acquire', {
      paths: [relEdit],
      intent: `EI-63 edited-path intruder attempt ${RUN_ID}`,
      ttl_sec: 60,
    });
    expect(editedIntruder.ok, 'the edited path in the explicit multi-file lock was silently released').not.toBe(true);

    // Cleanup: B releases its remaining explicit hold.
    await callTool(OWNER_B, 'locks:release', { lock_id: explicitLockId });
  });
});
