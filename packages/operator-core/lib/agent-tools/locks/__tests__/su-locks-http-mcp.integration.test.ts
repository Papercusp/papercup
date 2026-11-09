/**
 * su-locks HTTP MCP transport — end-to-end over the real /api/mcp route.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-030.
 * Migrated from apps/operator/scripts/su-locks-e2e.sh.
 *
 * §1  Five tools over real HTTP MCP transport (acquire/queue/heartbeat/release/cancel_wait)
 * §2  Cross-owner attack defense (release + heartbeat with foreign lock_id)
 * §3  Same-owner refresh preserves lock_id
 * §4  Multi-path acquire unification
 * §5  Failed multi-path acquire is side-effect free
 * §6  Concurrent contention — only one winner
 * §9  Wait subsystem — LISTEN/NOTIFY wake latency
 * §10 Path validation surface
 * §11 Zod input validation
 * §12 Per-session identity (Mcp-Session-Id header)
 *
 * §7 (hook scripts): the Claude/Codex hook scripts (restored at
 * apps/operator/scripts/hooks/cc/) are covered by their own spawn-based
 * suite, scripts/hooks/cc/__tests__/cc-hooks.test.ts; the OMP hook by
 * scripts/hooks/omp/__tests__/coord-hook.test.ts.
 *
 * All live tests are skipped when the operator is not reachable.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveTest, probeLive } from '../../../testing/live-integration';

const OP_PORT = process.env.OP_PORT ?? null;
const BASE = OP_PORT
  ? `http://localhost:${OP_PORT}`
  : (process.env.OPERATOR_BASE_URL ?? 'http://localhost:3070');

let TOKEN = '';

// `all_workspaces=1`: the scoped-superuser-workspace-clamp (2026-06-18,
// FLAGS.SCOPED_SUPERUSER_CLAMP, default-on) rejects a bare `?superuser=1` whose
// workspace can't be resolved (the `client=<agent>` here is a throwaway e2e owner with
// no registered workspace) — `scoped_superuser_workspace_unresolved`, surfacing as
// "acquire returns undefined". This e2e drives the lock surface unscoped (its prior,
// pre-clamp contract), so it opts into unscoped god-mode explicitly.
try {
  TOKEN = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
} catch { /* no token on disk — probe below fails closed */ }

// EI-52: probe a REAL `tools/call` against a locks verb, not `tools/list` — a bare
// tools/list can return 200 while the actual MCP-over-HTTP tool-dispatch path (what
// every test below exercises) is wedged, which is exactly what made this suite go RED
// instead of SKIP under a degraded :3070 (18/21 timing out at their own 10s bound,
// including instant zod-validation cases). `locks:queue` on a throwaway path is cheap
// and side-effect-free, so it's a faithful stand-in for the tool-call path itself.
const reachable = TOKEN
  ? await probeLive(async () => {
      const probe = await fetch(`${BASE}/api/mcp?superuser=1&all_workspaces=1&format=json`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 0, method: 'tools/call',
          params: { name: 'locks:queue', arguments: { paths: [`e2e/reachability-probe/${Date.now()}`] } },
        }),
        signal: AbortSignal.timeout(8000),
      });
      return probe.status < 500;
    }, 8000)
  : false;

const itLive = reachable ? it : it.skip;

const RUN_ID = `${process.pid}-${Date.now()}`;

function agentId(label: string): string {
  return `e2e-${label}-${RUN_ID}`;
}

function uniquePath(label: string): string {
  return `e2e/${RUN_ID}/${label}`;
}

