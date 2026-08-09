/**
 * inject-hook.test.ts — P-006 coverage for the OMP context-injection parity
 * work (plan omp-context-injection-parity-2026-08-09, D-001 + D-002).
 *
 * Two subjects:
 *   - the PURE adapter (../../inject/adapters/omp.mjs): portForEvent / parse /
 *     render, including the clamps that D-001 declares contract rather than
 *     tuning, and the toolCallId correlation that omp forces on us.
 *   - the omp client-native ARTIFACT (../inject-hook.ts): the fail-silent
 *     invariants. D-001 invariant 1 says any failure must inject NOTHING and
 *     surface NOTHING; on omp the concrete form of "exit 0 and empty output" is
 *     "runDispatcher resolves null and never rejects", because the dispatcher is
 *     a child process whose stdout we consume rather than our own exit code.
 *
 * ⚠ THE CALIBRATION TEST IS LOAD-BEARING — read before adding cases.
 * Every fail-silent assertion here has the shape `expect(result).toBeNull()`,
 * which is ALSO what a `runDispatcher` that was deleted, stubbed to
 * `return null`, or short-circuited by a bad env check would produce. A suite of
 * only-null assertions cannot tell a working guard from a removed one, and would
 * stay green through exactly the regression it exists to catch. The
 * "CALIBRATION" test below drives a real stub dispatcher end-to-end and asserts
 * a NON-null result; if it ever fails, treat every null assertion in this file
 * as vacuous until it passes again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-ignore — pure JS adapter, no .d.ts; the dispatcher's frozen CLI contract is the seam.
import adapter, { portForEvent, parse, render } from '../../inject/adapters/omp.mjs';
import {
  PORT_TIMEOUT_MS,
  SUBPROCESS_KILL_MARGIN_MS,
  resolveDispatcherPath,
  runDispatcher,
  shouldSkip,
} from '../inject-hook';

// ── fixtures ────────────────────────────────────────────────────────────────

let dir: string;
/** A stub standing in for the shared index.mjs. Echoes a fixed payload and,
 *  when asked, records the stdin it was fed so we can assert the wire shape. */
let echoDispatcher: string;
let stdinRecorder: string;
let recordedStdinFile: string;
let crashDispatcher: string;
let hangDispatcher: string;
let whitespaceDispatcher: string;

