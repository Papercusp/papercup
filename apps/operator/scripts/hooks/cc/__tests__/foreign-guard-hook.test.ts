/**
 * P-109 leg (i) — the PreToolUse hook's FOREIGN-WORKSPACE guard behaviors
 * (operator-independent paths; the policy itself is unit-tested in
 * operator-core lib/p2p/foreign-guard.test.ts, the route wraps that).
 *
 * Covers the fail-posture contract from the design (§2):
 *   - a FOREIGN-marked session (env) with no reachable verdict is denied
 *     EVERYTHING — fail-CLOSED;
 *   - a HOST session editing under a cached foreign root is denied even when
 *     the authoritative call is unreachable (deny-from-cache — a KNOWN
 *     foreign path never fails open);
 *   - a HOST session with no cached-root hit + unreachable operator stays
 *     fail-OPEN (and the best-effort roots refresh writes no error marker).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HOOK = join(__dirname, '..', 'pretooluse-locks-acquire.sh');
let home: string, cache: string, ws: string, foreignRoot: string;

beforeAll(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'fghook-home-'));
  fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
  fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
  fs.writeFileSync(join(home, '.papercusp', 'su-agent-id'), 'test-agent\n');
  cache = fs.mkdtempSync(join(os.tmpdir(), 'fghook-cache-'));
  ws = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'fghook-ws-')));
  // A foreign root OUTSIDE the workspace (the Q1 invariant placement).
  foreignRoot = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'fghook-foreign-')));
  fs.mkdirSync(join(foreignRoot, 'repo'), { recursive: true });
});
afterAll(() => {
  for (const d of [home, cache, ws, foreignRoot]) fs.rmSync(d, { recursive: true, force: true });
});

function run(input: object, extraEnv: Record<string, string> = {}) {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PAPERCUSP_LOCKS_CACHE_DIR: cache,
      PAPERCUSP_WORKSPACE_ROOT: ws,
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1', // unreachable, always
      ...extraEnv,
    },
  });
  return { status: r.status, stdout: (r.stdout ?? '').trim() };
}

const edit = (p: string) => ({
  tool_name: 'Edit',
  tool_input: { file_path: p },
  tool_use_id: 't',
  session_id: 's',
  cwd: ws,
});

const denyReason = (stdout: string): string => {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  return parsed.hookSpecificOutput.permissionDecisionReason;
};

describe('foreign-marked session (fail-CLOSED)', () => {
  it('operator unreachable → DENY everything, naming the offer', () => {
    const r = run(edit(join(foreignRoot, 'repo', 'x.ts')), {
      PAPERCUSP_FOREIGN_OFFER_ID: 'offer-abc',
      PAPERCUSP_FOREIGN_SESSION_ID: 'sess-1',
    });
    expect(r.status).toBe(0);
    const reason = denyReason(r.stdout);
    expect(reason).toContain('offer-abc');
    expect(reason).toContain('fail-closed');
  });

  it('even an in-workspace edit is denied without a verdict (no carve-outs)', () => {
    const r = run(edit(join(ws, 'papercusp', 'y.ts')), {
      PAPERCUSP_FOREIGN_OFFER_ID: 'offer-abc',
      PAPERCUSP_FOREIGN_SESSION_ID: 'sess-1',
    });
    expect(r.status).toBe(0);
    denyReason(r.stdout);
  });
});

describe('host session vs cached foreign roots', () => {
  it('edit under a cached foreign root + unreachable operator → DENY from cache (never fail-open on a KNOWN foreign path)', () => {
    fs.writeFileSync(
      join(cache, 'foreign-roots.json'),
      JSON.stringify({
        ts: Date.now() / 1000, // fresh
        roots: [{ offerId: 'offer-zzz', rootPath: foreignRoot }],
      }),
    );
    const r = run(edit(join(foreignRoot, 'repo', 'stolen.ts')));
    expect(r.status).toBe(0);
    const reason = denyReason(r.stdout);
    expect(reason).toContain('offer-zzz');
    expect(reason).toContain('ORIGIN author');
  });

  it('a STALE cache is ignored; refresh fails open quietly (no error marker from the best-effort refresh)', () => {
    fs.rmSync(join(cache, 'last-error.json'), { force: true });
    fs.writeFileSync(
      join(cache, 'foreign-roots.json'),
      JSON.stringify({
        ts: Date.now() / 1000 - 3600, // stale
        roots: [{ offerId: 'offer-zzz', rootPath: foreignRoot }],
      }),
    );
    const r = run(edit(join(foreignRoot, 'repo', 'stolen.ts')));
    // Stale cache → refresh attempt → unreachable → roots [] → fail-OPEN.
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.existsSync(join(cache, 'last-error.json'))).toBe(false);
  });

  it('host edit elsewhere (outside workspace, no root hit) stays allowed', () => {
    fs.rmSync(join(cache, 'foreign-roots.json'), { force: true });
    const elsewhere = fs.mkdtempSync(join(os.tmpdir(), 'fghook-elsewhere-'));
    try {
      const r = run(edit(join(elsewhere, 'z.ts')));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