/** Call a locks tool over the real HTTP MCP transport. Returns the parsed inner payload. */
async function callTool(
  agent: string,
  tool: string,
  args: unknown,
  opts: { mcpSessionId?: string; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const { mcpSessionId, timeoutMs = 10_000 } = opts;
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: tool, arguments: args },
  });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (mcpSessionId) headers['Mcp-Session-Id'] = mcpSessionId;

  // format=json: the MCP result-format negotiation default flipped to `compact`
  // (TOON-rendered text), so a programmatic consumer that JSON.parses the result
  // content must declare json explicitly (P-009 _meta.format / ?format= seam).
  const res = await fetch(`${BASE}/api/mcp?superuser=1&all_workspaces=1&format=json&client=${encodeURIComponent(agent)}`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) throw new Error(`no SSE data frame: ${raw.slice(0, 300)}`);
  const envelope = JSON.parse(dataLine.slice('data:'.length).trim()) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: unknown;
  };
  if (envelope.error) return { _rpcError: envelope.error } as Record<string, unknown>;
  const text = envelope.result?.content?.[0]?.text ?? '{}';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { _raw: text } as Record<string, unknown>;
  }
  // The entangled locks verbs (heartbeat/release/cancel_wait) are bulk-standardized
  // and return the keyed-array envelope { ok, results:[{…}], counts }. Every call here
  // is single-item, so surface the lone per-item result merged onto the envelope —
  // r.extended/released/cancelled resolve as before. Flat verbs (acquire/queue) have
  // no `results` and pass through unchanged.
  const results = parsed.results as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(results) && results.length === 1 && parsed.counts != null) {
    return { ...parsed, ...results[0] };
  }
  return parsed;
}

/** Release all locks for an agent unconditionally (best-effort cleanup). */
async function releaseAll(agent: string) {
  try { await callTool(agent, 'locks:release', { all_mine: true }); } catch { /* ignore */ }
}