const SID_ENV = { PAPERCUSP_SID: 'su-test-0001', PAPERCUSP_WORKSPACE: 'ws', PAPERCUSP_HARNESS_SLUG: 'papercusp' };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'omp-inject-hook-'));

  echoDispatcher = join(dir, 'echo.mjs');
  writeFileSync(echoDispatcher, `process.stdout.write('INJECTED CONTEXT');\n`);

  recordedStdinFile = join(dir, 'stdin.json');
  stdinRecorder = join(dir, 'record.mjs');
  writeFileSync(
    stdinRecorder,
    `import { writeFileSync } from 'node:fs';
let buf = '';
process.stdin.on('data', c => { buf += c; });
process.stdin.on('end', () => {
  writeFileSync(${JSON.stringify(recordedStdinFile)}, JSON.stringify({ stdin: buf, argv: process.argv.slice(2) }));
  process.stdout.write('RECORDED');
});
`,
  );

  crashDispatcher = join(dir, 'crash.mjs');
  writeFileSync(crashDispatcher, `process.stdout.write('partial'); process.exit(3);\n`);

  hangDispatcher = join(dir, 'hang.mjs');
  writeFileSync(hangDispatcher, `setInterval(() => {}, 1000);\n`);

  whitespaceDispatcher = join(dir, 'ws.mjs');
  writeFileSync(whitespaceDispatcher, `process.stdout.write('   \\n  ');\n`);

  for (const f of [echoDispatcher, stdinRecorder, crashDispatcher, hangDispatcher, whitespaceDispatcher]) {
    chmodSync(f, 0o755);
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const envWith = (dispatcher: string, extra: Record<string, string> = {}) => ({
  ...SID_ENV,
  PAPERCUSP_INJECT_DISPATCHER: dispatcher,
  ...extra,
});

// ── adapter: event mapping ──────────────────────────────────────────────────

describe('adapters/omp.mjs — portForEvent', () => {
  it('maps before_agent_start to turn-start and turn_end to mid-turn', () => {
    expect(portForEvent('before_agent_start')).toBe('turn-start');
    expect(portForEvent('turn_end')).toBe('mid-turn');
  });

  it('does NOT map tool_result to mid-turn', () => {
    // tool_result fires once per individual call. Mapping it would over-fire on
    // every tool and mis-shape the 12-call batch digest D-001 specifies. The
    // batch analogue is turn_end, which carries toolResults[] for the turn.
    expect(portForEvent('tool_result')).toBeNull();
  });

  it('ignores unknown/unsubscribed events rather than guessing a port', () => {
    for (const e of ['turn_start', 'agent_start', 'session_start', 'context', '']) {
      expect(portForEvent(e)).toBeNull();
    }
  });

  it('exposes the D-001 adapter surface', () => {
    expect(adapter.client).toBe('omp');
    expect(typeof adapter.portForEvent).toBe('function');
    expect(typeof adapter.parse).toBe('function');
    expect(typeof adapter.render).toBe('function');
  });
});

// ── adapter: parse ──────────────────────────────────────────────────────────

describe('adapters/omp.mjs — parse (turn-start)', () => {
  const withSid = <T>(fn: () => T): T => {
    const prev = { ...process.env };
    Object.assign(process.env, SID_ENV);
    try {
      return fn();
    } finally {
      for (const k of Object.keys(SID_ENV)) delete process.env[k as keyof typeof SID_ENV];
      Object.assign(process.env, prev);
    }
  };

  it('builds an InjectionRequest carrying client=omp and the per-session owner', () => {
    const req = withSid(() => parse('turn-start', { type: 'before_agent_start', prompt: 'hello' }));
    expect(req).toMatchObject({
      owner: 'su-test-0001',
      workspace: 'ws',
      harness: 'papercusp',
      client: 'omp',
      prompt: 'hello',
    });
    // D-001's NEW/REQUIRED field — the whole point of recording which client
    // received an injection. A request without it is unattributable.
    expect(req?.client).toBe('omp');
  });

  it('clamps the prompt to 4000 chars (D-001 invariant 5 — contract, not tuning)', () => {
    const req = withSid(() => parse('turn-start', { prompt: 'x'.repeat(9000) }));
    expect(req?.prompt).toHaveLength(4000);
  });

  it('returns null for an empty/whitespace prompt — no signal, spend nothing', () => {
    expect(withSid(() => parse('turn-start', { prompt: '' }))).toBeNull();
    expect(withSid(() => parse('turn-start', { prompt: '   ' }))).toBeNull();
    expect(withSid(() => parse('turn-start', {}))).toBeNull();
  });

  it('returns null when PAPERCUSP_SID is absent (invariant 3 — not a psu session)', () => {
    const prev = process.env.PAPERCUSP_SID;
    delete process.env.PAPERCUSP_SID;
    try {
      expect(parse('turn-start', { prompt: 'hello' })).toBeNull();
    } finally {
      if (prev !== undefined) process.env.PAPERCUSP_SID = prev;
    }
  });
});

describe('adapters/omp.mjs — parse (mid-turn)', () => {
  const turnEnd = (toolResults: unknown[], toolCalls: unknown[] = []) => ({
    type: 'turn_end',
    turnIndex: 1,
    message: { role: 'assistant', content: toolCalls },
    toolResults,
  });

  const withSid = <T>(fn: () => T): T => {
    const prev = { ...process.env };
    Object.assign(process.env, SID_ENV);
    try {
      return fn();
    } finally {
      Object.assign(process.env, prev);
    }
  };

  it('correlates a tool INPUT from message.content onto its RESULT by toolCallId', () => {
    // omp splits what claude delivers as one record: the result carries the
    // output, the assistant message carries the arguments. If this join breaks,
    // every digest silently ships an empty toolInput and the server's query
    // quality degrades with nothing failing.
    const req = withSid(() =>
      parse(
        'mid-turn',
        turnEnd(
          [{ toolCallId: 'tc-1', toolName: 'bash', content: [{ type: 'text', text: 'total 12' }] }],
          [{ type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { command: 'ls -la' } }],
        ),
      ),
    );
    expect(req?.toolCalls).toEqual([
      { tool: 'bash', toolInput: JSON.stringify({ command: 'ls -la' }), toolResponse: 'total 12' },
    ]);
  });

  it('still emits a result whose call cannot be correlated (output alone is signal)', () => {
    const req = withSid(() =>
      parse('mid-turn', turnEnd([{ toolCallId: 'orphan', toolName: 'grep', content: [{ type: 'text', text: 'hit' }] }])),
    );
    expect(req?.toolCalls).toEqual([{ tool: 'grep', toolInput: '', toolResponse: 'hit' }]);
  });

  it('clamps to 12 calls and 400 chars per field', () => {
    const results = Array.from({ length: 30 }, (_, i) => ({
      toolCallId: `tc-${i}`,
      toolName: 'read',
      content: [{ type: 'text', text: 'y'.repeat(5000) }],
    }));
    const calls = Array.from({ length: 30 }, (_, i) => ({
      type: 'toolCall',
      id: `tc-${i}`,
      name: 'read',
      arguments: { blob: 'z'.repeat(5000) },
    }));
    const req = withSid(() => parse('mid-turn', turnEnd(results, calls)));
    expect(req?.toolCalls).toHaveLength(12);
    for (const c of req!.toolCalls!) {
      expect(c.toolResponse).toHaveLength(400);
      expect(c.toolInput).toHaveLength(400);
    }
  });

  it('drops image parts but keeps text when flattening result content', () => {
    const req = withSid(() =>
      parse(
        'mid-turn',
        turnEnd([
          {
            toolCallId: 't',
            toolName: 'read',
            content: [{ type: 'image', data: 'BASE64' }, { type: 'text', text: 'real' }],
          },
        ]),
      ),
    );
    expect(req?.toolCalls?.[0].toolResponse).toBe('real');
  });

  it('returns null for an empty batch', () => {
    expect(withSid(() => parse('mid-turn', turnEnd([])))).toBeNull();
    expect(withSid(() => parse('mid-turn', { type: 'turn_end' }))).toBeNull();
  });

  it('survives circular tool arguments without throwing', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const req = withSid(() =>
      parse(
        'mid-turn',
        turnEnd(
          [{ toolCallId: 'c', toolName: 'x', content: [{ type: 'text', text: 'ok' }] }],
          [{ type: 'toolCall', id: 'c', name: 'x', arguments: circular }],
        ),
      ),
    );
    expect(req?.toolCalls?.[0]).toEqual({ tool: 'x', toolInput: '', toolResponse: 'ok' });
  });
});

