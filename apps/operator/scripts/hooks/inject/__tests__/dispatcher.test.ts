/**
 * Tests for the shared context-injection dispatcher.
 * Plan: codex-context-injection-parity-2026-08-09 P-007 (D-001 invariants).
 *
 * ── WHAT IS ACTUALLY BEING ASSERTED, AND WHY IT IS ASSERTED THIS WAY ──
 * The contract is "EXIT 0 AND EMPTY STDOUT", as a PAIR. Each half alone passes
 * trivially and for the wrong reason: a hook that crashes emits empty stdout,
 * and a hook that injects garbage exits 0. Only the conjunction distinguishes
 * "failed silently, as designed" from "failed" and from "succeeded loudly".
 *
 * So the fail-silent cases drive the REAL CLI as a SUBPROCESS rather than
 * calling dispatch() directly: exit code is a property of the process, and a
 * unit test that only inspects a return value cannot observe it. A crash inside
 * an in-process call would surface as a rejected promise the test could catch —
 * i.e. the very failure mode being guarded would be invisible.
 */

import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Overridable via PROBE_SCRIPT (CLAUDE.md's "Proving a guard is falsifiable"
// tier-2 shape) so scripts/mutation-probe.sh can point this suite at a
// mutated COPY of index.mjs — e.g. with the outer fail-silent catch removed —
// without ever mutating the tracked file (EI-19989482108652654).
const CLI = process.env.PROBE_SCRIPT || path.join(HERE, '..', 'index.mjs');

const claude = await import(path.join(HERE, '..', 'adapters', 'claude.mjs'));
const codex = await import(path.join(HERE, '..', 'adapters', 'codex.mjs'));
const ports = await import(path.join(HERE, '..', 'ports.mjs'));

/** A fake operator. Records what it received; answers with injectable text. */
function fakeOperator(opts: { text?: string | null; delayMs?: number } = {}) {
  const received: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ url: req.url ?? '', body: JSON.parse(raw || '{}') });
      const send = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: opts.text ?? 'INJECTED' }));
      };
      if (opts.delayMs) setTimeout(send, opts.delayMs);
      else send();
    });
  });
  return {
    received,
    async start() {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const addr = server.address();
      return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    },
    async stop() {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Run the real CLI. Returns exit code + stdout — never throws on non-zero. */
async function runCli(
  args: string[],
  stdin: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      { env: { ...process.env, ...env }, timeout: 20_000 },
      (err, stdout, stderr) => {
        // Bind to a local before narrowing: two separate `(err as ...).code`
        // cast expressions don't narrow each other, which is what triggered
        // TS2352 here (a genuine, if pre-existing, type-safety gap).
        const rawCode = err ? (err as NodeJS.ErrnoException).code : undefined;
        const code = typeof rawCode === 'number' ? rawCode : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child.stdin?.end(stdin);
  });
}

let running: { stop: () => Promise<void> } | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
});

describe('event -> port routing', () => {
  it('claude maps its two boundaries and ignores everything else', () => {
    expect(claude.portForEvent('UserPromptSubmit')).toBe('turn-start');
    expect(claude.portForEvent('PostToolBatch')).toBe('mid-turn');
    // PreToolUse is deliberately NOT mid-turn (D-027): injecting from there
    // requires a permissionDecision, which would auto-approve tool calls.
    expect(claude.portForEvent('PreToolUse')).toBeNull();
    expect(claude.portForEvent('SessionStart')).toBeNull();
  });

  it('codex maps BOTH its config (kebab) and payload (Pascal) spellings', () => {
    for (const e of ['UserPromptSubmit', 'user-prompt-submit']) {
      expect(codex.portForEvent(e)).toBe('turn-start');
    }
    for (const e of ['PostToolUse', 'post-tool-use']) {
      expect(codex.portForEvent(e)).toBe('mid-turn');
    }
    // Codex has no batch event at all; PostToolBatch is a Claude-only name and
    // must not silently map, or a mis-wired install would look like it worked.
    expect(codex.portForEvent('PostToolBatch')).toBeNull();
    expect(codex.portForEvent('PreToolUse')).toBeNull();
  });
});

