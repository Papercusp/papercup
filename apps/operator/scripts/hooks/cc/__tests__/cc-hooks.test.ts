/**
 * Regression guard for the shared Claude/Codex PreToolUse lock hook. Covers
 * the OPERATOR-INDEPENDENT paths (no live operator needed): tool filtering,
 * workspace scoping, and — critically — the fail-open contract (a hook must
 * NEVER exit non-zero / block an edit, even when the operator is down or the
 * input is junk). The acquire/deny/release paths that need a live operator
 * are exercised by the live functional checks recorded in the plan.
 *
 * The hook is bash+python, so we spawn it as a subprocess with crafted stdin.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

const HOOK = join(__dirname, '..', 'pretooluse-locks-acquire.sh');
let home: string, cache: string, ws: string, repo: string;

beforeAll(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'cchook-home-'));
  fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
  // Install markers — the hook bails out (exit 0) without these.
  fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
  fs.writeFileSync(join(home, '.papercusp', 'su-agent-id'), 'test-agent\n');
  cache = fs.mkdtempSync(join(os.tmpdir(), 'cchook-cache-'));
  ws = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'cchook-ws-')));
  // A fake worktree that is a direct child of the workspace root, with a
  // `.git` FILE (worktree-style) so find_repo_root resolves it.
  repo = join(ws, 'papercup-test');
  fs.mkdirSync(join(repo, 'sub'), { recursive: true });
  fs.writeFileSync(join(repo, '.git'), 'gitdir: /nonexistent\n');
});
afterAll(() => {
  for (const d of [home, cache, ws]) fs.rmSync(d, { recursive: true, force: true });
});

function run(input: string, extraEnv: Record<string, string> = {}) {
  const r = spawnSync('bash', [HOOK], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PAPERCUSP_LOCKS_CACHE_DIR: cache,
      PAPERCUSP_WORKSPACE_ROOT: ws,
      ...extraEnv,
    },
  });
  return { status: r.status, stdout: (r.stdout ?? '').trim() };
}
const payload = (o: object) => JSON.stringify(o);

describe('cc PreToolUse hook — operator-independent paths', () => {
  it('non-edit tool → allow (exit 0, no decision)', () => {
    const r = run(payload({ tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 't', session_id: 's', cwd: repo }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('malformed JSON → fail-open allow', () => {
    const r = run('not valid json {');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('edit OUTSIDE the workspace → allow, never coordinated (no operator call)', () => {
    const r = run(payload({ tool_name: 'Edit', tool_input: { file_path: '/tmp/somewhere-else/x.ts' }, tool_use_id: 't', session_id: 's', cwd: '/tmp/somewhere-else' }), { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    // Out-of-scope means we never reached the operator → no error marker.
    expect(fs.existsSync(join(cache, 'last-error.json'))).toBe(false);
  });

  it('in-workspace edit + operator unreachable → FAIL-OPEN allow + last-error marker', () => {
    const r = run(payload({ tool_name: 'Edit', tool_input: { file_path: join(repo, 'sub', 'f.ts') }, tool_use_id: 'tu', session_id: 's', cwd: repo }), { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1' });
    expect(r.status).toBe(0); // never blocks on infra failure
    expect(r.stdout).toBe(''); // no deny decision
    const marker = join(cache, 'last-error.json');
    expect(fs.existsSync(marker)).toBe(true);
    expect(JSON.parse(fs.readFileSync(marker, 'utf8')).handler).toBe('pretooluse');
  });

  it('connection-refused is retried (bounded) before failing open — rides over a restart window', () => {
    // port 1 → ECONNREFUSED on every attempt. A single-shot urlopen fails open
    // near-instantly (refused is immediate); the bounded retry must elapse its
    // ~2.4s budget first. The > 1.5s lower bound reliably distinguishes the two
    // without depending on cross-process server timing.
    const t0 = Date.now();
    const r = run(
      payload({ tool_name: 'Edit', tool_input: { file_path: join(repo, 'sub', 'r.ts') }, tool_use_id: 'tu2', session_id: 's', cwd: repo }),
      { PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1' },
    );
    const elapsed = Date.now() - t0;
    expect(r.status).toBe(0); // still fails open after the retries
    expect(r.stdout).toBe(''); // no deny decision
    expect(elapsed).toBeGreaterThan(1500); // proves the retry loop ran
  }, 15000);

  it('not installed (no token) → bail out, allow', () => {
    const bareHome = fs.mkdtempSync(join(os.tmpdir(), 'cchook-bare-'));
    const r = spawnSync('bash', [HOOK], {
      input: payload({ tool_name: 'Edit', tool_input: { file_path: join(repo, 'g.ts') }, tool_use_id: 't', session_id: 's', cwd: repo }),
      encoding: 'utf8',
      env: { ...process.env, HOME: bareHome, PAPERCUSP_LOCKS_CACHE_DIR: cache, PAPERCUSP_WORKSPACE_ROOT: ws },
    });
    fs.rmSync(bareHome, { recursive: true, force: true });
    expect(r.status).toBe(0);
    expect((r.stdout ?? '').trim()).toBe('');
  });
});

// ── PostToolUse coord-inbox hook ───────────────────────────────────────
// Operator-independent paths only: the psu-session + install gates, the
// first-run cursor seed, and the fail-open contract (a coord blip must
// NEVER block a turn / emit a deny). The live inbox→inject path needs a
// running operator and is exercised by the live functional smoke.
const COORD_HOOK = join(__dirname, '..', 'posttooluse-coord-inbox.sh');
const postPayload = { tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 't', session_id: 's', cwd: '/tmp' };

function runCoord(extraEnv: Record<string, string> = {}, homeDir = home) {
  const r = spawnSync('bash', [COORD_HOOK], {
    input: payload(postPayload),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      PAPERCUSP_LOCKS_CACHE_DIR: cache,
      PAPERCUSP_SID: '', // cleared unless a test opts in (parent psu session sets it)
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1', // never reach a real operator
      ...extraEnv,
    },
  });
  return { status: r.status, stdout: (r.stdout ?? '').trim() };
}

describe('cc PostToolUse coord-inbox hook — operator-independent paths', () => {
  it('no PAPERCUSP_SID (not a psu session) → no-op (exit 0, no stdout)', () => {
    const r = runCoord();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('psu session but not installed (no token) → no-op', () => {
    const bareHome = fs.mkdtempSync(join(os.tmpdir(), 'coordhook-bare-'));
    const r = runCoord({ PAPERCUSP_SID: 'sid-notok' }, bareHome);
    fs.rmSync(bareHome, { recursive: true, force: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('first run seeds the cursor (no fetch, no inject) — even with operator unreachable', () => {
    const sid = 'sid-first';
    const cur = join(cache, `coord-cursor-${sid}.json`);
    if (fs.existsSync(cur)) fs.rmSync(cur);
    const r = runCoord({ PAPERCUSP_SID: sid });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(''); // seeds only; never injects on first run
    expect(fs.existsSync(cur)).toBe(true);
    expect(typeof JSON.parse(fs.readFileSync(cur, 'utf8')).since_ts).toBe('string');
  });

  it('subsequent run + operator unreachable → FAIL-OPEN (exit 0, no stdout)', () => {
    const sid = 'sid-second';
    const cur = join(cache, `coord-cursor-${sid}.json`);
    fs.writeFileSync(cur, JSON.stringify({ since_ts: '2020-01-01T00:00:00Z' }));
    const r = runCoord({ PAPERCUSP_SID: sid });
    expect(r.status).toBe(0); // a coord/operator blip never blocks the turn
    expect(r.stdout).toBe(''); // and never injects junk
  });
});