describe('expired file-lock custody over HTTP MCP transport', () => {
  itLive('preserves predecessor A1 before successor acquisition without changing the shared index', liveTest(async () => {
    // A private physical domain exercises the running host adapter without
    // editing the shared checkout or borrowing a real agent's identity.
    const repo = mkdtempSync(join(tmpdir(), 'locks-http-custody-'));
    const predecessor = agentId('custody-predecessor');
    const successor = agentId('custody-successor');
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: repo, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim();
    try {
      git('init', '-b', 'main');
      git('config', 'user.name', 'HTTP custody fixture');
      git('config', 'user.email', 'fixture@example.test');
      writeFileSync(join(repo, 'a.txt'), 'base\n');
      writeFileSync(join(repo, 'b.bin'), Buffer.from([0, 1]));
      git('add', '--', 'a.txt', 'b.bin');
      git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture base');
      const base = git('rev-parse', 'HEAD');
      const acquired = await callTool(predecessor, 'locks:acquire', {
        coordination_domain: repo, paths: ['a.txt', 'b.bin'],
        intent: 'HTTP custody predecessor', ttl_sec: 5,
      });
      expect(acquired.ok).toBe(true);
      writeFileSync(join(repo, 'a.txt'), 'A1 staged\n');
      git('add', '--', 'a.txt');
      writeFileSync(join(repo, 'a.txt'), 'A1 working\n');
      const binary = Buffer.from([0, 255, 128, 1]);
      writeFileSync(join(repo, 'b.bin'), binary);
      const index = readFileSync(join(repo, '.git/index'));
      // Expiry, rather than explicit release, reaches beforeFileLocksRelease.
      await new Promise(resolve => setTimeout(resolve, 5_100));
      const granted = await callTool(successor, 'locks:acquire', {
        coordination_domain: repo, paths: ['a.txt', 'b.bin'],
        intent: 'HTTP custody successor', ttl_sec: 60,
      }, { timeoutMs: 30_000 });
      expect(granted.ok).toBe(true);
      const refs = git('for-each-ref', '--format=%(refname)', 'refs/papercusp/source-custody/')
        .split('\n').filter(Boolean);
      expect(refs).toHaveLength(1);
      const ref = refs[0];
      expect(JSON.parse(git('show', `${ref}:manifest.json`))).toMatchObject({
        kind: 'candidate', base, paths: ['a.txt', 'b.bin'],
        requestId: expect.stringMatching(/^release:/), generation: 1,
      });
      expect(git('show', `${ref}:payload/a.txt`)).toBe('A1 working');
      expect(execFileSync('git', ['show', `${ref}:payload/b.bin`], { cwd: repo })).toEqual(binary);
      expect(readFileSync(join(repo, '.git/index'))).toEqual(index);
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('A1 working\n');
      writeFileSync(join(repo, 'a.txt'), 'B1 working\n');
      expect(git('show', `${ref}:payload/a.txt`)).toBe('A1 working');
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('B1 working\n');
      expect(readFileSync(join(repo, '.git/index'))).toEqual(index);
      expect(git('rev-parse', 'HEAD')).toBe(base);
      expect(git('branch', '--show-current')).toBe('main');
      console.log(`HTTP_CUSTODY_ACCEPTANCE ${JSON.stringify({ baseUrl: BASE, repo, base,
        predecessor, successor, lockId: granted.lock_id, custodyRef: ref })}`);
    } finally {
      try {
        for (const owner of [predecessor, successor]) {
          await callTool(owner, 'locks:release', { coordination_domain: repo, all_mine: true },
            { timeoutMs: 30_000 });
        }
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  }), 90_000);
});

// ────────────────────────────────────────────────────────────────────
// §1. Five tools over HTTP MCP transport
// ────────────────────────────────────────────────────────────────────

describe('§1 five tools over HTTP MCP transport', () => {
  const A = agentId('s1-A');
  const p1 = uniquePath('s1/p1.ts');
  let lockIdA = '';

  afterAll(() => releaseAll(A));

  itLive('acquire: returns ok + lock_id', liveTest(async () => {
    const r = await callTool(A, 'locks:acquire', {
      paths: [p1], intent: 'E2E §1 acquire', ttl_sec: 60,
    });
    expect(r.ok).toBe(true);
    expect(typeof r.lock_id).toBe('string');
    lockIdA = r.lock_id as string;
  }), 15_000);

  itLive('queue: active_locks shows the holder', liveTest(async () => {
    const r = await callTool(A, 'locks:queue', { paths: [p1] });
    const locks = r.active_locks as Array<{ path: string; owner: string }>;
    const entry = locks?.find((l) => l.path === p1);
    expect(entry).toBeDefined();
    expect(entry?.owner).toContain(A);
  }), 15_000);

  itLive('heartbeat: extended=true on own lock', liveTest(async () => {
    const r = await callTool(A, 'locks:heartbeat', { lock_id: lockIdA, ttl_sec: 120 });
    expect(r.extended).toBe(true);
  }), 15_000);

  itLive('release: frees 1 path', liveTest(async () => {
    const r = await callTool(A, 'locks:release', { lock_id: lockIdA });
    expect((r.released as unknown[]).length).toBe(1);
    lockIdA = '';
  }), 15_000);

  itLive('cancel_wait: returns cancelled=false for non-existent ticket', liveTest(async () => {
    const r = await callTool(A, 'locks:cancel_wait', {
      ticket_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(r.cancelled).toBe(false);
  }), 15_000);
});

// ────────────────────────────────────────────────────────────────────
// §2. Cross-owner attack defense
// ────────────────────────────────────────────────────────────────────

describe('§2 cross-owner attack defense', () => {
  const A = agentId('s2-A');
  const B = agentId('s2-B');
  const p2 = uniquePath('s2/p2.ts');
  let lockIdA = '';

  beforeAll(async () => {
    if (!reachable) return;
    const r = await callTool(A, 'locks:acquire', { paths: [p2], intent: 'A holds p2', ttl_sec: 60 });
    lockIdA = r.lock_id as string;
  });
  afterAll(() => releaseAll(A));

  itLive("B cannot release A's lock_id", liveTest(async () => {
    const r = await callTool(B, 'locks:release', { lock_id: lockIdA });
    expect((r.released as unknown[]).length).toBe(0);
  }), 15_000);

  itLive("B cannot heartbeat A's lock_id", liveTest(async () => {
    const r = await callTool(B, 'locks:heartbeat', { lock_id: lockIdA, ttl_sec: 3000 });
    expect(r.extended).toBe(false);
  }), 15_000);
});

// ────────────────────────────────────────────────────────────────────
// §3. Same-owner refresh preserves lock_id
// ────────────────────────────────────────────────────────────────────

describe('§3 same-owner refresh preserves lock_id', () => {
  const A = agentId('s3-A');
  const p3 = uniquePath('s3/p3.ts');

  afterAll(() => releaseAll(A));

  itLive('second acquire on same path returns same lock_id', liveTest(async () => {
    const r1 = await callTool(A, 'locks:acquire', { paths: [p3], intent: 'first', ttl_sec: 60 });
    const r2 = await callTool(A, 'locks:acquire', { paths: [p3], intent: 'second', ttl_sec: 60 });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.lock_id).toBe(r2.lock_id);
  }), 15_000);
});

// ────────────────────────────────────────────────────────────────────
// §4. Multi-path acquire unification
// ────────────────────────────────────────────────────────────────────

describe('§4 multi-path acquire unification', () => {
  const A = agentId('s4-A');
  const pa = uniquePath('s4/u/a.ts');
  const pb = uniquePath('s4/u/b.ts');
  const pc = uniquePath('s4/u/c.ts');

  afterAll(() => releaseAll(A));

  itLive('extend across 2 prior lock_ids: releasing merged lock frees all 3 paths', liveTest(async () => {
    await callTool(A, 'locks:acquire', { paths: [pa], intent: 'u1', ttl_sec: 60 });
    await callTool(A, 'locks:acquire', { paths: [pb], intent: 'u2', ttl_sec: 60 });
    const r3 = await callTool(A, 'locks:acquire', { paths: [pa, pb, pc], intent: 'u3', ttl_sec: 60 });
    const rel = await callTool(A, 'locks:release', { lock_id: r3.lock_id });
    expect((rel.released as unknown[]).length).toBe(3);
  }), 30_000);
});

// ────────────────────────────────────────────────────────────────────
// §5. Failed multi-path acquire is side-effect free
// ────────────────────────────────────────────────────────────────────

describe('§5 failed multi-path acquire is side-effect free', () => {
  const A = agentId('s5-A');
  const B = agentId('s5-B');
  const pHeld = uniquePath('s5/se/kept.ts');
  const pBlock = uniquePath('s5/se/blocked.ts');
  let lockB = '';

  beforeAll(async () => {
    if (!reachable) return;
    await callTool(A, 'locks:acquire', { paths: [pHeld], intent: 'original', ttl_sec: 60 });
    const rb = await callTool(B, 'locks:acquire', { paths: [pBlock], intent: 'B', ttl_sec: 60 });
    lockB = rb.lock_id as string;
  });
  afterAll(async () => {
    await releaseAll(A);
    await releaseAll(B);
  });

  itLive("A's overlap call fails; pHeld intent stays 'original'", liveTest(async () => {
    const rFail = await callTool(A, 'locks:acquire', {
      paths: [pHeld, pBlock], intent: 'A retry', ttl_sec: 600,
    });
    expect(rFail.ok).toBe(false);

    const q = await callTool(A, 'locks:queue', { paths: [pHeld] });
    const locks = q.active_locks as Array<{ path: string; intent: string }>;
    const entry = locks?.find((l) => l.path === pHeld);
    expect(entry?.intent).toBe('original');
  }), 20_000);
});

// ────────────────────────────────────────────────────────────────────
// §6. Concurrent contention — only one winner
// ────────────────────────────────────────────────────────────────────

describe('§6 concurrent contention', () => {
  const pHot = uniquePath('s6/race/hot.ts');

  afterAll(async () => {
    for (let i = 1; i <= 5; i++) await releaseAll(agentId(`s6-race-${i}`));
  });

  itLive('5 simultaneous acquires: exactly 1 winner', liveTest(async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        callTool(agentId(`s6-race-${i + 1}`), 'locks:acquire', {
          paths: [pHot], intent: `race-${i + 1}`, ttl_sec: 60,
        }).catch(() => ({ ok: false })),
      ),
    );
    const winners = results.filter((r) => r.ok === true);
    expect(winners.length).toBe(1);
  }), 30_000);
});

