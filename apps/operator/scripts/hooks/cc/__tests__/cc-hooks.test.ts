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
      // The worktree guard (pretooluse-locks-acquire.sh, worktree-discipline-2026-06-30)
      // denies edits in a workspace-child tree that is NOT the canonical staging tree.
      // This fixture's repo is `<ws>/papercup-test` (a non-canonical sibling), so without
      // this the guard denies every in-workspace edit. Point the guard at the fixture so
      // the operator-independent paths under test (fail-open / scoping) are exercised, not
      // the guard's deny. (The guard's own deny path is covered by pretooluse-locks-decision.)
      PAPERCUSP_CANONICAL_TREE: repo,
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

  // NOTE: the P-015 gauge-on-empty-inbox path (operator returns entries:[] + a
  // server-rendered `context_gauge` → the hook injects it) needs a live operator, which
  // this box only permits on the real operator port — a mock server on a random loopback
  // port is firewalled. So it is verified by the LIVE functional smoke, alongside the rest
  // of this hook's inbox→inject path. The gauge STRING itself is unit-tested via
  // renderBandedContextGauge (inbox-context-usage.test.ts).
});

// ── PostToolUse activity-report hook ───────────────────────────────────
// Operator-independent paths only: the psu-session + install gates, the
// fail-open contract, and the non-blocking (detached) guarantee. The live
// report→agent_activity path needs a running operator and is exercised by
// the activity-tool integration test + the live smoke recorded in the plan.
const ACTIVITY_HOOK = join(__dirname, '..', 'posttooluse-activity-report.sh');
const editPayload = {
  tool_name: 'Edit',
  tool_input: { file_path: '/x/y.ts', old_string: 'a', new_string: 'b' },
  tool_use_id: 't',
  session_id: 's',
  cwd: '/x',
};

function runActivity(extraEnv: Record<string, string> = {}, input: string = payload(editPayload), homeDir = home) {
  const r = spawnSync('bash', [ACTIVITY_HOOK], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      PAPERCUSP_SID: '', // cleared unless a test opts in
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1', // never reach a real operator
      ...extraEnv,
    },
  });
  return { status: r.status, stdout: (r.stdout ?? '').trim() };
}