// ── adapter: render ─────────────────────────────────────────────────────────

describe('adapters/omp.mjs — render', () => {
  it('returns PLAIN TEXT, not a claude-style JSON envelope', () => {
    const out = render('turn-start', 'some memory', {});
    expect(out).toBe('some memory');
    expect(() => JSON.parse(out as string)).toThrow();
  });

  it('returns null for empty/whitespace so nothing at all is injected', () => {
    expect(render('turn-start', '', {})).toBeNull();
    expect(render('mid-turn', '   \n ', {})).toBeNull();
    expect(render('mid-turn', undefined as unknown as string, {})).toBeNull();
  });
});

// ── artifact: dispatcher resolution + skip gates ────────────────────────────

describe('inject-hook — resolveDispatcherPath', () => {
  it('prefers the explicit env override', () => {
    expect(resolveDispatcherPath({ PAPERCUSP_INJECT_DISPATCHER: '/x/index.mjs' }, undefined, () => true)).toBe(
      '/x/index.mjs',
    );
  });

  it('falls back to the installed layout under PAPERCUSP_HOME', () => {
    const got = resolveDispatcherPath({ PAPERCUSP_HOME: '/ph' }, undefined, p => p === '/ph/hooks/inject/index.mjs');
    expect(got).toBe('/ph/hooks/inject/index.mjs');
  });

  it('returns null when nothing is installed (never a fabricated path)', () => {
    expect(resolveDispatcherPath({ PAPERCUSP_HOME: '/ph' }, undefined, () => false)).toBeNull();
  });
});

describe('inject-hook — shouldSkip', () => {
  it('skips without PAPERCUSP_SID (invariant 3)', () => {
    expect(shouldSkip('turn-start', {})).toBe(true);
  });

  it('suppresses mid-turn when PAPERCUSP_MID_TURN_CONTEXT=off (recall-only port)', () => {
    expect(shouldSkip('mid-turn', { ...SID_ENV, PAPERCUSP_MID_TURN_CONTEXT: 'off' })).toBe(true);
    expect(shouldSkip('turn-start', { ...SID_ENV, PAPERCUSP_MID_TURN_CONTEXT: 'off' })).toBe(false);
  });

  it('does NOT skip turn-start on PAPERCUSP_TURN_START_MEMORY=off — that switch DEGRADES, it does not suppress', () => {
    // REGRESSION GUARD, and this was a real bug here before ports.mjs was read
    // (caught 2026-08-09, pre-merge). Inferring the semantics from D-001's
    // one-line summary ("PER-PORT KILL-SWITCH env: PAPERCUSP_TURN_START_MEMORY
    // =off, PAPERCUSP_MID_TURN_CONTEXT=off") reads as though both simply
    // disable their port. They do not.
    //
    // turn-start carries TWO payloads on one request: the memory delta AND the
    // one-shot CTRL transition (mode / loop / route changes). The env var is a
    // MEMORY preference; core.mjs honours it by sending memoryEnabled=false and
    // STILL making the call. If the artifact skipped the spawn instead, the
    // CTRL transition would be silently dropped — invisibly, since the turn
    // just proceeds without the transition it was owed.
    //
    // If someone "tidies" SUPPRESSING_KILL_SWITCH by adding a turn-start entry,
    // this test is what stops it.
    expect(shouldSkip('turn-start', { ...SID_ENV, PAPERCUSP_TURN_START_MEMORY: 'off' })).toBe(false);
  });

  it('runs when a psu session has neither switch off', () => {
    expect(shouldSkip('turn-start', SID_ENV)).toBe(false);
    expect(shouldSkip('mid-turn', SID_ENV)).toBe(false);
  });
});