// ────────────────────────────────────────────────────────────────────
// §9. Wait subsystem — LISTEN/NOTIFY wake over HTTP MCP transport
// ────────────────────────────────────────────────────────────────────

describe('§9 wait subsystem via HTTP MCP', () => {
  const A = agentId('s9-A');
  const B = agentId('s9-B');
  const pWait = uniquePath('s9/wait/file.ts');
  let lockA = '';

  afterAll(async () => {
    await releaseAll(A);
    await releaseAll(B);
  });

  itLive('B wakes and acquires after A releases (wake within 12s)', liveTest(async () => {
    const ra = await callTool(A, 'locks:acquire', { paths: [pWait], intent: 'A holds', ttl_sec: 60 });
    lockA = ra.lock_id as string;
    expect(ra.ok).toBe(true);

    // Start B's wait in parallel; release A after 2s.
    const bPromise = callTool(B, 'locks:acquire', {
      paths: [pWait], intent: 'B waits', ttl_sec: 60, wait: { max_sec: 20 },
    }, { timeoutMs: 30_000 });

    await new Promise<void>((r) => setTimeout(r, 2000));
    const rel = await callTool(A, 'locks:release', { lock_id: lockA });
    // The release MUST free exactly the held path. The 2026-06-09 failure
    // mode was here, not in the wake: with a >54-char coordination domain
    // the grant cascade's pg_notify raised "channel name too long" and
    // rolled back the WHOLE release — A kept the lock and B timed out
    // busy. Asserting the release result pins the real failure to the
    // right call instead of surfacing as a mysterious rb.ok=false.
    expect((rel.released as unknown[] | undefined)?.length, JSON.stringify(rel)).toBe(1);
    lockA = '';

    const rb = await bPromise;
    expect(rb.ok, JSON.stringify(rb)).toBe(true);
    // Push-wake SLO — the 12s in this test's name, now enforced. The wake
    // is event-driven (grant cascade NOTIFY → LISTEN), nominally sub-second
    // after A's release at t≈2s; 12s leaves ~10s of slack for a loaded box.
    // The 30s poll ceiling in acquire.ts is a silent-drop BACKSTOP, not the
    // wake mechanism — a wake that needs it (waited_sec ≈ max_sec) means
    // the NOTIFY path is broken and MUST fail here, not pass slowly.
    expect(rb.waited_sec as number, `waited_sec=${rb.waited_sec}`).toBeLessThanOrEqual(12);
    if (rb.lock_id) await callTool(B, 'locks:release', { lock_id: rb.lock_id });
  }), 40_000);
});