describe('cc PostToolUse activity-report hook — operator-independent paths', () => {
  it('no PAPERCUSP_SID (not a psu session) → no-op (exit 0, no stdout)', () => {
    const r = runActivity();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('psu session but not installed (no token) → no-op', () => {
    const bareHome = fs.mkdtempSync(join(os.tmpdir(), 'acthook-bare-'));
    const r = runActivity({ PAPERCUSP_SID: 'sid-x' }, payload(editPayload), bareHome);
    fs.rmSync(bareHome, { recursive: true, force: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('SID + token, SYNC mode, operator unreachable → FAIL-OPEN (exit 0, no stdout)', () => {
    const r = runActivity({ PAPERCUSP_SID: 'sid-sync', PAPERCUSP_ACTIVITY_SYNC: '1' });
    expect(r.status).toBe(0); // a reporting blip never blocks the tool
    expect(r.stdout).toBe(''); // and never emits anything onto the tool result
  });

  it('malformed JSON in SYNC mode → fail-open (exit 0, no stdout)', () => {
    const r = runActivity({ PAPERCUSP_SID: 'sid-junk', PAPERCUSP_ACTIVITY_SYNC: '1' }, 'not valid json {');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('detached (default) mode is NON-BLOCKING — returns fast even when the operator would hang', () => {
    const t0 = Date.now();
    // An unroutable host would hang a synchronous POST for the full timeout; the
    // detached path must return near-instantly (it reparents the POST to init).
    const r = runActivity({ PAPERCUSP_SID: 'sid-detach', PAPERCUSP_OPERATOR_URL: 'http://10.255.255.1:81' });
    const elapsed = Date.now() - t0;
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(elapsed).toBeLessThan(2500); // proves it did NOT wait on the 3s POST timeout
  });
});

// ── Fleet statusline (Claude-only progressive enhancement) ─────────────
// The render is fixture-driven (PAPERCUSP_STATUSLINE_FIXTURE) so it's testable
// without a live operator; the fail-open paths must NEVER error.
const STATUSLINE = join(__dirname, '..', 'statusline-fleet.sh');

function runStatusline(extraEnv: Record<string, string> = {}, homeDir = home) {
  const r = spawnSync('bash', [STATUSLINE], {
    input: '{"model":"opus","cwd":"/x"}',
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      PAPERCUSP_SID: '',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1',
      ...extraEnv,
    },
  });
  return { status: r.status, stdout: (r.stdout ?? '').trim() };
}

// ── SessionStart/SessionEnd lifecycle hook ─────────────────────────────
const LIFECYCLE_HOOK = join(__dirname, '..', 'lifecycle-report.sh');

function runLifecycle(payloadObj: object, extraEnv: Record<string, string> = {}, homeDir = home) {
  const r = spawnSync('bash', [LIFECYCLE_HOOK], {
    input: payload(payloadObj),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDir,
      PAPERCUSP_SID: '',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1',
      ...extraEnv,
    },
  });
  return { status: r.status, stdout: (r.stdout ?? '').trim() };
}

describe('cc lifecycle hook — operator-independent paths', () => {
  it('no PAPERCUSP_SID → no-op (exit 0, no stdout)', () => {
    const r = runLifecycle({ hook_event_name: 'SessionStart', session_id: 's' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('SessionStart + operator unreachable (SYNC) → fail-open (exit 0, no stdout)', () => {
    const r = runLifecycle({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's', cwd: '/x' }, { PAPERCUSP_SID: 'su-l', PAPERCUSP_ACTIVITY_SYNC: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('SessionEnd + operator unreachable (SYNC) → fail-open (exit 0)', () => {
    const r = runLifecycle({ hook_event_name: 'SessionEnd', reason: 'logout', session_id: 's' }, { PAPERCUSP_SID: 'su-l', PAPERCUSP_ACTIVITY_SYNC: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('a non-lifecycle event (PreToolUse) is ignored — exit 0, no report', () => {
    const r = runLifecycle({ hook_event_name: 'PreToolUse', tool_name: 'Edit' }, { PAPERCUSP_SID: 'su-l', PAPERCUSP_ACTIVITY_SYNC: '1' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});

describe('cc fleet statusline — render + fail-open', () => {
  it('renders peers + the newest PEER action (excluding my own activity)', () => {
    const fixture = join(cache, 'sl-fixture.json');
    fs.writeFileSync(fixture, JSON.stringify({
      activity: [
        { owner_id: 'su-074be3de', summary: '✎ catalog.ts', kind: 'tool' },
        { owner_id: 'su-me-self', summary: '▶ npm test', kind: 'tool' },
        { owner_id: 'su-a6146ddc', summary: '👁 README.md', kind: 'tool' },
      ],
      count: 3,
    }));
    const r = runStatusline({ PAPERCUSP_SID: 'su-me-self', PAPERCUSP_STATUSLINE_FIXTURE: fixture });
    expect(r.status).toBe(0);
    // The static 'papercusp' label was REMOVED 2026-07-03 at owner request (it only ate
    // line width; the ◇ id already identifies the pane) — the line leads with the self chip.
    expect(r.stdout).not.toContain('papercusp');
    expect(r.stdout).toContain('◇ su-me'); // THIS agent's own shorthand id chip
    expect(r.stdout).toContain('2 peers'); // su-074be + su-a6146, not me
    expect(r.stdout).toContain('4be3de'); // newest peer's short id
    expect(r.stdout).toContain('✎ catalog.ts');
    expect(r.stdout).not.toContain('npm test'); // my own action is excluded
  });

  it('renders "solo" + this agent\'s own id when only my own activity exists', () => {
    const fixture = join(cache, 'sl-solo.json');
    fs.writeFileSync(fixture, JSON.stringify({ activity: [{ owner_id: 'su-only-me', summary: '✎ x.ts', kind: 'tool' }], count: 1 }));
    const r = runStatusline({ PAPERCUSP_SID: 'su-only-me', PAPERCUSP_STATUSLINE_FIXTURE: fixture });
    expect(r.status).toBe(0);
    // no static 'papercusp' prefix (removed 2026-07-03 at owner request)
    expect(r.stdout).toBe('◇ su-only · solo');
  });

  it('not a psu session → prints nothing (Claude falls back to default), exit 0', () => {
    const r = runStatusline();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('operator unreachable → fail-open empty, exit 0 (never errors the statusline)', () => {
    const r = runStatusline({ PAPERCUSP_SID: 'su-x' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  // agent-managed-compaction P-015: the `ctx N%` context-usage chip from the glance
  // payload's self.context, ⚠-prefixed at/above the LOUD band (80%). PAPERCUSP_GATEWAY_URL
  // is pinned unroutable so the routed-account read-back (lead()) fails fast → deterministic.
  const CTX_ENV = { PAPERCUSP_SID: 'su-me-self', PAPERCUSP_GATEWAY_URL: 'http://127.0.0.1:1' };

  it('renders the ⚠-prefixed ctx gauge chip at/above the loud band (self.context.pct ≥ 80)', () => {
    const fixture = join(cache, 'sl-ctx-loud.json');
    fs.writeFileSync(fixture, JSON.stringify({
      wake: { default: 'auto' },
      self: { context: { tokens: 425000, limit: 500000, pct: 85 } },
      activity: [],
    }));
    const r = runStatusline({ ...CTX_ENV, PAPERCUSP_STATUSLINE_FIXTURE: fixture });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('⚠ ctx 85%');
  });

  it('renders a quiet ctx gauge chip (no ⚠) below the loud band', () => {
    const fixture = join(cache, 'sl-ctx-quiet.json');
    fs.writeFileSync(fixture, JSON.stringify({
      wake: { default: 'auto' },
      self: { context: { tokens: 210000, limit: 500000, pct: 42 } },
      activity: [],
    }));
    const r = runStatusline({ ...CTX_ENV, PAPERCUSP_STATUSLINE_FIXTURE: fixture });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ctx 42%');
    expect(r.stdout).not.toContain('⚠ ctx');
  });

  it('omits the ctx chip when self.context is absent (additive + fail-open)', () => {
    const fixture = join(cache, 'sl-ctx-absent.json');
    fs.writeFileSync(fixture, JSON.stringify({
      wake: { default: 'auto' },
      self: {},
      activity: [],
    }));
    const r = runStatusline({ ...CTX_ENV, PAPERCUSP_STATUSLINE_FIXTURE: fixture });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('ctx');
  });
});
