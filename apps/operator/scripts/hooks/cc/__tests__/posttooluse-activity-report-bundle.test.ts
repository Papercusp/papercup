/**
 * posttooluse-activity-report-bundle.test.ts — the merged activity-report hook's
 * OPERATOR-DEPENDENT delta-fold regression (EI-11405 / coordination-hook-rpc-fanout
 * -collapse-2026-07-16, WI-4654).
 *
 * cc-hooks.test.ts covers the operator-INDEPENDENT paths (psu-session gate, install
 * gate, first-run generation cursor behavior, fail-open on an unreachable operator). This suite
 * closes the remaining cell with a STUB operator (the same in-process HTTP stub
 * pattern as pretooluse-locks-decision.test.ts — async `spawn`, never `spawnSync`,
 * so the stub can actually answer): the exact GUARD the bug asked for —
 *
 *   - a CHANGED generation folds the coord:inbox injection into ONE PostToolUse
 *     additionalContext output, and persists only the generation; the server owns
 *     the inbox floor so a first call cannot seed itself past unread mail;
 *   - the VERY NEXT call forwards that persisted generation back to the server
 *     unchanged — which is what makes an UNCHANGED generation return no `surfaces`
 *     at all (server-side O(1), already unit-tested in hook-bundle.test.ts) — and the
 *     hook then emits NOTHING (no stdout), never re-asking for inbox/glance;
 *   - a P-015 context-gauge fallback still fires on a quiet fold with an empty inbox;
 *   - an INCOMPLETE fold (partial hydrate failure) resets the persisted generation to
 *     null so the NEXT call retries a full hydrate instead of wrongly believing it is
 *     caught up.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runHookProcess } from './spawn-hook';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

const HOOK = join(__dirname, '..', 'posttooluse-activity-report.sh');
const ACTIVITY_HOOK_BUNDLE_SCHEMA = 'activity-hook-bundle-v1';

let home: string, cache: string;
let server: Server;
let port: number;
/** The `activity:report` tool result body the stub returns next. */
let nextResult: unknown = { ok: true, id: 1 };
let lastRequest: { url: string; body: Record<string, any> } | null = null;
let requestCount = 0;

beforeAll(async () => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'cchook-actbundle-home-'));
  fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
  fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
  cache = fs.mkdtempSync(join(os.tmpdir(), 'cchook-actbundle-cache-'));

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requestCount += 1;
      lastRequest = { url: req.url ?? '', body: JSON.parse(body) as Record<string, any> };
      const rpc = {
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: JSON.stringify(nextResult) }] },
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rpc));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  nextResult = { ok: true, id: 1 };
  lastRequest = null;
  requestCount = 0;
  cache = fs.mkdtempSync(join(os.tmpdir(), 'cchook-actbundle-cache-'));
});

afterEach(() => {
  if (cache && fs.existsSync(cache)) fs.rmSync(cache, { recursive: true, force: true });
});