// ────────────────────────────────────────────────────────────────────
// §10. Path validation
// ────────────────────────────────────────────────────────────────────

describe('§10 path validation', () => {
  const A = agentId('s10-A');

  afterAll(() => releaseAll(A));

  itLive('rejects absolute path', liveTest(async () => {
    const r = await callTool(A, 'locks:acquire', { paths: ['/etc/passwd'], intent: 'x', ttl_sec: 60 });
    expect(String(r.error ?? '')).toMatch(/absolute/i);
  }), 15_000);

  itLive('rejects path traversal', liveTest(async () => {
    const r = await callTool(A, 'locks:acquire', { paths: ['../etc/passwd'], intent: 'x', ttl_sec: 60 });
    expect(String(r.error ?? '')).toMatch(/traversal/i);
  }), 15_000);

  itLive('rejects null byte in path', liveTest(async () => {
    const r = await callTool(A, 'locks:acquire', { paths: ['foo\x00bar'], intent: 'x', ttl_sec: 60 });
    expect(String(r.error ?? '')).toMatch(/null byte/i);
  }), 15_000);

  itLive('rejects Windows backslashes', liveTest(async () => {
    const r = await callTool(A, 'locks:acquire', { paths: ['apps\\\\foo.ts'], intent: 'x', ttl_sec: 60 });
    expect(String(r.error ?? '')).toMatch(/backslash/i);
  }), 15_000);

  itLive("'./x' collides with 'x' after canonicalization", liveTest(async () => {
    const canon = uniquePath('s10/canon-test.ts');
    await callTool(A, 'locks:acquire', { paths: [canon], intent: 'A canon', ttl_sec: 60 });
    const rb = await callTool(agentId('s10-B'), 'locks:acquire', {
      paths: [`./${canon}`], intent: 'B canon', ttl_sec: 60,
    });
    expect(rb.ok).toBe(false);
    await releaseAll(A);
  }), 20_000);
});

// ────────────────────────────────────────────────────────────────────
// §11. Zod input validation (raw SSE body, not inner text)
// ────────────────────────────────────────────────────────────────────