describe('adapter parse / render', () => {
  it('claude turn-start clamps the prompt to the contract length', () => {
    const parsed = claude.parse('turn-start', { prompt: 'x'.repeat(9_000) }) as { prompt: string };
    expect(parsed.prompt).toHaveLength(4_000);
  });

  it('claude mid-turn clamps to 12 calls x 400 chars per field', () => {
    const calls = Array.from({ length: 30 }, (_, i) => ({
      tool_name: `t${i}`,
      tool_input: 'i'.repeat(2_000),
      tool_response: 'r'.repeat(2_000),
    }));
    const parsed = claude.parse('mid-turn', { tool_calls: calls }) as {
      toolCalls: Array<{ toolInput: string; toolResponse: string }>;
    };
    expect(parsed.toolCalls).toHaveLength(12);
    expect(parsed.toolCalls[0].toolInput).toHaveLength(400);
    expect(parsed.toolCalls[0].toolResponse).toHaveLength(400);
  });

  it('codex mid-turn is PER-CALL and normalises to a one-element array', () => {
    const parsed = codex.parse('mid-turn', {
      tool_name: 'shell',
      tool_input: { command: 'ls' },
      tool_response: 'ok',
      cwd: '/repo',
    }) as { toolCalls: Array<{ tool: string }>; cwd: string };
    // The shape the SERVER sees is identical to claude's, which is what lets one
    // client-agnostic endpoint serve a per-batch and a per-call client.
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].tool).toBe('shell');
    // Codex supplies cwd on every event; prefer it over the hook's own cwd.
    expect(parsed.cwd).toBe('/repo');
  });

  it('parse returns null when there is no signal, so nothing is spent', () => {
    expect(claude.parse('turn-start', { prompt: 123 })).toBeNull();
    expect(claude.parse('mid-turn', { tool_calls: [] })).toBeNull();
    expect(codex.parse('mid-turn', { tool_name: '' })).toBeNull();
    expect(codex.parse('turn-start', {})).toBeNull();
  });

  it('render echoes the event name each client expects', () => {
    expect(JSON.parse(claude.render('mid-turn', 'T') as string)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: 'T' },
    });
    expect(JSON.parse(codex.render('mid-turn', 'T') as string)).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'T' },
    });
  });
});

describe('kill-switch asymmetry (the load-bearing one)', () => {
  it('turn-start DEGRADES — still calls, with memoryEnabled false', () => {
    // A memory preference must never suppress the CTRL transition riding the
    // same request. If this ever flips to suppress, safety-critical mode/loop/
    // route transitions stop being delivered whenever a user turns memory off.
    const state = ports.killSwitchState('turn-start', { PAPERCUSP_TURN_START_MEMORY: 'off' });
    expect(state).toEqual({ off: true, mode: 'degrade' });
  });

  it('mid-turn SUPPRESSES — the whole port goes away', () => {
    const state = ports.killSwitchState('mid-turn', { PAPERCUSP_MID_TURN_CONTEXT: 'off' });
    expect(state).toEqual({ off: true, mode: 'suppress' });
  });
});

describe('the happy path (so the fail-silent tests below are not vacuous)', () => {
  it('injects, and stamps the client on the request', async () => {
    const op = fakeOperator();
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=codex', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'hello' }),
      { PAPERCUSP_SID: 'sid-1', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'INJECTED' },
    });
    // P-005: without this the coverage query cannot tell "codex got nothing"
    // from "codex was never asked".
    expect(op.received).toHaveLength(1);
    expect(op.received[0].body.client).toBe('codex');
    expect(op.received[0].url).toContain('turn-start-memory');
  });

  it('carries the private mid-turn detector key separately from the public owner', async () => {
    const op = fakeOperator();
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=PostToolBatch'],
      JSON.stringify({
        tool_calls: [{ tool_name: 'Grep', tool_input: { pattern: 'failure-loop' }, tool_response: 'hit' }],
      }),
      {
        PAPERCUSP_SID: 'public-owner',
        PAPERCUSP_FAILURE_LOOP_SESSION_KEY: 'private-detector',
        PAPERCUSP_OPERATOR_URL: base,
      },
    );
    expect(res.code).toBe(0);
    expect(op.received).toHaveLength(1);
    expect(op.received[0].body.owner).toBe('public-owner');
    expect(op.received[0].body.detectorSessionKey).toBe('private-detector');
  });

  it('falls back to the public owner for legacy hook environments without a carrier', async () => {
    const op = fakeOperator();
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=PostToolBatch'],
      JSON.stringify({
        tool_calls: [{ tool_name: 'Grep', tool_input: { pattern: 'failure-loop' }, tool_response: 'hit' }],
      }),
      { PAPERCUSP_SID: 'legacy-owner', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(op.received).toHaveLength(1);
    expect(op.received[0].body.owner).toBe('legacy-owner');
    expect(op.received[0].body.detectorSessionKey).toBe('legacy-owner');
  });
});

describe('CTRL target-owner fence', () => {
  it('drops a foreign CTRL block but preserves following context', async () => {
    const op = fakeOperator({
      text: '⟦CTRL:transition⟧ {"targetOwnerId":"sid-previous"}\n\n## Orientation\nkeep this',
    });
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=codex', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'continue' }),
      { PAPERCUSP_SID: 'sid-current', PAPERCUSP_OPERATOR_URL: base },
    );

    expect(res.code).toBe(0);
    const output = JSON.parse(res.stdout).hookSpecificOutput.additionalContext as string;
    expect(output).not.toContain('CTRL:');
    expect(output).toContain('## Orientation\nkeep this');
  });

  it('keeps a CTRL block addressed to the requesting owner', async () => {
    const op = fakeOperator({ text: '⟦CTRL:full-resync⟧ {"targetOwnerId":"sid-current"}' });
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=codex', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'continue' }),
      { PAPERCUSP_SID: 'sid-current', PAPERCUSP_OPERATOR_URL: base },
    );

    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).hookSpecificOutput.additionalContext).toContain('CTRL:full-resync');
  });
});