async function run(
  sid: string,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string }> {
  const { status, stdout } = await runHookProcess('bash', [HOOK], {
    input: JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: '/x/y.ts', old_string: 'a', new_string: 'b' },
      tool_use_id: 't',
      session_id: 's',
      cwd: '/x',
    }),
    env: {
      ...process.env,
      HOME: home,
      PAPERCUSP_LOCKS_CACHE_DIR: cache,
      PAPERCUSP_SID: sid,
      PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}`,
      ...extraEnv,
    },
  });
  return { status, stdout: stdout.trim() };
}

function cursorFor(sid: string): { generation?: string | null; since_ts?: string | null } | null {
  const p = join(cache, `activity-hook-bundle-${sid}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('cc PostToolUse activity-report hook — hook_bundle fold (stub operator)', () => {
  it('first call: sends only a generation cursor and preserves a pre-session inbox injection', async () => {
    const sid = 'sid-seed';
    nextResult = {
      ok: true,
      id: 1,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: 'host-a:1',
        changed: true,
        complete: true,
        surfaces: {
          inbox: {
            entries: [{ ts: '2026-07-16T00:01:00Z', msg_id: 'm0' }],
            injection: '[coord+1] pre-session peer mail',
            summary: { newest_ts: '2026-07-16T00:01:00Z' },
          },
        },
      },
    };
    const r = await run(sid);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: '[coord+1] pre-session peer mail',
      },
    });
    expect(lastRequest?.body.params.arguments.hook_bundle).toEqual({ generation: null });
    const cur = cursorFor(sid);
    expect(cur).toEqual({ generation: 'host-a:1' }); // complete:true → generation persisted
  });

  it('changed generation with a real message: injects it and advances generation only', async () => {
    const sid = 'sid-changed';
    // Seed a cursor as if a prior call already ran (skips the "first call" branch).
    fs.writeFileSync(
      join(cache, `activity-hook-bundle-${sid}.json`),
      JSON.stringify({ generation: 'host-a:1' }),
    );
    nextResult = {
      ok: true,
      id: 2,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: 'host-a:2',
        changed: true,
        complete: true,
        surfaces: {
          inbox: {
            entries: [{ ts: '2026-07-16T01:00:00Z', msg_id: 'm1', from: 'peer', kind: 'message', summary: 'hi' }],
            injection: '[coord+1] peer: hi',
            summary: { newest_ts: '2026-07-16T01:00:00Z' },
          },
        },
      },
    };
    const r = await run(sid);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '[coord+1] peer: hi' },
    });
    expect(lastRequest?.body.params.arguments.hook_bundle).toEqual({ generation: 'host-a:1' });
    const cur = cursorFor(sid);
    expect(cur).toEqual({ generation: 'host-a:2' });
  });

  it('THE GUARD: an unchanged generation (no new coord deltas) is forwarded back untouched and injects nothing', async () => {
    const sid = 'sid-quiet';
    fs.writeFileSync(
      join(cache, `activity-hook-bundle-${sid}.json`),
      JSON.stringify({ generation: 'host-a:2' }),
    );
    // The server's real behavior on a matching generation: no `surfaces` at all
    // (hook-bundle.test.ts already pins this server-side; here we pin the CLIENT
    // reacts correctly to it — no extra inbox/glance call, no injection, generation held).
    nextResult = {
      ok: true,
      id: 3,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: 'host-a:2',
        changed: false,
        complete: true,
      },
    };
    const r = await run(sid);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(''); // O(1): nothing folded, nothing injected
    expect(requestCount).toBe(1); // exactly ONE round trip for this tool call — the whole point of the fix
    expect(lastRequest?.body.params.arguments.hook_bundle).toEqual({ generation: 'host-a:2' });
    const cur = cursorFor(sid);
    expect(cur).toEqual({ generation: 'host-a:2' }); // untouched
  });

  it('quiet fold with an empty inbox still surfaces the P-015 context gauge', async () => {
    const sid = 'sid-gauge';
    fs.writeFileSync(
      join(cache, `activity-hook-bundle-${sid}.json`),
      JSON.stringify({ generation: 'host-a:2' }),
    );
    nextResult = {
      ok: true,
      id: 4,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: 'host-a:3',
        changed: true,
        complete: true,
        surfaces: {
          inbox: { entries: [], injection: '', summary: { newest_ts: null }, context_gauge: '⚠ context 82%' },
        },
      },
    };
    const r = await run(sid);
    expect(JSON.parse(r.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '⚠ context 82%' },
    });
    const cur = cursorFor(sid);
    expect(cur).toEqual({ generation: 'host-a:3', gauge_pct: 82, gauge_band: 'loud' });

    nextResult = {
      ok: true,
      id: 5,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: 'host-a:4',
        changed: true,
        complete: true,
        surfaces: {
          inbox: { entries: [], injection: 'context: 249000/300000 (83%)', summary: { newest_ts: null } },
        },
      },
    };
    const suppressed = await run(sid);
    expect(suppressed.stdout).toBe('');
    expect(cursorFor(sid)).toEqual({ generation: 'host-a:4', gauge_pct: 82, gauge_band: 'loud' });

    nextResult = {
      ok: true,
      id: 6,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: 'host-a:5',
        changed: true,
        complete: true,
        surfaces: {
          inbox: { entries: [], injection: 'context: 261000/300000 (87%)', summary: { newest_ts: null } },
        },
      },
    };
    const material = await run(sid);
    expect(JSON.parse(material.stdout).hookSpecificOutput.additionalContext).toContain('(87%)');
    expect(cursorFor(sid)).toEqual({ generation: 'host-a:5', gauge_pct: 87, gauge_band: 'loud' });

    nextResult = {
      ok: true,
      id: 7,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: 'host-a:6',
        changed: true,
        complete: true,
        surfaces: {
          inbox: { entries: [], injection: 'context: 270000/300000 (90%)', summary: { newest_ts: null } },
        },
      },
    };
    const crossing = await run(sid);
    expect(JSON.parse(crossing.stdout).hookSpecificOutput.additionalContext).toContain('(90%)');
    expect(cursorFor(sid)).toEqual({ generation: 'host-a:6', gauge_pct: 90, gauge_band: 'critical' });
  });

  it('an INCOMPLETE fold (partial hydrate failure) resets generation to null so the next call retries fully', async () => {
    const sid = 'sid-incomplete';
    fs.writeFileSync(
      join(cache, `activity-hook-bundle-${sid}.json`),
      JSON.stringify({ generation: 'host-a:2' }),
    );
    nextResult = {
      ok: true,
      id: 5,
      hook_bundle: {
        schemaVersion: ACTIVITY_HOOK_BUNDLE_SCHEMA,
        generation: 'host-a:3',
        changed: true,
        complete: false, // glance hydrate failed server-side; inbox may still be present
        surfaces: {
          inbox: { entries: [], injection: '', summary: { newest_ts: null } },
        },
      },
    };
    const r = await run(sid);
    expect(r.status).toBe(0);
    const cur = cursorFor(sid);
    expect(cur).toEqual({ generation: null }); // never advance on an incomplete hydrate
  });

  it('a response with no usable hook_bundle (server predates the fold) never advances the cursor', async () => {
    const sid = 'sid-nobundle';
    fs.writeFileSync(
      join(cache, `activity-hook-bundle-${sid}.json`),
      JSON.stringify({ generation: 'host-a:2' }),
    );
    nextResult = { ok: true, id: 6 }; // no hook_bundle field at all
    const r = await run(sid);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const cur = cursorFor(sid);
    expect(cur).toEqual({ generation: 'host-a:2' }); // held, not clobbered
  });
});