describe('§11 zod input validation', () => {
  const A = agentId('s11-A');

  /** Call and return the full SSE body (before inner-JSON parse). */
  async function rawCall(tool: string, args: unknown): Promise<string> {
    const res = await fetch(`${BASE}/api/mcp?superuser=1&all_workspaces=1&client=${encodeURIComponent(A)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.text();
  }

  itLive('rejects empty paths array', liveTest(async () => {
    const body = await rawCall('locks:acquire', { paths: [], intent: 'x', ttl_sec: 60 });
    expect(body).toMatch(/invalid_args|Too small/i);
  }), 15_000);

  itLive('CLAMPS wait.max_sec > 300 instead of rejecting (free path still acquires)', liveTest(async () => {
    // MAX_WAIT_SEC clamp (acquire.ts): a value above the 300s cap is CLAMPED, NOT
    // rejected — the turn can't block past the tool's own timeout anyway, so the
    // schema accepts any nonnegative int and the handler clamps. A free path therefore
    // acquires cleanly rather than erroring with invalid_args/too_big.
    const body = await rawCall('locks:acquire', {
      paths: [uniquePath('s11/cap.ts')], intent: 'x', wait: { max_sec: 9999 },
    });
    expect(body).not.toMatch(/invalid_args|too_big|Too big/i);
    expect(body).toMatch(/lock_id|"ok":true/i);
  }), 15_000);
});

// ────────────────────────────────────────────────────────────────────
// §12. Per-session identity (Mcp-Session-Id header)
// ────────────────────────────────────────────────────────────────────

describe('§12 per-session identity via Mcp-Session-Id', () => {
  const sharedClient = agentId('s12-shared');
  const identPath = uniquePath('s12/identity/shared.ts');
  let sess1Lock = '';

  afterAll(async () => {
    try { await callTool(sharedClient, 'locks:release', { all_mine: true }, { mcpSessionId: 'e2e-sess-1' }); } catch {}
    try { await callTool(sharedClient, 'locks:release', { all_mine: true }, { mcpSessionId: 'e2e-sess-2' }); } catch {}
    try { await callTool(sharedClient, 'locks:release', { all_mine: true }); } catch {}
  });

  itLive('same ?client=, different Mcp-Session-Id → SAME owner (explicit SID outranks transport id, EI-7066)', liveTest(async () => {
    // EXPLICIT-SID-BEFORE-TRANSPORT-ID (EI-7066, 2026-07-03): an explicit per-launch
    // SID (`x-papercusp-client` header or `?client=`) now ALWAYS outranks the
    // per-CONNECTION Mcp-Session-Id — a reconnecting claude session (cold-loop
    // recycle, dropped transport) must keep ONE identity, and a shell's interactive
    // calls + its lock hook (separate connections) must share one owner (no
    // manual-claim-vs-hook self-deadlock). So two connections with the same
    // ?client= are the SAME owner regardless of transport id: the second acquire
    // is a same-owner refresh (stable lock_id), never busy.
    const r1 = await callTool(sharedClient, 'locks:acquire', {
      paths: [identPath], intent: 'session 1', ttl_sec: 60,
    }, { mcpSessionId: 'e2e-sess-1' });
    expect(r1.ok).toBe(true);
    sess1Lock = r1.lock_id as string;

    const r2 = await callTool(sharedClient, 'locks:acquire', {
      paths: [identPath], intent: 'session 2', ttl_sec: 60,
    }, { mcpSessionId: 'e2e-sess-2' });
    expect(r2.ok).toBe(true);
    expect(r2.lock_id).toBe(sess1Lock);
  }), 20_000);

  itLive('no explicit SID at all → Mcp-Session-Id fallback still separates owners (session 2 busy)', liveTest(async () => {
    // The transport id remains the LAST-resort identity for callers that supplied
    // no SID — there it must still isolate per-connection owners.
    const noSidPath = uniquePath('s12/identity/no-sid.ts');
    const r1 = await callTool('', 'locks:acquire', {
      paths: [noSidPath], intent: 'anon session 1', ttl_sec: 60,
    }, { mcpSessionId: 'e2e-anon-1' });
    expect(r1.ok).toBe(true);

    const r2 = await callTool('', 'locks:acquire', {
      paths: [noSidPath], intent: 'anon session 2', ttl_sec: 60,
    }, { mcpSessionId: 'e2e-anon-2' });
    expect(r2.ok).toBe(false);
    expect((r2.busy as unknown[])?.length).toBeGreaterThanOrEqual(1);
    try { await callTool('', 'locks:release', { all_mine: true }, { mcpSessionId: 'e2e-anon-1' }); } catch { /* cleanup */ }
  }), 20_000);

  itLive('same ?client=, no Mcp-Session-Id → same owner (refresh, stable lock_id)', liveTest(async () => {
    const fb = uniquePath('s12/identity/fb.ts');
    const r1 = await callTool(sharedClient, 'locks:acquire', { paths: [fb], intent: 'fb1', ttl_sec: 60 });
    const r2 = await callTool(sharedClient, 'locks:acquire', { paths: [fb], intent: 'fb2', ttl_sec: 60 });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r1.lock_id).toBe(r2.lock_id);
    await callTool(sharedClient, 'locks:release', { lock_id: r1.lock_id });
  }), 20_000);
});