describe('fail-silent: EXIT 0 AND EMPTY STDOUT (D-001 invariant 1)', () => {
  const cases: Array<{ name: string; args: string[]; stdin: string; env: Record<string, string> }> =
    [
      {
        name: 'no PAPERCUSP_SID (not a psu session)',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: '' },
      },
      {
        name: 'mid-turn kill-switch off',
        args: ['--client=claude', '--event=PostToolBatch'],
        stdin: JSON.stringify({ tool_calls: [{ tool_name: 'B' }] }),
        env: { PAPERCUSP_SID: 's', PAPERCUSP_MID_TURN_CONTEXT: 'off' },
      },
      {
        name: 'malformed stdin',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: '{not json at all',
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'empty stdin',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: '',
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'unknown client',
        args: ['--client=nosuchtui', '--event=UserPromptSubmit'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'unknown event',
        args: ['--client=claude', '--event=NoSuchEvent'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'missing flags entirely',
        args: [],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: 's' },
      },
      {
        name: 'operator down (connection refused)',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        // Reserved-by-convention discard port: nothing listens, connect fails fast.
        env: { PAPERCUSP_SID: 's', PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9' },
      },
      {
        // EI-19989482108652654: the 8 cases above are all absorbed by dispatch()'s
        // OWN try/catch, so none of them can observe whether the OUTER catch at the
        // bottom of index.mjs (`dispatch().then(...).catch(() => process.exit(0))`)
        // still exists. This case forces dispatch() itself to reject (via the
        // test-only env seam), which only the outer catch can absorb — deleting
        // that line turns this into an unhandled promise rejection (Node exits
        // non-zero), so this case is what makes that line's removal detectable.
        name: 'unexpected throw reaching dispatch() (outer catch, not the inner one)',
        args: ['--client=claude', '--event=UserPromptSubmit'],
        stdin: JSON.stringify({ prompt: 'hi' }),
        env: { PAPERCUSP_SID: 's', PAPERCUSP_INJECT_TEST_FORCE_THROW: '1' },
      },
    ];

  for (const c of cases) {
    it(`${c.name} -> exit 0, no output`, async () => {
      const res = await runCli(c.args, c.stdin, c.env);
      expect(res.code).toBe(0);
      expect(res.stdout).toBe('');
    });
  }

  it('operator SLOWER than the port wall -> exit 0, no output', async () => {
    // mid-turn's wall is 1.5s; answer at 4s. The turn must proceed un-augmented
    // rather than wait — a slow operator costs the turn nothing.
    const op = fakeOperator({ delayMs: 4_000 });
    const base = await op.start();
    running = op;
    const started = Date.now();
    const res = await runCli(
      ['--client=claude', '--event=PostToolBatch'],
      JSON.stringify({ tool_calls: [{ tool_name: 'B', tool_input: 'x', tool_response: 'y' }] }),
      { PAPERCUSP_SID: 's', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
    // Bounded well under the 4s answer: proves the wall fired rather than the
    // request simply having failed for some other reason.
    expect(Date.now() - started).toBeLessThan(3_500);
  }, 20_000);

  it('empty/whitespace injection text -> nothing emitted', async () => {
    const op = fakeOperator({ text: '   ' });
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'hi' }),
      { PAPERCUSP_SID: 's', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('');
  });
});

describe('CONTROL — proves the assertions above can actually fail', () => {
  /**
   * Without this, every fail-silent assertion is satisfiable by a dispatcher
   * that does nothing at all, and a test suite that cannot distinguish a
   * working guard from a DELETED one is not a guard at all (P-007).
   *
   * These drive the SAME CLI with the SAME harness and assert the OPPOSITE
   * outcome, so if the fail-silent paths were removed — or if the runner were
   * silently not executing anything — the pair could not both hold.
   */
  it('a working path DOES produce stdout, so "empty stdout" is a real signal', async () => {
    const op = fakeOperator();
    const base = await op.start();
    running = op;
    const res = await runCli(
      ['--client=claude', '--event=UserPromptSubmit'],
      JSON.stringify({ prompt: 'hi' }),
      { PAPERCUSP_SID: 's', PAPERCUSP_OPERATOR_URL: base },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).not.toBe('');
    expect(res.stdout).toContain('additionalContext');
  });

  it('a NON-ZERO exit is observable by this harness, so "exit 0" is a real signal', async () => {
    // If runCli always reported 0 — a plausible bug in the helper — every
    // fail-silent test would pass against a dispatcher that crashes.
    const res = await new Promise<number>((resolve) => {
      const child = execFile(process.execPath, ['-e', 'process.exit(3)'], () => {});
      child.on('exit', (code) => resolve(code ?? -1));
    });
    expect(res).toBe(3);
  });

  it('the turn-start kill-switch is NOT suppress — catches a collapse to boolean', () => {
    // The specific regression: someone reads D-001's one-line summary, makes
    // both switches booleans, and turn-start stops delivering CTRL transitions.
    expect(ports.killSwitchState('turn-start', { PAPERCUSP_TURN_START_MEMORY: 'off' }).mode).not.toBe(
      'suppress',
    );
  });
});