describe('inject-hook — per-port budgets match D-001 invariant 2', () => {
  it('pins the contract values', () => {
    expect(PORT_TIMEOUT_MS['turn-start']).toBe(2500);
    expect(PORT_TIMEOUT_MS['mid-turn']).toBe(1500);
  });

  it('kills only ABOVE the port budget, so core.mjs own timeout wins normally', () => {
    // If the margin went <= 0 we would pre-empt core's clean timeout with a
    // SIGKILL, losing its fail-silent path for every slow-operator turn.
    expect(SUBPROCESS_KILL_MARGIN_MS).toBeGreaterThan(0);
  });
});

// ── artifact: the CALIBRATION control, then the fail-silent invariants ──────

describe('inject-hook — runDispatcher', () => {
  it('CALIBRATION (must pass or every null assertion below is vacuous): a working dispatcher yields its stdout', async () => {
    const out = await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: envWith(echoDispatcher),
    });
    expect(out).toBe('INJECTED CONTEXT');
  });

  it('feeds the native event as JSON on STDIN and passes --client/--event as argv', async () => {
    // This pins the contract the shared index.mjs must honour. A mismatch here
    // is invisible in production: both sides fail silent, so it looks exactly
    // like "no memories were relevant".
    const out = await runDispatcher('mid-turn', 'turn_end', { type: 'turn_end', turnIndex: 4 }, {
      env: envWith(stdinRecorder),
    });
    expect(out).toBe('RECORDED');
    const rec = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(recordedStdinFile, 'utf8')));
    expect(JSON.parse(rec.stdin)).toEqual({ type: 'turn_end', turnIndex: 4 });
    expect(rec.argv).toEqual(['--client=omp', '--event=turn_end']);
  });

  it('FAIL-SILENT: missing PAPERCUSP_SID injects nothing and spawns nothing', async () => {
    expect(await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: { PAPERCUSP_INJECT_DISPATCHER: echoDispatcher },
    })).toBeNull();
  });

  it('the mid-turn kill switch suppresses the spawn entirely', async () => {
    expect(await runDispatcher('mid-turn', 'turn_end', { toolResults: [] }, {
      env: envWith(echoDispatcher, { PAPERCUSP_MID_TURN_CONTEXT: 'off' }),
    })).toBeNull();
  });

  it('the turn-start memory switch still dispatches, so CTRL transitions survive', async () => {
    // The paired end-to-end half of the shouldSkip guard above: with memory
    // off, the dispatcher MUST still be invoked (core.mjs then degrades the
    // request via memoryEnabled=false rather than skipping it).
    expect(await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: envWith(echoDispatcher, { PAPERCUSP_TURN_START_MEMORY: 'off' }),
    })).toBe('INJECTED CONTEXT');
  });

  it('FAIL-SILENT: no dispatcher installed resolves null (never throws)', async () => {
    expect(await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: { ...SID_ENV, PAPERCUSP_HOME: join(dir, 'nope') },
    })).toBeNull();
  });

  it('FAIL-SILENT: a non-zero exit discards even partial stdout', async () => {
    // 'partial' was printed before the crash. Injecting a truncated payload is
    // worse than injecting nothing — it would look like real context.
    expect(await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: envWith(crashDispatcher),
    })).toBeNull();
  });

  it('FAIL-SILENT: a hung dispatcher is killed at the deadline and injects nothing', async () => {
    const started = Date.now();
    const out = await runDispatcher('mid-turn', 'turn_end', { toolResults: [] }, {
      env: envWith(hangDispatcher),
      killAfterMs: 250,
    });
    expect(out).toBeNull();
    // The point of the deadline is that the turn is not held hostage: omp's own
    // only bound is 30s, and it abandons rather than cancels.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('FAIL-SILENT: whitespace-only stdout injects nothing', async () => {
    expect(await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: envWith(whitespaceDispatcher),
    })).toBeNull();
  });

  it('FAIL-SILENT: a non-serialisable event resolves null instead of throwing', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(await runDispatcher('turn-start', 'before_agent_start', circular, {
      env: envWith(echoDispatcher),
    })).toBeNull();
  });

  it('FAIL-SILENT: an unexecutable dispatcher path resolves null', async () => {
    expect(await runDispatcher('turn-start', 'before_agent_start', { prompt: 'hi' }, {
      env: envWith(echoDispatcher),
      execPath: join(dir, 'no-such-runtime'),
    })).toBeNull();
  });
});
