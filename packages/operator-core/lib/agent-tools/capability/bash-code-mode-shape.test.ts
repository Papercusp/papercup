/**
 * bash-code-mode-shape.test.ts — EI-20066912585022608.
 *
 * capability:bash renders a human-readable text result (a header line + combined
 * output). That is right for a MODEL reading the result and wrong for a `code:run`
 * script, which receives whatever `unwrapToolResult` can make of it: no JSON to
 * parse ⇒ a raw STRING ⇒ every `result.<field>` access resolves to `undefined`,
 * silently, and an `?? ''` fallback launders that into a real-looking empty output.
 * The reported case read as "the codebase does not contain this" for two greps that
 * both matched.
 *
 * The sharp edge is that the tool DISAGREED WITH ITSELF: the background branch
 * returns JSON (a real object), the foreground branch returns text — so the same
 * call expression changed shape depending on an argument.
 *
 * Runs the real shell (no mocks), mirroring bash-desktop-env.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Same rationale as bash-desktop-env.test.ts: pin the exec-sandbox flag OFF so the
// suite is hermetic on a host with no bubblewrap (the console.warn would otherwise
// be turned into a failure by vitest-fail-on-console).
vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  capabilityExecSandboxEnabled: vi.fn(async () => false),
}));

import bashTool from './bash';
import { __resetBashJobs } from './bash-jobs';
import { generateToolFacadeTypes, lookupByMcpName } from '@papercusp/agent-mcp';
import { unwrapToolResult } from '@papercusp/tooldef';

type ToolResultish = {
  content: Array<{ text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
type Tool = { handler: (a: unknown, c: unknown) => Promise<ToolResultish> };
type BashArgsSchema = {
  safeParse: (value: unknown) => {
    success: boolean;
    error?: { issues: Array<{ message: string }> };
  };
};
const bash = bashTool as unknown as Tool;
const STATE = mkdtempSync(join(tmpdir(), 'cap-bash-shape-'));

function makeCtx(opts: { codeMode?: boolean } = {}) {
  return {
    projectDir: STATE,
    stateDir: STATE,
    signal: new AbortController().signal,
    emit: () => {},
    role: 'cup',
    ...(opts.codeMode ? { codeMode: true } : {}),
  } as never;
}

afterEach(() => {
  __resetBashJobs();
});

describe('capability:bash — result shape for a code:run script (EI-20066912585022608)', () => {
  it('advertises the code-mode result fields in the generated tools facade', () => {
    const registered = lookupByMcpName('capability:bash');
    expect(registered).toBeDefined();

    const facade = generateToolFacadeTypes([registered!]);
    expect(facade).not.toMatch(/bash\([^)]*\): Promise<unknown>;/);
    expect(facade).toContain('ok: boolean');
    expect(facade).toContain('output?: string');
    expect(facade).toContain('exit_code?: number | null');
  });

  it('rejects sub-second public timeouts with explicit millisecond guidance', () => {
    const args = (bashTool as unknown as { args: BashArgsSchema }).args;
    const tooShort = args.safeParse({ command: 'true', timeout: 20 });
    const tooShortMessages = tooShort.error?.issues.map((issue) => issue.message).join(' ') ?? '';

    // `timeout: 20` is the reported live shape: a caller means 20 seconds, while
    // the child runner receives 20ms and expires before it can do useful work.
    expect(tooShort.success).toBe(false);
    expect(tooShortMessages).toContain('milliseconds');
    expect(tooShortMessages).toContain('20 seconds');
    expect(tooShortMessages).toContain('20000');
    expect(args.safeParse({ command: 'true', timeout: 999 }).success).toBe(false);
    expect(args.safeParse({ command: 'true', timeout: 1000 }).success).toBe(true);
    expect(args.safeParse({ command: 'true', timeout: 20000 }).success).toBe(true);
  });

  // This test pins the SUBSTANCE of the guidance, not its wording. `capability:bash`
  // sits against a hard 1500-unit prompt-weight cap (tool-guidance-budget.ts), so this
  // prose gets legitimately re-compressed to stay under it — 897b933647 rewrote
  // "strips database credential environment variables" to "strips DB credential env
  // vars" and "fails before either search tool runs" to "fails before either tool runs",
  // changing nothing semantic and reddening every exact-phrase assertion here.
  // Asserting whole sentences made this file fail for editorial compression, which
  // teaches the next editor to pad the guidance back over budget to appease a test.
  // So match the load-bearing TOKENS (and tolerate the abbreviations a budget squeeze
  // reaches for) — a real regression is the claim GOING AWAY, not being said shorter.
  it('routes operator database reads away from psql because shell credentials are scrubbed', () => {
    const guidance = (bashTool as unknown as { guidance?: { when?: string; notWhen?: string } }).guidance;
    expect(guidance?.notWhen).toContain('dev:pg_query');
    // The claim that earns the redirect: the shell cannot see DB credentials.
    expect(guidance?.notWhen).toMatch(/strips (?:database|DB) credential env(?:ironment)? var(?:iable)?s/);
    expect(guidance?.when).toContain('fixed-string searches');
    expect(guidance?.when).toContain('`rg -F`');
    expect(guidance?.when).toContain('`grep -F`');
    // Quote the argument, because an unmatched backtick fails before the search runs.
    expect(guidance?.when).toMatch(/single-quot(?:e|ed)/);
    expect(guidance?.when).toContain('unmatched backtick');
    expect(guidance?.when).toMatch(/fails before either (?:search )?tool runs/);
    expect(guidance?.when).toContain('do not shell-background child');
    expect(guidance?.when).toContain('without `wait`');
  });

  it('gives a code-mode caller an OBJECT whose output field carries the real output', async () => {
    const r = await bash.handler({ command: 'echo HELLO-SHAPE-PROBE' }, makeCtx({ codeMode: true }));

    // What the script actually receives — through the REAL unwrap seam, not a
    // hand-asserted shape. This is the assertion the defect would have failed:
    // before the fix `unwrap` returned a string and `.output` was undefined.
    const seen = unwrapToolResult(r as never) as Record<string, unknown>;
    expect(typeof seen).toBe('object');
    expect(String(seen.output)).toContain('HELLO-SHAPE-PROBE');
    expect(seen.ok).toBe(true);
    expect(seen.exit_code).toBe(0);
    expect(seen.cwd).toBe(STATE);
    expect(typeof seen.duration_ms).toBe('number');
  });

  it('leaves a DIRECT caller byte-identical — no duplicated output on the wire', async () => {
    const r = await bash.handler({ command: 'echo HELLO-SHAPE-PROBE' }, makeCtx());

    // The cost control: capability:bash is one of the most-called tools here, so
    // attaching the machine-readable copy unconditionally would double the payload
    // for every caller that only ever reads the text.
    expect(r.structuredContent).toBeUndefined();
    expect(r.content[0].text).toContain('HELLO-SHAPE-PROBE');
    // And the raw-string fallback is still what such a result unwraps to — this is
    // the behaviour being deliberately confined to non-code-mode, not removed.
    expect(typeof unwrapToolResult(r as never)).toBe('string');
  });

  it('reports a FAILING command as ok:false with the real exit code, not a bare empty', async () => {
    const r = await bash.handler(
      { command: 'echo OOPS >&2; exit 3' },
      makeCtx({ codeMode: true }),
    );
    const seen = unwrapToolResult(r as never) as Record<string, unknown>;

    // exit_code must survive as a NUMBER: a script branching on `exit_code !== 0`
    // is the whole reason to hand back structure instead of a rendered header line.
    expect(seen.exit_code).toBe(3);
    // The load-bearing one: `ok` must track the COMMAND, not the shell. Defining it
    // as `!isError` would report ok:true here, because isError is reserved for a
    // command that never produced an exit code at all.
    expect(seen.ok).toBe(false);
    expect(seen.status).toBe('failed');
    // stderr is folded into the same buffer by bash-jobs, which is exactly why the
    // field is named `output` and not `stdout`.
    expect(String(seen.output)).toContain('OOPS');
  });

  it('does not name the combined buffer `stdout` — the name would read true and be false', async () => {
    const r = await bash.handler({ command: 'echo X >&2' }, makeCtx({ codeMode: true }));
    const seen = unwrapToolResult(r as never) as Record<string, unknown>;

    // A script that guesses `.stdout` now gets `undefined` from an OBJECT, which the
    // code:run field-miss tracker reports with the real key list. That is a loud
    // correction; the pre-fix `.stdout` on a STRING was silent and unreportable.
    expect(seen.stdout).toBeUndefined();
    expect(Object.keys(seen)).toContain('output');
    expect(String(seen.output)).toContain('X');
  });

  it('agrees with its own background branch: both shapes are objects', async () => {
    // The asymmetry WITHIN this tool is what made `.stdout` the natural thing to
    // write — an agent who used the background form first learned "it is an object".
    const bg = await bash.handler(
      { command: 'echo BG', run_in_background: true },
      makeCtx({ codeMode: true }),
    );
    const fg = await bash.handler({ command: 'echo FG' }, makeCtx({ codeMode: true }));

    const bgSeen = unwrapToolResult(bg as never) as Record<string, unknown>;
    const fgSeen = unwrapToolResult(fg as never) as Record<string, unknown>;
    expect(typeof bgSeen).toBe('object');
    expect(typeof fgSeen).toBe('object');
    // Both carry the launch/run facts under the same names.
    expect(bgSeen.ok).toBe(true);
    expect(typeof bgSeen.task_id).toBe('string');
    expect(fgSeen.ok).toBe(true);
    expect(bgSeen.cwd).toBe(STATE);
    expect(fgSeen.cwd).toBe(STATE);
  });

  it('refuses an untracked shell-backgrounded child before creating a task', async () => {
    const r = await bash.handler(
      {
        command: 'nohup sleep 30 >/tmp/capability-bash-untracked.log 2>&1 & echo launched; sleep 1',
        run_in_background: true,
      },
      makeCtx({ codeMode: true }),
    );
    expect(r.isError).toBe(true);
    const seen = JSON.parse(r.content[0].text) as Record<string, unknown>;
    expect(seen).toMatchObject({ ok: false, reason: 'untracked_shell_background' });
    expect(String(seen.message)).toContain('reaped when the shell finishes');
    expect(String(seen.message)).toContain('foreground payload');
    expect(seen.task_id).toBeUndefined();
  });
});
